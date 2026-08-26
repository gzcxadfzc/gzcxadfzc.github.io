---
layout: post
title: "Barlow Automation: Human-in-the-Loop 워크플로우와 Slack 3초 제약 대응"
date: 2026-03-26 09:33:00
tags: ["barlow", "serverless"]
---


# Slack 3초 응답 제한 안에서 Human-in-the-Loop 이슈 자동화 시스템 구현하기

---

## Situation (상황)

클로드 코드 도입 시 AI 코드 생성 결과의 품질을 일관되게 유지하는 것이 목표였습니다. AI가 무분별하게 작업을 진행하지 못하도록 **Git Issue를 작업의 엔트리포인트**로 삼아, Slack 자연어 요청 → 코드베이스 분석 → 기존 이슈 검토 → 초안 생성 → GitHub 이슈 생성까지 수행하는 내부 도구가 필요했습니다.

## Task (과제)

1. AI는 탐색·초안 작성을, 최종 판단은 사용자가 내리는 `human-in-the-loop` 구조를 설계해야 했습니다.
2. 대기 구간이 여러 번 존재하는 장기 워크플로우를 Lambda에서 상태 손실 없이 재개 가능하게 만들어야 했습니다.
3. Slack의 3초 이내 응답과 수초~수십 초 걸리는 AI 작업을 동시에 만족시켜야 했습니다.
4. Slack retry와 SQS at-least-once 전달로 인한 중복 실행을 차단해야 했습니다.

## Action (행동)

- 워크플로우를 **상태 머신**으로 모델링했습니다 (`CONTINUE` / `WAIT_FOR_USER` / `STOP`). 다음 step은 SQS `event_type`이 결정하고, DynamoDB는 누적 컨텍스트 저장만 담당하도록 했습니다.
- Slack 3초 제한 대응을 위해 **Ack Lambda(즉시 응답, trigger_id 소비) / Worker Lambda(SQS 트리거 비동기 실행)**로 분리했습니다.
- Cold start 개선을 시도했습니다: lazy import와 패키지 경량화를 시도하였고 최종적으로 aws event bridge를 통해 5분주기로 ping을 보내 항상 warm start를 보장하였습니다.
- 멱등키를 도입하여 slack의 자동 재요청에도 안전한 시스템을 구축하였습니다.


## Result (결과)

- Ack Lambda 체감 지연을 **cold 1,708ms → warm 466ms**로 안정화하여 Slack 3초 응답 제한을 안정적으로 충족했습니다.
- `human-in-the-loop` 상태 머신으로 관련 없는 이슈 연결·중복 이슈 생성 같은 자동화 리스크를 사용자 최종 확인 단계에서 차단했습니다.
- Slack retry 와 동일 요청에 대해 중복처리를 방지하였습니다.