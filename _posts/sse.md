# SSE 전환 검토

## 배경: 현재 polling 구조의 문제

### 부하테스트 실측 (mixed_w40, 2026-05-02)

```
write VU: 40개  각 VU당 poll 100ms 간격 최대 300회
read VU:  200개

write_poll_count:
  avg: 42회   med: 11회
  p(90): 300  p(95): 300  ← 10% 이상이 타임아웃(30초)
```

Lambda 처리 완료를 기다리는 동안 VU당 평균 42번, 최악 300번 HTTP 요청이 발생한다.
40VU 기준 poll만으로 약 400 req/s가 추가로 발생한다.

---

## polling이 completeBook 지연에 미치는 영향

### Tomcat accept queue 포화

```
server.tomcat.accept-count: 100 (기본값)

poll burst → accept queue 포화 → 새 TCP 연결 거부
→ completeBook 연결 자체가 대기 또는 거부
```

실측에서 `connectex: A connection attempt failed` 오류가 발생했다.
Tomcat 스레드(200)가 포화되지 않았음에도 연결이 실패한 것은
accept queue(100) 포화가 원인이다.

### Tomcat 스레드 간접 점유

```
poll 1건: 스레드 점유 ~10ms (Redis round-trip)
40VU × 10 req/s = 400 poll req/s
순간 점유 스레드 ≈ 400 × 0.01 = 4개 (평균, burst 시 더 많음)
```

completeBook이 poll burst 구간에 도착하면 스레드 대기 후 실행된다.

### 실측 영향

| 지표 | 값 | 관계 |
|---|---|---|
| `write_complete_duration` p(95) | 1,065ms | poll + read VU의 DB 경합 합산 |
| `write_confirm_duration` p(95) | 910ms | poll이 accept queue 압박하는 상황에서 실행됨 |
| `connectex` 오류 | 발생 | accept queue 포화 직접 증거 |

---

## SSE가 해결하는 것

### 연결 수 비교

```
현재 polling:
  40VU × 평균 42 poll = 1,680 HTTP 요청 (쓰기 시나리오 전체)
  각 요청마다 TCP 연결 or keep-alive 유지

SSE:
  40VU × 1 SSE 연결 = 40 long-lived 연결
  Lambda 완료 시 서버가 push → 클라이언트는 대기만
```

accept queue에 쌓이는 연결 수가 대폭 줄어든다.

### completeBook 지연 개선 예상

poll이 사라지면:
- accept queue 여유 확보 → completeBook 연결 즉시 수용
- 스레드 점유 감소 → completeBook 스레드 대기 감소
- 전체 req/s 감소 → 읽기 VU와의 DB 경합 완화

### 클라이언트 구조 단순화

```
현재: initBook → poll(반복) → confirm → completeBook
SSE:  initBook + SSE 연결 → 이벤트 수신 → confirm → completeBook
```

poll 루프가 없어지고 confirm은 그대로 유지된다.
(confirm의 멱등성, Redis 장애 내성은 SSE와 무관하게 유지)

---

## SSE 전환 시 추가 필요 사항

### Lambda → 메인앱 이벤트 채널

Lambda가 `bip:result`에 저장할 때 메인앱이 감지해야 한다.

| 방식 | 설명 | 비고 |
|---|---|---|
| Redis Keyspace Notification | `bip:result` SET 이벤트 구독 | 별도 설정 필요, 단순 |
| Redis Pub/Sub | Lambda가 결과 저장 후 채널 PUBLISH | Lambda 코드 수정 필요 |
| 폴링 스케줄러 | 서버 내부에서 주기적으로 result 스캔 | 서버 내부 polling, 비효율 |

현재 Redis 인프라를 그대로 사용하면 **Redis Keyspace Notification**이 추가 인프라 없이 연결 가능하다.

### 수평 확장 시 SSE fanout

```
클라이언트 → SSE 연결 → 인스턴스 A
Redis 이벤트 감지 → 인스턴스 B
→ 인스턴스 B가 Redis Pub/Sub으로 A에게 전달
→ A가 SSE push
```

현재 단일 인스턴스 환경에서는 fanout 없이 동작 가능하다.

---

## 현재 미적용 이유

- Lambda가 Redis에서 BIP를 직접 읽어 LLM 컨텍스트를 구성하므로 `bip:result` 채널은 유지 필요
- SSE 연결 상태 관리(SseEmitter)가 추가 구현 필요
- 현재 단계에서는 accept-count 증가로 즉각적인 완화 가능

---

## 관련 수치 요약 (mixed_w40_2026-05-02)

| 지표 | 값 |
|---|---|
| poll로 인한 추가 요청 | 평균 42회/VU (최대 300회) |
| write_complete p(95) | 1,065ms |
| write_confirm p(95) | 910ms |
| connectex 오류 | 발생 (accept queue 포화) |
| write_e2e p(95) | 4,848ms |
| write_completed 건수 | 620 / 698 (완료율 89%) |

---

## mixed_w40 부하테스트 분석 (2026-05-02 vs 2026-04-20)

### 임계값 결과 비교

| 지표 | 04-20 p(95) | 05-02 p(95) | 변화 | 임계값 |
|---|---|---|---|---|
| `write_e2e_duration` | 3,584ms | 4,848ms | +35% | ✅ <15s |
| `write_complete_duration` | 520ms | 1,065ms | +105% | ❌ <300ms |
| `write_confirm_duration` | — | 910ms | 신규 | ❌ <300ms |
| `book_detail_duration` | 350ms | 334ms | -5% | ❌ <300ms |
| `board_all_duration` | 339ms | 307ms | -9% | ✅ <500ms |
| `error_rate` | 0.069% | 0.028% | -59% | ✅ <5% |
| `http_reqs/s` | 1,028 | 972 | -5% | — |

### 주요 변화 분석

**완료율 개선**
```
04-20: 923건 시작 → 749건 완료 (81%)
05-02: 698건 시작 → 620건 완료 (89%)
```

**poll_count 개선 (Lambda 처리 속도 감지)**
```
         avg    med   p(90)  p(95)
04-20:   77     25    300    300
05-02:   42     11    300    300
```
중앙값 기준 25→11로 Lambda 완료를 더 빠르게 감지하지만,
꼬리(p90, p95=300)는 여전히 타임아웃 → Lambda 처리 시간 분산이 크다.

**write_confirm 910ms (신규 문제)**

confirm은 Redis 전용 연산임에도 910ms. 원인:
1. `save()` 방식: `DEL book:pages` + `RPUSH × N` (전체 재작성)
2. 락 점유 중 reinsert → 락 보유 시간 연장 → completeBook 대기 증가

→ `addPageTo()`(append only)로 수정 완료. 다음 테스트에서 확인 필요.

**write_complete 1,065ms (악화)**

confirm 추가로 completeBook 실행 타이밍이 늦어지고,
poll burst + accept queue 압박이 겹쳐 연결 대기 발생.
confirm 단축(addPageTo) + accept-count 증가로 완화 가능.

**write_init 악화 (341ms → 737ms)**

initBook 자체는 SQS 발행으로 빠르게 끝나야 하는데 737ms는 이상.
poll burst 구간에 accept queue가 포화된 상태에서 initBook 요청도 대기했을 가능성.
accept-count 증가로 함께 개선될 것으로 예상.
