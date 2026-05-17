# Virtual Thread 도입 실험 결과

## Situation

5만건 book 데이터 투입 후 부하테스트(280 VU)에서 읽기 성능이 전반적으로 저하됐다.
특히 `my_chars` 엔드포인트가 p(95) 1,821ms로 다른 엔드포인트 대비 이상하게 느렸다.

분석 결과 **convoy effect** 로 진단했다. 4개의 요청을 순서대로 실행하는 k6 스크립트 특성상 280 VU가 마지막 요청(`my_chars`)에 동시에 몰려 Tomcat 스레드 풀(200개)을 초과하는 큐잉이 발생했다.

| 지표 | 5만건 투입 전 | 5만건 투입 후 |
|------|------------|------------|
| `board_all` p(95) | ~120ms | 1,469ms |
| `book_detail` p(95) | ~90ms | 1,010ms |
| `my_chars` p(95) | ~440ms | 1,821ms |

## Task

- convoy effect로 인한 `my_chars` 지연 해결
- Tomcat 스레드 한도 제거 → Virtual Thread 도입

## Action

### 1단계: COUNT 쿼리 제거 (board_all 개선)

`Page<T>` → `Slice<T>` 전환으로 매 요청마다 실행되던 `SELECT COUNT(*) FROM book` 제거.

- `GET /api/v1/book/board/slice` 신규 엔드포인트 추가
- `BookJpaRepository.findSliceBy(Pageable)` 추가
- `SliceResult`, `SliceResponse` 도메인/응답 클래스 추가

결과: board p(95) 1,469ms → **170ms**, 전체 throughput 86 iter/s → **282 iter/s**

### 2단계: Virtual Thread 도입

`spring.threads.virtual.enabled: true` (load-test 프로파일)

convoy effect 해소를 목적으로 Tomcat 스레드 한도를 제거했다.

### 3단계: 원인 규명

`-Djdk.tracePinnedThreads=full` 플래그를 추가해 stderr를 `/app/flags.txt`로 분리했다.
app.log에서 18,474건의 pinning 이벤트 확인.

```
VirtualThread[#37,tomcat-handler-0]/runnable@ForkJoinPool-1-worker-1 reason:MONITOR
    ...
    com.mysql.cj.protocol.ReadAheadInputStream.read(...) <== monitors:1
```

`monitors:1` = 해당 프레임이 `synchronized` 모니터를 1개 보유 중.  
MySQL Connector/J 9.2.0의 `ReadAheadInputStream.read()`가 `synchronized` 블록 안에서 소켓 읽기를 수행하여 VT가 carrier thread에서 unmount되지 못하는 것이 원인.

## Result

### VT 도입 전후 비교

| 지표 | VT off (slice) | VT on |
|------|---------------|-------|
| `board_slice` p(95) | 170ms ✅ | 425ms ❌ |
| `book_detail` p(95) | 187ms ✅ | 425ms ❌ |
| `my_books` p(95) | 264ms ✅ | 424ms ❌ |
| `my_chars` p(95) | 1,821ms | **416ms** ✅ |
| iterations/s | 282 | 145 |
| `write_init` avg | 145ms | 33,824ms |
| `write_completed` | 736건 | 0건 |

### 분석

**my_chars는 개선됐다.** Tomcat 스레드 한도 제거로 convoy effect가 해소됐다.

**나머지 지표는 전반적으로 악화됐다.** 원인은 MySQL JDBC pinning으로 인한 carrier thread 고갈이다.

- EC2 vCPU 수 = carrier thread 수
- read VU 200개의 JDBC 쿼리가 `ReadAheadInputStream.synchronized` 구간에서 carrier thread를 점유
- write VU의 initBook이 carrier thread를 얻지 못해 60초 timeout 발생
- `write_poll_count` avg 70회 → 6.4회로 개선됐으나(Redis polling은 VT 친화적), initBook 자체가 timeout되어 polling 단계에 도달하지 못함

**polling 엔드포인트는 VT가 유리하다.** Redis 조회는 Lettuce(Netty 기반, non-blocking)를 사용하므로 synchronized 없이 VT가 정상 unmount된다. 실제로 VT on 시 `write_poll_count`가 감소(빠른 감지)한 것으로 확인됐다.

### 결론

| 방안 | 결과 |
|------|------|
| VT 전체 적용 | JDBC pinning으로 역효과 |
| DeferredResult + VT executor 분리 | 구현 복잡도 대비 실익 없음 (40 VU 수준) |
| **VT 롤백** | 채택 |

### 근본 해결 조건

MySQL Connector/J의 `ReadAheadInputStream`에서 `synchronized` 제거가 완료되거나, R2DBC 전환이 이루어지면 VT 재도입이 가능하다. convoy effect는 k6 요청 순서 랜덤화로 별도 대응한다.
