# Phase 3 구현 계획: 비동기 LLM 처리

> **목적**: generateWithAi / initBook / 캐릭터 생성을 SQS + Lambda로 위임, 클라이언트 폴링 기반 완료 감지
> **전제**: SQS FIFO + DLQ, Python Lambda(Mock), Lambda 인프라 모두 완료
> **작성일**: 2026-04-10  
> **완료일**: 2026-04-12

---

## 구현 상태 (전체 완료)

| 항목 | 상태 |
|------|------|
| 3-A: `BookInProgressRedisEntity.Status` PENDING 추가 | ✅ 완료 |
| 3-B: SQS 클라이언트 Bean + 발행 포트 구현 | ✅ 완료 |
| 3-C: `BookProgressService` 비동기 전환 | ✅ 완료 |
| 3-D: 폴링 엔드포인트 (`GET /{id}/status`) | ✅ 완료 |
| 3-E: Controller 202 반환 전환 | ✅ 완료 |
| 3-F: 미사용 코드 정리 | ✅ 완료 |
| 3-G: Pending Guard (stale PENDING 자동 복구) | ✅ 완료 |
| CharacterInProgress 도메인 + 캐릭터 비동기 전환 | ✅ 완료 |

---

## 현재 상태 (v3 비동기)

### BookProgress
```
POST /init          → BIP 생성 → SQS 발행(pageIndex=0) → 202 (bipId)
POST /{id}          → Lock → PENDING 저장 → guard SET → SQS 발행 → 202 (bipId)
GET  /{id}/status   → Redis 폴링 → PENDING | COMPLETED(페이지 데이터 포함)
POST /{id}/complete → IN_PROGRESS 상태 체크 → DB 저장 → 200
```

### CharacterInProgress
```
POST /character/create         → CIP 생성(IN_PROGRESS) → SQS 발행 → 202 (cipId)
GET  /character/{cipId}/status → Redis 폴링 → PENDING | READY
POST /character/{cipId}/complete → IN_PROGRESS 체크 → result 존재 체크 → DB 저장 → 200
```

---

## Lambda ↔ 메인 앱 계약

### SQS 메시지 페이로드

#### 페이지 생성 (type 없거나 "PAGE")
```json
{
  "bipId": "abc123",
  "pageIndex": 0,
  "userInput": "오늘 숲에서 토끼를 만났어",
  "characterName": "토끼 토리",
  "characterDescription": "숲속에 사는 착한 토끼",
  "backgroundInfo": "숲속 친구들의 모험 이야기"
}
```
- `MessageGroupId = bipId`
- `MessageDeduplicationId = {bipId}-{pageIndex}`

#### 캐릭터 생성 (type = "CHARACTER")
```json
{
  "type": "CHARACTER",
  "cipId": "uuid",
  "name": "토끼 토리",
  "appearanceKeywords": "흰색, 긴 귀",
  "personality": "활발함",
  "description": "숲속 친구"
}
```
- `MessageGroupId = character-{cipId}`
- `MessageDeduplicationId = character-{cipId}`

### Lambda 라우팅
```python
def process(message_id, body):
    msg_type = body.get("type", "PAGE")
    if msg_type == "CHARACTER":
        process_character(message_id, body)
    else:
        process_page(message_id, body)
```

### Redis 결과 스키마 (Lambda → 메인 앱)

#### 페이지 결과
```
key: bip:result:{bipId}    TTL: 600s
value: { "pageIndex": 0, "context": "...", "imageUrl": "...", "questions": [...] }
```

#### 캐릭터 결과
```
key: char:result:{cipId}   TTL: 600s
value: { "imageUrl": "https://mock-s3/.../characters/{cipId}.png" }
```

### Pending Guard (페이지 생성 전용)
```
key: bip:pending-guard:{bipId}    TTL: 600s
value: "1"
```
- **메인 앱**: PENDING 저장 직후 guard SET (Lock 임계 구역 내)
- **Lambda**: finally 블록에서 DEL (성공/실패 무관)
- **stale 판정**: `status == PENDING` AND `guard 없음` → IN_PROGRESS 취급

---

## CharacterInProgress 설계

### Redis 키
```
char:progress:{cipId}    TTL: 1800s
  { id, userId, name, appearanceKeywords, personality, description, status }

char:result:{cipId}      TTL: 600s  (Lambda가 저장)
  { imageUrl }
```

### 상태 머신
```
requestCreate() → [IN_PROGRESS]
                      │
               Lambda 완료 → char:result:{cipId} 저장
                      │
          completeCharacter() 호출
                      │
                 [COMPLETED] → DB 저장 (main_character 테이블)
```

### 도메인 규칙
- `completeCharacter`: CIP가 IN_PROGRESS이어야 함 (COMPLETED → 409)
- `completeCharacter`: `char:result:{cipId}` 가 반드시 존재해야 함 (없으면 409)

---

## 주요 도메인 규칙 변경

### completeBook (BookCompleteExecutor)
- **변경 전**: BIP 상태가 PENDING일 때만 허용
- **변경 후**: BIP 상태가 IN_PROGRESS일 때만 허용 (PENDING = Lambda 처리 중 → 409)

### generateWithAi (BookProgressService)
- PENDING + guard 있음 → 409 (진짜 처리 중)
- PENDING + guard 없음 → stale PENDING → IN_PROGRESS 취급, 진행

---

## 정리된 파일 목록

### 삭제됨
- `storage/.../s3/ImageUploadEvent.java`
- `storage/.../s3/ImageUploadEventHandler.java`
- `storage/.../s3/AsyncBucketImageUploader.java`
- `storage/.../loadtest/LoadTestStorageConfig.java`
- `domain/.../ai/BookPageGenerator.java`
- `domain/.../ai/BookCharacterGenerator.java`
- `ai/.../adapter/BookPageGeneratorAdapter.java`
- `ai/.../adapter/BookCharacterGeneratorAdapter.java`
- `ai/.../adapter/BookPageGeneratorAdapterIntegrationTest.java`

### ai 모듈 의존 제거
- `api/build.gradle.kts`: `:ai` implementation 제거
- `api/src/main/resources/application.yml`: `ai.yml` import 제거
- `api/src/test/resources/application-test.yml`: `ai.yml` import 제거
- `api/.../ApiControllerAdvice.java`: `OpenAiException` 핸들러 제거

---

## Phase 4 예정 사항

- `BIP Redis → DynamoDB` 전환 (Lock을 Condition Expression으로 대체)
- `CharacterInProgress Redis → DynamoDB` 전환 고려
