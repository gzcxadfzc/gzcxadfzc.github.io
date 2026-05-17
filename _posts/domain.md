# Domain Bounded Contexts

## Overview

| Bounded Context | Package | Storage | Key Entity |
|---|---|---|---|
| Member | `domain.member` | RDS | Member |
| Book | `domain.book` | RDS | Book |
| BookProgress | `domain.bookprogress` | Redis | BookInProgress |
| Character | `domain.character` | Redis(진행중) + RDS(완성) | CharacterInProgress, BookCharacter |
| Image | `domain.image` | S3 | - |

> **v3**: `domain.ai` 컨텍스트 제거. LLM 호출은 Lambda가 전담하며 Spring 앱에서 직접 호출하지 않음.

---

## 1. Member Context

**Responsibility:** 회원 가입, 인증 자격 관리

### Entities
```
Member (record)
  - Long id
  - String username
  - String password (hashed)
  - Role role         ← GUEST | MEMBER | ADMIN
```

### Value Objects
```
Actor (record)        ← 요청 컨텍스트에 실려 다니는 인증 정보
  - Long id
  - Role role
```

### Commands
```
SignUpCommand (record)
  - String username   ← 비어있으면 MemberException.invalidCommand()
  - String password   ← 비어있으면 MemberException.invalidCommand()
```

### Repository
```java
Member register(Member member)
```

### Domain Rules
- username은 고유해야 함 (`duplicatedUsername` E409)
- password는 저장 전 반드시 해싱 (`PasswordHasher`)

### Exceptions
| Method | Code | 설명 |
|---|---|---|
| `notFound(username)` | E404 | 존재하지 않는 회원 |
| `invalidPassword()` | E404 | 비밀번호 불일치 |
| `duplicatedUsername(username)` | E409 | 중복 username |
| `invalidCommand(message)` | E400 | 유효하지 않은 커맨드 |

---

## 2. Book Context

**Responsibility:** 완성된 책 저장 및 조회

### Entities
```
Book (record)
  - String id           ← compact UUID
  - Long memberId
  - List<BookPage> bookPages
  - String title
  - String author
  - BookCharacter character
```

### Value Objects
```
BookPage (record)
  - String context       ← 페이지 본문
  - String imageUrl      ← 삽화 URL (Lambda가 S3에 직접 업로드)
  - int pageNumber       ← 0-based

BookThumbnail (record)
  - String bookId
  - String title
  - String author
  - String coverImageUrl
  - LocalDateTime createdAt
```

### Factory Method
```java
// Book.java
static Book completeFromCommand(BookInProgress bip, CompleteBookCommand cmd)
  // Validation: bip.status == IN_PROGRESS    → BookProgressException.bookNotCompleted()
  // Validation: actor == owner || ADMIN      → BookException.notAuthorizedBookCreationFrom()
```

> **v3 변경**: `completeFromCommand` 상태 체크가 PENDING → IN_PROGRESS로 변경됨.
> PENDING은 Lambda 처리 중임을 의미하므로 completeBook 불가 (409).

### Repository
```java
Book saveFrom(BookInProgress bip, Function<BookInProgress, Book> converter)
Book save(Book book)
Book retrieveById(String bookId)
List<BookThumbnail> retrieveThumbnailsByUser(Actor currentUser)
PageResult<BookThumbnail> retrieveThumbnails(BookRetrieveQuery query)
```

### Domain Rules
- `BookInProgress` 상태가 **IN_PROGRESS**일 때만 `Book`으로 완성 가능
- PENDING 상태에서 completeBook 호출 시 409 (Lambda 처리 중)
- 완성은 소유자 또는 ADMIN만 가능
- 첫 페이지의 imageUrl이 커버 이미지

### Exceptions
| Method | Code | 설명 |
|---|---|---|
| `notFound(bookId)` | E404 | 존재하지 않는 책 |
| `notAuthorizedBookCreationFrom(bip)` | E403 | 권한 없음 |

---

## 3. BookProgress Context

**Responsibility:** 진행 중인 책의 생성·페이지 추가·완성 처리 (핵심 도메인)

### Entity
```
BookInProgress (record)
  - String id               ← compact UUID
  - Long ownerId
  - String backgroundInfo
  - BookCharacter character
  - List<BookPage> previousPages
  - Status status           ← IN_PROGRESS | PENDING | COMPLETED
```

### Status State Machine (v3)

```
initBook()              generateWithAi()        pollPageResult() 성공
  ──────► IN_PROGRESS ──────────────────► PENDING ──────────────► IN_PROGRESS
               ▲           (Lock + guard SET,        (Lambda 결과 감지,
               │            SQS 발행)                 Redis DEL, 페이지 저장)
               │
        completeBook() ← IN_PROGRESS 상태에서만 가능
               │
               ▼
            COMPLETED (불변)
```

- **PENDING → 재요청**: guard 있으면 409, guard 없으면 stale → IN_PROGRESS 취급
- **PENDING → completeBook**: 409 (Lambda 처리 중)

### State Transition Methods
```java
markAsPending()
  // 전제: status != COMPLETED
  // 결과: status → PENDING

markAsCompleted()
  // 전제: status != COMPLETED
  // 결과: status → COMPLETED

addBookPage(BookPage page)
  // 결과: 페이지 추가, status → IN_PROGRESS
```

### Commands
```
BookInitCommand
  - Long characterId
  - String background
  - Actor currentUser
  - String userInput

CreateOnePageCommand
  - String bipId
  - String userInput
  - Actor currentUser

CompleteBookCommand
  - Actor actor
  - String bookInProgressId
  - String title
  - String author
```

### Queue Message
```java
BookPageQueueMessage
  - String bipId
  - int pageIndex
  - String userInput
  - String characterName
  - String characterDescription
  - String backgroundInfo
```

### Repository
```java
List<BookInProgress> retrieveByMemberId(Long memberId)
BookInProgress retrieveById(String id)
BookInProgress save(BookInProgress bip)
BookInProgress addPageTo(String id, BookPage page)
```

### Services

**BookProgressService** (v3 구현)
```java
// initBook: BIP 생성 → SQS 발행(pageIndex=0) → 202
BookPageAccepted initBook(BookInitCommand command)

// generateWithAi: Lock → stale PENDING 판정 → PENDING 저장 → guard SET → SQS 발행 → 202
BookPageAccepted generateWithAi(CreateOnePageCommand command)

// pollPageResult: Redis 결과 확인 → 있으면 페이지 저장 → Redis DEL
BookPagePollResult pollPageResult(Actor user, String bipId)

// 소유자 또는 ADMIN만 조회 가능
BookInProgress retrieveById(Actor user, String bipId)
```

**BookCompleteExecutor** (v3 구현)
```java
// completeBook: Lock 없이 직접 실행
// BIP 상태 IN_PROGRESS 검증 (PENDING → 409)
// bookRepository.saveFrom() → BookCompleteEvent 발행 → COMPLETED 저장
Book completeBook(CompleteBookCommand command)
```

### Pending Guard
```
key: bip:pending-guard:{bipId}    TTL: 600s

Set  : generateWithAi Lock 임계 구역 내 (PENDING 저장 직후)
Del  : Lambda finally 블록 (성공/실패 무관)
stale: PENDING + guard 없음 → IN_PROGRESS 취급
```

### SQS 메시지 스키마
```json
{
  "bipId": "string",
  "pageIndex": 0,
  "userInput": "string",
  "characterName": "string",
  "characterDescription": "string",
  "backgroundInfo": "string"
}
```
- MessageGroupId: `{bipId}`
- MessageDeduplicationId: `{bipId}-{pageIndex}`

### Redis 결과 스키마 (Lambda 저장)
```
key: bip:result:{bipId}        TTL: 600s
value: { "pageIndex": 0, "context": "...", "imageUrl": "...", "questions": [...] }

key: idempotency:{messageId}   TTL: 86400s
value: IN_FLIGHT | {llmResult} | DONE
```

### 폴링 응답
```
GET /api/v1/book/progress/{id}/status
없음 → { status: "PENDING" }
있음 → DB 페이지 저장 → Redis DEL → { status: "COMPLETED", page: { ... } }
```

### Exceptions
| Method | Code | 설명 |
|---|---|---|
| `notFound(resource)` | E404 | 리소스 없음 |
| `forbiddenResource()` | E403 | 권한 없음 |
| `bookNotCompleted(bipId)` | E409 | IN_PROGRESS 아닌 상태에서 completeBook |
| `alreadyCompleted(bipId)` | E409 | 이미 완성됨 |
| `alreadyPending(bipId)` | E409 | 이미 Lambda 처리 중 (guard 있음) |

---

## 4. Character Context

**Responsibility:** 캐릭터 생성(비동기) 및 조회. 생성 진행 상태는 Redis로 관리.

### Entities

```
BookCharacter (record)                ← 완성된 캐릭터 (RDS 영구 저장)
  - Long id
  - Long userId
  - String name
  - String appearanceKeywords
  - String personality
  - String description
  - String imageUrl

CharacterInProgress (record)          ← 생성 진행 중 (Redis)
  - String id               ← compact UUID (cipId)
  - Long userId
  - String name
  - String appearanceKeywords
  - String personality
  - String description
  - Status status           ← IN_PROGRESS | COMPLETED
```

### CharacterInProgress Status Machine

```
requestCreate() → [IN_PROGRESS]
                       │
              Lambda 완료 → char:result:{cipId} 저장
                       │
         completeCharacter() 호출
                       │
                  [COMPLETED] → DB 저장 → BookCharacter 반환
```

### State Transition Methods
```java
// CharacterInProgress.java
toCreateCommand(String imageUrl)
  // 전제: status == IN_PROGRESS (위반 시 alreadyCompleted())
  // 결과: BookCharacterCreateCommand 반환

markAsCompleted()
  // 결과: status → COMPLETED
```

### Commands / Requests
```
BookCharacterCreateCommand
  - String name, personality, description, appearanceKeywords
  - String imageUrl
  - Long userId

BookCharacterGenerateRequest
  - Actor creator
  - String name, appearanceKeywords, personality, description
  → toCommand(imageUrl): BookCharacterCreateCommand

CharacterQueueMessage
  - String type ("CHARACTER")
  - String cipId
  - String name, appearanceKeywords, personality, description
```

### Repository (BookCharacter)
```java
BookCharacter retrieveById(Long characterId)
List<BookCharacter> retrieveByUser(Actor user)
BookCharacter createFrom(BookCharacterCreateCommand command)
```

### Repository (CharacterInProgress)
```java
void save(CharacterInProgress cip)
CharacterInProgress getById(String cipId)       // 없으면 notFound(E404)
void markAsCompleted(String cipId)
```

### Repository (CharacterResult - Redis)
```java
Optional<CharacterResult> find(String cipId)
void delete(String cipId)
```

### Service: BookCharacterService (v3)
```java
// 캐릭터 생성 요청: CIP 저장 → SQS 발행 → cipId 반환 (202)
String requestCreate(BookCharacterGenerateRequest request)

// 생성 상태 폴링: char:result:{cipId} 존재 여부 확인
CharacterPollResult pollStatus(Actor user, String cipId)
  // → PENDING | READY

// 캐릭터 완성: IN_PROGRESS 검증 → result 존재 검증 → DB 저장 → CIP COMPLETED
BookCharacter completeCharacter(Actor user, String cipId)

// 완성된 캐릭터 조회
BookCharacter retrieveById(Long characterId)
List<BookCharacter> retrieveByUser(Actor currentUser)
```

### Redis 키
```
char:progress:{cipId}    TTL: 1800s   (CharacterInProgress 상태)
char:result:{cipId}      TTL: 600s    (Lambda 결과, imageUrl 포함)
```

### SQS 메시지
```json
{
  "type": "CHARACTER",
  "cipId": "uuid",
  "name": "string",
  "appearanceKeywords": "string",
  "personality": "string",
  "description": "string"
}
```
- MessageGroupId: `character-{cipId}`
- MessageDeduplicationId: `character-{cipId}`

### Domain Rules
- `completeCharacter`: CIP가 IN_PROGRESS이어야 함 (COMPLETED → 409)
- `completeCharacter`: `char:result:{cipId}` 가 반드시 존재해야 함 (없으면 409)
- 소유권 검증: `cip.userId == user.id` (위반 시 403)

### Exceptions (CharacterInProgressException)
| Method | Code | 설명 |
|---|---|---|
| `notFound(cipId)` | E404 | CIP 없음 (만료 또는 미존재) |
| `alreadyCompleted(cipId)` | E409 | 이미 완성됨 |
| `resultNotReady(cipId)` | E409 | Lambda 결과 미도착 |
| `forbidden()` | E403 | 권한 없음 |

---

## 5. Image Context

**Responsibility:** 이미지 업로드 추상화. v3에서 페이지/캐릭터 이미지 업로드는 Lambda가 S3에 직접 수행.

> **v3 현황**: `ImageRepository` 인터페이스와 `ImageRepositoryAdapter`는 코드에 잔존하나 호출처 없음.
> Phase 4에서 정리 예정.

### Repository (현재 미사용)
```java
ImageUploadResult uploadTemporary(String url)         // 호출처 없음
ImageUploadResult uploadCharacterImage(String url)    // 호출처 없음
```

### Value Objects
```
ImageUploadResult (record)
  - String originUrl
  - String newUrl
```

---

## 6. Storage Implementation

### Redis Entities

**BookInProgressRedisEntity**
```
Key: book:inprogress:{id}    TTL: 360000s (100h)
Fields: id, memberId, backgroundInfo, character, storyLength, status
Status: IN_PROGRESS | PENDING | COMPLETED
```

**BookPageRedisEntity**
```
Key: book:pages:{bookId}     TTL: 3600s
Type: Redis List
Fields: bookInProgressId, context, imageUrl, pageNumber
```

**CharacterInProgress**
```
Key: char:progress:{cipId}   TTL: 1800s
Fields: id, userId, name, appearanceKeywords, personality, description, status
Status: IN_PROGRESS | COMPLETED
```

**Pending Guard**
```
Key: bip:pending-guard:{bipId}   TTL: 600s
Value: "1"
```

**Result Keys (Lambda 저장)**
```
Key: bip:result:{bipId}       TTL: 600s
Key: char:result:{cipId}      TTL: 600s
```

**Idempotency (Lambda 관리)**
```
Key: idempotency:{messageId}          TTL: 86400s   (페이지)
Key: idempotency:char:{messageId}     TTL: 86400s   (캐릭터)
Value: IN_FLIGHT | DONE
```

**Member Index**
```
Key: member:{memberId}:bip   → Set of BIP IDs
```

### Redis Lock
```java
RedisLockManager
  <T> execute(String key, long expireMillis, Supplier<T> action)
  // SET NX EX → 성공 시 action 실행 → Lua script atomic 해제

Lock Key: bip:lock:{bipId}    TTL: 120000ms
```
> completeBook의 Lock은 v3에서 제거됨. generateWithAi Lock은 SQS FIFO MessageGroupId로 중복 방지 보완.

---

## Dependency Graph (v3)

```
BookProgressService
  ├── BookCharacterRepository     (Character ctx)
  ├── BookInProgressRepository    (BookProgress ctx / Redis)
  ├── BookPageQueuePublisher      (SQS → Lambda)
  ├── BookPageResultRepository    (Redis / Lambda 결과 수신)
  ├── BookInProgressPendingGuard  (Redis / stale PENDING 방지)
  └── BookInProgressLockExecutor  (Redis)

BookCompleteExecutor
  ├── BookInProgressRepository
  ├── BookCharacterRepository
  └── BookRepository              (Book ctx)

BookCharacterService
  ├── BookCharacterRepository
  ├── CharacterInProgressRepository  (Redis)
  ├── CharacterQueuePublisher        (SQS → Lambda)
  └── CharacterResultRepository      (Redis / Lambda 결과 수신)
```

---

## API Endpoints

| Method | Path | Handler | 설명 |
|---|---|---|---|
| POST | `/api/v1/member/signup` | MemberController | 회원가입 |
| POST | `/api/v1/member/login` | MemberController | 로그인 |
| GET | `/api/v1/book/board/{bookId}` | BookController | 책 상세 |
| GET | `/api/v1/book/board/all` | BookController | 책 목록 (페이징·정렬) |
| GET | `/api/v1/book/my` | BookController | 내 책 목록 |
| POST | `/api/v1/book/progress/init` | BookProgressController | 책 작성 시작 → 202 + bipId |
| POST | `/api/v1/book/progress/{id}` | BookProgressController | 페이지 생성 (SQS) → 202 + bipId |
| GET | `/api/v1/book/progress/{id}/status` | BookProgressController | 페이지 생성 완료 폴링 |
| POST | `/api/v1/book/progress/{id}/complete` | BookProgressController | 책 완성 (IN_PROGRESS 필요) |
| GET | `/api/v1/book/progress/{id}` | BookProgressController | 진행 상황 조회 |
| GET | `/api/v1/character/my` | CharacterController | 내 캐릭터 목록 |
| GET | `/api/v1/character/board/{id}` | CharacterController | 캐릭터 상세 |
| POST | `/api/v1/character/create` | CharacterController | 캐릭터 생성 요청 → 202 + cipId |
| GET | `/api/v1/character/{cipId}/status` | CharacterController | 캐릭터 생성 완료 폴링 → PENDING\|READY |
| POST | `/api/v1/character/{cipId}/complete` | CharacterController | 캐릭터 완성 → DB 저장 → 200 |

---

## Exception Code Reference

| Code | HTTP | 의미 |
|---|---|---|
| E400 | 400 | Bad Request (유효성 오류) |
| E401 | 401 | Unauthorized (인증 실패) |
| E403 | 403 | Forbidden (권한 없음) |
| E404 | 404 | Not Found |
| E409 | 409 | Conflict (상태 충돌, 중복) |
| E500 | 500 | Internal Server Error |
