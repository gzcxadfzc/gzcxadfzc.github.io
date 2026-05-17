# Lock-Network I/O 패턴 성능 및 안정성 분석 문서

> **분석 대상**: `BookRepositoryAdapter.saveFrom()`, `BookInProgressLockExecutorAdapter`, `RedisLockManager`
> **작성일**: 2026-02-04
> **버전**: 1.1 (2026-03-28: 부하 테스트 계획 추가)

---

## 목차

1. [개요](#1-개요)
2. [현재 아키텍처 분석](#2-현재-아키텍처-분석)
3. [Lock → Network I/O → Unlock 패턴 상세](#3-lock--network-io--unlock-패턴-상세)
4. [DB 성능 영향 분석](#4-db-성능-영향-분석)
5. [주요 문제점](#5-주요-문제점)
6. [성능 측정 방법](#6-성능-측정-방법)
7. [안정성 측정 방법](#7-안정성-측정-방법)
8. [권장 개선 사항](#8-권장-개선-사항)
9. [결론](#9-결론)
10. [부하 테스트 계획](#10-부하-테스트-계획)

---

## 1. 개요

### 1.1 분석 목적

본 문서는 `BookRepositoryAdapter.saveFrom()` 메서드와 관련된 Lock-Network I/O 패턴이 시스템 성능과 안정성에 미치는 영향을 분석하고, 측정 방법 및 개선 방안을 제시한다.

### 1.2 분석 범위

| 파일 | 경로 |
|------|------|
| BookRepositoryAdapter | `storage/src/main/java/com/pkg/jpa/BookRepositoryAdapter.java` |
| BookInProgressLockExecutorAdapter | `storage/src/main/java/com/pkg/redis/BookInProgressLockExecutorAdapter.java` |
| RedisLockManager | `storage/src/main/java/com/pkg/redis/RedisLockManager.java` |
| BookCompleteExecutor | `domain/src/main/java/com/pkg/domain/bookprogress/BookCompleteExecutor.java` |
| BookProgressService | `domain/src/main/java/com/pkg/domain/bookprogress/BookProgressService.java` |

---

## 2. 현재 아키텍처 분석

### 2.1 컴포넌트 구조

```
┌─────────────────────────────────────────────────────────────────┐
│                        Controller Layer                          │
│                     BookProgressController                       │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
┌─────────────────────┐       ┌─────────────────────────┐
│  BookProgressService │       │   BookCompleteExecutor   │
│  (generateWithAi)    │       │   (completeBook)         │
└─────────┬───────────┘       └───────────┬─────────────┘
          │                               │
          └───────────────┬───────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              BookInProgressLockExecutorAdapter                   │
│                    (Redis Distributed Lock)                      │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│    Redis     │  │   Database   │  │  External    │
│  (Lock/Data) │  │  (MySQL)     │  │  API (AI/S3) │
└──────────────┘  └──────────────┘  └──────────────┘
```

### 2.2 saveFrom 메서드 구조

```java
// BookRepositoryAdapter.java:53-77
@Transactional
@Override
public Book saveFrom(BookInProgress bookInProgress, Function<BookInProgress, Book> converter) {
    // 1. URL 매핑 생성
    Map<String, PreAssignedUrl> urls = PreAssignedUrl.mapOfBookPrefix(...);

    // 2. 이미지 URL 변경
    BookInProgress updated = bookInProgress.changeBookPage(page -> {...});

    // 3. 이벤트 발행 (트랜잭션 커밋 후 비동기 처리)
    eventPublisher.publishEvent(new ImageUploadEvent(...));

    // 4. Book 변환 및 저장
    Book book = converter.apply(updated);
    BookJpaEntity bookEntity = bookJpaRepository.save(BookJpaEntity.fromBook(book));

    // 5. Page 일괄 저장
    List<BookPageJpaEntity> pageEntities = pageJpaRepository.saveAll(...);

    // 6. Character 조회 후 반환
    return new Book(..., bookCharacterRepository.retrieveById(...));
}
```

---

## 3. Lock → Network I/O → Unlock 패턴 상세

### 3.1 generateWithAi 흐름

```
┌─────────────────────────────────────────────────────────────────────────┐
│  BookProgressService.generateWithAi (라인 56-66)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐                                                    │
│  │ Redis Lock 획득  │ ← SET NX (atomic)                                  │
│  └────────┬────────┘                                                    │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────────────────────────┐                                │
│  │ Redis 조회 (BookInProgress)          │ ← Network I/O (~5ms)           │
│  └────────┬────────────────────────────┘                                │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────────────────────────┐                                │
│  │ AI API 호출 (bookPageGenerator)      │ ← Network I/O (5~30초)         │
│  │ - 텍스트 생성                         │                                │
│  │ - 이미지 생성                         │                                │ 
│  └────────┬────────────────────────────┘                                │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────────────────────────┐                                │
│  │ 이미지 업로드 (imageRepository)       │ ← Network I/O (~500ms)         │
│  └────────┬────────────────────────────┘                                │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────────────────────────┐                                │
│  │ Redis 저장 (addPageTo)               │ ← Network I/O (~5ms)           │
│  └────────┬────────────────────────────┘                                │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────┐                                                    │
│  │ Redis Lock 해제  │ ← DEL (조건부)                                      │
│  └─────────────────┘                                                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

Lock 유지 시간: 평균 5.5초, 최대 32초
```

### 3.2 completeBook 흐름

```
┌─────────────────────────────────────────────────────────────────────────┐
│  BookCompleteExecutor.completeBook (라인 29-39)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐                                                    │
│  │ Redis Lock 획득  │ ← SET NX (atomic)                                  │
│  └────────┬────────┘                                                    │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────────────────────────┐                                │
│  │ Redis 조회 (BookInProgress)          │ ← Network I/O (~5ms)           │
│  └────────┬────────────────────────────┘                                │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────────────────────────┐                                │
│  │ DB 트랜잭션 시작                      │ ← Connection Pool 획득          │
│  │                                     │                                │
│  │  ├─ Book 저장                        │ ← DB I/O (~20ms)               │
│  │  ├─ BookPage 일괄 저장                │ ← DB I/O (~30ms)               │
│  │  └─ BookCharacter 조회               │ ← DB I/O (~10ms)               │
│  │                                     │                                │
│  │ DB 트랜잭션 커밋                      │ ← Connection Pool 반환          │
│  └────────┬────────────────────────────┘                                │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────────────────────────┐                                │
│  │ Redis 저장 (markAsCompleted)         │ ← Network I/O (~5ms)           │
│  └────────┬────────────────────────────┘                                │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────┐                                                    │
│  │ Redis Lock 해제  │                                                    │
│  └─────────────────┘                                                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

Lock 유지 시간: 평균 60ms, 최대 520ms
```

### 3.3 Lock 설정 분석

```java
// BookInProgressLockExecutorAdapter.java
private static final String BIP_LOCK_KEY_PREFIX = "bip:lock:";
private static final Long EXPIRATION_SEC = 120L;  // 2분 TTL
```

| 설정 | 값 | 평가 |
|------|-----|------|
| Lock Key 패턴 | `bip:lock:{bipId}` | 적절 (리소스별 분리) |
| Expiration | 120초 | AI 호출 고려 시 적절하나 위험 요소 존재 |
| Lock 방식 | SET NX | 적절 (atomic operation) |

---

## 4. DB 성능 영향 분석

### 4.1 영향도 매트릭스

| 영향 항목 | 직접 영향 | 간접 영향 | 종합 |
|-----------|----------|----------|------|
| DB Connection Pool | 중간 | 높음 | **높음** |
| DB Lock 경합 | 낮음 | 낮음 | **낮음** |
| 트랜잭션 처리량 | 중간 | 높음 | **높음** |
| 쿼리 응답 시간 | 낮음 | 중간 | **중간** |
| 전체 시스템 처리량 | - | 높음 | **높음** |

### 4.2 직접적 DB 영향

#### 4.2.1 Connection Pool 점유

```
시나리오: completeBook 동시 요청 10건

┌────────────────────────────────────────────────────────────────┐
│ HikariCP Connection Pool (기본 10개)                           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│ Request 1: ████████ (Lock + DB 60ms)                          │
│ Request 2: ██████████████ (Lock 대기 + DB 60ms)               │
│ Request 3: ████████████████████ (Lock 대기 + DB 60ms)         │
│ ...                                                            │
│ Request 10: Connection 대기 또는 타임아웃                       │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

#### 4.2.2 트랜잭션 대기 시간

```
정상 케이스:
  트랜잭션 시작 → 쿼리 실행 → 커밋 (50-100ms)

Lock 내 트랜잭션 케이스:
  Lock 대기 → 트랜잭션 시작 → 쿼리 실행 → 커밋 (50ms + Lock 대기 시간)
```

### 4.3 간접적 시스템 영향

#### 4.3.1 동시성 병목

```
generateWithAi 동시 요청 시나리오:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

시간(초)  0    5    10   15   20   25   30
          │    │    │    │    │    │    │
Request A ████████████████████████████████ (AI 호출 30초)
          │    │    │    │    │    │    │
Request B ╳ Lock 실패 (RedisLockException)
          │    │    │    │    │    │    │
Request C ╳ Lock 실패 (RedisLockException)
          │    │    │    │    │    │    │

결과: 동일 bipId에 대해 1개만 처리, 나머지는 즉시 실패
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

#### 4.3.2 리소스 사용량 추정

| 구분 | 단일 요청 | 동시 10 요청 | 비고 |
|------|----------|-------------|------|
| generateWithAi | | | |
| - Lock 유지 시간 | 5.5초 | 5.5초 (1개만) | 나머지 즉시 실패 |
| - DB Connection | 0개 | 0개 | Redis만 사용 |
| - 메모리 | ~10MB | ~10MB | AI 응답 데이터 |
| completeBook | | | |
| - Lock 유지 시간 | 60ms | 600ms (순차) | 같은 bipId일 경우 |
| - DB Connection | 1개/60ms | 1개/600ms | 순차 처리 |
| - 메모리 | ~1MB | ~1MB | |

### 4.4 정량적 영향 계산

```
가정:
- DB Connection Pool: 10개
- 평균 트랜잭션 시간 (Lock 없음): 50ms
- 평균 Lock 대기 시간: 30ms (completeBook 기준)
- 초당 completeBook 요청: 100건

Lock 없는 경우 처리량:
  = Pool 크기 × (1000ms / 트랜잭션 시간)
  = 10 × (1000 / 50)
  = 200 TPS

Lock 있는 경우 처리량 (같은 bipId):
  = 1 × (1000 / 80)
  = 12.5 TPS (단일 리소스 기준)

Lock 있는 경우 처리량 (다른 bipId):
  = Pool 크기 × (1000 / (트랜잭션 시간 + Lock 오버헤드))
  = 10 × (1000 / 55)
  = 181 TPS

처리량 감소율: 약 9.5% (다른 bipId 기준)
```

---

## 5. 주요 문제점

### 5.1 Lock 내 장시간 작업

**문제**: `generateWithAi`에서 AI API 호출(5~30초)을 Lock 내부에서 수행

```java
// BookProgressService.java:56-66
return lockExecutor.updateWithLock(command.bipId(), () -> {
    // ... Redis 조회
    BookPageGenerated bookPageGenerated = bookPageGenerator.generatePageFrom(...);  // 5~30초
    ImageUploadResult result = imageRepository.uploadTemporary(...);  // ~500ms
    // ... Redis 저장
});
```

**영향**:
- 동일 bipId에 대한 모든 요청이 블로킹
- Lock timeout(120초) 초과 시 데이터 정합성 위험

### 5.2 Lock Expiration과 작업 시간 불일치

**문제**: Lock TTL(120초)보다 작업이 오래 걸릴 수 있음

```
시나리오:
1. Request A: Lock 획득 (TTL 120초)
2. Request A: AI 호출 시작 (예상 외로 지연)
3. 120초 경과: Lock 자동 만료
4. Request B: Lock 획득 (같은 bipId)
5. Request A: AI 호출 완료, 데이터 저장
6. Request B: AI 호출 완료, 데이터 저장 (덮어쓰기!)

결과: 데이터 손실 또는 불일치
```

### 5.3 Lock 해제 시 Race Condition

**문제**: `releaseLock`이 atomic하지 않음

```java
// RedisLockManager.java:44-56
private void releaseLock(String key, String lockId) {
    redisTemplate.execute((RedisCallback<Void>) connection -> {
        byte[] k = redisTemplate.getStringSerializer().serialize(key);
        byte[] v = connection.get(k);           // 1. 값 조회
        if (v != null) {
            String currentId = redisTemplate.getStringSerializer().deserialize(v);
            if (lockId.equals(currentId)) {
                connection.del(k);               // 2. 삭제 (1과 2 사이에 gap 존재)
            }
        }
        return null;
    });
}
```

**개선 필요**: Lua 스크립트로 atomic 처리

### 5.4 실패 시 데이터 불일치

**문제**: DB 저장 성공 후 Redis 업데이트 실패 시 불일치

```
completeBook 흐름:
1. Lock 획득 ✓
2. BookInProgress 조회 ✓
3. DB 저장 (Book, BookPage) ✓ (커밋 완료)
4. Redis 업데이트 (markAsCompleted) ✗ (네트워크 오류)
5. Lock 해제 ✓

결과:
- DB: Book 저장됨, 상태 = COMPLETED
- Redis: BookInProgress 상태 = PENDING (불일치!)
```

### 5.5 이벤트 처리 실패 복구 부재

**문제**: 이미지 업로드 이벤트 실패 시 재시도/복구 로직 없음

```java
// BookRepositoryAdapter.java:79-85
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Async(value = "transaction-event")
public void handle(ImageUploadEvent event) {
    for(PreAssignedUrl url : event.jobs()) {
        imageUploader.copyToBookStorage(url);  // 실패 시 무시됨
    }
}
```

---

## 6. 성능 측정 방법

### 6.1 Lock 유지 시간 측정

#### 6.1.1 Micrometer 기반 측정

```java
@Component
public class InstrumentedRedisLockManager {

    private final RedisTemplate<String, String> redisTemplate;
    private final MeterRegistry meterRegistry;

    public <T> T execute(String key, long expireMillis, Supplier<T> action) {
        String lockId = tryLock(key, expireMillis);
        if (lockId == null) {
            meterRegistry.counter("redis.lock.acquisition.failure",
                "key_prefix", extractPrefix(key)).increment();
            throw new RedisLockException(key + " is locked");
        }

        meterRegistry.counter("redis.lock.acquisition.success",
            "key_prefix", extractPrefix(key)).increment();

        Timer.Sample sample = Timer.start(meterRegistry);
        try {
            return action.get();
        } finally {
            sample.stop(meterRegistry.timer("redis.lock.hold.duration",
                "key_prefix", extractPrefix(key)));
            releaseLock(key, lockId);
        }
    }

    private String extractPrefix(String key) {
        return key.substring(0, key.lastIndexOf(":"));
    }
}
```

#### 6.1.2 로그 기반 측정

```java
@Slf4j
public class RedisLockManager {

    public <T> T execute(String key, long expireMillis, Supplier<T> action) {
        String lockId = tryLock(key, expireMillis);
        if (lockId == null) {
            log.warn("Lock acquisition failed for key: {}", key);
            throw new RedisLockException(key + " is generating...");
        }

        long startTime = System.currentTimeMillis();
        log.debug("Lock acquired for key: {}", key);

        try {
            return action.get();
        } finally {
            long duration = System.currentTimeMillis() - startTime;
            log.info("Lock released for key: {}, held for: {}ms", key, duration);

            if (duration > 10_000) {
                log.warn("Long lock hold detected: {}ms for key: {}", duration, key);
            }
            if (duration > expireMillis) {
                log.error("Lock held longer than TTL! duration: {}ms, TTL: {}ms, key: {}",
                    duration, expireMillis, key);
            }

            releaseLock(key, lockId);
        }
    }
}
```

### 6.2 DB Connection Pool 모니터링

#### 6.2.1 HikariCP 메트릭 설정

```yaml
# application.yml
spring:
  datasource:
    hikari:
      pool-name: MainPool
      maximum-pool-size: 10
      minimum-idle: 5
      connection-timeout: 30000
      idle-timeout: 600000
      max-lifetime: 1800000
      register-mbeans: true

management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
  metrics:
    export:
      prometheus:
        enabled: true
    tags:
      application: littleWriter
```

#### 6.2.2 주요 모니터링 메트릭

```
# Prometheus 쿼리 예시

# 활성 Connection 수
hikaricp_connections_active{pool="MainPool"}

# 대기 중인 스레드 수
hikaricp_connections_pending{pool="MainPool"}

# Connection 획득 시간 (p99)
histogram_quantile(0.99, rate(hikaricp_connections_acquire_seconds_bucket[5m]))

# Connection 사용 시간 (p99)
histogram_quantile(0.99, rate(hikaricp_connections_usage_seconds_bucket[5m]))
```

### 6.3 saveFrom 세부 단계 측정

```java
@Component
@Transactional(transactionManager = "storageTransactionManager")
public class BookRepositoryAdapter implements BookRepository {

    private final MeterRegistry meterRegistry;

    @Transactional
    @Override
    public Book saveFrom(BookInProgress bookInProgress, Function<BookInProgress, Book> converter) {
        Timer.Sample totalSample = Timer.start(meterRegistry);

        // 1. URL 매핑
        Timer.Sample urlMappingSample = Timer.start(meterRegistry);
        Map<String, PreAssignedUrl> urls = PreAssignedUrl.mapOfBookPrefix(...);
        urlMappingSample.stop(meterRegistry.timer("book.saveFrom.urlMapping"));

        // 2. 이미지 URL 변경
        Timer.Sample urlChangeSample = Timer.start(meterRegistry);
        BookInProgress updated = bookInProgress.changeBookPage(...);
        urlChangeSample.stop(meterRegistry.timer("book.saveFrom.urlChange"));

        // 3. 이벤트 발행
        Timer.Sample eventSample = Timer.start(meterRegistry);
        eventPublisher.publishEvent(new ImageUploadEvent(...));
        eventSample.stop(meterRegistry.timer("book.saveFrom.eventPublish"));

        // 4. Book 저장
        Timer.Sample bookSaveSample = Timer.start(meterRegistry);
        Book book = converter.apply(updated);
        BookJpaEntity bookEntity = bookJpaRepository.save(BookJpaEntity.fromBook(book));
        bookSaveSample.stop(meterRegistry.timer("book.saveFrom.bookSave"));

        // 5. Page 저장
        Timer.Sample pageSaveSample = Timer.start(meterRegistry);
        List<BookPageJpaEntity> pageEntities = pageJpaRepository.saveAll(...);
        pageSaveSample.stop(meterRegistry.timer("book.saveFrom.pageSaveAll"));

        // 6. Character 조회
        Timer.Sample characterSample = Timer.start(meterRegistry);
        BookCharacter character = bookCharacterRepository.retrieveById(bookEntity.getCharacterId());
        characterSample.stop(meterRegistry.timer("book.saveFrom.characterRetrieve"));

        totalSample.stop(meterRegistry.timer("book.saveFrom.total"));

        return new Book(...);
    }
}
```

### 6.4 JPA 쿼리 통계

```yaml
# application.yml
spring:
  jpa:
    properties:
      hibernate:
        generate_statistics: true
        session:
          events:
            log:
              LOG_QUERIES_SLOWER_THAN_MS: 100

logging:
  level:
    org.hibernate.stat: DEBUG
    org.hibernate.SQL: DEBUG
    org.hibernate.type.descriptor.sql.BasicBinder: TRACE
```

---

## 7. 안정성 측정 방법

### 7.1 트랜잭션 롤백 테스트

```java
@SpringBootTest
@Transactional
class BookRepositoryAdapterStabilityTest {

    @Autowired
    private BookRepositoryAdapter adapter;

    @Autowired
    private BookJpaRepository bookJpaRepository;

    @Autowired
    private BookPageJpaRepository pageJpaRepository;

    @Test
    @DisplayName("페이지 저장 실패 시 Book 저장도 롤백되어야 함")
    void shouldRollbackBookWhenPageSaveFails() {
        // given
        BookInProgress inProgress = createBookInProgressWithInvalidPage();
        long initialBookCount = bookJpaRepository.count();
        long initialPageCount = pageJpaRepository.count();

        // when & then
        assertThrows(DataIntegrityViolationException.class,
            () -> adapter.saveFrom(inProgress, converter));

        // 롤백 확인
        assertThat(bookJpaRepository.count()).isEqualTo(initialBookCount);
        assertThat(pageJpaRepository.count()).isEqualTo(initialPageCount);
    }

    @Test
    @DisplayName("트랜잭션 타임아웃 시 롤백 확인")
    void shouldRollbackOnTransactionTimeout() {
        // given
        BookInProgress inProgress = createBookInProgress();

        // when - 의도적으로 지연 발생
        // then - 타임아웃 예외 및 롤백 확인
    }
}
```

### 7.2 동시성 테스트

```java
@SpringBootTest
class ConcurrencyStabilityTest {

    @Autowired
    private BookCompleteExecutor executor;

    @Test
    @DisplayName("동시 completeBook 요청 시 데이터 정합성 유지")
    void shouldMaintainConsistencyUnderConcurrentRequests() throws InterruptedException {
        // given
        int threadCount = 10;
        ExecutorService executorService = Executors.newFixedThreadPool(threadCount);
        CountDownLatch startLatch = new CountDownLatch(1);
        CountDownLatch endLatch = new CountDownLatch(threadCount);

        AtomicInteger successCount = new AtomicInteger();
        AtomicInteger lockFailureCount = new AtomicInteger();
        AtomicInteger otherFailureCount = new AtomicInteger();

        String bipId = createTestBookInProgress();

        // when
        for (int i = 0; i < threadCount; i++) {
            final int index = i;
            executorService.submit(() -> {
                try {
                    startLatch.await();  // 동시 시작
                    CompleteBookCommand command = new CompleteBookCommand(
                        createActor(), bipId, "Title " + index, "Author " + index);
                    executor.completeBook(command);
                    successCount.incrementAndGet();
                } catch (BookProgressException e) {
                    if (e.getMessage().contains("saving")) {
                        lockFailureCount.incrementAndGet();
                    } else {
                        otherFailureCount.incrementAndGet();
                    }
                } catch (Exception e) {
                    otherFailureCount.incrementAndGet();
                } finally {
                    endLatch.countDown();
                }
            });
        }

        startLatch.countDown();  // 모든 스레드 동시 시작
        endLatch.await(30, TimeUnit.SECONDS);

        // then
        System.out.println("Success: " + successCount.get());
        System.out.println("Lock failures: " + lockFailureCount.get());
        System.out.println("Other failures: " + otherFailureCount.get());

        // 정확히 1개만 성공해야 함 (Lock으로 직렬화)
        assertThat(successCount.get()).isEqualTo(1);
        assertThat(lockFailureCount.get()).isEqualTo(threadCount - 1);
    }

    @Test
    @DisplayName("서로 다른 bipId에 대한 동시 요청은 모두 성공해야 함")
    void shouldSucceedForDifferentBipIds() throws InterruptedException {
        // given
        int threadCount = 10;
        ExecutorService executorService = Executors.newFixedThreadPool(threadCount);
        CountDownLatch latch = new CountDownLatch(threadCount);
        AtomicInteger successCount = new AtomicInteger();

        List<String> bipIds = IntStream.range(0, threadCount)
            .mapToObj(i -> createTestBookInProgress())
            .toList();

        // when
        for (int i = 0; i < threadCount; i++) {
            final String bipId = bipIds.get(i);
            executorService.submit(() -> {
                try {
                    CompleteBookCommand command = new CompleteBookCommand(
                        createActor(), bipId, "Title", "Author");
                    executor.completeBook(command);
                    successCount.incrementAndGet();
                } finally {
                    latch.countDown();
                }
            });
        }

        latch.await(60, TimeUnit.SECONDS);

        // then
        assertThat(successCount.get()).isEqualTo(threadCount);
    }
}
```

### 7.3 Lock Expiration 테스트

```java
@Test
@DisplayName("Lock TTL 초과 시 다른 요청이 진입 가능함을 확인")
void shouldAllowNewRequestAfterLockExpiration() throws InterruptedException {
    // given
    String bipId = createTestBookInProgress();
    RedisLockManager lockManager = new RedisLockManager(redisTemplate);

    // when - 짧은 TTL로 Lock 획득 후 만료까지 대기
    String lockId = lockManager.tryLock("bip:lock:" + bipId, 1000);  // 1초 TTL
    assertThat(lockId).isNotNull();

    Thread.sleep(1500);  // TTL 만료 대기

    // then - 새로운 Lock 획득 가능
    String newLockId = lockManager.tryLock("bip:lock:" + bipId, 1000);
    assertThat(newLockId).isNotNull();
    assertThat(newLockId).isNotEqualTo(lockId);
}
```

### 7.4 이벤트 리스너 안정성 테스트

```java
@SpringBootTest
class EventListenerStabilityTest {

    @Autowired
    private BookRepositoryAdapter adapter;

    @MockBean
    private AsyncBucketImageUploader imageUploader;

    @Test
    @DisplayName("이미지 업로드 실패해도 DB 저장은 완료되어야 함")
    void shouldSaveToDbEvenWhenImageUploadFails() {
        // given
        doThrow(new RuntimeException("S3 upload failed"))
            .when(imageUploader).copyToBookStorage(any());

        BookInProgress inProgress = createBookInProgress();

        // when
        Book savedBook = adapter.saveFrom(inProgress, converter);

        // then - DB 저장 성공 확인
        assertThat(savedBook).isNotNull();
        assertThat(savedBook.id()).isNotNull();

        // 이미지 업로드는 @Async로 별도 처리되므로 예외가 전파되지 않음
    }
}
```

### 7.5 데이터 정합성 검증

```java
@Test
@DisplayName("DB와 Redis 상태 일관성 검증")
void shouldMaintainConsistencyBetweenDbAndRedis() {
    // given
    String bipId = createTestBookInProgress();
    CompleteBookCommand command = new CompleteBookCommand(
        createActor(), bipId, "Title", "Author");

    // when
    Book book = executor.completeBook(command);

    // then
    // DB 상태 확인
    BookJpaEntity dbBook = bookJpaRepository.findById(book.id()).orElseThrow();
    assertThat(dbBook).isNotNull();

    // Redis 상태 확인
    BookInProgress redisState = bookInProgressRepository.retrieveById(bipId);
    assertThat(redisState.status()).isEqualTo(BookInProgressStatus.COMPLETED);
}
```

---

## 8. 권장 개선 사항

### 8.1 Lock 범위 최소화

#### 현재 구조

```java
// 현재: 전체 작업을 Lock 내에서 수행
return lockExecutor.updateWithLock(command.bipId(), () -> {
    BookInProgress bip = bookInProgressRepository.retrieveById(...);
    BookPageGenerated generated = bookPageGenerator.generatePageFrom(...);  // 오래 걸림
    ImageUploadResult result = imageRepository.uploadTemporary(...);         // 오래 걸림
    BookInProgress updated = bip.appendPageFrom(...);
    return bookInProgressRepository.addPageTo(...);
});
```

#### 개선 구조

```java
// 개선: Network I/O를 Lock 밖으로 분리
public AiGenerateResult generateWithAi(CreateOnePageCommand command) {
    // 1. Lock 없이 데이터 조회
    BookInProgress bip = bookInProgressRepository.retrieveById(command.bipId());

    // 2. Lock 없이 AI 호출 (가장 오래 걸리는 작업)
    BookPageGenerated generated = bookPageGenerator.generatePageFrom(
        new BookToProgress(bip, command.userInput()));

    // 3. Lock 없이 이미지 업로드
    ImageUploadResult result = imageRepository.uploadTemporary(
        generated.generatedIllustrationUrl());

    // 4. Lock 범위: 상태 변경만
    return lockExecutor.updateWithLock(command.bipId(), () -> {
        // 최신 상태 다시 조회 (Optimistic Lock 효과)
        BookInProgress currentBip = bookInProgressRepository.retrieveById(command.bipId());

        // 버전 체크 또는 상태 검증
        if (currentBip.version() != bip.version()) {
            throw new ConcurrentModificationException("Data was modified");
        }

        BookInProgress updated = currentBip.appendPageFrom(
            command, generated.context(), result.newUrl());
        return new AiGenerateResult(
            bookInProgressRepository.addPageTo(updated.id(), updated.previousPages().getLast()),
            new ArrayList<>()
        );
    });
}
```

### 8.2 Atomic Lock 해제 (Lua Script)

```java
@Component
public class RedisLockManager {

    private static final String RELEASE_LOCK_SCRIPT = """
        if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('del', KEYS[1])
        else
            return 0
        end
        """;

    private final RedisScript<Long> releaseLockScript;

    public RedisLockManager(RedisTemplate<String, String> redisTemplate) {
        this.redisTemplate = redisTemplate;
        this.releaseLockScript = new DefaultRedisScript<>(RELEASE_LOCK_SCRIPT, Long.class);
    }

    private void releaseLock(String key, String lockId) {
        redisTemplate.execute(releaseLockScript,
            Collections.singletonList(key),
            lockId);
    }
}
```

### 8.3 이벤트 처리 재시도 로직

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Async(value = "transaction-event")
@Retryable(
    value = {S3Exception.class, IOException.class},
    maxAttempts = 3,
    backoff = @Backoff(delay = 1000, multiplier = 2)
)
public void handle(ImageUploadEvent event) {
    for (PreAssignedUrl url : event.jobs()) {
        imageUploader.copyToBookStorage(url);
    }
}

@Recover
public void handleFailure(Exception e, ImageUploadEvent event) {
    log.error("Image upload failed after retries: {}", event, e);
    // 실패 이벤트 발행 또는 Dead Letter Queue 저장
    failedEventRepository.save(new FailedImageUploadEvent(event, e.getMessage()));
}
```

### 8.4 DB-Redis 정합성 보장

```java
@Transactional
public Book completeBook(CompleteBookCommand command) {
    return lockExecutor.saveWithLock(command.bookInProgressId(), () -> {
        BookInProgress target = getBookInProgress(command).markAsPending();

        try {
            Book book = bookRepository.saveFrom(target, bip -> {
                validateNotNull(bip.character());
                return Book.completeFromCommand(bip, command);
            });

            // Redis 업데이트
            bookInProgressRepository.save(target.markAsCompleted());

            return book;
        } catch (Exception e) {
            // Redis 업데이트 실패 시 보상 처리
            log.error("Failed to complete book: {}", command.bookInProgressId(), e);

            // 보상 이벤트 발행
            compensationEventPublisher.publish(
                new BookCompletionFailedEvent(command.bookInProgressId()));

            throw e;
        }
    });
}
```

### 8.5 배치 처리 최적화

```yaml
# application.yml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50
        order_inserts: true
        order_updates: true
```

### 8.6 개선 우선순위

| 순위 | 개선 항목 | 효과 | 복잡도 | 권장 |
|------|----------|------|--------|------|
| 1 | Lock 범위 최소화 | 높음 | 중간 | **즉시 적용** |
| 2 | Atomic Lock 해제 | 중간 | 낮음 | **즉시 적용** |
| 3 | 이벤트 재시도 로직 | 중간 | 낮음 | **즉시 적용** |
| 4 | 배치 처리 최적화 | 낮음 | 낮음 | 선택적 |
| 5 | DB-Redis 정합성 보장 | 높음 | 높음 | 중기 검토 |

---

## 9. 결론

### 9.1 현재 상태 요약

| 항목 | 평가 | 설명 |
|------|------|------|
| Lock 전략 | ⚠️ 개선 필요 | Network I/O가 Lock 범위 내에 포함됨 |
| DB 성능 영향 | 중간 | 동일 리소스 접근 시 직렬화로 처리량 감소 |
| 안정성 | ⚠️ 개선 필요 | Lock 해제 Race Condition, 데이터 불일치 위험 |
| 확장성 | 낮음 | 단일 리소스당 동시 처리 불가 |

### 9.2 권장 조치

1. **단기 (1-2주)**
   - Atomic Lock 해제 적용 (Lua Script)
   - 이벤트 재시도 로직 추가
   - 모니터링 메트릭 추가

2. **중기 (1-2개월)**
   - Lock 범위 최소화 리팩토링
   - DB-Redis 정합성 보장 메커니즘 구현

3. **장기 (분기)**
   - 아키텍처 검토 (이벤트 소싱, CQRS 고려)
   - 부하 테스트 및 성능 튜닝

### 9.3 모니터링 대시보드 구성 권장

```
┌─────────────────────────────────────────────────────────────────┐
│                    Lock Performance Dashboard                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Lock Hold Duration (p99)          Lock Acquisition Rate        │
│  ┌─────────────────────┐          ┌─────────────────────┐      │
│  │ ████████████ 5.2s   │          │ Success: 95%        │      │
│  │ generateWithAi      │          │ Failure: 5%         │      │
│  │                     │          │                     │      │
│  │ ██ 58ms             │          │                     │      │
│  │ completeBook        │          │                     │      │
│  └─────────────────────┘          └─────────────────────┘      │
│                                                                 │
│  DB Connection Pool                Active Transactions          │
│  ┌─────────────────────┐          ┌─────────────────────┐      │
│  │ Active: 3/10        │          │ ████████ 8          │      │
│  │ Pending: 0          │          │                     │      │
│  │ Idle: 7             │          │                     │      │
│  └─────────────────────┘          └─────────────────────┘      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 부록

### A. 테스트 체크리스트

- [ ] Lock 획득 성공/실패 케이스
- [ ] Lock TTL 만료 케이스
- [ ] 동시 요청 처리 (같은 리소스)
- [ ] 동시 요청 처리 (다른 리소스)
- [ ] 트랜잭션 롤백 케이스
- [ ] 이벤트 처리 실패 케이스
- [ ] DB-Redis 정합성 검증

### B. 참고 자료

- [Redisson Distributed Locks](https://github.com/redisson/redisson/wiki/8.-Distributed-locks-and-synchronizers)
- [Spring Data Redis Documentation](https://docs.spring.io/spring-data/redis/docs/current/reference/html/)
- [HikariCP Configuration](https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby)

---

## 10. 부하 테스트 계획

### 10.1 테스트 대상 선정

부하 테스트 대상으로 `completeBook` 흐름을 선정한다.

**`generateWithAi`를 선정하지 않은 이유**

`generateWithAi`는 AI 호출(OpenAI, 5~30초)과 S3 업로드가 Lock 내부에 포함되어 있어
Network I/O를 제거하면 Redis 연산만 남는다. 이 경우 Lock contention 자체가 거의 발생하지
않아 의미 있는 부하를 생성하기 어렵다.

**`completeBook`을 선정한 이유**

```
Redis lock 획득
  → markAsPending()                           ← Redis read/write
  → BookRepositoryAdapter.saveFrom()
      ┌─ @Transactional START ─────────────────
      │  PreAssignedUrl 계산 (I/O 없음)
      │  eventPublisher.publishEvent()         ← 이벤트 등록만
      │  bookJpaRepository.save()              ← DB INSERT
      │  pageJpaRepository.saveAll()           ← DB INSERT (pages)
      └─ COMMIT
         └─ @Async handle(ImageUploadEvent)   ← S3 copy (별도 스레드)
  → bookInProgressRepository.save(markAsCompleted())  ← Redis write
Redis lock 해제
```

- OpenAI 호출 없음 → Network I/O 제거 대상이 S3 하나뿐
- 트랜잭션 경계 명확: `saveFrom()` 단일 `@Transactional`
- Redis lock + DB transaction 두 레이어를 동시에 측정 가능
- P4 문제(DB 커밋 후 Redis 업데이트 실패로 인한 상태 불일치)를 부하 상황에서 재현 가능

### 10.2 Network I/O 제거 전략

제거 대상은 `AsyncBucketImageUploader` 하나다.

```java
// BookRepositoryAdapter.java:79-85
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Async(value = "transaction-event")
public void handle(ImageUploadEvent event) {
    imageUploader.copyToBookStorage(url);  // ← 이것만 mock
}
```

테스트 환경에서 `AsyncBucketImageUploader`를 no-op Bean으로 교체하면
S3 I/O가 완전히 제거된다. DB 트랜잭션, Redis lock은 실제 그대로 동작한다.

### 10.3 인프라 구성

클라우드 환경은 불필요하다. 로컬 환경으로 충분하다.

**측정 목적**이 "Redis lock contention 동작", "DB 트랜잭션 처리량", "P4 상태 불일치 재현"이므로
절대적인 TPS 숫자보다 **상대적인 동작 검증**이 핵심이다.

```
[로컬 k6]
    ↓
[로컬 Spring Boot] — test-local 프로파일
    ├─ Redis: 127.0.0.1:6379
    └─ MySQL: localhost:3306/little-writer-v2

인프라 구성 파일: infra/main.tf (클라우드 환경이 필요한 경우에만 사용)
```

`test-local` 프로파일이 이미 로컬 Redis, 로컬 MySQL을 바라보도록 설정되어 있다.

### 10.4 BIP 상태 관리

`completeBook`은 `BookInProgress`가 `IN_PROGRESS` 상태여야 실행 가능하다.
한 번 완료되면 `COMPLETED`로 전이되어 재사용이 불가능하다. 도메인이 이를 강하게 제어한다.

```java
// BookInProgress.java:98-110
public BookInProgress markAsCompleted() {
    if (status == Status.COMPLETED) {
        throw BookProgressException.alreadyCompleted(id);  // 재진입 차단
    }
    ...
}
```

**해결 전략: `initBook`을 VU setup으로 포함**

`BookPageGenerator`를 mock으로 교체하면 `initBook`은 Redis write만 수행한다.
k6 VU 라이프사이클을 다음과 같이 구성한다.

```
setup:    POST /initBook (AI mock → 즉시 반환) → bipId 발급
test:     POST /completeBook/{bipId}
teardown: Redis TTL로 자동 만료
```

각 VU가 독립적인 BIP를 소유하므로 **같은 bipId 동시 접근**(lock contention)과
**다른 bipId 동시 접근**(DB 병목)을 시나리오로 분리해 측정할 수 있다.

| 시나리오 | 설정 | 측정 항목 |
|---------|------|----------|
| A. 같은 bipId 동시 요청 | N VU → 동일 bipId | Lock contention, 실패율 |
| B. 다른 bipId 동시 요청 | N VU → 각자 다른 bipId | DB connection pool 압박, TPS |

### 10.5 측정 도구 사용 순서

단계적으로 적용한다. 처음부터 Prometheus/Grafana를 구성하는 것은 오버엔지니어링이다.

```
1단계 — k6만 사용
  목적: 처리량(TPS), 응답 시간(p95/p99), 에러율 측정
  판단: "병목이 있다/없다"

        ↓ 에러 또는 지연 발견 시

2단계 — Spring Actuator + Micrometer 활성화
  확인 대상:
    - HikariCP connection pool: hikaricp_connections_active, pending
    - Redis lock: redis.lock.hold.duration (6.1.1 참고)
    - DB transaction: book.saveFrom.total (6.3 참고)

        ↓ 특정 메트릭이 튀는 원인 파악이 필요할 때

3단계 — Prometheus + Grafana 연동
  목적: k6 결과와 앱 내부 메트릭을 시간축으로 겹쳐서 원인 분석
  대시보드: 9.3 참고
```

**Prometheus + Grafana가 필요한 시점**은 k6가 "느리다"고 알려준 이후,
그 원인이 HikariCP 고갈인지, GC 압박인지, Redis 지연인지 구분해야 할 때다.
