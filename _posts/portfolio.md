# LittleWriter v2 → v3 성능·안정성 개선 포트폴리오

> 측정 환경: EC2 t3.small (2 vCPU, 2GB) / RDS MySQL db.t3.micro / Redis t3.micro  
> 부하 도구: k6 (mixed-load: 읽기 200VU + 쓰기 40VU / read-book: 최대 280VU)

---

## 개요 (STAR)

**Situation**  
동화책 생성 서비스의 핵심 기능인 "책 페이지 저장 + LLM 삽화 생성"이 HTTP 커넥션을 30초간 블로킹하며 응답했다. 40VU 부하 시 write_complete p95가 880ms까지 치솟고, LLM 타임아웃 시 데이터 불일치가 발생했으며 이미지 업로드 실패에 대한 복구 수단이 없었다.

**Task**  
신뢰성 있는 비동기 처리 구조로 전환하고, 반복 쿼리·커넥션 풀 낭비를 제거하여 서비스 처리량과 응답 안정성을 실측 기준으로 개선한다. 단, 인프라 비용 증가 없이 현재 EC2 인스턴스 규모 내에서 해결한다.

**Action**  
LLM 처리를 SQS + Lambda로 비동기 전환하고, Redis Lock 원자성 결함 수정, DB/Redis 정합성 보장, 이중 쿼리 제거, 커넥션 풀 최적화, 인덱스 추가를 순차적으로 적용했다.

**Result**

| 지표 | 개선 전 | 개선 후 | 변화 |
|---|---|---|---|
| write_complete p95 (40VU) | 880ms | **493ms** | **-44%** |
| book_detail p95 | 350ms | **191ms** | **-45%** |
| http_reqs/s | 1,028 | **1,239** | **+21%** |
| HTTP 스레드 점유 (LLM 처리) | 30초 | **~5ms** | **-99.9%** |
| LLM 실패 복구 | 불가 | SQS DLQ 3회 재시도 | 신뢰성 확보 |

---


## 1. LLM 처리 비동기 전환 (핵심)

### Situation
```
POST /book/progress/{id}
  → Redis Lock 획득
  → LLM 호출 (5~30초) ← Lock 보유 중
  → 이미지 업로드 (~500ms)
  → HTTP 응답 (30초 블로킹)
```
- HTTP 커넥션이 LLM 응답 대기 시간만큼 Tomcat 스레드를 점유
- Lock TTL(120초) 내 LLM 완료를 보장할 수 없어 데이터 덮어쓰기 위험
- 이미지 업로드 실패 시 재시도·복구 수단 없음

### Task
LLM + 이미지 업로드를 HTTP 요청-응답 사이클 밖으로 분리하고, 실패 시 자동 재시도·멱등성을 보장하는 구조로 전환한다.

### Action
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

**기술 선택 근거**

| 후보 | 탈락 이유 |
|---|---|
| Spring `@Async` | 프로세스 재시작 시 작업 유실, 재시도 로직 직접 구현 필요 |
| Kafka | 소규모 서비스에 브로커 운영 비용 과도, 순서 보장은 FIFO로 충분 |
| SQS Standard + Lambda | 메시지 순서 미보장 → 같은 페이지 중복 처리 위험 |
| **SQS FIFO + Lambda** | MessageGroupId(=bipId)로 동일 사용자 순서 보장, DeduplicationId로 중복 발행 하드 방어, Lambda 스케일링·재시도·DLQ가 관리형으로 제공 → **채택** |

**Redis를 idempotency store로 선택한 이유**  
Lambda 재시도 시 LLM을 다시 호출하지 않기 위해 "이미 처리됨" 여부를 빠르게 확인해야 한다. DB 조회는 커넥션 비용이 발생하고, 이 정보는 10분 후 불필요해지므로 TTL 설정이 자연스러운 Redis가 적합하다.

### Result
- HTTP 스레드 점유 시간: 30초 → **~5ms** (-99.9%)
- LLM 실패 시 SQS DLQ 3회 재시도로 자동 복구
- SQS FIFO DeduplicationId로 중복 처리 하드 방어

---

## 2. Redis Lock 해제 Race Condition 수정

### Situation
```java
byte[] v = connection.get(k);          // 1. 조회
if (lockId.equals(deserialize(v))) {
    connection.del(k);                  // 2. 삭제 ← 1~2 사이 gap
}
```
GET과 DEL 사이에 다른 스레드가 Lock을 탈취하면, 자신의 Lock이 아닌 것을 삭제하는 race condition이 발생한다. 동시 요청이 많을수록 데이터 덮어쓰기 확률이 증가한다.

### Task
Lock 확인과 해제를 원자적(atomic)으로 처리하여 race condition을 원천 차단한다.

### Action
```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end
```

**기술 선택 근거**

| 후보 | 탈락 이유 |
|---|---|
| Redis MULTI/EXEC (낙관적 잠금) | WATCH 실패 시 클라이언트가 재시도해야 함 — 결국 gap 잔존 |
| Redisson RLock | 외부 라이브러리 의존 추가, 현재 요구사항에 과도한 기능 |
| **Lua Script** | Redis 서버 내에서 단일 명령으로 실행 → 원자성 보장, 추가 의존성 없음 → **채택** |

### Result
GET→DEL 사이 gap을 서버 측 원자 연산으로 제거, 다른 스레드의 Lock 탈취 불가능

---

## 3. DB/Redis 정합성 보장

### Situation
```
DB commit 성공 → redis.markAsCompleted() 네트워크 실패 가능
→ DB: COMPLETED / Redis: PENDING (불일치)
→ 이후 요청에서 이미 완료된 책을 재완료 시도
```
DB 트랜잭션 커밋 직후 Redis 갱신을 동기 호출하면, 네트워크 장애 시 두 저장소의 상태가 갈린다.

### Task
DB 커밋 성공 이후에만 Redis 갱신이 시도되도록 이벤트 처리 순서를 보장한다.

### Action
```java
@TransactionalEventListener(phase = AFTER_COMMIT)
public void onBookCompleted(BookCompletedEvent event) {
    redis.markAsCompleted(event.getBipId());
}
```

**기술 선택 근거**

| 후보 | 탈락 이유 |
|---|---|
| `@EventListener` | 트랜잭션 커밋 전 실행 가능 → 롤백 시 Redis만 갱신된 상태 발생 |
| Outbox Pattern | 정합성 보장은 동일하나 별도 테이블·폴링 스레드 필요 → 현재 규모에 과도 |
| **`@TransactionalEventListener(AFTER_COMMIT)`** | Spring이 커밋 완료 후 이벤트를 발행하도록 보장 — 추가 인프라 없이 순서 보장 → **채택** |

### Result
DB 롤백 시 Redis 갱신이 아예 발생하지 않아 불일치 시나리오 원천 차단

---

## 4. 이미지 업로드 구조 개선

### Situation
```
BookRepositoryAdapter (@Transactional)
  → saveFrom() 내 ImageUploadEvent 발행
  → @Async handle() → S3 copy
  → 실패 시 복구 없음
  → S3 I/O 대기 중 DB 커넥션 점유 지속
```
DB 트랜잭션이 열린 상태에서 S3 업로드를 대기하면, 커넥션 풀을 S3 응답 시간만큼 낭비한다.

### Task
이미지 업로드를 DB 트랜잭션 범위 밖으로 완전히 분리하고, 실패 시 재시도를 보장한다.

### Action
```
Lambda가 S3에 직접 업로드 (bip/{bipId}/page-{n}.png)
→ ImageUploadEventHandler / ImageUploadEvent / transaction-event 스레드풀 전부 삭제
```

**기술 선택 근거**  
Lambda가 이미 LLM 호출을 위해 비동기로 실행되므로, 같은 실행 컨텍스트에서 S3 업로드까지 처리하면 코드 경로가 단순해지고 메인 앱의 DB 커넥션 낭비와 별도 이벤트 인프라를 동시에 제거할 수 있다. Lambda의 재시도가 이미지 업로드 재시도를 포함하므로 별도 복구 로직이 필요 없다.

### Result
- S3 I/O로 인한 DB 커넥션 낭비 제거
- 업로드 실패 = Lambda 재시도로 자동 처리
- 메인 앱 코드에서 이벤트 핸들러·스레드풀 설정 삭제

---

## 5. HikariCP 커넥션 풀 최적화

### Situation
```yaml
maximum-pool-size: 10  # Spring Boot 기본값
```
completeBook 동시 10건 처리 시 커넥션 풀이 고갈되어 HikariCP acquire timeout이 발생했다. 에러 로그 분석 결과 커넥션 대기가 p95 지연 시간의 주요 원인으로 확인되었다.

### Task
k6 부하테스트 결과를 근거로 RDS 한도 내에서 최적 풀 크기를 도출한다.

### Action
```yaml
maximum-pool-size: 50
minimum-idle: 10
```

**기술 선택 근거**  
RDS db.t3.micro의 `max_connections`는 60이며, 모니터링·관리 목적 커넥션 10을 제외하면 애플리케이션이 사용 가능한 최대는 50이다. k6 부하테스트로 VU별 p95를 측정하여 pool 50이 포화점(140VU @ 1,059 req/s, CPU 85.8%) 이전까지 안정적임을 확인했다. 이론값이 아닌 실측값으로 결정했다.

**M/M/c 큐잉 이론 검증**
```
응답시간 = 서비스시간 / (1 - 이용률)
이용률 90% → 응답시간 10x
이용률 95% → 응답시간 20x  ← pool=10일 때 4초 acquire 발생 구간
```

### Result
- completeBook acquire timeout 해소
- 포화점: 140VU @ 1,059 req/s (CPU 85.8%)

---

## 6. completeBook 이중 쿼리 제거

### Situation
```
Redis lock 내부:
  validateNotNull(character)  → SELECT main_character #1
  saveFrom()
    └─ retrieveById(charId)  → SELECT main_character #2 (동일 행 재조회)
```
Lock 구간 내에서 같은 행을 두 번 조회하여 DB 커넥션 점유 시간이 불필요하게 늘어났다.

### Task
단일 조회로 획득한 객체를 재사용하도록 호출 구조를 변경한다.

### Action
```java
// Before: 검증 후 saveFrom 내부에서 재조회
BookCharacter character = bookCharacterRepository.retrieveById(id); // 1회 조회
bookRepository.saveFrom(target, character, converter);               // 전달받아 재사용
```

### Result (k6 mixed-load, 읽기 200VU + 쓰기 동시)

| VU | 개선 전 p95 | 개선 후 p95 | 개선율 |
|:--:|:-----------:|:-----------:|:------:|
| 20 | 500ms | 479ms | -4% |
| 30 | 565ms | 471ms | -17% |
| 40 | 880ms | **493ms** | **-44%** |

> 경합이 심할수록 개선 효과가 지수적으로 증가 — 큐잉 이론의 knee of the curve 구간에서 커넥션 점유 단축이 이용률을 결정적으로 낮추기 때문

---

## 7. retrieveByBookId 이중 쿼리 제거

### Situation
```java
public Book retrieveByBookId(String bookId) {
    Book book = bookRepository.retrieveById(bookId);  // 1차 조회
    if (book == null) throw BookException.notFound(bookId);
    return bookRepository.retrieveById(bookId);        // 2차 조회 (불필요)
}
```
단건 조회 API마다 DB 쿼리가 2배로 발생하여 읽기 처리량을 절반으로 낭비하고 있었다.

### Task
조회 결과를 변수로 재사용하도록 수정한다.

### Action
```java
public Book retrieveByBookId(String bookId) {
    Book book = bookRepository.retrieveById(bookId);
    if (book == null) throw BookException.notFound(bookId);
    return book;  // 1차 조회 결과 재사용
}
```

### Result (k6 mixed-load w40)

| 지표 | 개선 전 | 개선 후 | 개선율 |
|---|---|---|---|
| book_detail p95 | 350ms ❌ | **191ms** ✅ | **-45%** |
| board_all p95 | 339ms | 222ms | -35% |
| write_complete p95 | 521ms | 314ms | -40% |
| http_reqs/s | 1,028 | **1,239** | **+21%** |

> 읽기 쿼리 절반 감소 → DB 커넥션 풀 여유 확보 → 쓰기 성능에도 연쇄 개선

---

## 8. FK 컬럼 인덱스 추가

### Situation
`book.user_id`, `book.created_at`, `book_page.book_id`, `main_character.member_id`에 인덱스가 없어 데이터 증가 시 O(N) full scan이 발생했다. 부하 테스트 반복마다 쓰기 p95가 단조 증가하는 패턴이 관찰되었다.

### Task
자주 조회되는 FK·정렬 컬럼에 인덱스를 추가하여 스캔 복잡도를 O(log N)으로 줄인다.

### Action
```sql
CREATE INDEX idx_book_user_id        ON book(user_id);
CREATE INDEX idx_book_created_at     ON book(created_at DESC);
CREATE INDEX idx_book_page_book_id   ON book_page(book_id);
CREATE INDEX idx_character_member_id ON main_character(member_id);
```

**기술 선택 근거**  
복합 인덱스보다 단일 컬럼 인덱스를 우선 적용한 이유: 쿼리 패턴이 단일 컬럼 필터(WHERE user_id = ?, WHERE book_id = ?) 위주이므로 복합 인덱스의 추가 선택도 이점이 없고, 쓰기 오버헤드만 증가시킨다.

**쓰기 지연 증가 원인 분석 (큐잉 이론)**
```
INSERT = B-tree 인덱스 수정 (SELECT는 탐색만)
데이터 누적 → B-tree 깊어짐 → INSERT당 인덱스 갱신 비용 증가
           → 커넥션 점유 시간 증가 → pool 이용률 상승
           → M/M/c knee of the curve 진입 → 응답시간 지수적 폭등
```
검증: Buffer pool hit rate 99.9999% (디스크 I/O 병목 아님) / Tomcat busy thread 140/200 (스레드 병목 아님) → 커넥션 pool 포화 단일 원인 확인

### Result
O(N) full scan → O(log N) index scan으로 전환, 데이터 증가에 따른 선형 성능 저하 완화

---

## 9. Virtual Thread 도입 가능성 분석

### Situation
JVM 스레드 모델 한계에 대응하기 위해 Java 21 Virtual Thread 도입을 검토했다.

### Task
k6 부하테스트 + JFR(Java Flight Recorder) 프로파일링으로 실측하여 도입 여부를 결정한다.

### Action

| 설정 | req/s | p95 결과 |
|---|---|---|
| **no-VT + Connector 8.x** | **653** | ✅ 안정 |
| VT + Connector 9.1.0 | 363 | ❌ 불안정 |
| VT + Connector 9.2.0 | 358 | ✅ 안정 |

**탈락 원인 (JFR 스택 트레이스)**
```
MySQL Connector의 ReadAheadInputStream (소켓 읽기)이
synchronized 블록 내에서 park 발생 → carrier thread 점유 유지
→ CPU per req +33%, throughput -45%
```
MySQL Connector의 `synchronized` 사용이 Virtual Thread의 pinning을 유발하여 오히려 처리량이 감소했다.

**도입 안 한 근거**  
현재 병목은 스레드 수가 아니라 DB 커넥션 풀과 LLM 응답 대기이므로, VT가 해결하는 문제(스레드 생성 비용)와 실제 병목이 다르다. R2DBC 전환 또는 동시 요청 200+ 환경이 되기 전까지 net benefit이 없다.

### Result
- **현재 최적**: no-VT + Connector 9.2.0 + pool 50
- **VT 도입 기준**: 동시 요청 200+ 또는 R2DBC 전환 시 재검토

---

## 10. poll/confirm 분리 — BIP 업데이트 책임 이전

### Situation

```java
// 기존 pollPageResult(): GET 요청임에도 세 가지 쓰기를 수행
public BookPagePollResult pollPageResult(Actor user, String bipId) {
    return bookPageResultRepository.find(bipId)
            .map(page -> {
                bookInProgressRepository.save(updated);      // 쓰기 1
                bookPageResultRepository.delete(bipId);      // 쓰기 2
                return BookPagePollResult.completed(page);
            })
            ...
}
```

두 가지 문제가 있었다.

1. **네트워크 오류 시 데이터 유실**: 서버가 BIP 저장 + result 삭제를 완료한 후 응답 전송에서 오류가 나면, 클라이언트는 결과를 영영 받지 못한다. 재poll하면 result가 이미 삭제되어 PENDING만 반환된다.
2. **poll의 side effect**: GET 요청이 상태를 변경하므로 멱등하지 않다. 동시 poll 시 같은 페이지가 BIP에 중복 추가될 수 있다.

**추가로 발견된 허점**: `pollPageResult`에 락이 없어 `generateWithAi`(락 보유)와 동시 실행 시 PENDING 상태를 덮어쓸 수 있었다.

### Task

poll은 순수 읽기로 분리하고, BIP 업데이트는 클라이언트가 명시적으로 confirm을 호출할 때만 수행하도록 책임을 이전한다.

### Action

```
GET  /progress/{id}/status  → bip:result 조회만, BIP 수정 없음 (멱등)
POST /progress/{id}/confirm → lock 획득 → BIP 페이지 추가 → result 삭제 → guard 삭제
```

**confirm 멱등성 3중 보장**

| 보장 수단 | 역할 |
|---|---|
| Redis 분산 락 | 동시 confirm 직렬화 |
| `bip:result` 존재 여부 | result 없으면 ifPresent 스킵 (이미 처리된 경우 no-op) |
| pageIndex 중복 체크 | BIP 저장 성공 후 result 삭제 실패 시 재시도해도 페이지 중복 없음 |

세 번째 보장은 Redis 부분 장애 시나리오를 커버한다. BIP 저장 후 result 삭제 전에 Redis 장애가 나면 재시도 시 같은 pageIndex가 BIP에 이미 있으므로 저장 단계를 건너뛰고 result만 삭제한다.

**Redis를 BIP 저장소로 유지한 이유**

DB로 전환 시 Lambda가 LLM 컨텍스트(이전 페이지) 조회를 위해 DB에 접근해야 한다. Lambda는 수평 확장 특성상 DB 커넥션 풀 고갈 위험이 있으므로, BIP는 Redis에 유지해야 한다. 또한 Lambda 버스트 시 Redis가 버퍼 역할을 해 메인앱이 직접 부하를 받지 않는 구조적 이점이 있다.

### Result

| 항목 | 개선 전 | 개선 후 |
|---|---|---|
| poll 멱등성 | ✗ (BIP 수정) | ✅ (순수 읽기) |
| 네트워크 오류 복구 | 데이터 유실 | 재poll → 재confirm 가능 |
| Redis 부분 장애 | 페이지 중복 가능 | pageIndex 체크로 방어 |
| guard 정리 | TTL 만료 대기 | confirm 시 명시적 삭제 |
| pollPageResult 동시성 | 락 없음 | confirm에 락 추가 |

---

## 미해결 항목

| 항목 | 현황 | 비고 |
|---|---|---|
| board_all COUNT(*) | 분석 완료, 미적용 | Slice 전환 또는 COUNT 캐싱 |
| my_books p95 | 240VU 한계 | 캐시 없이는 pool 포화 불가피 |
| write_complete p95 | 300ms 초과 지속 | pool 경합 근본 해결 필요 |
| Phase 4 SSE | 미구현 | poll → SSE 전환 시 Redis Pub/Sub 기반으로 연결 가능 |
| completeBook BIP 미갱신 | 미수정 | Book DB 저장 후 BIP status COMPLETED 미반영 |
| 페이지 전체 재작성 | 미수정 | save() 시 deleteAll + reinsert, addPageTo() 미사용 |
