# BIP 락 구조

BIP(BookInProgress)를 보호하는 두 가지 장치.

- **분산 락** (`bip:lock`) — 동시에 두 요청이 같은 BIP를 수정하지 못하게 막는다
- **PendingGuard** (`bip:pending-guard`) — Lambda가 죽었을 때 PENDING이 영구 고착되는 것을 방지한다

---

## 1. 분산 락 (`bip:lock:{bipId}`)

### 왜 필요한가

클라이언트가 "다음 페이지 생성" 버튼을 빠르게 두 번 누르면 두 요청이 동시에 서버에 도달할 수 있다.

```
요청 A: BIP 읽기 → IN_PROGRESS 확인 → PENDING 저장 → SQS 발행
요청 B: BIP 읽기 → IN_PROGRESS 확인 → PENDING 저장 → SQS 발행
                              ↑
            두 요청이 동시에 이 시점을 통과하면 Lambda가 두 번 실행된다
```

**PENDING 상태 체크만으로는 부족하다.** 두 요청이 동시에 `IN_PROGRESS`를 읽으면 둘 다 체크를 통과한다.
락은 이 간극을 원자적으로 막는다.

> 이 내용은 SQS FIFO dedup으로 대체 가능한지 검토한 적 있다.
> 결론: dedup은 처리 중복을 막지만 요청 B에게 202를 반환하므로 B는 자신의 userInput이 처리됐다고 오해한다. Lock 유지가 맞다.

---

### 구현 — Redis SET NX + Lua 스크립트

**락 획득**

```java
// RedisLockManager.java:49-57
String lockId = UuidGen.compact();          // 랜덤 UUID 생성 (소유자 식별용)
connection.set(key, lockId,
    Expiration.milliseconds(expireMillis),
    RedisStringCommands.SetOption.SET_IF_ABSENT);  // NX
```

Redis 명령으로 보면:

```
SET bip:lock:{bipId}  <uuid>  PX 120000  NX
                      └─소유자  └─ 120초  └─ 키 없을 때만
```

- 키가 없으면 → UUID 저장, 획득 성공
- 키가 이미 있으면 → 즉시 실패 (재시도 없음)

**락 해제 — Lua 스크립트로 원자적 처리**

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0
end
```

GET 후 DEL을 Lua로 묶는 이유:
GET → DEL 사이에 TTL이 만료돼 다른 요청이 락을 가져갈 수 있다.
UUID 비교를 통해 내 락일 때만 삭제해 다른 요청의 락을 실수로 해제하는 것을 막는다.

---

### 락 해제 — RedisCallback에서 Lua로 변경한 이유

원래 구현은 `RedisCallback`으로 GET → DEL을 같은 커넥션에서 실행했다.

```java
// 변경 전 (커밋 77d8a2b)
private void releaseLock(String key, String lockId) {
    redisTemplate.execute((RedisCallback<Void>) connection -> {
        byte[] v = connection.get(k);           // GET
        if (lockId.equals(deserialize(v))) {
            connection.del(k);                  // DEL
        }
        return null;
    });
}
```

`RedisCallback`은 같은 커넥션을 재사용할 뿐, **원자성을 보장하지 않는다.**
Redis 서버 입장에서 GET과 DEL은 여전히 별개 명령이다.

```
스레드 A: GET → "내 UUID 맞음" 확인
                  ↑ 여기서 TTL 만료, 스레드 B가 SET NX로 락 획득
스레드 A: DEL → 스레드 B의 락을 삭제
스레드 C: SET NX 성공 → B와 C 동시에 임계 구역 진입
```

Lua 스크립트는 Redis가 **단일 명령처럼 원자적으로 실행**한다.
GET과 DEL 사이에 다른 클라이언트가 개입할 수 없다.

> `fix: bookInProgress racecondition을 위해 lua script 기반 lock으로 수정` (cdc3dec)

---

### UUID(lockId)가 없으면 생기는 문제

```
요청 A: 락 획득 → 작업 시작
        → 처리가 길어져 TTL 120초 만료
        → 락 자동 삭제
요청 B: 락 획득
요청 A: finally 블록 DEL 실행
        → UUID 없으면 요청 B의 락이 삭제됨  ← 버그
        → UUID 있으면 불일치로 DEL 건너뜀   ← 안전
```

---

### 사용 위치

같은 키(`bip:lock:{bipId}`)를 두 곳에서 사용한다.

| 호출 메서드 | 락 안에서 하는 일 | 획득 실패 시 |
|---|---|---|
| `generateWithAi()` | PENDING 체크 → status 변경 → SQS 발행 | 409 `is generating page via ai` |
| `confirmPage()` | pageIndex 중복 체크 → BIP 업데이트 → result/guard 삭제 | 409 `is generating page via ai` |
| `completeBook()` | PENDING 체크 → Book DB 저장 | 409 `is being saved` |

"다음 페이지 생성", "confirm", "책 완성" 세 연산이 같은 BIP에 동시에 실행되는 것을 막는다.

---

### 시나리오별 동작

**정상: 순차 처리**
```
요청 A: SET NX 성공 → 락 획득 → 작업 → Lua DEL → 락 해제
요청 B: (A 완료 후) SET NX 성공 → 락 획득
```

**경합: 동시 요청**
```
요청 A: SET NX 성공 → 락 획득 → 작업 중
요청 B: SET NX 실패 → 즉시 409 반환
요청 A: 작업 완료 → 락 해제
```
재시도가 없으므로 클라이언트가 잠시 후 직접 재요청해야 한다.

**장애: 서버 다운**
```
요청 A: 락 획득 → 서버 다운 → finally 실행 불가
TTL 120초 후 락 자동 만료 → 이후 정상 처리 가능
```

---

## 2. PendingGuard (`bip:pending-guard:{bipId}`, TTL 600초)

### 분산 락만으로 해결 안 되는 문제

락은 "동시 수정"을 막는다. 하지만 Lambda가 처리 중 죽으면 다른 문제가 생긴다.

```
generateWithAi(): 락 획득 → PENDING 저장 → guard 설정 → SQS 발행 → 락 해제
Lambda: 메시지 수신 → LLM 호출 → [하드 크래시]

결과:
  - bip:result 없음 (Lambda가 결과를 저장 못 함)
  - BIP status = PENDING  ← 락은 이미 해제됨
  - 클라이언트가 poll해도 PENDING만 영원히 반환
```

이 상태에서 클라이언트가 다시 "페이지 생성"을 누르면:

```java
// BookProgressService.java:56-60
if (bip.status() == BookInProgress.Status.PENDING) {
    if (pendingGuard.exists(bip.id())) {
        throw BookProgressException.alreadyPending(bipId);  // Lambda 처리 중으로 판단 → 막힘
    }
    // guard 없음 → Lambda가 죽은 것으로 판단 → 정상 진행
}
```

guard 존재 여부가 "진짜 처리 중"과 "Lambda가 죽어서 stale 상태"를 구분하는 유일한 기준이다.

---

### TTL 설계 의도

```
bip:lock:{bipId}          TTL: 120초  ← 메인 앱 작업의 최대 보장 시간
bip:pending-guard:{bipId} TTL: 600초  ← Lambda 최대 실행 시간 가정
```

락은 메인 앱이 `finally`로 명시적으로 해제한다.
guard는 Lambda 정상 완료 시 삭제해야 하지만, 현재 Lambda가 직접 삭제하지 않아 TTL 만료에 의존한다.

---

### 상태 조합 해석표

| BIP status | guard 존재 | 해석 |
|---|---|---|
| `IN_PROGRESS` | — | 대기 중, 페이지 요청 가능 |
| `PENDING` | 있음 | Lambda 처리 중, 요청 불가 |
| `PENDING` | 없음 | Lambda 크래시 추정 (stale), 재요청 허용 |
| `COMPLETED` | — | 완성됨 |

---

### 시나리오별 동작

**정상 완료**
```
generateWithAi(): PENDING + guard 설정 (TTL 600초)
Lambda: 처리 완료 → bip:result 저장
pollPageStatus(): COMPLETED 반환 (bip:result 그대로 유지)
confirmPage(): lock → BIP 업데이트 → result 삭제 → guard 삭제
```

**Lambda 크래시**
```
generateWithAi(): PENDING + guard 설정 (TTL 600초)
Lambda: 크래시

600초 이내 재시도 → guard 있음 → 409 alreadyPending
600초 경과 후    → guard TTL 만료
다음 generateWithAi(): PENDING + guard 없음 → stale 판단 → 정상 진행
```

---

## 전체 흐름

```
generateWithAi() 호출
        │
        ▼
SET bip:lock:{bipId} NX (TTL 120초)
  ├─ 실패 → 409 already generating (다른 요청 처리 중)
  └─ 성공 ↓
        │
        ▼
BIP status 확인
  ├─ PENDING + guard 있음 → 409 alreadyPending (Lambda 처리 중)
  ├─ PENDING + guard 없음 → stale 판단, 계속 진행
  └─ IN_PROGRESS          → 계속 진행
        │
        ▼
BIP → PENDING 저장
SET bip:pending-guard:{bipId} (TTL 600초)
SQS 발행
        │
        ▼
Lua: GET bip:lock == 내 UUID → DEL (락 해제)

─────────── Lambda 영역 ───────────

Lambda 처리 완료 → bip:result:{bipId} 저장
Lambda 크래시   → guard TTL 600초 만료 대기
```

---

## 잔존 문제점

| 항목 | 문제 | 영향 |
|---|---|---|
| Lambda의 guard 미삭제 | Lambda 정상 완료 후 guard를 직접 삭제하지 않음 | confirmPage가 삭제하므로 기능상 무해 |
| 락 획득 재시도 없음 | 경합 시 즉시 409 | 클라이언트가 직접 재시도해야 함 |
