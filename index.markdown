---
layout: home
title: 프로젝트 경험
slug: /work2
profile_picture:
  src: /assets/img/user/profile.jpg
  alt: /assets/img/user/my-notion-face-portrait.png
title: 개발자 박순용 입니다
subtitle: 
social:
  - name: github
    url: https://github.com/gzcxadfzc
    iconName: github

techStacks:
  - name: 언어/프레임워크
    values: ["Java/Spring Boot", "Dart/Flutter"]
  - name: 데이터베이스
    values: ["MySQL", "PostgreSQL", "Redis"]
  - name: 인프라/클라우드
    values: ["AWS", "Docker", "Terraform"]
education:
  - school: 숭실대학교 글로벌미디어학부
    period: 2019 ~ 2026.2 졸업
certifications:
  - name: AWS Solutions Architect Associate
    image: /assets/img/user/certificates/aws_saa.png
  - name: Certified Kubernetes Application Developer
    image: /assets/img/user/certificates/ckad-certified-kubernetes-application-developer.png
    period: ""
contact: yongsa0221@gmail.com 
---

## 소개

안정적인 시스템을 구축하고, 서비스 규모에 맞게 구조를 최적화하는 일에 집중해왔습니다.

 실사용자가 있는 서비스를 기준으로 인프라와 배포 파이프라인을 설계하고 안정화하는 데 특히 관심이 있습니다. baro 서비스에서는 MAU 2,000 · DAU 150 규모로 실제 사용자가 이용하는 서비스를 대상으로 스키마 재설계, 인프라 안정화, 배포 파이프라인 구축을 담당하며, 크래시 원인 규명부터 Blue/Green 배포 전환등의 서비스 안정성을 개선  경험이 있습니다.

 LLM과 같은 예측하기 어려운 작업도 시스템 경계 안으로 가져와 통제하는 설계에 꾸준히 도전해왔습니다. 생성형 AI 서비스에서는 파이프라인과 트랜잭션 경계를 조정해 응답 속도와 품질을 함께 개선했고, 의안 조회 플랫폼에서는 예측 불가능한 생성 작업을 배치 시스템 안에 안전하게 편입시켰습니다. 최근에는 Slack 기반 agentic 시스템을 직접 설계하며, AI 호출을 애플리케이션 로직이 아닌 인프라 수준에서 제어하는 구조까지 확장했습니다.


<br>
<br>

<div class="no-break" markdown="1">

# 프로젝트

<br>

---

<br>

## theSociety (baro-backend)

> ### 정치 플랫폼 '바로' 백엔드 — 인프라·데이터·배포 안정화
> - 기간: 2026.3 ~ 
> - 역할: 백엔드/인프라 개발
> - 도메인: 지방선거 인물·행정구역 정보 서비스
> - 규모: MAU 2,000 · DAU 150 (실서비스 운영)

### 사용 기술
- 백엔드: `Java`, `Spring Boot`, `PostgreSQL`
- 인프라: `AWS ASG/CodeBuild/ECR/ALB`, `Docker`, `OrbStack`, `Terraform`

<br>

---

<br>

### 주요 개발 내용

'우리 동네 담당 공직자가 누구인지' 보여주는 지방선거 정보 서비스에서, MAU 2,000 · DAU 150 규모의 실사용자를 대상으로 스키마 재설계·인프라 안정화·배포 파이프라인 구축을 함께 담당했습니다. 

**[지방선거 인물·행정구역 데이터 스키마 재설계](/2026/07/01/thesociety-schema-migration#action-행동)**
- 6단계 7개 테이블로 흩어져 있던 행정구역 정보를 2단계로 축소, 인물 정보 5개 테이블을 1개 테이블+유형 컬럼으로 통합
- 조회 시 거치는 테이블 수 6개→2개, 조인 80% 감소
- 조회 속도 행정동 단위 2~3배, 시/도 단위 15~16배 개선

<br>

**[macOS Docker Desktop 크래시 원인 분석과 재발 방지](/2026/06/21/thesociety-docker-crash#action-행동)**
- 컨테이너 내부(JVM 힙 미설정, 셀레니움 세션 누수) / 외부(Docker Desktop 자체 메모리 누수) 원인을 동시에 추적해 근본 원인 규명
- JVM 힙 상한 설정, `@Transactional` 스코프 정리, Docker Desktop → OrbStack 전환
- load average 486~712 → 1.97~2.18로 안정화

<br>

**[Dev 환경 CI/CD 개선](/2026/08/01/thesociety-cicd#action-행동)**
- 컨테이너 직접 배포 방식을 ASG 기반 Blue/Green 구조로 전환, Slack 명령어로 배포/롤백 통합 관리
- Swap Thrashing·OOM Killer로 인한 강제 중단 리스크 구조적으로 제거
- 배포 리드타임 16분 5초 → 5분~7분대, 약 2.2~3.1배 단축

<br>
<br>

## Barlow Automation

> ### Slack 기반 Agentic 이슈 생성 시스템
> - 기간: 2026.3
> - 현재 상태: 개인 프로젝트
> - 역할: 설계 및 구현 전담

### 프로젝트 소개

![구성도](assets/img/work/agentic-system.png){: width="500"}

### 사용 기술
- 백엔드: `Python 3.12`, `AWS Lambda`, `SQS`, `DynamoDB`
- 연동: `Slack Bolt`, `OpenAI Agents SDK`, `GitHub MCP`
- 인프라: `Terraform`, `GitHub Actions`

<br>

---

<br>

### 주요 개발 내용

Slack 슬래시 커맨드로 기능 요청을 입력하면, AI가 GitHub 코드베이스와 기존 이슈를 분석해 이슈 초안을 만들고, 사용자 확인 후 실제 GitHub 이슈까지 생성하는 서버리스 개발 도구입니다.

기존 프로젝트의 방식은 AI 호출이 애플리케이션 내부 실행 흐름에 직접 묶여 있어 병목이 발생했고, 재시도, 상태 관리, 사용자 확인 로직도 함께 복잡해졌습니다. 이를 이벤트 기반 구조를 통해 `human-in-the-loop` 워크플로우와 Slack의 3초 응답 제한을 동시에 만족시키는 구조를 만드는 데 집중했습니다. 

**[Human-in-the-Loop 기반 Agentic 워크플로우 설계](/2026/03/26/agent-star#1-human-in-the-loop을-상태-머신으로-구현)**
- `Step Graph` 기반 상태 머신 설계
- `WorkflowInstance`, `RESUME_MAP`으로 중단 지점과 재개 흐름 명시화
- `pending-action`, `active-session` 이중 dedup 구조로 중복 실행 제어

<br>

**[Slack 3초 제한 문제](/2026/03/26/agent-star#2-slack-3초-제한-대응--ackworker-lambda-분리)**
- Worker Lambda는 SQS 기반 비동기 분석과 이슈 생성 담당
- `trigger_id` 제약 때문에 Ack를 단순 producer가 아닌 Event Controller로 설계
- coldstart 최적화 전략 및 keep-warm 전략 수립을 통한 사용자 응답속도개선 `1,708ms` > `466ms`

<br>
<br>

## Barlow 

> ### 국회 법안 조회 서비스
> - 기간: 2025.1 ~ 2026.2
> - 인원: 2명
> - 역할: API 서버 개발, 앱 개발 및 스토어 관리

### 프로젝트 소개

![바로서비스](assets/img/work/barlow-example.png){: width="500"}

### 사용 기술
- API 서버: `Java`, `Spring Boot`
- 앱: `Dart`, `Flutter`
- 데이터베이스: `Mysql`, `JPA/Hibernate`
- 배포: `AWS EC2`

<br>

---

<br>

### 주요 개발 내용

국회 의안 조회 서비스 바로에서는 예측 불가능한 작업을 기존 서비스와 배치 시스템에 안정적으로 통합하는 문제가 핵심이었습니다. 특히 생성형 AI 기반 요약 기능은 응답 시간 편차와 실패 가능성이 크기 때문에, 일반적인 동기 처리 방식으로는 한계가 있었습니다.

이 프로젝트에서는 생성 작업을 배치 시스템에 안전하게 편입시키는 구조를 설계했습니다.

**API Server - Spring Boot**

**[생성형 AI 요약 Batch 작업](/2024/09/16/barlow-star#2-ai-법안-요약-기능-설계-원칙)**
- `AsyncItemProcessor`, `AsyncItemWriter` 기반 비동기 요약 처리
- Polling 정책 및 스레드 최적화
- 처리 시간 `1분+ -> 24초`, 약 `60%` 단축

<br>
<br>

## [LittleWriter]

> ### 생성형 AI를 사용한 동화 제작 서비스
> - 기간: 2024.1 ~ 2024.6
> - 인원: 3명
> - 현재 상태: 배포 중단
> - 역할: API 서버 개발

### 프로젝트 소개

![littleWriter](assets/img/work/little-writer-example02.jpg){: width="500"}

### 사용 기술
- API 서버: `Java`, `Spring Boot`
- 데이터베이스: `Mysql`, `JPA/Hibernate`, `Redis`

<br>

---

<br>

### 주요 개발 내용

LittleWriter는 사용자의 입력을 바탕으로 동화와 삽화를 함께 생성하는 서비스입니다.

핵심 문제는 당시 LLM과 이미지 생성 모델의 성능이 아직 불안정했고, 호출 비용도 높았다는 점이었습니다. 단순히 모델을 연결하는 것만으로는 서비스 품질을 보장할 수 없었기 때문에, 호출 구조와 상태 관리 방식을 함께 설계해야 했습니다.

이 프로젝트에서는 사용자 흐름을 상태 기반으로 재정의하고, 생성형 AI 호출을 파이프라인으로 조직하는 작업에 집중했습니다.

**[동화 생성을 위한 생성형 AI 프롬프팅 파이프라인 구현](/2024/08/21/littleWriter01-star#1-생성-파이프라인-반복-설계)**
- GPT와 이미지 생성 모델을 조합한 파이프라인 구조 설계, 상태 기반 도메인으로 재설계하여 Redis에 진행 상태·문맥 캐싱
- 이전 문맥을 재사용해 연속성 있는 스토리 생성
- 생성 시간 `1분 -> 30초`, 약 `50%` 단축

<br>

**[트랜잭션 경계 재설정 및 조회 구조 개선을 통한 응답 속도 개선](/2025/11/19/littleWriter02-star#2-트랜잭션-경계-재설정--io를-트랜잭션-밖으로)**
- `@Transactional` 내부 IO 작업 분리, JPQL Projection 기반 조회로 N+1 문제 제거
- 저장 요청 응답 속도 `600ms -> 150ms`, 약 `75%` 개선

<br>

**[Redis를 이용한 사용자 동시 요청 제어](/2025/11/21/littleWriterSetnx-star)**
- Redis `SETNX` 기반 동시성 제어 구조 설계
- LLM 중복 호출 방지 및 도메인 정합성 확보

</div>
