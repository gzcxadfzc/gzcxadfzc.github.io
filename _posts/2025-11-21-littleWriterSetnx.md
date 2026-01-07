---
layout: post
title: "LittleWriterSetnx"
date: 2025-11-21 10:00:40
---


# Redis SETNX 기반 BookInProgress 엔티티 동시성 제어


## 1. 개요

이 문서는 LittleWriter V2 프로젝트에서 **Redis의 SETNX**를 사용하여 BookInProgress 엔티티의 동시성을 제어하는 방법을 상세히 설명합니다.

### 1.1 왜 동시성 제어가 필요한가?

BookInProgress는 AI를 사용하여 책의 페이지를 생성하는 엔티티입니다. 동일한 책에 대해 여러 사용자(또는 동일 사용자의 여러 요청)가 동시에 페이지 생성을 시도할 경우 다음과 같은 문제가 발생할 수 있습니다:

- **데이터 불일치**: 여러 스레드가 동시에 페이지를 추가하면 페이지 순서가 뒤섞일 수 있음
- **리소스 낭비**: 동일한 AI 생성 작업이 중복 실행되어 비용 증가
- **사용자 경험 저하**: 예상치 못한 결과로 인한 혼란

이를 방지하기 위해 **Redis SETNX 기반 락**을 사용하여 동시에 하나의 스레드만 특정 책에 대한 작업을 수행할 수 있도록 제어합니다.

---


### 1.2 동작 방식
```
SETNX key value
```
- 키가 **존재하지 않으면**: 값을 설정하고 1 반환 (성공)
- 키가 **이미 존재하면**: 아무 작업도 하지 않고 0 반환 (실패)

### 1.3 왜 적합한가?

1. **원자성(Atomicity)**: 체크와 설정이 하나의 연산으로 수행되어 Race Condition 방지
2. **단순성**: 복잡한 로직 없이 분산 환경에서 동시성 제어 가능
3. **성능**: 매우 빠른 연산 속도

### 1.4 프로젝트에서의 사용
본 프로젝트에서는 `RedisStringCommands.SetOption.SET_IF_ABSENT`를 사용하며, 이는 SETNX와 동일한 동작을 수행합니다.

---

## 2. BookInProgress 엔티티 구조

```java
public record BookInProgress(
    String id,                      // 책 진행 상태 고유 ID
    Long ownerId,                   // 소유자 ID
    String backgroundInfo,          // 배경 정보
    BookCharacter character,        // 등장인물
    List<BookPage> previousPages,   // 이전 페이지 목록
    Status status                   // 상태 (IN_PROGRESS, COMPLETED, PENDING)
) {

    public enum Status {
        COMPLETED,      // 완료됨
        IN_PROGRESS,    // 진행 중
        PENDING         // 대기 중
    }

    // 주요 메서드
    public BookInProgress addBookPage(BookPage bookPage) {
        // 불변성 유지를 위해 새로운 인스턴스 반환
        List<BookPage> newPages = new ArrayList<>(previousPages);
        newPages.add(bookPage);
        return new BookInProgress(id, ownerId, backgroundInfo,
                                  character, newPages, status);
    }

    public BookInProgress markAsCompleted() {
        return new BookInProgress(id, ownerId, backgroundInfo,
                                  character, previousPages, Status.COMPLETED);
    }

    public BookInProgress markAsPending() {
        return new BookInProgress(id, ownerId, backgroundInfo,
                                  character, previousPages, Status.PENDING);
    }
}
```

### 2.1 주요 특징
1. **불변(Immutable) 타입**: Java Record로 구현되어 모든 필드가 final
2. **상태 관리**: Status enum을 통한 명확한 상태 전이
3. **페이지 관리**: List<BookPage>로 페이지 순서 보장

---

## 3. SETNX 기반 락 구현

### 3.1 RedisLockManager - 핵심 락 관리자

**파일 경로**: `storage/src/main/java/com/pkg/redis/RedisLockManager.java`

```java
@Component
public class RedisLockManager {

    private final RedisTemplate<String, String> redisTemplate;

    public RedisLockManager(RedisTemplate<String, String> redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    /**     
     * @param key 락을 획득할 Redis 키
     * @param expireMillis 락의 만료 시간 (밀리초)
     * @param action 락 획득 후 실행할 작업
     * @return 작업 실행 결과
     * @throws RedisLockException 락 획득 실패 시
     */
    public <T> T execute(String key, long expireMillis, Supplier<T> action) {
        // 1. 락 획득 시도
        String lockId = tryLock(key, expireMillis);

        if (lockId == null) {
            // 락 획득 실패 - 다른 스레드가 이미 작업 중
            throw new RedisLockException(key + " is generating... ");
        }

        try {
            // 2. 락 획득 성공 - 작업 실행
            return action.get();
        } finally {
            // 3. 작업 완료 후 반드시 락 해제 (예외 발생 시에도)
            releaseLock(key, lockId);
        }
    }

    /**
     * SETNX를 사용하여 락을 획득합니다.
     *
     * @param key 락 키
     * @param expireMillis 만료 시간
     * @return 락 획득 성공 시 lockId, 실패 시 null
     */
    private String tryLock(String key, long expireMillis) {
        // 고유한 락 ID 생성 (UUID)
        String lockId = UuidGen.compact();

        // SETNX + TTL을 원자적으로 수행
        Boolean success = redisTemplate.execute((RedisCallback<Boolean>) connection -> {
            byte[] k = redisTemplate.getStringSerializer().serialize(key);
            byte[] v = redisTemplate.getStringSerializer().serialize(lockId);

            // SET_IF_ABSENT = SETNX와 동일한 동작
            // Expiration으로 TTL 설정 (데드락 방지)
            return connection.set(
                k,                                              // 키
                v,                                              // 값 (lockId)
                Expiration.milliseconds(expireMillis),          // TTL
                RedisStringCommands.SetOption.SET_IF_ABSENT     // SETNX
            );
        });

        // 성공 시 lockId 반환, 실패 시 null 반환
        return Boolean.TRUE.equals(success) ? lockId : null;
    }

    /**
     * 락을 안전하게 해제합니다.
     * 자신이 획득한 락만 해제할 수 있도록 lockId를 검증합니다.
     *
     * @param key 락 키
     * @param lockId 락 ID
     */
    private void releaseLock(String key, String lockId) {
        redisTemplate.execute((RedisCallback<Void>) connection -> {
            byte[] k = redisTemplate.getStringSerializer().serialize(key);
            byte[] v = connection.get(k);

            // 현재 저장된 lockId 확인
            if (v != null) {
                String currentLockId = redisTemplate.getStringSerializer().deserialize(v);

                // 자신이 설정한 lockId와 일치하는 경우에만 삭제
                // 다른 스레드의 락을 실수로 해제하는 것을 방지
                if (lockId.equals(currentLockId)) {
                    connection.del(k);
                }
            }

            return null;
        });
    }
}
```

### 3.2 락 획득 과정 (tryLock)

```
[Thread A]                         [Redis]                      [Thread B]
    |                                 |                              |
    |--SETNX "bip:lock:123" "uuid-A"->|                              |
    |                                 |                              |
    |<------------SUCCESS(1)----------|                              |
    |                                 |                              |
    |                                 |<--SETNX "bip:lock:123"-------|
    |                                 |    "uuid-B"                  |
    |                                 |                              |
    |                                 |----------FAILURE(0)--------->|
```

- **Thread A**: 키가 없으므로 SETNX 성공, lockId 반환
- **Thread B**: 키가 이미 존재하므로 SETNX 실패, null 반환

### 3.3 TTL 설정으로 데드락 방지

```java
Expiration.milliseconds(expireMillis)
```

만약 작업 수행 중 서버가 다운되거나 예외가 발생해 `releaseLock`이 호출되지 않더라도, TTL이 지나면 자동으로 락이 해제됩니다.

### 3.4 안전한 락 해제 (releaseLock)

```java
if (lockId.equals(currentLockId)) {
    connection.del(k);
}
```

**왜 lockId를 비교하는가?**

시나리오:
1. Thread A가 락을 획득하고 작업 시작
2. Thread A의 작업이 너무 오래 걸려 TTL 만료
3. Thread B가 새로운 락 획득
4. Thread A의 finally 블록이 실행되어 `releaseLock` 호출

이때 lockId를 비교하지 않으면 Thread A가 Thread B의 락을 삭제하게 됩니다. lockId 비교를 통해 **자신이 획득한 락만 해제**할 수 있도록 보장합니다.

---

## 4. BookInProgress 락 실행자

### 4.1 인터페이스 정의

**파일 경로**: `domain/src/main/java/com/pkg/domain/bookprogress/BookInProgressLockExecutor.java`

```java
@Component
public interface BookInProgressLockExecutor {

    /**
     * AI 생성 작업을 락과 함께 실행
     */
    AiGenerateResult updateWithLock(String lockKey, Supplier<AiGenerateResult> generator);

    /**
     * 책 저장 작업을 락과 함께 실행
     */
    Book saveWithLock(String lockKey, Supplier<Book> generator);
}
```

### 4.2 어댑터 구현

**파일 경로**: `storage/src/main/java/com/pkg/redis/BookInProgressLockExecutorAdapter.java`

```java
@Component
public class BookInProgressLockExecutorAdapter implements BookInProgressLockExecutor {

    // 락 키 접두사
    private static final String BIP_LOCK_KEY_PREFIX = "bip:lock:";

    // TTL: 120초
    private static final Long EXPIRATION_SEC = 120L;

    private final RedisLockManager lockManager;

    public BookInProgressLockExecutorAdapter(RedisLockManager lockManager) {
        this.lockManager = lockManager;
    }

    @Override
    public AiGenerateResult updateWithLock(String bipId, Supplier<AiGenerateResult> generator) {
        try {
            // 락 키 생성: "bip:lock:{bookInProgressId}"
            String key = BIP_LOCK_KEY_PREFIX + bipId;

            // RedisLockManager를 통해 락 획득 및 작업 실행
            return lockManager.execute(key, EXPIRATION_SEC, generator);

        } catch (RedisLockException e) {
            // 락 획득 실패 시 도메인 예외로 변환
            throw BookProgressException.bookPageAlreadyGenerating(bipId);
        }
    }

    @Override
    public Book saveWithLock(String bipId, Supplier<Book> generator) {
        try {
            String key = BIP_LOCK_KEY_PREFIX + bipId;
            return lockManager.execute(key, EXPIRATION_SEC, generator);

        } catch (RedisLockException e) {
            // 락 획득 실패 시 도메인 예외로 변환
            throw BookProgressException.bookPageAlreadySaving(bipId);
        }
    }
}
```

**주요 특징**

1. **락 키 네이밍 컨벤션**: `bip:lock:{bookInProgressId}`
   - 각 책마다 독립적인 락 보유
   - Redis에서 키 패턴 검색 용이

2. **긴 TTL 설정**: 120초
   - AI 페이지 생성은 시간이 오래 걸릴 수 있음
   - 충분한 시간을 주되, 데드락은 방지

3. **예외 변환**: RedisLockException → BookProgressException
   - 인프라 계층의 예외를 도메인 예외로 변환
   - 상위 계층에서 Redis 의존성 제거

---

## 5. 비즈니스 로직에서의 활용

### 5.1 BookProgressService

```java
@Service
public class BookProgressService {

    private final BookInProgressRepository bookInProgressRepository;
    private final BookPageGenerator bookPageGenerator;
    private final ImageRepository imageRepository;
    private final BookInProgressLockExecutor lockExecutor;

    /**
     * AI를 사용하여 페이지 생성 - 동시성 제어 적용
     */
    public AiGenerateResult generateWithAi(CreateOnePageCommand command) {

        // lockExecutor.updateWithLock()으로 감싸서 동시성 제어
        return lockExecutor.updateWithLock(command.bipId(), () -> {

            // 1. BookInProgress 조회
            BookInProgress bip = bookInProgressRepository.retrieveById(command.bipId());

            // 2. AI를 통한 페이지 생성
            BookPageGenerated bookPageGenerated =
                bookPageGenerator.generatePageFrom(
                    new BookToProgress(bip, command.userInput())
                );

            // 3. 생성된 이미지를 임시 저장소에 업로드
            ImageUploadResult result =
                imageRepository.uploadTemporary(
                    bookPageGenerated.generatedIllustrationUrl()
                );

            // 4. BookInProgress에 새 페이지 추가
            BookInProgress updated = bip.appendPageFrom(
                command,
                bookPageGenerated.context(),
                result.newUrl()
            );

            // 5. 업데이트된 BookInProgress 저장
            BookInProgress appended = bookInProgressRepository.addPageTo(
                updated.id(),
                updated.previousPages().getLast()
            );

            // 6. 결과 반환
            return new AiGenerateResult(appended, new ArrayList<>());
        });
    }

   ...

    /**
     * BookInProgress 조회 - 동시성 제어 불필요
     * 읽기 작업이므로 경쟁 상태 발생하지 않음
     */
    public BookInProgress retrieveById(Actor user, String bipId) {
        BookInProgress found = bookInProgressRepository.retrieveById(bipId);
        validateOwner(found, user);
        return found;
    }
}
```

### 5.2 BookCompleteExecutor - 책 완성 처리

**파일 경로**: `domain/src/main/java/com/pkg/domain/bookprogress/BookCompleteExecutor.java`

```java
@Component
public class BookCompleteExecutor {

    private final BookInProgressLockExecutor lockExecutor;
    private final BookRepository bookRepository;
    private final BookInProgressRepository bookInProgressRepository;

    /**
     * 책 완성 처리 - 동시성 제어 적용
     */
    public Book completeBook(CompleteBookCommand command) {

        // lockExecutor.saveWithLock()으로 감싸서 동시성 제어
        return lockExecutor.saveWithLock(command.bookInProgressId(), () -> {

            // 1. BookInProgress 조회 및 PENDING 상태로 변경
            BookInProgress target = getBookInProgress(command).markAsPending();

            // 2. Book 엔티티로 변환 및 저장
            Book book = bookRepository.saveFrom(target, bip -> {
                validateNotNull(bip.character());
                return Book.completeFromCommand(bip, command);
            });

            // 3. BookInProgress를 COMPLETED 상태로 변경
            bookInProgressRepository.save(target.markAsCompleted());

            return book;
        });
    }
}
```

### 5.3 전체 시스템 흐름

```
┌─────────────┐
│   Client    │
│ (사용자)     │
└──────┬──────┘
       │ POST /api/v1/book/progress/{id}
       │ (페이지 생성 요청)
       ▼
┌─────────────────────────────┐
│  BookProgressController     │
│  generatePage()             │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  BookProgressService        │
│  generateWithAi()           │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  BookInProgressLockExecutor │
│  updateWithLock()           │
│  (어댑터)                    │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  RedisLockManager           │
│  execute()                  │
└──────────┬──────────────────┘
           │
           ▼
      ┌────────┐
      │ Redis  │
      │ SETNX  │
      └────┬───┘
           │
    ┌──────┴──────┐
    │             │
┌───▼───┐    ┌───▼───┐
│성공(1) │    │실패(0) │
└───┬───┘    └───┬───┘
    │            │
    │            ▼
    │   ┌─────────────────┐
    │   │ RedisLock       │
    │   │ Exception       │
    │   └────────┬────────┘
    │            │
    │            ▼
    │   ┌─────────────────┐
    │   │ BookProgress    │
    │   │ Exception       │
    │   │ (409 Conflict)  │
    │   └─────────────────┘
    │
    ▼
┌─────────────────────────────┐
│ 작업 실행 (Supplier)         │
│ 1. BookInProgress 조회       │
│ 2. AI 페이지 생성            │
│ 3. 이미지 업로드             │
│ 4. 페이지 추가               │
│ 5. 저장                     │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ finally: releaseLock()      │
│ (lockId 검증 후 락 해제)     │
└─────────────────────────────┘
```

### 5.4 동시 요청 시 경쟁 상태 처리

```
시간축 (Time) ──────────────────────────────────────────────────►

Thread A    Thread B
   │           │
   │ [t1]      │ [t1]
   │ POST      │ POST
   │ /book/    │ /book/
   │ progress/ │ progress/
   │ 123       │ 123
   │           │
   │ [t2]      │ [t2]
   ├───SETNX───┤ (동시 시도)
   │  "bip:    │
   │  lock:    │
   │  123"     │
   │           │
   ▼           ▼
SUCCESS(1)  FAILURE(0)
   │           │
   │           ▼
   │      RedisLockException
   │           │
   │           ▼
   │      BookProgressException
   │      "bookPageAlreadyGenerating"
   │      HTTP 409 Conflict
   │
   ▼
락 획득 성공
   │
   ├─ AI 페이지 생성 (15초)
   │
   ├─ 이미지 업로드 (5초)
   │
   ├─ 데이터 저장 (1초)
   │
   ▼
releaseLock()
(자동 해제)
   │
   ▼
HTTP 200 OK
(페이지 생성 완료)
```

### 5.5 사용자 응답 시나리오

```
동일한 책(bipId)에 대한 동시 요청:
  - Thread A: 페이지 생성 중...  ✓ (락 획득 성공)
  - Thread B: 409 Conflict       ✗ (락 획득 실패)
  - Thread C: 409 Conflict       ✗ (락 획득 실패)

다른 책에 대한 동시 요청:
  - Thread A (book-1): 페이지 생성 중... ✓
  - Thread B (book-2): 페이지 생성 중... ✓
  - Thread C (book-3): 페이지 생성 중... ✓
```
---

## 6. 동시성 제어 테스트

### 6.1 단일 스레드 테스트

```java
@Test
@DisplayName("단일 스레드 - 락 획득 및 자동 해제 확인")
void testSingleThreadLockAcquisitionAndRelease() {
    String bipId = "test-book-1";

    AiGenerateResult result = lockExecutor.updateWithLock(bipId, () -> {
        return new AiGenerateResult(null, null);
    });

    assertThat(result).isNotNull();
}
```

**목적**: 기본적인 락 획득과 자동 해제 검증

---

### 6.2 다중 스레드 동시 접근 테스트

```java
@Test
@DisplayName("다중 스레드 - 동시에 같은 리소스에 대한 락 획득 시도 시 하나만 성공")
void testMultiThreadConcurrentLockAcquisition() throws InterruptedException {
    String bipId = "concurrent-book";
    int threadCount = 10;
    CountDownLatch startLatch = new CountDownLatch(1);
    CountDownLatch endLatch = new CountDownLatch(threadCount);

    AtomicInteger successCount = new AtomicInteger(0);
    AtomicInteger failureCount = new AtomicInteger(0);

    ExecutorService executorService = Executors.newFixedThreadPool(threadCount);

    // 10개의 스레드가 동시에 같은 bipId에 대해 락 획득 시도
    for (int i = 0; i < threadCount; i++) {
        executorService.submit(() -> {
            try {
                startLatch.await();  // 모든 스레드가 동시에 시작하도록 대기

                lockExecutor.updateWithLock(bipId, () -> {
                    // 락 획득 성공 시 실행
                    successCount.incrementAndGet();

                    // 작업 시뮬레이션 (100ms 대기)
                    Thread.sleep(100);

                    return new AiGenerateResult(null, null);
                });

            } catch (BookProgressException e) {
                // 락 획득 실패 시 예외 발생
                failureCount.incrementAndGet();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                endLatch.countDown();
            }
        });
    }

    startLatch.countDown();  // 모든 스레드 동시 시작
    endLatch.await(10, TimeUnit.SECONDS);  // 모든 스레드 완료 대기

    executorService.shutdown();

    // 검증: 정확히 1개만 성공, 나머지 9개는 실패
    assertThat(successCount.get()).isEqualTo(1);
    assertThat(failureCount.get()).isEqualTo(threadCount - 1);
}
```

**결과**:
- 10개 스레드 중 **1개만 성공** (SETNX 성공)
- 나머지 **9개는 실패** (BookProgressException 발생)

---

### 6.3 예외 발생 시에도 안전한 락 해제 테스트

```java
@Test
@DisplayName("예외 발생 시에도 락이 안전하게 해제됨")
void testLockReleaseOnException() {
    String bipId = "exception-book";

    // 첫 번째 시도: 예외 발생
    assertThatThrownBy(() -> {
        lockExecutor.updateWithLock(bipId, () -> {
            throw new RuntimeException("Simulated error");
        });
    }).isInstanceOf(RuntimeException.class);

    // 두 번째 시도: 락이 해제되었으므로 성공해야 함
    assertThatCode(() -> {
        lockExecutor.updateWithLock(bipId, () -> {
            return new AiGenerateResult(null, null);
        });
    }).doesNotThrowAnyException();
}
```

---
