---
layout: post
title: "LittleWriter v3 - 성능·안정성 개선"
date: 2025-12-12 10:00:40
---

# 들어가며

[SETNX 기반 동시성 제어]({% post_url 2025-11-21-littleWriterSetnx %})와 [아키텍처 리팩터링]({% post_url 2025-11-19-littleWriter02 %})으로 V2 구조를 정리한 뒤, 실제 부하 상황에서 이 구조가 어디까지 버티는지 k6로 측정해봤다. 이 글은 그 측정 결과를 근거로 V2 → V3로 넘어가며 손댄 것들을 정리한 것이다.

> 측정 환경: EC2 t3.small (2 vCPU, 2GB) / RDS MySQL db.t3.micro / Redis t3.micro
> 부하 도구: k6 (mixed-load: 읽기 200VU + 쓰기 40VU / read-book: 최대 280VU)

# 1. 무엇이 문제였나

동화책 생성 서비스의 핵심 기능인 "책 페이지 저장 + LLM 삽화 생성"이 HTTP 커넥션을 30초간 블로킹하며 응답하고 있었다. 40VU 부하 시 `write_complete` p95가 880ms까지 치솟았고, LLM 타임아웃이 발생하면 데이터 불일치가 생겼으며, 이미지 업로드가 실패해도 복구할 방법이 없었다.

목표는 신뢰성 있는 비동기 처리 구조로 전환하면서, **인프라 비용 증가 없이 현재 EC2 인스턴스 규모 내에서** 반복 쿼리·커넥션 풀 낭비를 제거해 처리량과 응답 안정성을 실측 기준으로 개선하는 것이었다.

## 결과 요약

| 지표 | 개선 전 | 개선 후 | 변화 |
|---|---|---|---|
| write_complete p95 (40VU) | 880ms | **493ms** | **-44%** |
| book_detail p95 | 350ms | **191ms** | **-45%** |
| http_reqs/s | 1,028 | **1,239** | **+21%** |
| HTTP 스레드 점유 (LLM 처리) | 30초 | **~5ms** | **-99.9%** |
| LLM 실패 복구 | 불가 | SQS DLQ 3회 재시도 | 신뢰성 확보 |

# 2. LLM 처리 비동기 전환 (핵심)

## 2.1 문제

```
POST /book/progress/{id}
  → Redis Lock 획득
  → LLM 호출 (5~30초) ← Lock 보유 중
  → 이미지 업로드 (~500ms)
  → HTTP 응답 (30초 블로킹)
```

HTTP 커넥션이 LLM 응답 대기 시간만큼 Tomcat 스레드를 점유하고 있었다. Lock TTL(120초) 내 LLM 완료를 보장할 수 없어 데이터 덮어쓰기 위험도 있었고, 이미지 업로드가 실패해도 재시도·복구 수단이 없었다.

## 2.2 전환한 구조

```
POST /book/progress/{id}
  → Redis Lock 획득 (race condition 방지)
  → status = PENDING 저장
  → SQS FIFO 발행 (MessageGroupId=bipId, DeduplicationId=bipId-pageIndex)
  → 202 즉시 반환

Lambda (비동기)
  → 멱등성 검증 (Redis idempotency key)
  → LLM 호출 + 이미지 S3 업로드 (deterministic key)
  → Redis SET bip:result:{bipId} (TTL 10분)

GET /book/progress/{id}/status
  → Redis 조회 → PENDING / COMPLETED
```

**왜 SQS FIFO + Lambda인가**

| 후보 | 탈락 이유 |
|---|---|
| Spring `@Async` | 프로세스 재시작 시 작업 유실, 재시도 로직 직접 구현 필요 |
| Kafka | 소규모 서비스에 브로커 운영 비용 과도, 순서 보장은 FIFO로 충분 |
| SQS Standard + Lambda | 메시지 순서 미보장 → 같은 페이지 중복 처리 위험 |
| **SQS FIFO + Lambda** | MessageGroupId(=bipId)로 동일 사용자 순서 보장, DeduplicationId로 중복 발행 하드 방어, Lambda 스케일링·재시도·DLQ가 관리형으로 제공 → **채택** |

Redis를 idempotency store로 쓴 이유는 단순하다. Lambda가 재시도할 때 "이미 처리됐는지"를 빠르게 확인해야 하는데, 이 정보는 10분 후엔 필요 없어지므로 TTL 설정이 자연스러운 Redis가 DB 조회보다 적합했다.

**결과**: HTTP 스레드 점유 시간 30초 → ~5ms(-99.9%). LLM 실패 시 SQS DLQ 3회 재시도로 자동 복구되고, DeduplicationId로 중복 처리를 하드하게 막는다.

# 3. BIP 락 구조 — 분산 락과 PendingGuard

LLM 처리를 Lambda로 넘기면서 락 구조도 함께 다시 설계해야 했다. BIP(BookInProgress)를 보호하는 장치는 두 가지다.

- **분산 락** (`bip:lock`) — 동시에 두 요청이 같은 BIP를 수정하지 못하게 막는다
- **PendingGuard** (`bip:pending-guard`) — Lambda가 죽었을 때 PENDING이 영구 고착되는 것을 방지한다

## 3.1 분산 락 — Redis SET NX + Lua

클라이언트가 "다음 페이지 생성" 버튼을 빠르게 두 번 누르면 두 요청이 동시에 서버에 도달할 수 있다. PENDING 상태 체크만으로는 부족하다 — 두 요청이 동시에 `IN_PROGRESS`를 읽으면 둘 다 체크를 통과하기 때문이다.

```
SET bip:lock:{bipId}  <uuid>  PX 120000  NX
                      └─소유자  └─ 120초  └─ 키 없을 때만
```

> SQS FIFO의 DeduplicationId로 대체 가능한지도 검토했었다. 결론은 아니다 — dedup은 처리 중복은 막지만 요청 B에게 202를 반환해버리기 때문에, B는 자신의 입력이 처리됐다고 오해하게 된다. Lock은 별도로 유지해야 한다.

락 해제는 원래 `RedisCallback`으로 GET → DEL을 같은 커넥션에서 실행했는데, 이건 커넥션만 재사용할 뿐 원자성을 보장하지 않는다. GET 확인 후 DEL 사이에 TTL이 만료돼 다른 요청이 락을 가져가면, 그 락을 실수로 지워버리는 race condition이 있었다.

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0
end
```

GET과 DEL을 Lua 스크립트로 묶어 Redis가 단일 명령처럼 원자적으로 실행하게 만들었다. UUID(lockId)로 소유자를 비교하기 때문에, TTL 만료 후 다른 요청이 새로 획득한 락을 실수로 지우는 경우도 막힌다.

## 3.2 PendingGuard — Lambda가 죽었을 때

락은 "동시 수정"만 막는다. Lambda가 LLM 호출 중 크래시하면 다른 문제가 남는다: BIP는 PENDING인데 락은 이미 해제된 상태라, 클라이언트가 poll해도 영원히 PENDING만 돌아온다.

`bip:pending-guard:{bipId}` (TTL 600초)가 이 상태를 구분하는 유일한 기준이다.

| BIP status | guard 존재 | 해석 |
|---|---|---|
| `IN_PROGRESS` | — | 대기 중, 페이지 요청 가능 |
| `PENDING` | 있음 | Lambda 처리 중, 요청 불가 |
| `PENDING` | 없음 | Lambda 크래시 추정 (stale), 재요청 허용 |
| `COMPLETED` | — | 완성됨 |

락 TTL(120초)은 메인 앱 작업의 최대 보장 시간이고, guard TTL(600초)은 Lambda 최대 실행 시간을 가정한 값이다. 두 TTL이 서로 다른 이유가 여기에 있다 — 락은 메인 앱이 `finally`로 명시적으로 해제하지만, guard는 Lambda가 직접 지우지 않고 confirm 단계나 TTL 만료에 의존한다.

# 4. DB/Redis 정합성 보장

DB 트랜잭션 커밋 직후 Redis 갱신을 동기 호출하면, 네트워크 장애 시 두 저장소의 상태가 갈린다 — DB는 COMPLETED인데 Redis는 PENDING으로 남아, 이후 요청에서 이미 완료된 책을 재완료 시도하는 일이 생길 수 있었다.

```java
@TransactionalEventListener(phase = AFTER_COMMIT)
public void onBookCompleted(BookCompletedEvent event) {
    redis.markAsCompleted(event.getBipId());
}
```

`@EventListener`는 트랜잭션 커밋 전에도 실행될 수 있어 롤백 시 Redis만 갱신된 상태가 남을 위험이 있었다. Outbox 패턴은 정합성 보장 수준은 동일하지만 별도 테이블과 폴링 스레드가 필요해 현재 규모엔 과했다. `@TransactionalEventListener(AFTER_COMMIT)`은 Spring이 커밋 완료 후에만 이벤트를 발행하도록 보장해주므로, 추가 인프라 없이 DB 롤백 시 Redis 갱신 자체가 발생하지 않게 만들 수 있었다.

# 5. 이미지 업로드를 Lambda로 완전히 이관

기존에는 DB 트랜잭션이 열린 상태에서 S3 업로드 이벤트를 발행하고 `@Async`로 처리했는데, 실패 시 복구 수단이 없었고 S3 I/O를 기다리는 동안 DB 커넥션을 낭비하고 있었다.

Lambda가 이미 LLM 호출을 위해 비동기로 실행되므로, 같은 실행 컨텍스트에서 S3 업로드(`bip/{bipId}/page-{n}.png`, deterministic key)까지 처리하도록 옮겼다. `ImageUploadEventHandler`, `ImageUploadEvent`, 전용 스레드풀을 메인 앱 코드에서 통째로 삭제할 수 있었고, Lambda의 재시도가 이미지 업로드 재시도까지 포함하게 되어 별도 복구 로직이 필요 없어졌다.

# 6. HikariCP 커넥션 풀 최적화

`completeBook` 동시 10건 처리 시 커넥션 풀(기본값 10)이 고갈되어 HikariCP acquire timeout이 발생했다. RDS `db.t3.micro`의 `max_connections`는 60이고 모니터링용 커넥션 10을 빼면 애플리케이션이 쓸 수 있는 최대는 50이다.

이론값이 아니라 k6 부하테스트로 VU별 p95를 실측해 `maximum-pool-size: 50`이 포화점(140VU @ 1,059 req/s, CPU 85.8%) 이전까지 안정적임을 확인하고 그 값을 채택했다.

```
M/M/c 큐잉 이론:
응답시간 = 서비스시간 / (1 - 이용률)
이용률 90% → 응답시간 10x
이용률 95% → 응답시간 20x  ← pool=10일 때 4초 acquire 발생 구간
```

# 7. 이중 쿼리 두 건 제거

## 7.1 completeBook

Lock 구간 안에서 같은 캐릭터 행을 두 번 조회하고 있었다(`validateNotNull`에서 한 번, `saveFrom` 내부에서 재조회로 한 번). 단일 조회 결과를 재사용하도록만 고쳤는데, 락 구간 내 DB 커넥션 점유 시간이 줄면서 효과는 경합이 심할수록 커졌다.

| VU | 개선 전 p95 | 개선 후 p95 | 개선율 |
|:--:|:-----------:|:-----------:|:------:|
| 20 | 500ms | 479ms | -4% |
| 30 | 565ms | 471ms | -17% |
| 40 | 880ms | **493ms** | **-44%** |

경합이 심할수록 개선 효과가 지수적으로 커지는 건 큐잉 이론의 knee of the curve 구간에서 커넥션 점유 단축이 이용률을 결정적으로 낮추기 때문이다.

## 7.2 retrieveByBookId

```java
// Before
public Book retrieveByBookId(String bookId) {
    Book book = bookRepository.retrieveById(bookId);
    if (book == null) throw BookException.notFound(bookId);
    return bookRepository.retrieveById(bookId);  // 불필요한 재조회
}
```

null 체크 후 같은 쿼리를 한 번 더 실행하고 있었다. 단건 조회 API마다 DB 쿼리가 2배로 발생해 읽기 처리량을 절반으로 낭비하는 구조였다.

| 지표 | 개선 전 | 개선 후 | 개선율 |
|---|---|---|---|
| book_detail p95 | 350ms | **191ms** | **-45%** |
| board_all p95 | 339ms | 222ms | -35% |
| write_complete p95 | 521ms | 314ms | -40% |
| http_reqs/s | 1,028 | **1,239** | **+21%** |

읽기 쿼리가 절반으로 줄면서 DB 커넥션 풀에 여유가 생기고, 그 여유가 쓰기 성능에도 연쇄적으로 영향을 줬다.

# 8. 인덱스 추가

`book.user_id`, `book.created_at`, `book_page.book_id`, `main_character.member_id`에 인덱스가 없어 데이터가 쌓일수록 O(N) full scan이 발생하고 있었다. 부하 테스트를 반복할 때마다 쓰기 p95가 단조 증가하는 패턴으로 이 문제를 감지했다.

```sql
CREATE INDEX idx_book_user_id        ON book(user_id);
CREATE INDEX idx_book_created_at     ON book(created_at DESC);
CREATE INDEX idx_book_page_book_id   ON book_page(book_id);
CREATE INDEX idx_character_member_id ON main_character(member_id);
```

복합 인덱스 대신 단일 컬럼 인덱스를 택한 이유는 쿼리 패턴이 대부분 단일 컬럼 필터(`WHERE user_id = ?`)라서 복합 인덱스의 추가 선택도 이점이 없고 쓰기 오버헤드만 늘기 때문이다. Buffer pool hit rate 99.9999%(디스크 I/O 병목 아님), Tomcat busy thread 140/200(스레드 병목 아님)을 확인해 커넥션 풀 포화가 단일 원인임을 검증한 뒤 적용했다.

`GET /book/board/all`의 경우 인덱스만으론 부족했다 — Spring Data JPA의 `Page` 조회가 `COUNT(*)` 쿼리를 항상 함께 실행해서, 데이터가 13만 건 누적된 시점에 100VU 부하로 timeout이 발생했다. COUNT 쿼리가 필요 없는 `Slice` 기반 커서 페이징으로의 전환을 다음 단계로 정리해뒀다.

# 9. Virtual Thread, 도입하지 않기로 한 이유

Java 21 Virtual Thread 도입을 검토했지만, k6 부하테스트 + JFR 프로파일링 실측 결과 오히려 처리량이 떨어졌다.

| 설정 | req/s | 결과 |
|---|---|---|
| **no-VT + Connector 8.x** | **653** | ✅ 안정 |
| VT + Connector 9.1.0 | 363 | ❌ 불안정 |
| VT + Connector 9.2.0 | 358 | ✅ 안정 |

JFR 스택 트레이스로 원인을 추적해보니 MySQL Connector의 `ReadAheadInputStream`(소켓 읽기)이 `synchronized` 블록 내에서 park되면서 carrier thread를 계속 점유하고 있었다. Virtual Thread의 pinning이 발생해 CPU per request가 +33%, throughput은 -45%였다.

현재 병목은 스레드 개수가 아니라 DB 커넥션 풀과 LLM 응답 대기이기 때문에, VT가 해결하는 문제(스레드 생성 비용)와 실제 병목이 다르다고 판단해 도입하지 않았다. R2DBC 전환이나 동시 요청 200+ 환경이 되기 전까지는 재검토하지 않기로 했다.

# 10. poll/confirm 분리

기존 `pollPageResult()`는 GET 요청임에도 BIP 저장과 result 삭제라는 두 가지 쓰기를 함께 수행하고 있었다. 여기엔 두 가지 문제가 있었다.

1. **네트워크 오류 시 데이터 유실** — 서버가 BIP 저장 + result 삭제를 마친 뒤 응답 전송에서 오류가 나면, 클라이언트는 결과를 영영 받지 못한다. 재poll하면 result가 이미 삭제돼 PENDING만 반환된다.
2. **poll의 side effect** — GET이 상태를 변경하므로 멱등하지 않다. 동시 poll 시 같은 페이지가 BIP에 중복 추가될 수 있었다. 게다가 `pollPageResult`엔 락도 없어서 `generateWithAi`(락 보유)와 동시 실행되면 PENDING 상태를 덮어쓸 수 있는 허점도 있었다.

poll은 순수 읽기로 분리하고, BIP 업데이트는 클라이언트가 명시적으로 confirm을 호출할 때만 수행하도록 책임을 옮겼다.

```
GET  /progress/{id}/status  → bip:result 조회만, BIP 수정 없음 (멱등)
POST /progress/{id}/confirm → lock 획득 → BIP 페이지 추가 → result 삭제 → guard 삭제
```

confirm의 멱등성은 세 겹으로 보장했다 — Redis 분산 락으로 동시 confirm을 직렬화하고, `bip:result` 존재 여부로 이미 처리된 요청은 스킵하고, pageIndex 중복 체크로 BIP 저장 후 result 삭제에 실패해도 재시도 시 페이지가 중복되지 않게 막았다. 세 번째 보장이 특히 중요한데, Redis 부분 장애로 저장은 됐지만 삭제가 안 된 상태에서 재시도가 들어와도 이미 있는 pageIndex는 건너뛰고 result 삭제만 다시 시도하기 때문이다.

BIP를 DB가 아니라 Redis에 계속 둔 이유도 짚어둘 만하다. DB로 옮기면 Lambda가 LLM 컨텍스트(이전 페이지) 조회를 위해 매번 DB에 접근해야 하는데, Lambda는 수평 확장 특성상 커넥션 풀 고갈 위험이 있다. Redis에 두면 Lambda 버스트 시 Redis가 버퍼 역할을 해줘서 메인 앱이 그 부하를 직접 받지 않는다.

# 11. poll이 만든 병목, 그리고 다음 단계

confirm을 추가한 뒤 다시 측정해보니(`mixed_w40`, 2026-05-02 vs 2026-04-20), poll 자체가 새로운 병목이 되어있었다.

```
write VU: 40개  각 VU당 poll 100ms 간격 최대 300회
write_poll_count: avg 42회, med 11회, p90/p95 300회 (10% 이상 30초 타임아웃)
```

40VU면 poll만으로 초당 약 400개의 추가 요청이 발생한다. Tomcat `accept-count`(기본값 100)가 poll burst로 포화되면서 `completeBook`을 위한 새 연결 자체가 거부되는 `connectex` 오류가 실측에서 확인됐다. Tomcat 스레드(200)는 포화되지 않았는데 연결이 실패한 게 accept queue 포화가 원인이라는 직접적인 증거였다.

| 지표 | 04-20 p95 | 05-02 p95 | 변화 |
|---|---|---|---|
| write_e2e_duration | 3,584ms | 4,848ms | +35% |
| write_complete_duration | 520ms | 1,065ms | +105% |
| write_confirm_duration | — | 910ms | 신규 |

confirm이 910ms나 걸린 원인은 `save()`가 `DEL book:pages` + `RPUSH × N`으로 페이지 전체를 매번 재작성하고 있었기 때문이다 — 락을 쥔 채로 reinsert하니 락 보유 시간이 늘어나고, 그만큼 `completeBook` 대기가 길어졌다. `addPageTo()`(append-only)로 바꾸는 수정은 반영했지만, 다음 부하테스트로 확인이 더 필요한 상태로 남아있다.

근본적으로는 poll 자체를 없애는 게 맞는 방향이라고 판단했다. SSE로 전환하면 40VU × 평균 42회의 poll 요청이 40개의 long-lived 연결로 줄어든다. 현재 Redis 인프라를 그대로 쓰면 Keyspace Notification으로 `bip:result` SET 이벤트를 감지할 수 있어 추가 인프라 없이 연결 가능하다는 것까지는 확인했고, 실제 전환은 아직 하지 않았다.

## 남은 항목

| 항목 | 현황 |
|---|---|
| board_all COUNT(*) | 분석 완료, Slice 전환 또는 COUNT 캐싱 미적용 |
| my_books p95 | 240VU에서 한계 — 캐시 없이는 pool 포화 불가피 |
| confirm 910ms | addPageTo() 반영, 재측정 필요 |
| poll → SSE 전환 | 미구현 — Keyspace Notification 기반 설계까지 확인 |
| completeBook 후 BIP 미갱신 | Book DB 저장 후 BIP status COMPLETED 미반영 |
