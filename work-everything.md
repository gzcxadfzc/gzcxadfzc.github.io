---
layout: home
title: 작업한 프로젝트 목록
slug: /work
profile_picture:
  src: /assets/img/user/profile.jpg
  alt: /assets/img/user/my-notion-face-portrait.png
title: 백엔드 개발자 박순용 입니다.
subtitle: 다양한 기술과 지식을 통해 육각형 인간이 되고 싶은 개발자 입니다.
social:
  - name: github
    url: https://github.com/gzcxadfzc
    iconName: github
  - name: Tistory
    url: https://yongsa0221.tistory.com/
    iconName: tistory
techStacks:
  - name: 언어/프레임워크
    values: ["Java/Spring", "Dart/Flutter"]
  - name: 기타
    values: ["Mysql"]
certificates:
contact: yongsa0221@gmail.com 
---
## 학업
> 숭실대학교 글로벌미디어학부 : 2019 ~ 2026.2 졸업

<br>

## 자격증
> **AWS Solutions Architect Associate** _2025.12 ~ 2028.12_

![alt text](/assets/img/user/certificates/aws_saa.png){: width="100" height="100"}
<br>
<br>
<br>

## 소개

Java/Spring 기반 서버 개발 경험과 실제 서비스 성능 개선 이력을 보유한 신입 개발자입니다

생성형 AI 파이프라인 최적화, 캐시 기반 상태 관리, 비동기 배치 처리 등을 통해 응답 속도 75% 개선, 처리 시간 60% 단축 등의 성과를 달성했습니다.

서버 아키텍처 구축과 비즈니스 로직 설계를 통해 서비스를 개발한 경험이 있으며, Flutter를 사용한 클라이언트 개발도 경험하여, 서버–클라이언트 간 흐름을 전체적으로 이해하며 문제를 바라보는 능력을 갖추고 있습니다.

다양한 기술과 도메인을 스스로 탐색하고 확장하는 것을 즐기며, “육각형 개발자”를 목표로 꾸준히 학습하고 개발하고 있습니다.

협업에서는 팀원들과 문서 공유 하는 것을 중요시 생각하며 이를 위하여 다이어그램이나 시각 자료 등을 적극적으로 사용합니다.


<br>
<br>
<br>

<div class="no-break" markdown="1">

# 프로젝트

<br>

---

<br>

## [LittleWriter](https://github.com/gzcxadfzc/BE)

> ### 생성형 AI를 사용한 동화 제작 서비스
> - 기간: 2024.1 ~ 2024.6 
> - 인원: 3명
> - 현재 상태: 배포 중단
> - 역할: api 서버 개발

<br>

## 프로젝트 소개

![littleWriter](assets/img/work/little-writer-example02.jpg){: width="1000"}

### 프로젝트 구조
```mermaid
graph TD

%% 그룹: controller
    subgraph controller [api]
        app_api["controller"]
    end

%% 그룹: domain
    subgraph domain [application/domain]
        a["domain"]
    end

%% 그룹: infra
    subgraph infra [infra]
        ai["ai"]
        storage[storage]
        auth[auth]
    end
```

</div>


### 사용 기술
- API서버: `Java`, `Spring Boot`
- 데이터베이스: `Mysql`, `JPA/hibernate`, `Redis`

<br>

---

<br>

## 기능 개발
**[캐시 기반 사용자 진행상태 관리 기능](/2024/08/21/littleWriter01#2-생성형-ai-프로젝트에서-사용하기)**
- 사용자의 "동화 만들기" 과정의 상태 기반 도메인 설계
- Redis를 도입하여 사용자별 진행 상태를 캐싱 저장

<br>

**[동화 생성을 위한 생성형 AI 프롬프팅 파이프라인 구현](/2024/08/21/littleWriter01#1-파이프라인-구성)**
- 사용자 입력에 따른 일관된 스토리 구조 + 삽화 + 질문 생성을 동시 생성
- Redis에 저장된 이전 맥락을 활용하여 연속성 있는 스토리 생성
- 파이프라인 최적화를 통해 생성 시간 1분 → 30초로 50% 단축


<br>

**[트랜잭션 경계 설정을 통한 응답 속도 개선](/2025/11/19/littleWriter02#2-트랜잭션)**
- `@Transactional` 내부 IO 작업 분리
- 동화 저장 요청 응답 속도 600ms → 150ms로 75% 개선

<br>

**[JPA 연관관계 제거를 통한 조회 성능 개선](/2025/11/19/littleWriter02#3-책-조회-성능-개선)**
- ORM 수준의 연관관계 제약에서 JPQL 기반 Projection을 통한 명시적 조회로 재설계
- N+ 문제 제거 및 단일 쿼리 일괄 조회로 쿼리 효율 50% 이상 향상

<br>

**[Redis를 이용한 사용자 동시 요청 제어](/2025/11/21/littleWriterSetnx)**
- '진행중인 동화 책' 단위의 Redis 엔티티를 SETNX 기반으로 동시성 제어
- LLM 중복 호출 방지 및 도메인 엔티티의 정합성 보장


<br>

---


<br>
<br>

## Barlow _[API서버](https://github.com/ogongchill/barlow)_, _[앱](https://github.com/ogongchill/barlow-front)_
> ### 국회 법안 조회 서비스
> - 기간: 2025.1 ~  
> - 인원: 2명
> - [Google Play](https://play.google.com/store/apps/details?id=com.barlow.front) 배포중
> - 역할: api서버 개발, 앱 개발 및 스토어 관리

## 프로젝트 소개

바로 앱 서비스는 관심 분야에 맞춰 법안 정보를 쉽게 받아볼 수 있는 서비스 입니다.

![바로서비스](assets/img/work/barlow-example.png)

<br>

### 프로젝트 구조
```mermaid
graph TD

%% 그룹: app
    subgraph app [app]
        app_api["app:api"]
        app_batch["app:batch"]
    end

%% 그룹: core
    subgraph core [core]
        core_domain["core:domain"]
        core_storage["core:storage"]
    end

%% 그룹: services
    subgraph services [services]
        services_auth["services:auth"]
        services_noti["services:notification"]
    end

%% 그룹: clients
    subgraph clients [clients]
        client_knal_api["client-knal-api"]
    end
```

<br>

### 사용 기술
- API서버: `Java/Spring Boot`
- 앱: `Dart/Flutter`
- 데이터베이스: `Mysql`, `JPA/hibernate`
- 배포: `AWS EC2`

<br>

---

<br>

## 기능 개발

**API Server - Spring Boot**

**[공통 인증 모듈 구현](/2024/09/16/barlow#1-인증모듈)**
- Credential기반 Authenticator 인터페이스로 전략 패턴 설계 
- RSA기반 암호화로 서명/인증 분리 구현

**[생성형 AI요약 Batch 작업](/2024/09/16/barlow#2-ai를-통한-법안-요약-기능-추가하기)**
- AsyncItemProcessor, AsyncItemWriter기반 요약 요청 처리
- Polling 정책 및 스레드 최적화로 처리 시간 1분 → 24초로 60% 단축

<!-- 
<div class="no-break" markdown="1">

<br>

**Mobile Application - Dart/Flutter**

**[Github actions를 통한 Play Store 트랙 자동 배포 환경 구성](https://ogongchill.github.io/posts/PlayStore%EB%B0%B0%ED%8F%AC/)**
- 빌드 및 배포 완전 자동화로 배포 리드타임 단축
- 빌드 버전별 Google Play 트랙 자동 배포 구현

**[feature-first 구조에 따른 Clean Architecture구조](https://ogongchill.github.io/posts/%EB%B0%94%EB%A1%9C%EC%95%B1%EC%95%84%ED%82%A4%ED%85%8D%EC%B3%90/)**
- Feature-first 구조의 Clean Architecture 적용
- 모듈 분리에 따른 getIt 의존성 코드 생성 최적화를 통한 로컬 빌드 속도 개선

<br>

</div> -->

<br>
<br>

## Barlow Automation
> ### Slack 기반 Agentic 이슈 생성 시스템
> - 기간: 2026.3
> - 인원: 1명
> - 현재 상태: 개인 프로젝트
> - 역할: 설계 및 구현 전담

## 프로젝트 소개

Slack 슬래시 커맨드로 기능 요청을 입력하면, AI가 GitHub 코드베이스와 기존 이슈를 분석하여 GitHub 이슈 초안을 생성하고, 사용자 확인 후 실제 이슈까지 생성하는 서버리스 내부 도구입니다.

핵심 과제는 AI 연동 자체가 아니라, 사람의 판단이 개입되는 워크플로우를 서버리스 환경에서 안정적으로 구현하고 Slack의 3초 응답 제한을 동시에 만족시키는 것이었습니다.

<br>

### 사용 기술
- 백엔드: `Python 3.12`, `AWS Lambda`, `SQS`, `DynamoDB`
- 연동: `Slack Bolt`, `OpenAI Agents SDK`, `GitHub MCP`
- 인프라: `Terraform`, `GitHub Actions`

<br>

---

<br>

## 기능 개발

**[Human-in-the-Loop 기반 Agentic 워크플로우 설계](/2026/03/26/agent#1-human-in-the-loop을-어떻게-시스템으로-구현했는가)**
- `Step Graph` 기반 상태 머신으로 사용자 확인, 재개, 종료 흐름을 명시적으로 모델링
- `WorkflowInstance`와 `RESUME_MAP` 구조로 Lambda 실행이 끊겨도 동일 문맥에서 재개 가능하도록 설계
- `pending-action`, `active-session` 이중 dedup 구조로 Slack retry와 사용자 동시 세션 충돌을 분리 제어

<br>

**[DynamoDB를 사용한 서버리스 상태 저장 구조 설계](/2026/03/26/agent#redis가-아닌-dynamodb를-선택한-이유)**
- 상태 저장 요구사항을 `TTL`, `조건부 쓰기`, `재시도 안정성` 기준으로 재정의
- ElastiCache, EC2 Redis 대비 DynamoDB on-demand가 저빈도 워크로드에서 더 낮은 운영비를 갖는다고 판단
- `barlow-workflow`, `barlow-pending-action`, `barlow-active-session` 3개 테이블로 상태, 멱등성, 활성 세션 책임 분리

<br>

**[Slack 3초 제한 대응을 위한 Ack/Worker 분리 아키텍처](/2026/03/26/agent#2-slack의-3초-제한을-어떻게-해결했는가)**
- Ack Lambda는 즉시 응답과 modal open만 담당하고, Worker Lambda는 SQS 기반 비동기 실행 담당
- `trigger_id` 3초 제약 때문에 Ack를 단순 Producer가 아니라 Event Controller로 설계
- `pipeline_start`, `accept`, `reject`, `extend_existing` 등 이벤트 기반 resume 구조로 장기 실행을 짧은 Lambda 실행들로 분해

<br>

**[Ack Lambda cold start 분석 및 keep-warm 전략 수립](/2026/03/26/agent#실측-수치)**
- 실측 기준 cold start `1,558ms`, warm start `316ms`, 네트워크 포함 체감 지연 `1,708ms` vs `466ms`
- lazy import 적용 시 `Init Duration`은 `908ms -> 108ms`로 감소했지만 `expired_trigger_id` 발생, 전체 wall-clock time 악화 확인
- 패키지 경량화 후에도 `Init Duration`이 `908ms -> 969ms`로 유의미하게 개선되지 않아, 코드 최적화보다 EventBridge keep-warm이 더 타당하다고 판단
