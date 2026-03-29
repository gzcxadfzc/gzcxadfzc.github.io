# Barlow Automation — 아키텍처 문서

Slack 슬래시 커맨드로 개발자가 기능/리팩토링/버그 요청을 입력하면, AI가 GitHub 코드를 분석해 GitHub 이슈를 자동 생성하는 서버리스 시스템.

---

## 전체 흐름

```
개발자 (Slack)
    │
    ├─ /feat | /refactor | /fix
    │         │
    │    [Modal 입력]
    │         │
    ▼         ▼
Ack Lambda (Function URL)
src/controller/lambda_ack.py
    │  Bolt 처리 (서명 검증 + ack)
    │  → SQS.send({type: pipeline_start, ...})
    ▼
SQS Queue (barlow-queue)
    ▼
Worker Lambda (SQS Trigger)
src/app/handlers/step_worker_handler.py
    │  WorkflowRuntime.start() / .resume()
    ▼
Step Graph 실행 (WorkflowRuntime)
    │  CONTINUE → 다음 step 즉시 실행
    │  WAIT_FOR_USER → Slack 메시지 전송 후 종료 (Lambda 반환)
    │  STOP → Slack 완료 메시지 전송 후 종료
    ▼
DynamoDB (상태 저장)
    barlow-workflow        — WorkflowInstance
    barlow-pending-action  — 멱등성 (dedup_id)
    barlow-active-session  — 채널+유저별 활성 워크플로우
```

사용자가 Slack 버튼을 클릭하면 Ack Lambda가 다시 SQS에 resume 이벤트를 전송하고 Worker Lambda가 재개한다.

---

## 디렉토리 구조

```
src/
├── config.py                      # 환경변수 기반 Config (dataclass)
├── logging_config.py              # 로깅 초기화
├── local_server.py                # 로컬 개발 (Socket Mode)
│
├── controller/                    # Ack Lambda 진입점
│   ├── lambda_ack.py              # Lambda Function URL 핸들러
│   ├── app.py                     # AsyncApp 팩토리
│   ├── router.py                  # 핸들러 등록
│   └── handler/
│       ├── slash.py               # 슬래시 커맨드, Modal, Block Action 핸들러
│       └── modal_templates/       # FeatModalInput, RefactorModalInput, FixModalInput
│
├── app/                           # Worker Lambda 진입점
│   ├── workflow_runtime.py        # step 그래프 실행 오케스트레이터
│   ├── handlers/
│   │   └── step_worker_handler.py # SQS 트리거 핸들러
│   └── slack/
│       └── payload_mapper.py      # Slack Block Kit 빌더
│
├── domain/                        # 도메인 로직 (순수)
│   ├── queue.py                   # IQueueSender 인터페이스
│   ├── common/
│   │   ├── models/
│   │   │   ├── lifecycle.py       # WorkflowStatus enum
│   │   │   ├── step_result.py     # ControlSignal enum
│   │   │   ├── workflow_instance.py  # WorkflowInstance + IWorkflowInstanceRepository
│   │   │   └── issue_base.py      # BaseIssueTemplate, IssueType, Label
│   │   ├── ports/
│   │   │   ├── idempotency.py     # IIdempotencyRepository
│   │   │   └── active_session.py  # IActiveSessionRepository
│   │   └── steps/
│   │       └── base.py            # Step Protocol
│   │
│   ├── feat/                      # feat_issue 워크플로우 (구현 완료)
│   │   ├── definition.py          # GRAPH, FIRST_STEP, RESUME_MAP
│   │   ├── executor.py            # FeatAgentExecutor (Agent 팩토리)
│   │   ├── models/
│   │   │   ├── state.py           # FeatIssueWorkflowState
│   │   │   ├── issue.py           # FeatTemplate (Pydantic)
│   │   │   └── issue_decision.py  # Decision enum
│   │   ├── steps/                 # 개별 step 구현
│   │   └── agents/                # Agent 프롬프트 + 출력 스키마
│   │
│   ├── refactor/                  # refactor_issue 워크플로우 (placeholder)
│   └── fix/                       # fix_issue 워크플로우 (placeholder)
│
├── agent/                         # Agent 추상화 계층
│   ├── base.py                    # IAgent, AgentResult
│   ├── models.py                  # Model 레지스트리 (Claude/GPT 가격 포함)
│   ├── usage.py                   # AgentUsage (토큰/비용 추적)
│   ├── openai.py                  # OpenAIAgent (agents SDK 래퍼)
│   └── mcp.py                     # GitHubMCPFactory
│
└── infrastructure/                # 외부 시스템 구현체
    ├── queue/
    │   └── sqs_publisher.py       # SqsQueueSender
    └── storage/
        ├── dynamodb/              # DynamoDB 구현체 (프로덕션)
        │   ├── workflow_instance_store.py
        │   ├── pending_action_store.py
        │   └── active_session_store.py
        └── memory/                # 인메모리 구현체 (로컬 개발)
            ├── workflow_instance_store.py
            ├── pending_action_store.py
            └── active_session_store.py
```

---

## 핵심 인터페이스

| 인터페이스 | 위치 | 역할 |
|-----------|------|------|
| `IQueueSender` | `domain/queue.py` | 메시지 큐 전송 |
| `IWorkflowInstanceRepository` | `domain/common/models/workflow_instance.py` | 워크플로우 상태 저장/조회 |
| `IIdempotencyRepository` | `domain/common/ports/idempotency.py` | SQS 중복 처리 방지 |
| `IActiveSessionRepository` | `domain/common/ports/active_session.py` | 채널+유저별 활성 세션 관리 |
| `IAgent` | `agent/base.py` | AI Agent 실행 |
| `Step` (Protocol) | `domain/common/steps/base.py` | step 실행 단위 |

---

## feat_issue 워크플로우 Step 그래프

```
find_relevant_bc          [CONTINUE]
    ↓
find_relevant_issue       [CONTINUE]
    ↓
wait_issue_decision       [WAIT_FOR_USER]
    ├─ reject_duplicate   → reject_end            [STOP]
    ├─ extend_existing    → generate_issue_draft
    ├─ block_existing     → generate_issue_draft
    └─ create_new_independent → generate_issue_draft
    ↓
generate_issue_draft      [CONTINUE]
    ↓
wait_confirmation         [WAIT_FOR_USER]
    ├─ accept             → create_github_issue   [STOP]
    ├─ reject             → regenerate_issue_draft
    └─ drop_restart       → regenerate_issue_draft
    ↓
regenerate_issue_draft    [CONTINUE]
    ↓
wait_confirmation         (루프)
```

### Step 입출력 타입

| Step | Input | Output | 비고 |
|------|-------|--------|------|
| `find_relevant_bc` | `user_message: str` | `bc_candidates: str` | RELEVANT_BC_FINDER Agent |
| `find_relevant_issue` | `user_message`, `bc_candidates` | `RelevantIssue` (JSON 저장) | RELEVANT_ISSUE_FINDER Agent |
| `wait_issue_decision` | `RelevantIssue`, `workflow_id` | Slack blocks | WAIT |
| `generate_issue_draft` | `bc_candidates`, `bc_decision` | `FeatTemplate` (JSON 저장) | ISSUE_GEN Agent |
| `regenerate_issue_draft` | `bc_candidates`, `issue_draft`, `user_feedback` | `FeatTemplate` | ISSUE_REGEN Agent |
| `wait_confirmation` | `FeatTemplate`, `workflow_id` | Slack blocks | WAIT |
| `reject_end` | `RelevantIssue` | `completion_message: str` | STOP |
| `create_github_issue` | `issue_draft`, `issue_decision`, `RelevantIssue` | `github_issue_url: str` | GitHub REST API |

### issue_decision에 따른 GitHub 관계 설정

| Decision | 동작 |
|----------|------|
| `extend_existing` | `POST /issues/{anchor_no}/sub_issues` — 신규 이슈를 anchor의 child로 설정 |
| `block_existing` | `POST /issues/{anchor_no}/dependencies/blocked_by` — anchor가 신규 이슈에 의해 blocked |
| `create_new_independent` | 관계 설정 없음 |
| `reject_duplicate` | 이슈 생성 안 함 |

---

## WorkflowInstance 상태 모델

```python
WorkflowInstance
├── workflow_id: str          # UUID
├── workflow_type: str        # "feat_issue" | "refactor_issue" | "fix_issue"
├── status: WorkflowStatus    # CREATED / RUNNING / WAITING / FAILED / COMPLETED / CANCELLED
├── current_step: str         # GRAPH 내 현재 step 이름
├── state: Any                # FeatIssueWorkflowState 등 (워크플로우별 등록)
├── pending_action_token: str | None  # WAITING 시 발급되는 UUID
├── slack_channel_id: str
├── slack_user_id: str
├── slack_message_ts: str | None      # 업데이트할 메시지 ts
├── created_at: int
└── ttl: int                  # Unix timestamp (24시간 TTL)
```

### FeatIssueWorkflowState 필드

| 필드 | 타입 | 내용 |
|------|------|------|
| `user_message` | str | 원본 사용자 요청 |
| `bc_candidates` | str \| None | BC finder 출력 |
| `bc_decision` | str \| None | 관련 BC 결정 |
| `relevant_issues` | str \| None | RelevantIssue JSON |
| `issue_decision` | Decision \| None | 사용자 이슈 결정 |
| `issue_draft` | str \| None | FeatTemplate JSON |
| `github_issue_url` | str \| None | 생성된 이슈 URL |
| `completion_message` | str \| None | 완료 메시지 |
| `user_feedback` | str \| None | 재생성 요청 피드백 |
| `dropped_item_ids` | list[str] | 제외할 항목 ID |

---

## SQS 이벤트 스키마

### pipeline_start (새 워크플로우 시작)
```json
{
  "type": "pipeline_start",
  "subcommand": "feat | refactor | fix",
  "channel_id": "C12345",
  "user_id": "U12345",
  "user_message": "...",
  "dedup_id": "view_id"
}
```

### resume (사용자 액션 후 재개)
```json
{
  "type": "accept | reject | drop_restart | reject_duplicate | extend_existing | block_existing | create_new_independent",
  "workflow_id": "uuid",
  "channel_id": "C12345",
  "user_id": "U12345",
  "additional_requirements": "...",
  "dedup_id": "action_ts"
}
```

---

## 세션 관리 (IActiveSessionRepository)

- 키: `{channel_id}#{user_id}`
- `start()` 시 동일 사용자+채널에 진행 중인 워크플로우가 있으면 거부
- COMPLETED / FAILED / CANCELLED 시 세션 해제
- `/drop` 커맨드 또는 `issue_drop` 버튼으로 강제 중단 가능

---

## 멱등성 (IIdempotencyRepository)

- 키: `dedup_id` (Slack view_id 또는 action_ts)
- DynamoDB 조건부 PutItem (`attribute_not_exists(pk)`) 으로 중복 실행 방지
- TTL: 1시간

---

## 이슈 템플릿

### FeatTemplate (feat_issue)
| 필드 | 설명 |
|------|------|
| `issue_title` | 이슈 제목 |
| `about` | 개요 |
| `goal` | 목표 |
| `new_features` | 새로운 기능 목록 |
| `domain_rules` | 도메인 규칙 목록 |
| `additional_info` | 추가사항 |

GitHub payload: `title`, `body`, `labels: ["feat"]`, `type: "Feature"`

### IssueType enum (공통, `common/models/issue_base.py`)
| 값 | GitHub type |
|----|-------------|
| `IssueType.FEAT` | `"Feature"` |
| `IssueType.REFACTOR` | `"Refactor"` |
| `IssueType.FIX` | `"Bug"` |

---

## GitHub MCP 연결

- Endpoint: `https://api.githubcopilot.com/mcp/`
- 인증: `GITHUB_TOKEN` (Bearer)
- read-only (`X-MCP-Readonly: true`)
- 사용 도구: `get_repository_tree`, `get_file_contents`, `search_code`, `list_issues`
- step 실행 시 `GitHubMCPFactory`를 통해 on-demand 연결

---

## 로컬 개발

```bash
# 의존성 설치
pip install -r requirements-dev.txt

# .env 설정 (default.env 참고)
cp default.env .env

# Socket Mode 서버 실행
python -m src.local_server

# 테스트
python -m pytest tests/
```

`local_server.py`는 모든 repository를 메모리 구현체로 대체하여 AWS 없이 동작한다.
