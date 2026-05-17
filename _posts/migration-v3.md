# LittleWriter v3 마이그레이션 계획

> **목적**: LLM 호출 파이프라인의 안정성 확보, 사용자 경험 개선, Scale-out 대응, 멀티 프로바이더 LLM Gateway 전환
> **기반 문서**: `lock-network-io-performance-analysis.md`, `vt.md`, `performance.md`
> **작성일**: 2026-03-27 | **최종 수정**: 2026-04-08

---

## 0. 인프라 기준값 (부하 테스트 확정)

> `vt.md` 참고. 모든 Phase의 커넥션/스레드 설정 기준.

### 0.1 HikariCP Pool

```
RDS max connections: 60
메인 앱 pool:        50  ← 확정 (부하 테스트 기반)
버퍼:               10  (관리/모니터링/Lambda 비상용)
```

Lambda는 Redis에만 쓰고 RDS 직접 접근 금지. Lambda → RDS 직접 접근 시 커넥션 제어 불가.

### 0.2 포화점

| VU | req/s | CPU avg | 상태 |
|------|------|------|------|
| 100 | 653 | 69.2% | 안정 |
| 120 | 993 | 84.7% | 안정 |
| 140 | **1,059** | 85.8% | **포화점** |
| 160 | 663 ↓ | ~100% | 과부하 |

- **현재 최적 설정**: no-VT + Connector 9.2.0 + pool 50

### 0.3 Virtual Thread 전략

| Phase | VT 설정 | 이유 |
|------|------|------|
| Phase 1~3 | **no-VT** | 100~140 VU = platform thread로 충분. VT pinning 오버헤드만 추가 |
| Phase 4 (SSE) | **VT 도입** | SSE 연결 수백 개 = 스레드 수백 개 점유 → VT가 진가 발휘하는 구간 |

JDBC + no-VT가 현재 환경에서 최적. R2DBC 전환 없이 VT 도입 시 `ReadAheadInputStream` synchronized pinning 지속.

---

## 1. 현재 상태 요약 및 문제점

### 1.1 핵심 문제

| # | 문제 | 영향 |
|---|------|------|
| P1 | Redis Lock을 LLM 호출 동안(최대 30초) 보유 | HTTP 커넥션 블로킹, 클라이언트 타임아웃 |
| P2 | Lock TTL(120초) 초과 시 동시 처리 가능 | 데이터 덮어쓰기, 페이지 중복 |
| P3 | Lock 해제 로직 non-atomic (GET → DEL) | Race condition 발생 가능 |
| P4 | completeBook: DB 커밋 후 Redis 업데이트 실패 | DB/Redis 상태 불일치 |
| P5 | 이미지 업로드 이벤트 실패 시 복구 없음 | 이미지 영구 손실 가능 |
| P6 | LLM 재시도 시 멱등성 없음 | 페이지 중복 생성 |
| P7 | Scale-out 시 실시간 알림 라우팅 불가 | 멀티 인스턴스 환경에서 클라이언트 알림 불가 |
| P8 | LLM 호출이 OpenAI 단일 프로바이더에 하드코딩 | 장애 시 전체 서비스 중단, 프로바이더 교체 불가 |
| P9 | `handle()`에 클래스 레벨 `@Transactional` 적용 | S3 작업에 불필요한 커넥션 점유 위험 |
| P10 | `transaction-event` 스레드 풀(max 40) vs HikariCP 불균형 | 부하 시 커넥션 풀 고갈 → 데드락 가능 |

### 1.2 근본 원인

`BookInProgress`에는 지켜져야 할 불변식이 있다:

```
"같은 책에 대해 한 번에 하나의 페이지만 생성되어야 한다"
```

현재 이 불변식 보호 책임이 **Redis Lock(인프라)** 에 위임되어 있다.

```
v2: 불변식 = Redis Lock이 보호  → Lock 실패 = 불변식 위반 가능

v3: 불변식 = Redis Lock 유지 (generateWithAi) → 동시 요청 시 userInput이 달라질 수 있어 race condition은 허용 불가
    SQS FIFO MessageDeduplicationId           → 처리 중복 하드 보장 (2차 방어)
    PENDING 상태                               → 순차 중복 요청 즉시 차단 (409)
    Redis                                      → 캐시/신호 역할로 격리
```
> Lock 제거 검토 내용 및 결정 이유: `docs/lock.md` 참고

---

## 2. v3 목표 아키텍처

### 2.1 전체 구조

```
                         ┌─────────────────────────────────────┐
                         │           Client                     │
                         └────┬──────────────┬─────────────────┘
                              │ POST          │ 폴링 (Phase 3) / SSE (Phase 4)
                              ▼              ▼
                    ┌─────────────────────────────────────┐
                    │         Spring Boot API              │
                    │  - REST endpoint (즉시 202 반환)     │
                    │  - GET 폴링 endpoint (상태 조회)      │
                    │  - SSE endpoint [Phase 4 선택]       │
                    └──────┬──────────────────────────────┘
                           │ SQS Publish
                           ▼
                    ┌──────────────────┐
                    │   SQS FIFO Queue │  MessageGroupId = bipId
                    │  (MessageDedup)  │  MessageDeduplicationId = bipId+pageIdx
                    └──────┬───────────┘
                           │
                           ▼
                    ┌──────────────────────────────────┐
                    │  Java Lambda Consumer             │
                    │  - 멱등성 검증                    │
                    │  - LLMGateway.chatWithFallback()  │
                    │  - 이미지 업로드                  │
                    │  - Redis 결과 저장 (key-value)    │  ← Phase 3 폴링
                    │  - Redis PUBLISH                  │  ← Phase 4 SSE
                    └──────┬───────────────────────────┘
                           │
                    ┌──────▼──────────────────────────┐
                    │  LLM Gateway                    │
                    │  OpenAiLLMProvider (primary)    │
                    │  ClaudeLLMProvider  (fallback)  │
                    └─────────────────────────────────┘
                           │
                    ┌──────▼────────────────────────────┐
                    │      Redis t3.micro               │
                    │  key-value: bip:result:{bipId}    │  ← 폴링용 (TTL 10분)
                    │  Pub/Sub: bip:result:{bipId}      │  ← SSE용 (Phase 4)
                    │  idempotency:{messageId}          │
                    └───────────────────────────────────┘
```

> Redis 커넥션: max 10,000 → Lambda 수백 동시 실행도 문제 없음

### 2.2 BookInProgress 상태 머신

```
현재:  IN_PROGRESS ──────────────────────────────▶ COMPLETED

v3:    IN_PROGRESS ──[SQS 발행, 메인 앱]──▶ PENDING
                                                │
                                                │ Lambda → Redis SET bip:result:{bipId}
                                                │ (Lambda는 DB 접근 없음)
                                                │
                                                │ Client 폴링 → 메인 앱 Redis 확인
                                                │ → 결과 있음 → DB 페이지 추가
                                                ▼
                                        IN_PROGRESS (페이지 추가됨)
                                                │
                                                │ completeBook (메인 앱)
                                                ▼
                                            COMPLETED
```

`PENDING` 상태는 이미 도메인에 존재하므로 모델 변경 없음.

### 2.3 완료 감지 방식

**Phase 3 (1단계): 폴링**

```
Lambda → Redis SET bip:result:{bipId} {result} EX 600
Client → GET /api/v1/book/progress/{id}/status (2~3초 간격)
App    → Redis GET bip:result:{bipId}
         없음 → { status: "PENDING" }
         있음 → DB 저장, Redis DEL → { status: "COMPLETED", ... }
```

**Phase 4 (2단계): SSE + Redis Pub/Sub [선택]**

```
Lambda → Redis SET (위와 동일) + Redis PUBLISH bip:result:{bipId}
App    → Redis 채널 구독 → SSE emitter.send()
Client → SSE 이벤트 수신 (폴링 불필요)
```

Phase 4 전환 시 Lambda 재배포 불필요. `NoOpBookProgressNotifier` → `SseBookProgressNotifier` Bean 교체만으로 활성화.

### 2.4 LLM Gateway 설계

```java
public interface LLMProvider {
    LLMResponse chat(LLMRequest request);
    String name();
}

@Component
public class LLMGateway {
    public LLMResponse chatWithFallback(LLMRequest request, List<String> fallbackChain) {
        for (String name : fallbackChain) {
            try { return providers.get(name).chat(request); }
            catch (Exception e) { /* 다음 프로바이더로 */ }
        }
        throw new LLMGatewayException("All providers failed");
    }
}
```

### 2.5 멱등성 설계

```
idempotency:{messageId}:
  NOT EXISTS  → 최초 처리
  "IN_FLIGHT" → Lambda 진입 후 LLM 호출 직전 마킹 (TTL 5분)
  {llmResult} → LLM 완료, 저장 전 크래시 대비 캐싱 (TTL 1시간)
  "DONE"      → 완전히 처리됨 (TTL 24시간)
```

---

## 3. 마이그레이션 단계

### Phase 1: 즉시 안정성 수정 (P3, P4, P5, P9, P10)

> 독립 적용 가능. SQS/Lambda 불필요.

#### 1-1. Lock 해제 atomic 처리 (P3)

`RedisLockManager.releaseLock()` GET → DEL 패턴을 Lua script로 교체.

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end
```

#### 1-2. completeBook DB/Redis 정합성 (P4)

```java
@Transactional
public void completeBook(String bipId) {
    bookRepository.save(completed);
    eventPublisher.publishEvent(new BookCompletedEvent(bipId));
}

@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onBookCompleted(BookCompletedEvent event) {
    try {
        redis.markAsCompleted(event.getBipId());
    } catch (Exception e) {
        log.warn("Redis sync failed for {}, will recover on next read", event.getBipId());
    }
}
```

#### 1-3. 이미지 업로드 이벤트 재시도 (P5) → Phase 3으로 이관

> Lambda가 이미지 업로드를 직접 담당(S3 deterministic key)하므로 `temp/ → book/` 복사 단계 자체가 제거됨.
> `ImageUploadEventHandler` 삭제는 Phase 3에서 수행. P5 재시도 스케줄러는 불필요.

#### 1-4. `handle()` 불필요한 트랜잭션 제거 (P9, P10) ✅ 완료

`BookRepositoryAdapter`(클래스 레벨 `@Transactional`)에서 S3 이벤트 핸들러 분리.

```java
// 완료: storage/src/main/java/com/pkg/s3/ImageUploadEventHandler.java
@Component
public class ImageUploadEventHandler {
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Async(value = "transaction-event")
    public void handle(ImageUploadEvent event) {
        for (PreAssignedUrl url : event.jobs()) {
            imageUploader.copyToBookStorage(url);
        }
    }
}
```

**`transaction-event` 스레드 풀:**

Phase 3에서 `ImageUploadEventHandler` 자체가 제거되므로 이 스레드 풀 설정도 함께 삭제.

#### 1-5. HikariCP 명시적 설정 (P10) ✅ 완료

```yaml
# storage.yml (load-test, prod 프로파일) ← 완료
storage:
  datasource:
    maximum-pool-size: 50
    minimum-idle: 10
    connection-timeout: 30000
```

---

### Phase 2: LLM Gateway 구현 (P8) ✅ 불필요 (결정 변경)

> Lambda를 Python으로 결정함에 따라 Java LLM Gateway 불필요.
> Python Lambda에서 OpenAI API 직접 호출. Mock 단계에서는 sleep + 고정 응답으로 대체.

---

### Phase 3: 비동기 LLM 처리 (P1, P2, P6)

> 인프라 완료. 애플리케이션 코드 작업 진행 중.
> **범위**: `initBook` + `generateWithAi` 모두 비동기 전환 (Q1 결정 변경 - 둘 다 LLM 호출 존재).

#### 3-1. SQS FIFO 큐 설정 ✅ 완료

```
Queue: littlewriter-bip-generation.fifo  ✅ 생성 완료
MessageGroupId: {bipId}
MessageDeduplicationId: {bipId}-{pageIndex}
Visibility Timeout: 300초
DLQ: littlewriter-bip-dlq.fifo (3회 실패 시 이동)  ✅ 생성 완료
```

#### 3-2. API 변경

```
현재: POST /{id}  → Lock 획득 → LLM 호출(30초) → 응답
v3:   POST /{id}  → status = PENDING (DB 저장) → SQS 발행 → 202 즉시 반환 (bipId)

GET  /{id}/status → Redis 조회 → PENDING / COMPLETED
```

#### 3-3. Lambda 처리 흐름

> **원칙**: Lambda는 Redis와 S3에만 쓴다. RDS 직접 접근 금지.
> DB 저장 책임은 메인 앱 폴링 엔드포인트(3-4)가 담당.

```
1. SQS 메시지 수신 (bipId, pageIndex, userInput, characterInfo, backgroundInfo, messageId)
2. idempotency:{messageId} 확인
     "DONE"      → ack 종료 (중복 메시지)
     {llmResult} → step 7로 점프 (LLM 완료 후 crash 재처리)
     "IN_FLIGHT" → ack 종료 (동일 메시지 병렬 수신, FIFO로 거의 불발)
3. SET idempotency:{messageId} "IN_FLIGHT" NX EX 300
     실패(이미 존재) → ack 종료
4. LLMGateway.chatWithFallback(["openai", "claude"])
5. SET idempotency:{messageId} {llmResult} EX 3600  ← crash 대비 캐시
6. 이미지 업로드 (S3 deterministic key: bip/{bipId}/page-{pageIndex}.png)
7. SET idempotency:{messageId} "DONE" EX 86400
8. Redis SET bip:result:{bipId} (아래 스키마) EX 600  ← 폴링용
9. Redis PUBLISH bip:result:{bipId} {result}           ← Phase 4 SSE 준비 (항상 수행)
10. SQS ack
```

**Redis 결과 스키마** (`bip:result:{bipId}` 값):
```json
{
  "pageIndex": 2,
  "context": "...",
  "imageUrl": "https://s3.../bip/{bipId}/page-2.png",
  "questions": ["질문1", "질문2", "질문3"]
}
```

**메인 앱 → SQS 메시지 페이로드**:
```json
{
  "bipId": "abc123",
  "pageIndex": 2,
  "userInput": "...",
  "characterName": "...",
  "characterDescription": "...",
  "backgroundInfo": "..."
}
```
MessageDeduplicationId = `{bipId}-{pageIndex}`  
MessageGroupId = `{bipId}`

#### 3-4. 폴링 엔드포인트

```
GET /api/v1/book/progress/{id}/status
  → Redis GET bip:result:{id}
  → 없음:
      { status: "PENDING" }
  → 있음 (Lambda 완료):
      BookInProgress.addPage(pageIndex, context, imageUrl)  ← DB 저장
      BookInProgress.status = IN_PROGRESS                   ← PENDING → IN_PROGRESS 전환
      Redis DEL bip:result:{id}
      { status: "COMPLETED", page: { context, imageUrl, questions } }
```

> 응답의 `"COMPLETED"`는 페이지 생성 완료(BookInProgress.Status.IN_PROGRESS)를 의미.
> 책 완성(BookInProgress.Status.COMPLETED)과 구분 주의.

**멱등성**: 클라이언트가 폴링 중 중복 요청해도 안전해야 함.
`bip:result` DEL 이전에 DB 저장이 완료되지 않으면 중복 저장 위험.
→ DB 저장 성공 후 DEL. 실패 시 Redis 키 유지 → 다음 폴링에서 재시도.

#### 3-5. Redis Lock 처리

| 현재 Lock | v3 결정 | 이유 |
|-----------|---------|------|
| generateWithAi Lock | **유지** | race condition 시 userInput이 달라질 수 있음. SQS dedup은 처리 중복만 방지하고 호출자에게 알리지 않음 |
| completeBook Lock | 별도 검토 | 동시 완성 요청 시 Book 중복 생성 위험 |

> 상세 분석: `docs/lock.md` 참고

#### 3-6. ImageUploadEventHandler 제거 (P5)

Lambda가 이미지 업로드를 직접 담당하므로 `ImageUploadEventHandler`, `ImageUploadEvent`, `transaction-event` 스레드 풀 설정 전부 삭제.

```
제거 대상:
- ImageUploadEventHandler.java
- ImageUploadEvent.java (발행 지점 포함)
- AsyncConfig의 transaction-event 스레드 풀 Bean
```

---

### Phase 4: SSE 실시간 알림 [선택] (P7)

> Phase 3 완료 후 독립 추가 가능. Lambda 재배포 불필요.
> **이 시점에 VT 도입**: SSE 연결 수백 개 = 스레드 수백 개 점유 문제 → VT로 해결.

```java
// Bean 교체만으로 활성화
@Component
@ConditionalOnProperty("feature.sse.enabled")
public class SseBookProgressNotifier implements BookProgressNotifier {
    public void notify(String bipId, BookProgressResult result) {
        registry.findEmitter(bipId).ifPresent(e -> e.send(result));
    }
}
```

멀티 인스턴스 라우팅: Lambda → Redis PUBLISH → 모든 인스턴스 구독 → 해당 emitter 있는 인스턴스가 push.

---

## 4. 컴포넌트별 변경 범위

| 컴포넌트 | Phase | 변경 내용 |
|----------|-------|---------|
| `ImageUploadEventHandler` (신규) ✅ | 1 | S3 핸들러 분리, `@Transactional` 제거 |
| `RedisLockManager` ✅ | 1 | `releaseLock` Lua script 적용 |
| `BookRepositoryAdapter` ✅ | 1 | `handle()` 제거 |
| `HikariCP` ✅ | 1 | pool 50 명시적 설정 (load-test, prod) |
| ~~`LLMProvider` / `LLMGateway`~~ | ~~2~~ | Python Lambda 전환으로 불필요 |
| `BookInProgressRedisEntity.Status` | 3 | PENDING 추가 |
| `BookProgressController` | 3 | 202 반환, 폴링 엔드포인트 추가 |
| `BookProgressService` | 3 | SQS 발행, PENDING 처리, Lock 유지 (generateWithAi) |
| SQS 클라이언트 Bean | 3 | application.yml + SQS config 추가 |
| Python Lambda ✅ | 3 | lambda/handler.py (멱등성, Mock LLM, Redis 저장) |
| `ImageUploadEventHandler` | 3 | Lambda 이미지 위임으로 삭제 |
| `ImageUploadEvent` | 3 | 발행 지점 포함 삭제 |
| `transaction-event` 스레드 풀 | 3 | 핸들러 삭제와 함께 제거 |
| `SseBookProgressNotifier` (신규) | 4 | Redis Pub/Sub → SSE push |
| VT 활성화 | 4 | SSE 연결 급증 시점에 도입 |

---

## 5. 적용 순서 및 우선순위

```
Phase 1 (즉시, 독립 적용)
  ├─ ✅ handle() @Transactional 분리 (P9, P10)
  ├─ ✅ HikariCP pool 50 (load-test, prod)
  ├─ ✅ Lock 해제 atomic (P3)
  └─ completeBook 정합성 (P4)
  (P5 이미지 재시도 → Phase 3에서 핸들러 삭제로 대체)

Phase 2 → 불필요 (Python Lambda 전환)

Phase 3 (진행 중)
  ├─ ✅ SQS FIFO + DLQ 생성
  ├─ ✅ Python Lambda 핸들러 (lambda/handler.py)
  ├─ ✅ Lambda 인프라 (IAM, S3 아티팩트, Event Source Mapping)
  ├─ BookInProgressRedisEntity.Status PENDING 추가
  ├─ BookProgressService SQS 발행 + PENDING 전환
  ├─ BookProgressController 202 반환 + 폴링 엔드포인트
  ├─ SQS 클라이언트 Bean 구성
  └─ ImageUploadEventHandler / ImageUploadEvent / transaction-event 풀 삭제 (P5)

Phase 4 [선택, 언제든 독립 추가]
  └─ SSE + VT 도입 (P7)
```

---

## 6. 미결 판단 사항

| # | 질문 | 현재 결정 |
|---|------|---------|
| Q1 | initBook 비동기 처리 여부 | **비동기 전환** (LLM 호출 존재 확인, generateWithAi와 동일 처리) |
| Q2 | Lambda DLQ 도착 시 처리 | LLM Gateway 폴백으로 빈도 감소. 도달 시 운영자 알림 + 수동 재처리 |
| Q3 | idempotency key 저장소 | Redis (현재 인프라 재사용) |
| Q4 | 폴링 vs SSE | Phase 3: 폴링, Phase 4: SSE [선택] |
| Q5 | completeBook 동기 유지 | 유지 (60ms, 부하 테스트 확인됨) |
| Q6 | LLM 폴백 우선순위 | Python Lambda에서 직접 처리. Mock 단계에서는 불필요 |
| Q7 | VT 도입 시점 | Phase 4 SSE 도입 시 함께 적용 |
| Q8 | Redis 내구성 | Lambda 쓰기 후 빠른 소비로 위험 최소화. TTL 10분 필수 |
