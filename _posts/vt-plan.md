# Virtual Thread 도입 계획

## 기본 방침

`spring.threads.virtual.enabled=true` (전역 설정)은 JDBC pinning 문제로 보류.  
대신 VT가 실제로 유리한 엔드포인트에만 **전용 VT executor**를 선택적으로 적용한다.

---

## Phase 1 — VT Executor 분리 (즉시 적용 가능)

### 구현

```java
@Configuration
public class ThreadPoolConfig {

    // JDBC 없는 I/O 전용 VT executor
    @Bean("vtExecutor")
    public Executor vtExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }
}
```

Tomcat은 플랫폼 스레드 유지 → JDBC 엔드포인트 pinning 없음.  
VT executor는 Redis·SQS 등 non-blocking I/O에만 사용.

---

## Phase 2 — Polling 엔드포인트 VT 적용

polling은 Redis 조회만 수행 (Lettuce Netty 기반, synchronized 없음) → VT 최적 사례.  
`DeferredResult`로 Tomcat 스레드를 즉시 해제하고 VT에서 Redis 조회 실행.

### 대상 엔드포인트

| 엔드포인트 | 현재 | 변경 후 |
|-----------|------|--------|
| `GET /api/v1/book/progress/{bipId}/status` | 플랫폼 스레드 | VT executor |
| `GET /api/v1/character/{cipId}/status` | 플랫폼 스레드 | VT executor |

### 구현 패턴

```java
@GetMapping("/{bipId}/status")
public DeferredResult<ApiResponse<BookProgressStatusResponse>> pollStatus(
        @PathVariable String bipId,
        @Authenticated Actor currentUser) {

    DeferredResult<ApiResponse<BookProgressStatusResponse>> result = new DeferredResult<>(5000L);
    CompletableFuture
        .supplyAsync(() -> bookProgressService.pollStatus(currentUser, bipId), vtExecutor)
        .thenAccept(r -> result.setResult(ApiResponse.success(r)))
        .exceptionally(e -> { result.setErrorResult(e); return null; });
    return result;
}
```

**기대 효과**
- 동시 polling 요청 수백 개를 VT로 수용 (Tomcat 스레드 소비 없음)
- `write_poll_count` 감소 (VT on 시 avg 70 → 6.4 확인됨)

---

## Phase 3 — SSE 도입 (polling 대체)

현재 클라이언트가 100ms 간격으로 polling하는 구조를 **서버 푸시(SSE)** 로 전환한다.  
SSE는 장기 연결이고 JDBC가 없어 VT에 최적이다.

### 아키텍처

```
Lambda 완료
  → Redis Pub/Sub에 완료 이벤트 발행
  → App의 Redis Subscriber가 수신
  → 해당 bipId를 구독 중인 SseEmitter에 이벤트 전송
  → 클라이언트 연결 종료
```

### 구현 스케치

```java
// SSE 연결 (VT executor로 오프로드)
@GetMapping(value = "/{bipId}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter streamStatus(@PathVariable String bipId) {
    SseEmitter emitter = new SseEmitter(30_000L); // 30초 timeout
    vtExecutor.execute(() -> sseService.subscribe(bipId, emitter));
    return emitter;
}

// Redis Pub/Sub 수신 → SseEmitter push
@Component
public class BookCompletionSubscriber {
    public void onMessage(String bipId) {
        SseEmitter emitter = emitterRegistry.get(bipId);
        if (emitter != null) {
            emitter.send(SseEmitter.event().name("COMPLETED").data(bipId));
            emitter.complete();
        }
    }
}
```

**기대 효과**

| | 현재 (polling) | SSE 도입 후 |
|--|--------------|------------|
| 클라이언트 요청 수 | 완료까지 평균 70회 | **1회** (연결 후 대기) |
| 서버 부하 | polling 요청 지속 발생 | 연결 유지만 (VT로 경량화) |
| 응답 지연 | polling 간격(100ms) 지연 | 완료 즉시 전달 |

---

## Phase 4 — 전역 VT 전환 조건

아래 조건 충족 시 `spring.threads.virtual.enabled=true`로 전환한다.

| 조건 | 확인 방법 |
|------|---------|
| MySQL Connector/J `ReadAheadInputStream` synchronized 제거 | 릴리즈 노트 확인 + `tracePinnedThreads` 0건 확인 |
| 또는 R2DBC 전환 완료 | JDBC 완전 제거 |

전환 후 `-Djdk.tracePinnedThreads=full`로 pinning 이벤트 0건 검증 필수.

---

## 요약

```
현재         → Tomcat: 플랫폼 스레드 (JDBC 보호)
Phase 1~2   → polling: VT executor + DeferredResult
Phase 3     → SSE: VT + Redis Pub/Sub (polling 완전 대체)
Phase 4     → JDBC pinning 해결 후 전역 VT 전환
```
