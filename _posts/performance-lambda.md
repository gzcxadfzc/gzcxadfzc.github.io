# Ack Lambda 성능 분석 및 최적화

---

## 핵심 결론

**Cold start duration 자체를 줄이는 것은 이 스택에서 의미 있는 개선이 불가능하다.
올바른 접근은 cold start가 발생하지 않도록 Lambda를 warm 상태로 유지하는 것이다.**

---

## 측정 환경

- Lambda: `barlow-slack-ack` (arm64 / Graviton, 256MB)
- 트리거: Slack `/feat` 슬래시 커맨드 → Lambda Function URL
- 측정 방법: CloudWatch REPORT 로그

---

## 실측 수치

### Cold start vs Warm start (기준선 — 2026-03-29)

| 구분 | Init Duration | Handler Duration | 합계 |
|---|---|---|---|
| Cold start (n=2 평균) | 908ms | 650ms | **1,558ms** |
| Warm start (n=2 평균) | — | 316ms | **316ms** |
| 차이 | +908ms | +334ms | **+1,242ms** |

```
Slack이 경험하는 latency (네트워크 ~150ms 포함):

warm: ~466ms   ✓ 안전
cold: ~1,708ms △ Slack 3초 제약 대비 margin 1.3초
```

---

## 문제 구조

```
월 30회 호출 → 호출 간격 길다 → 대부분 cold start
cold start (~1,708ms) → Slack 3초 초과 위험 → timeout → retry → dedup 필요
```

dedup 레이어(pending-action, active-session)가 존재하는 근본 원인 중 하나가 cold start다.

---

## 시도한 최적화와 결과

### 시도 1 — Lazy Import (롤백)

**가설**: 모듈 레벨 초기화를 handler 진입 시점으로 지연하면 Init Duration이 줄어든다.

**결과**: `expired_trigger_id` 에러 발생. Init Duration 수치는 108ms로 감소했지만 동일한 작업이 handler 안으로 이동했을 뿐이고 wall-clock time은 오히려 증가했다.

**왜 더 느려졌나 — 두 가지 근거:**

① **Lambda Init Phase는 Handler Phase보다 CPU가 빠르다**

Lambda는 Init Phase에 메모리 설정과 무관하게 2 vCPU를 무제한 할당한다. Handler Phase에서는 메모리에 비례해 CPU가 throttle된다. 256MB 기준 Handler Phase CPU는 Init Phase 대비 수 배 느리다. 동일한 import 작업이 Init에서는 빠르고 Handler에서는 느리다.

> "Lambda grants your function's bootstrap code unthrottled access to two vCPUs, regardless of the function's configured memory."

— [Lambda Cold Starts and Bootstrap Code (Luc van Donkersgoed, 2022)](https://lucvandonkersgoed.com/2022/04/08/lambda-cold-starts-and-bootstrap-code/)
— [AWS Lambda execution environment lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)

② **asyncio 이벤트 루프 안에서 동기 import는 루프 전체를 blocking한다**

asyncio는 단일 스레드 + cooperative 모델이다. 루프가 실행 중인 상태에서 무거운 동기 import를 호출하면 yield point가 없으므로 루프 전체가 멈춘다.

> "Blocking (CPU-bound) code should not be called directly. For example, if a function performs a CPU-intensive calculation for 1 second, all concurrent asyncio Tasks and IO operations would be delayed by 1 second."

— [Python 공식 문서: Developing with asyncio](https://docs.python.org/3/library/asyncio-dev.html)
— [BBC cloudfit: Mixing Synchronous and Asynchronous Code](https://bbc.github.io/cloudfit-public-docs/asyncio/asyncio-part-5.html)

---

### 시도 2 — 패키지 분리 (완료, Init Duration 개선 없음)

**가설**: Ack Lambda zip에 불필요하게 포함된 AI SDK(openai-agents, mcp)를 제거하면 Init Duration이 줄어든다.

**분석 — import 체인 추적:**

```
Ack Lambda 실제 import: slack_bolt, pydantic, boto3, src.controller.*, src.domain.common.*
                        → openai-agents, mcp 미사용

Worker Lambda 실제 import: + openai-agents, mcp (executor.py 경로)
```

**패키지 크기 측정 결과:**

```
전체 패키지 (requirements-deploy.txt): 90MB
Ack 전용  (requirements-ack.txt):      11MB

주요 제거 대상:
  openai + 의존성:  ~23MB
  mcp:               ~2MB
```

**After 측정 결과 (11MB 패키지):**

| 구분 | Before (90MB) | After (11MB) | 변화 |
|---|---|---|---|
| Init Duration 평균 | 908ms | 969ms | **유의미한 변화 없음** |
| Handler Duration 평균 | 650ms | 718ms | 측정 분산 범위 내 |

**왜 개선이 없었나:**

Python은 실제로 `import`하는 모듈만 로드한다. openai-agents와 mcp는 zip에 존재했지만 Ack Lambda 코드에서 한 번도 import되지 않으므로 Init Duration에 영향이 없었다.

**Init Duration의 실제 병목:**

```
pydantic_core  — Rust 컴파일 .so 파일 로딩         ~250ms
slack_bolt     — 대형 Python 패키지                 ~250ms
boto3 client 3개 생성                               ~150ms
Python 런타임 시작 + src.* 컴파일                   ~250ms
────────────────────────────────────────────────────────
합계                                                ~900ms
```

이것들은 11MB 패키지와 90MB 패키지 모두에 동일하게 존재한다. 스택을 바꾸지 않는 한 Init Duration ~900ms는 이 시스템의 하한선이다.

**패키지 분리의 실질적 가치**: Init Duration 개선은 없었지만 Ack/Worker 배포 독립성 확보, 빌드 시간 단축은 유효하다.

커밋: `852201b`

---

## 결론 — 올바른 접근 방향

**Cold start duration 최적화는 한계에 도달했다.**

| 접근 | 결과 |
|---|---|
| Lazy import | Init Duration 수치↓, wall-clock time↑, trigger_id 만료 → 역효과 |
| 패키지 분리 | Init Duration 변화 없음 → import되는 패키지가 병목이므로 무효 |
| 패키지 교체 | slack_bolt, pydantic_core를 더 가벼운 것으로 교체 → 스택 전면 교체 수준 |

**올바른 방향은 cold start 빈도를 0에 가깝게 낮추는 것이다.**

```
현재: 월 30회 호출, 호출 간격 길다 → 거의 모든 요청이 cold start (1,708ms)
목표: Lambda를 항상 warm 상태로 유지 → 모든 요청이 warm handler (466ms)
```

warm 상태의 handler 316ms는 Slack 3초 제약 대비 충분히 안전하다.
cold start duration을 줄이는 것보다 cold start 자체를 없애는 것이 현실적이다.

---

## 다음 단계 — EventBridge Keep-warm

5분 간격 ping으로 Lambda를 warm 상태로 유지한다.
Step 1에서 구현한 진입점 분리(`source == "aws.events"` 분기)가 이 ping을 처리한다.

```hcl
resource "aws_cloudwatch_event_rule" "keep_warm" {
  name                = "barlow-ack-keep-warm"
  schedule_expression = "rate(5 minutes)"
}
resource "aws_cloudwatch_event_target" "keep_warm" {
  rule      = aws_cloudwatch_event_rule.keep_warm.name
  target_id = "AckLambdaKeepWarm"
  arn       = aws_lambda_function.ack.arn
}
resource "aws_lambda_permission" "allow_eventbridge" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ack.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.keep_warm.arn
}
```

비용: 월 ~8,640회 ping → Lambda 무료 티어(월 1,000,000회) 내 **$0**

**기대 효과:**

| 측정 항목 | 현재 | Keep-warm 적용 후 |
|---|---|---|
| Cold start 빈도 | ~100% | ~0% |
| Slack 경험 latency | ~1,708ms (cold) | ~466ms (warm) |
| Slack timeout 위험 | 존재 | 제거 |

---

## 측정 방법

**CloudWatch Logs Insights:**

```
fields @timestamp, @duration, @initDuration
| filter @type = "REPORT"
| stats
    count()                        as total,
    sum(ispresent(@initDuration))  as cold_count,
    avg(@initDuration)             as avg_init_ms,
    avg(@duration)                 as avg_handler_ms
```

**Cold start 강제 유발 (n회 반복 측정):**

```bash
for i in $(seq 1 5); do
  aws lambda update-function-configuration \
    --function-name barlow-slack-ack \
    --environment Variables={PROBE=$i} \
    --region ap-northeast-2 --no-cli-pager > /dev/null
  aws lambda wait function-updated \
    --function-name barlow-slack-ack --region ap-northeast-2
  aws lambda invoke \
    --function-name barlow-slack-ack \
    --payload '{"source":"aws.events"}' \
    --region ap-northeast-2 /dev/null --no-cli-pager
done
```
