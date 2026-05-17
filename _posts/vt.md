# Virtual Thread (VT) 성능 분석

## 환경

- 인스턴스: t3.small (2 vCPU, 2GB RAM)
- Java 21
- Spring Boot 3.x
- HikariCP (pool size = 25)
- MySQL Connector/J 버전별 테스트
- k6 부하 테스트: 100 VU, ramp_up 시나리오 (295초)

---

## 테스트 결과 비교 (100 VU, DB truncate 기준)

| 설정 | req/s | avg latency | book_detail p95 | my_books p95 |
|------|------|------|------|------|
| no-VT + 8.x | **653** | 71ms | 265ms ✅ | 253ms ✅ |
| VT + 9.1.0 | ~363 | ~210ms | 405ms ❌ | 385ms ❌ |
| VT + 9.2.0 | 358 | 148ms | 263ms ✅ | 251ms ✅ |

> no-VT + 8.x 기준 req/s가 약 1.8배 높음. p95는 유사.

---

## VT가 100 VU에서 느린 이유

### 1. 스케줄링 레이어 이중화
```
Platform Thread:  요청 → OS 커널 스케줄링 (하드웨어 최적화)
Virtual Thread:   요청 → JVM ForkJoinPool → OS 커널 스케줄링 (2중 오버헤드)
```

t3.small 2코어 환경에서 carrier thread = 2개. 100 VU는 platform thread로 충분히 감당 가능한 수준이라 VT 스케줄링 오버헤드만 추가됨.

### 2. VirtualThreadPinned 발생

JFR 분석 결과 (300초 기준):

| Connector | Pinned 이벤트 | avg 지속시간 | 빈도 |
|------|------|------|------|
| 8.x | 212건 | - | 0.71건/초 |
| 9.1.0 | 157건 | - | 0.52건/초 |
| 9.2.0 | 231건 | 36.2ms | 0.77건/초 |


### 3. CPU 효율

| 설정 | CPU avg | req/s | CPU per req |
|------|------|------|------|
| no-VT + 8.x | 69.2% | 653 | 0.106%/req |
| VT + 9.2.0 | 50.6% | 358 | 0.141%/req |

VT가 요청당 CPU를 33% 더 소모. ForkJoinPool 스케줄러 오버헤드 + pinning으로 carrier thread 낭비.

---

## Pinning 원인 분석 (JFR 전체 스택트레이스)

`jfr print --stack-depth 64`로 확인한 전체 스택:

```
VirtualThread.parkOnCarrierThread        ← pinning 감지
LockSupport.park()
sun.nio.ch.Poller.pollIndirect           ← NIO 소켓 I/O 대기
sun.nio.ch.NioSocketImpl.implRead        ← MySQL 소켓 읽기
com.mysql.cj.protocol.ReadAheadInputStream.read  ← Connector 패킷 읽기
com.mysql.cj.protocol.FullReadInputStream.readFully
com.mysql.cj.protocol.a.SimplePacketReader.readHeader
com.mysql.cj.protocol.a.NativeProtocol.sendCommand
com.mysql.cj.jdbc.ClientPreparedStatement.executeUpdate
com.zaxxer.hikari.pool.ProxyPreparedStatement.executeUpdate
org.hibernate.engine.jdbc...executeUpdate
...Hibernate INSERT 체인...
org.hibernate.internal.SessionImpl.persist
```

**원인: MySQL Connector의 `ReadAheadInputStream` (소켓 읽기 스트림)이 `synchronized` 블록 내에서 park 발생.**

- Connector 9.x는 DB 연결/쿼리 실행 로직을 ReentrantLock으로 전환 → pinning 일부 감소
- 그러나 소켓 I/O 읽기 경로(`ReadAheadInputStream`)는 여전히 `synchronized` 유지
- HikariCP는 원인 아님 (ProxyPreparedStatement는 단순 래퍼)

---

## VT 도입 판단 기준

| 상황 | 권장 |
|------|------|
| 동시 요청 < 200 (Tomcat max-threads) | **no-VT** |
| 동시 요청 > 200 | **VT 필수** (platform thread 포화) |
| JDBC 중심 워크로드 | VT 이점 제한적 |
| R2DBC / WebClient 등 비동기 I/O | **VT 효과 극대화** |
| 외부 API 호출(느린 I/O) 비중 높음 | **VT 유리** |

### 핵심 개념

- **Pinning**: VT가 `synchronized` 블록 안에서 park → carrier thread 점유 유지 → 다른 VT 실행 불가
- **Carrier thread 수 = CPU 코어 수**: 코어가 많을수록 pinning 영향 감소하나 근본 해결 아님
- **진짜 해결책**: JDBC → R2DBC 전환 (소켓 I/O 자체가 비동기화되어 pinning 발생 없음)

---

## HikariCP Pool 크기와 Pinning 관계

### pool 25 → pool 50 변경 결과 (VT + 9.2.0, 100 VU)

| 항목 | pool 25 | pool 50 |
|------|------|------|
| req/s | 358 | **375** (+5%) |
| book_detail p95 | 263ms | **240ms** |
| my_books p95 | 251ms | **230ms** |
| avg latency | 148ms | **140ms** |
| Pinned 이벤트 | 231건 | **396건** |
| avg pinning 지속시간 | 36.2ms | **31.4ms** |
| 총 pinning 시간 | 8,359ms | **12,417ms** |

### 분석

pool이 늘어날수록:
- 동시 DB 쿼리 증가 → 소켓 읽기 동시 발생 → **pinning 이벤트 수 증가**
- 커넥션 대기 감소 → **각 pinning 지속시간 단축**

```
처리 빨라짐 → 같은 시간에 더 많은 요청 → DB 작업 동시 실행 증가
→ pinning 이벤트 비례 증가, 但 개별 시간은 단축
```

요청당 pinning 비율:
```
pool 25: 231 / 110,612 req ≈ 2.1건/1000req
pool 50: 396 / 110,612 req ≈ 3.6건/1000req
```

### 결론

throughput 개선폭이 5%에 그치는 이유: **병목이 커넥션 부족이 아니라 pinning 자체**. pool을 100으로 늘려도 동일한 패턴 반복. 커넥션 풀 증가는 임시방편이며 pinning 근본 해결(R2DBC 전환)이 필요.

---

## 포화점 탐색 (no-VT + 9.2.0 + pool 50)

### VU별 성능 곡선

| VU | req/s | avg latency | CPU avg | my_books p95 | 상태 |
|------|------|------|------|------|------|
| 100 | 653 | 71ms | 69.2% | 253ms ✅ | 안정 |
| 120 | 993 | 48ms | 84.7% | 90ms ✅ | 안정 |
| 140 | **1,059** | 54ms | **85.8%** | 102ms ✅ | **포화점** |
| 160 | 663 ↓ | 119ms ↑ | ~100% | 303ms ❌ | 과부하 |

### 분석

- **120 VU**: pool 25 → 50 덕분에 커넥션 대기 해소 → req/s 653 → 993 급등
- **140 VU**: CPU 85.8%로 한계 근접, req/s 소폭 증가 → 포화점
- **160 VU**: CPU 100% 지속 → 컨텍스트 스위칭 오버헤드 → 레이턴시 2배 급등 → req/s 역전 감소

```
t3.small 최대 안정 처리량: ~1,059 req/s @ 140 VU
```

### VT vs no-VT CPU 특성 차이

VT의 CPU 사용률이 낮은 이유는 "효율적"이 아니라 "덜 일하는 것":
- VT: pinning으로 carrier thread park 대기 → CPU 점유하지만 연산 없음 → 낮은 CPU
- no-VT: 요청 처리 후 즉시 다음 요청 → CPU 풀 활용

---

## 읽기/쓰기 커넥션 풀 분리

### 단일 RDS 인스턴스에서 풀 분리는 무의미

```
읽기 풀 30 + 쓰기 풀 20 = 50
vs
단일 풀 50
→ DB 서버 입장에선 동일
```

### Read Replica 도입 시 유효

```
쓰기 요청 → Primary RDS (쓰기 풀)
읽기 요청 → Read Replica RDS (읽기 풀)
```

Spring 구현: `AbstractRoutingDataSource` + `@Transactional(readOnly=true)` 라우팅

### 현실적인 대안: Redis 캐싱

이미 Redis 인스턴스 보유. `board_all` 등 자주 조회되는 데이터 캐싱 시 DB 커넥션 자체를 절약 가능 → 포화점 이후에도 처리량 유지 가능.

---

## 결론

- **현재 최적 설정**: no-VT + Connector 9.2.0 + pool 50 @ 140 VU = 1,059 req/s
- **포화점**: 140 VU (CPU 85.8%), 160 VU 초과 시 처리량 역전 감소
- **VT 도입 시점**: 동시 요청 200+ 초과 또는 R2DBC 전환 시
- **다음 최적화**: Redis 캐싱으로 DB 부하 감소 → 포화점 상향

---

## 참고 파일 (JFR)

| 파일 | 설명 |
|------|------|
| `k6/recording_no_vt.jfr` | no-VT + 8.x, 100 VU |
| `k6/recording_vt.jfr` | VT + 8.x, 100 VU |
| `k6/recording_vt_9x.jfr` | VT + 9.1.0, 100 VU |
| `k6/recording_vt_92.jfr` | VT + 9.2.0, 100 VU |
| `k6/recording_deep.jfr` | VT + 9.2.0, stack-depth 64 (pinning 원인 분석용) |
| `k6/recording_vt_pool50.jfr` | VT + 9.2.0, pool 50, 100 VU |
| `k6/recording_novt_120vu.jfr` | no-VT + 9.2.0, pool 50, 120 VU |
| `k6/recording_novt_140vu.jfr` | no-VT + 9.2.0, pool 50, 140 VU (포화점) |
| `k6/recording_novt_160vu.jfr` | no-VT + 9.2.0, pool 50, 160 VU (과부하) |
