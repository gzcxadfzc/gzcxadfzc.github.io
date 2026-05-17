# Performance 이슈 기록

---

## [P1] GET /book/board/all — COUNT(*) Full Scan

### 발견 경위
k6 read 부하테스트(100 VU) 중 `GET /book/board/all` 요청이 timeout되며 서버가 응답 불가 상태에 빠짐.
테스트 데이터 누적량: 약 130,000건.

### 원인
`BookJpaRepository.findAll(Pageable)` 사용 시 Spring Data JPA가 아래 두 쿼리를 항상 함께 실행:

```sql
-- 1. 실제 데이터 (LIMIT 적용, 빠름)
SELECT * FROM book ORDER BY created_at DESC LIMIT 10 OFFSET 0

-- 2. 전체 개수 (full scan, 느림)
SELECT COUNT(*) FROM book
```

데이터가 많아질수록 COUNT(*) 쿼리가 선형적으로 느려지며, 100 VU 동시 요청 시 DB 커넥션 고갈 및 timeout 발생.

### 영향 범위
- `GET /api/v1/book/board/all` 엔드포인트
- `BookRepositoryAdapter.retrieveThumbnails()`
- `BookJpaRepository.findAll(Pageable)`

### 해결 방안

#### 방안 1. Slice 기반 커서 페이징으로 전환 (권장)
`Page` 대신 `Slice`를 사용하면 COUNT 쿼리를 실행하지 않음.
클라이언트는 "다음 페이지 있음/없음" 여부만 알 수 있고 전체 페이지 수는 알 수 없음.

```java
// BookJpaRepository
Slice<BookJpaEntity> findAll(Pageable pageable);

// BookRepositoryAdapter
Slice<BookJpaEntity> entitySlice = bookJpaRepository.findAll(pageable);
// entitySlice.hasNext() 로 다음 페이지 존재 여부 확인
```

#### 방안 2. COUNT 쿼리 분리 및 캐싱
COUNT 쿼리를 별도로 분리하고 Redis 등으로 캐싱 (TTL 30초~1분).
전체 건수가 필요한 경우 선택.

```java
@Query(value = "SELECT b FROM BookJpaEntity b",
       countQuery = "SELECT COUNT(b.id) FROM BookJpaEntity b")
Page<BookJpaEntity> findAll(Pageable pageable);
```

count 결과를 `@Cacheable`로 캐싱하여 매 요청마다 full scan 방지.

#### 방안 3. created_at 인덱스 추가
정렬 컬럼에 인덱스가 없으면 ORDER BY도 full scan. 인덱스 추가만으로도 개선 가능.

```sql
CREATE INDEX idx_book_created_at ON book(created_at DESC);
```

### 권장 적용 순서
1. `idx_book_created_at` 인덱스 추가 (즉시 적용 가능, 리스크 낮음)
2. `Slice` 기반 커서 페이징 전환 (API 스펙 변경 필요)

---

## [P2] GET /book/board/{id} — 동일 쿼리 이중 실행

### 발견 경위
`read-book.js` 부하테스트 코드 리뷰 및 정적 분석 중 발견.

### 원인
`BookService.retrieveByBookId()`에서 null 체크 후 동일 쿼리를 한 번 더 실행:

```java
// BookService.java
public Book retrieveByBookId(String bookId) {
    Book book = bookRepository.retrieveById(bookId);  // 1차 조회
    if (book == null) {
        throw BookException.notFound(bookId);
    }
    return bookRepository.retrieveById(bookId);  // 2차 조회 (불필요)
}
```

`retrieveById()` 내부에서 실행되는 쿼리:
```sql
-- (1) book + character JOIN 쿼리
SELECT b.id, b.user_id, b.title, ... , c.id, c.name, ...
FROM book b INNER JOIN main_character c ON b.character_id = c.id
WHERE b.id = ?

-- (2) book_page 쿼리
SELECT * FROM book_page WHERE book_id = ?
```

단건 조회 1회당 DB 쿼리 총 **4회** 발생 (위 2쌍이 두 번 실행).
100 VU 기준 DB 요청 수 2배 증가.

### 영향 범위
- `GET /api/v1/book/board/{id}` 엔드포인트
- `BookService.retrieveByBookId()`
- `BookRepositoryAdapter.retrieveById()`

### 해결 방안
1차 조회 결과를 재사용:

```java
public Book retrieveByBookId(String bookId) {
    Book book = bookRepository.retrieveById(bookId);
    if (book == null) {
        throw BookException.notFound(bookId);
    }
    return book;  // 이미 조회된 객체 반환
}
```

### 기대 효과
- `/book/board/{id}` DB 쿼리 수 50% 감소
- 적용 난이도: 낮음 (1줄 수정)

---

## [P3] 외래 키 컬럼 인덱스 누락

### 발견 경위
`read-book.js` 정적 분석 — `my_books`, `my_chars` 엔드포인트의 쿼리 경로 추적.

### 원인
JPA 엔티티에 `@Index` 어노테이션이 없고 별도 DDL 스크립트도 없음.
아래 컬럼들이 FK로 사용되지만 인덱스 미생성 상태:

| 테이블 | 컬럼 | 사용 쿼리 | 영향 엔드포인트 |
|--------|------|-----------|----------------|
| `book` | `user_id` | `findAllByUserId(Long)` | GET /book/my |
| `book` | `created_at` | `ORDER BY created_at DESC` | GET /book/board/all |
| `book_page` | `book_id` | `findAllByBookId(String)` | GET /book/board/{id} |
| `main_character` | `member_id` | `findByMemberId(Long)` | GET /character/my |

데이터가 적을 때는 full scan이 빠르지만, 데이터 누적 시 선형 저하 발생.
현재 book 테이블 130,000건 기준으로 이미 `/board/all` timeout 경험(P1).

### 해결 방안

#### JPA 엔티티에 @Table 인덱스 추가

```java
// BookJpaEntity.java
@Entity
@Table(name = "book", indexes = {
    @Index(name = "idx_book_user_id",    columnList = "user_id"),
    @Index(name = "idx_book_created_at", columnList = "created_at DESC")
})
public class BookJpaEntity { ... }

// BookPageJpaEntity.java
@Entity
@Table(name = "book_page", indexes = {
    @Index(name = "idx_book_page_book_id", columnList = "book_id")
})
public class BookPageJpaEntity { ... }

// CharacterJpaEntity.java
@Entity
@Table(name = "main_character", indexes = {
    @Index(name = "idx_character_member_id", columnList = "member_id")
})
public class CharacterJpaEntity { ... }
```

#### 또는 직접 SQL 실행 (prod 환경, ddl-auto: validate)

```sql
CREATE INDEX idx_book_user_id       ON book(user_id);
CREATE INDEX idx_book_created_at    ON book(created_at DESC);
CREATE INDEX idx_book_page_book_id  ON book_page(book_id);
CREATE INDEX idx_character_member_id ON main_character(member_id);
```

### 기대 효과
- `GET /book/my`: O(N) full scan → O(log N) index scan
- `GET /character/my`: O(N) full scan → O(log N) index scan
- `GET /book/board/{id}` 내 book_page 조회 개선

---

## [P4] 조회 엔드포인트 캐싱 미적용

### 발견 경위
`read-book.js` 정적 분석 — Redis 설정 확인 시.

### 원인
Redis가 인프라에 구성되어 있고 `RedisConfig`도 존재하지만,
조회 API에는 캐싱이 전혀 적용되지 않아 매 요청마다 DB 쿼리 발생.

현재 Redis 활용 현황:
- `BookInProgressRedisEntity`: 책 진행 중 상태 저장 (쓰기 경로)
- `BookPageRedisEntity`: 페이지 임시 저장 (쓰기 경로)
- **읽기 경로 캐싱: 없음**

`read-book.js` 기준 100 VU × 4개 엔드포인트 = 초당 수백 건의 동일 DB 쿼리 발생.

### 해결 방안

#### 방안 1. Spring Cache + Redis (@Cacheable)

```java
// RedisCacheConfig.java
@Configuration
@EnableCaching
public class RedisCacheConfig {

    @Bean
    public CacheManager cacheManager(RedisConnectionFactory connectionFactory) {
        RedisCacheConfiguration defaultConfig = RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofSeconds(30))
            .disableCachingNullValues();

        return RedisCacheManager.builder(connectionFactory)
            .cacheDefaults(defaultConfig)
            .withCacheConfiguration("book-thumbnails",
                RedisCacheConfiguration.defaultCacheConfig().entryTtl(Duration.ofSeconds(30)))
            .withCacheConfiguration("book-detail",
                RedisCacheConfiguration.defaultCacheConfig().entryTtl(Duration.ofMinutes(5)))
            .build();
    }
}

// BookService.java
@Cacheable(value = "book-detail", key = "#bookId")
public Book retrieveByBookId(String bookId) { ... }

@Cacheable(value = "book-thumbnails", key = "#query.sort + '_' + #query.index")
public PageResult<BookThumbnail> retrieveBookThumbnails(BookRetrieveQuery query) { ... }
```

#### 캐시 무효화 전략
- `book-detail`: 책 수정/삭제 시 `@CacheEvict`
- `book-thumbnails`: TTL 만료 방식 (30초) — 신규 책 반영 지연 허용

### 기대 효과
- Cache hit 시 DB 쿼리 0회
- 100 VU 부하 시 DB 쿼리 수 대폭 감소
- `board_all_duration` p(95) 임계값 500ms 달성 가능성 높아짐

---

## read-book.js 부하 테스트 시나리오 요약

### 테스트 구성

| 항목 | 값 |
|------|-----|
| 도구 | k6 |
| VU 수 | 최대 100 |
| 총 시간 | 4분 (30s 워밍업 + 1m 증가 + 2m 유지 + 30s 쿨다운) |
| setup | 100개 유저/책 사전 생성 |
| 주요 패턴 | 공개 목록 → 단건 조회 → 내 책 → 내 캐릭터 |

### 측정 대상 엔드포인트 및 임계값

| 엔드포인트 | 메트릭 | 임계값 | 인증 |
|-----------|--------|--------|------|
| GET /api/v1/book/board/all | `board_all_duration` p(95) | < 500ms | 불필요 |
| GET /api/v1/book/board/{id} | `book_detail_duration` p(95) | < 300ms | 불필요 |
| GET /api/v1/book/my | `my_books_duration` p(95) | < 300ms | JWT 필요 |
| GET /api/v1/character/my | `my_chars_duration` p(95) | < 300ms | JWT 필요 |
| 전체 | `error_rate` | < 5% | - |

### setup 단계 문제점
`setup()`에서 100개 유저 생성 시 각각 4개 API 순차 호출 (signup → character → init → complete).
AI/이미지 처리가 실제 환경에서는 수 초가 소요되므로 `load-test` 프로파일 필수.

---

## 개선 우선순위 요약

| 우선순위 | 이슈 | 적용 난이도 | 기대 효과 |
|---------|------|------------|----------|
| P1 (완료 분석) | /board/all COUNT(*) full scan | 중 | 매우 큼 (timeout 해소) |
| P2 | /board/{id} 이중 쿼리 | 낮음 | 중간 (DB 요청 50% 감소) |
| P3 | FK 컬럼 인덱스 누락 | 낮음 | 큼 (데이터 증가 시 선형 저하 방지) |
| P4 | 조회 캐싱 미적용 | 중 | 매우 큼 (DB 부하 대폭 감소) |
