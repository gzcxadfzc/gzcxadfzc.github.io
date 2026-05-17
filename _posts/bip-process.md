# BIP (BookInProgress) 처리 구조

## 개요

책 한 권을 만드는 작업 단위. 클라이언트가 페이지를 요청하면 SQS를 통해 Lambda에 위임하고,
Lambda가 LLM + 이미지를 생성한 뒤 Redis에 결과를 저장한다. 클라이언트는 poll로 완료 여부를 확인하고, confirm으로 BIP를 업데이트한다.

poll과 confirm이 분리되어 있다. poll은 순수 읽기(멱등)이고, BIP 상태 변경은 confirm에서만 일어난다.

---

## Redis 키 구조

| 키 | 값 | TTL | 역할 |
|---|---|---|---|
| `book:inprogress:{bipId}` | `BookInProgressRedisEntity` (JSON) | 100시간 | BIP 메타 + 상태 |
| `book:pages:{bipId}` | `List<BookPageRedisEntity>` (JSON) | - | 생성된 페이지 목록 |
| `bip:result:{bipId}` | `BookPageResult` (JSON) | - | Lambda → 메인앱 결과 전달 채널 |
| `bip:lock:{bipId}` | `"1"` | 120초 | BIP 수정 시 분산 락 |
| `bip:pending-guard:{bipId}` | `"1"` | 600초 | PENDING stale 상태 감지용 |
| `member:{memberId}:bip` | `Set<String>` | - | 회원별 BIP ID 인덱스 |

> BIP 메타(`book:inprogress`)와 페이지 목록(`book:pages`)이 분리 저장된다.
> 조회 시 두 키를 합쳐서 도메인 객체(`BookInProgress`)를 조립한다.

---

## 상태 전이

```
fromCommand()
     │
     ▼
IN_PROGRESS  ◄─────────────────────────────┐
     │                                     │
     │  generateWithAi() + lock            │
     ▼                                     │
  PENDING                                  │
     │                                     │
     │  Lambda 완료 → bip:result 저장       │
     │                                     │
     │  pollPageStatus() → COMPLETED 반환  │
     │  confirmPage() + lock               │
     ▼                                     │
  페이지 추가 → guard 삭제 → result 삭제 ──┘
```

---

## 전체 흐름

### 1단계 — 책 초기화 (`POST /api/v1/book/progress/init`)

```
클라이언트                메인앱                    SQS        Lambda
    │                      │                         │            │
    │── BookInitRequest ──▶│                         │            │
    │                      │ BookInProgress 생성      │            │
    │                      │ Redis save (IN_PROGRESS) │            │
    │                      │── BookPageQueueMessage ─▶│            │
    │                      │                         │── 메시지 ──▶│
    │◀── bipId ────────────│                         │            │ (LLM + 이미지 생성 중)
```

- `BookInProgress` 생성 후 즉시 Redis에 저장
- SQS에 메시지 발행 후 `bipId`만 반환 (202 Accepted)
- Lambda는 비동기로 처음 페이지를 생성하기 시작

---

### 2단계 — 결과 polling (`GET /api/v1/book/progress/{id}/status`) — 순수 읽기

```
클라이언트                메인앱                Redis
    │                      │                    │
    │── GET /status ───────▶│                   │
    │                      │── GET bip:result ─▶│
    │                      │◀── (없음) ──────────│
    │◀── PENDING ──────────│                    │
    │                      │                    │
    │   (반복)              │       Lambda가 완료되어 bip:result 저장됨
    │                      │                    │
    │── GET /status ───────▶│                   │
    │                      │── GET bip:result ─▶│
    │                      │◀── BookPageResult ──│
    │◀── COMPLETED + page ─│  (BIP 수정 없음)   │
```

poll은 `bip:result` 조회만 한다. BIP 변경 없음. 같은 요청을 여러 번 호출해도 같은 결과를 반환한다.

---

### 2.5단계 — confirm (`POST /api/v1/book/progress/{id}/confirm`) — BIP 업데이트

```
클라이언트                메인앱                Redis
    │                      │                    │
    │── POST /confirm ─────▶│                   │
    │                      │ lock 획득           │
    │                      │── GET bip:result ─▶│
    │                      │◀── BookPageResult ──│
    │                      │                    │
    │                      │ pageIndex 중복 체크  │
    │                      │── save(BIP + page) ▶│
    │                      │── DELETE result ───▶│
    │                      │── DELETE guard ────▶│
    │                      │ lock 해제           │
    │◀── 204 No Content ───│                    │
```

**멱등성 보장 방식**

- **락** → 동시 confirm 직렬화
- **result 존재 여부** → result 없으면 ifPresent 스킵 (이미 confirm된 경우 no-op)
- **pageIndex 중복 체크** → BIP 저장 성공 후 result 삭제 실패 시 재시도해도 페이지 중복 없음

```java
boolean alreadyAdded = bip.previousPages().stream()
        .anyMatch(p -> p.pageNumber() == page.pageIndex());
if (!alreadyAdded) {
    bookInProgressRepository.save(bip.addBookPage(...));
}
bookPageResultRepository.delete(bipId);
pendingGuard.delete(bipId);
```

---

### 3단계 — 다음 페이지 생성 (`POST /api/v1/book/progress/{id}`)

```
클라이언트                메인앱                    SQS
    │                      │                         │
    │── BookProgressRequest▶│                         │
    │                      │ lock 획득 (bip:lock)     │
    │                      │ BIP status → PENDING     │
    │                      │── save(PENDING) ─────────▶ Redis
    │                      │ pendingGuard.set()        │
    │                      │── BookPageQueueMessage ──▶│
    │◀── bipId ────────────│ lock 해제                │
```

- 반드시 lock을 잡은 상태에서 PENDING으로 변경
- `pendingGuard` 설정 (Lambda 크래시 대비)
- 2단계 polling 반복

---

### 4단계 — 책 완성 (`POST /api/v1/book/progress/{id}/complete`)

```
클라이언트                메인앱                    DB
    │                      │                         │
    │── BookCompleteRequest▶│                         │
    │                      │ lock 획득 (bip:lock)     │
    │                      │ PENDING이면 예외          │
    │                      │── Book.completeFromCommand│
    │                      │── bookRepository.saveFrom▶│ (DB 저장)
    │◀── BookResponse ─────│ lock 해제                │
```

> BIP 자체의 status는 COMPLETED로 변경되지 않는다. Book이 DB에 저장되는 것이 완료 처리다.

---

## 동시성 제어

### 분산 락 (`bip:lock:{bipId}`, TTL 120초)

세 곳에서 사용한다.

| 호출 위치 | 락 안에서 하는 일 |
|---|---|
| `generateWithAi()` | PENDING 체크 → status 변경 → SQS 발행 |
| `confirmPage()` | pageIndex 중복 체크 → BIP 업데이트 → result/guard 삭제 |
| `completeBook()` | PENDING 체크 → Book DB 저장 |

### PendingGuard (`bip:pending-guard:{bipId}`, TTL 600초)

Lambda 하드 크래시 시 BIP가 PENDING으로 영구 고착되는 것을 방지한다.

```
generateWithAi() → pendingGuard.set()
confirmPage()    → pendingGuard.delete()  ← confirm 시 명시적 삭제

다음 generateWithAi() 호출 시:
  - PENDING 상태 + guard 존재 → 예외 (Lambda 처리 중)
  - PENDING 상태 + guard 없음 → stale 판단, 정상 진행
```

---

## 컴포넌트 역할 요약

```
BookProgressController        API 진입점, 요청/응답 변환
BookProgressService           핵심 비즈니스 로직 (initBook, generateWithAi, pollPageStatus, confirmPage)
BookCompleteExecutor          책 완성 전용 (lock + DB 저장)
BookInProgressLockExecutor    분산 락 획득/해제 추상화
BookInProgressPendingGuard    PENDING 마커 관리
BookPageResultRepository      bip:result 읽기/삭제 (Lambda 결과 채널)
BookInProgressRepositoryAdapter   BIP ↔ Redis 변환 (메타 + 페이지 분리 저장)
```

---

## 저장 구조 상세

`BookInProgressRepositoryAdapter.save()` 호출 시:

```
1. BookInProgressRedisEntity 저장 (storyLength만 기록, 페이지 내용 없음)
2. book:pages:{bipId} 전체 삭제
3. 페이지 목록 전체 재append
```

페이지가 1개 추가될 때마다 전체 페이지를 재작성한다.

`retrieveById()` 호출 시:

```
1. book:inprogress:{bipId} 조회
2. book:pages:{bipId} 조회
3. 두 결과를 합쳐 BookInProgress 도메인 객체 반환
```

---

## 잔존 문제점

| 문제 | 위치 | 내용 |
|---|---|---|
| completeBook BIP 미갱신 | `BookCompleteExecutor` | Book DB 저장 후 BIP status가 COMPLETED로 변경되지 않음 |
| 페이지 전체 재작성 | `BookInProgressRepositoryAdapter.save()` | 페이지 추가 시 기존 전체 삭제 후 재insert |
| Lambda guard 미삭제 | Lambda | 정상 완료 후 guard를 직접 삭제하지 않음 (confirmPage가 삭제하므로 기능상 무해) |
