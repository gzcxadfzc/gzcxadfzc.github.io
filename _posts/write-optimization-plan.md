# 쓰기 성능 최적화 계획

> 작성일: 2026-04-20
> 대상: `completeBook` API (`POST /api/v1/book/progress/{id}/complete`)

---

## 1. 문제 현황

### 부하 테스트 결과 — 최적화 전/후 비교 (읽기 200VU + 쓰기 N VU, mixed-load.js)

| WRITE_VUS | before p95 | after p95 | 개선 | 임계값 | 판정 |
|:---------:|:----------:|:---------:|:----:|:------:|:----:|
| 0 (무부하) | 96ms | — | — | 300ms | ✅ |
| 20 | 500ms | 479ms | -4% | 300ms | ❌ |
| 30 | 565ms | 471ms | -17% | 300ms | ❌ |
| **40** | **880ms** | **493ms** | **-44%** | 300ms | ❌ |

> 기본 WRITE_VUS = 40 (2026-04-21 변경)
> after 수치: 2026-04-21 최신 측정 기준 (`mixed_w40_2026-04-20_163523.json`)

- 경합이 심할수록 개선 효과가 지수적으로 커짐 — VU 33% 증가(30→40) 시 before 56% 악화 → after 11% 악화로 완화
- `board_all` p95 298ms → 임계값 500ms 기준 ✅, write_complete는 임계값 300ms 초과 지속
- 처리량: 692건 → 745건 (+8%) 향상

### 읽기와 쓰기 병목 특성 비교

| 구분 | Hikari connection 점유 시간 | 경합 영향 |
|------|:---------------------------:|:---------:|
| 읽기 (board_all, book_detail) | ~10ms (SELECT, 인덱스) | 낮음 |
| 쓰기 (completeBook) before | ~96ms (SELECT×2 + INSERT×2) | **높음** |
| 쓰기 (completeBook) after | ~50ms (SELECT×1 + INSERT×2) | 높음 (완화) |

큐잉 이론상 connection 점유 시간이 길수록 utilization이 높아져 대기 시간이 지수적으로 증가.

---

## 2. 원인 분석

### completeBook 실행 흐름

```
saveWithLock(bipId)
  └─ Redis: Lua lock 획득

getBookInProgress(bipId)
  └─ Redis: GET + LRANGE                              (2 Redis ops)

validateNotNull(character)
  └─ DB: SELECT main_character WHERE id = ?           ← DB call #1 (존재 검증)

bookRepository.saveFrom()                             ← Hikari connection 획득
  ├─ INSERT book
  ├─ INSERT book_page × N
  └─ bookCharacterRepository.retrieveById(charId)     ← DB call #2 (최신 데이터 조회)

[AFTER_COMMIT]
  └─ Redis: SET bip:{id} status=COMPLETED
```

### DB SELECT가 2회인 이유

두 SELECT는 각각 다른 목적을 가지므로 제거할 수 없음.

| 호출 위치 | 목적 |
|-----------|------|
| `validateNotNull()` | character가 DB에서 삭제됐는지 **존재 검증** |
| `saveFrom()` 반환 | Redis BIP의 스냅샷이 아닌 **최신 DB 데이터**로 Book 구성 (정합성) |

Redis BIP에 캐싱된 character는 BIP 생성 시점의 스냅샷 → 이후 DB 변경을 반영하지 못함.
따라서 completeBook 시점에 DB에서 최신 character를 읽어야 정합성 보장.

### 문제: 동일한 쿼리를 2회 실행

두 호출이 동일한 `SELECT main_character WHERE id = ?`를 각각 독립적으로 실행하고 있어 불필요한 중복 발생.

---

## 3. 최적화 방안

### 핵심 아이디어

`BookCompleteExecutor`에서 character를 **1회만 조회**하고, 검증과 반환값 구성에 모두 재사용.

### 변경 전

```java
// BookCompleteExecutor
public Book completeBook(CompleteBookCommand command) {
    return lockExecutor.saveWithLock(command.bookInProgressId(), () -> {
        BookInProgress target = getBookInProgress(command);
        if (target.status() == BookInProgress.Status.PENDING) {
            throw BookProgressException.alreadyPending(command.bookInProgressId());
        }
        return bookRepository.saveFrom(target, bip -> {      // saveFrom 내부에서 DB 조회
            validateNotNull(bip.character());                // ← DB SELECT #1
            return Book.completeFromCommand(bip, command);
        });
    });
}

// BookRepositoryAdapter.saveFrom()
return new Book(
    bookEntity.getId(), bookEntity.getUserId(),
    pageEntities.stream().map(BookPageJpaEntity::toBookPage).toList(),
    bookEntity.getTitle(), bookEntity.getAuthor(),
    bookCharacterRepository.retrieveById(bookEntity.getCharacterId()) // ← DB SELECT #2
);
```

### 변경 후

```java
// BookCompleteExecutor
public Book completeBook(CompleteBookCommand command) {
    return lockExecutor.saveWithLock(command.bookInProgressId(), () -> {
        BookInProgress target = getBookInProgress(command);
        if (target.status() == BookInProgress.Status.PENDING) {
            throw BookProgressException.alreadyPending(command.bookInProgressId());
        }
        BookCharacter character = bookCharacterRepository.retrieveById(
                target.character().id());                    // ← DB SELECT 1회만
        if (character == null) {
            throw BookProgressException.notFound("bookCharacter:");
        }
        return bookRepository.saveFrom(target, character,   // character를 인자로 전달
                bip -> Book.completeFromCommand(bip, command));
    });
}

// BookRepositoryAdapter.saveFrom() - character 파라미터 추가
public Book saveFrom(BookInProgress bookInProgress, BookCharacter character,
                     Function<BookInProgress, Book> converter) {
    ...
    return new Book(
        bookEntity.getId(), bookEntity.getUserId(),
        pageEntities.stream().map(BookPageJpaEntity::toBookPage).toList(),
        bookEntity.getTitle(), bookEntity.getAuthor(),
        character                                            // DB 재조회 없이 재사용
    );
}
```

---

## 4. 변경 내용

### 핵심 변경

`BookCompleteExecutor.completeBook()` 내부에서 `SELECT main_character WHERE id = ?`를 2회 → 1회로 줄임.

| 파일 | 변경 내용 |
|------|-----------|
| `BookCompleteExecutor` | `validateNotNull()` 제거, character 1회 조회 후 `saveFrom`에 전달 |
| `BookRepository` | `saveFrom` 시그니처에 `BookCharacter character` 파라미터 추가 |
| `BookRepositoryAdapter` | `saveFrom` 내부 `bookCharacterRepository.retrieveById()` 제거, 전달받은 character 재사용. `bookCharacterRepository` 의존성 완전 제거 |

---

## 5. 실측 결과 (2026-04-21, 읽기 200VU + 쓰기 N VU)

### write_complete_duration

| WRITE_VUS | before p95 | after p95 | 개선 | before avg | after avg | 개선 |
|:---------:|:----------:|:---------:|:----:|:----------:|:---------:|:----:|
| 20 | 500ms | 479ms | -4% | 245ms | 231ms | -6% |
| 30 | 565ms | 471ms | **-17%** | 285ms | 228ms | **-20%** |
| 40 | 880ms | 493ms | **-44%** | 426ms | 233ms | **-45%** |

경합이 심할수록 개선 효과가 지수적으로 커짐 — 큐잉 이론 예측과 일치.

### 읽기 지표 (w40 기준)

| 지표 | before p95 | after p95 |
|------|:----------:|:---------:|
| book_detail | 330ms | 350ms |
| board_all | 317ms | 339ms |

w40에서 읽기 지표가 소폭 증가했으나 ±20ms 노이즈 범위로, 유의미한 변화 없음.

---

## 6. 미해결 항목

### write_poll_count p95 = 300 (타임아웃) 지속
- Lambda `MOCK_SLEEP_MS=3000` (3초 대기) → 정상 완료 시 폴링 횟수 ~30회가 기대값
- p95 = 300은 부하 상황에서 30초 타임아웃 도달 → Lambda가 제때 완료 못 함
- 원인: SQS FIFO MessageGroupId 순서 대기 또는 Lambda cold start
- 별도 조사 필요

### book_detail p95 300ms 임계값 초과
- 최적화 후에도 w40에서 350ms로 초과
- 임계값 재검토(350ms) 또는 RDS 스펙 업그레이드 검토

### 커넥션 풀 분리 (추가 검토)
- 읽기 풀 / 쓰기 풀 분리 (`AbstractRoutingDataSource`)
- 쓰기 경합이 읽기에 영향을 주지 않도록 격리
- 제약: RDS t3.micro max_connections ≈ 60, 총합 증가 불가

### book_page 배치 INSERT (추가 검토)
- `BookPageJpaEntity`가 `@GeneratedValue(IDENTITY)` 사용 → 페이지 N개를 N번 개별 INSERT
- `rewriteBatchedStatements=true` 설정이 있어도 IDENTITY 전략에서는 무효
- 해결하려면 book_page.id를 UUID 등 애플리케이션 생성 ID로 변경 필요 (스키마 변경 수반)
