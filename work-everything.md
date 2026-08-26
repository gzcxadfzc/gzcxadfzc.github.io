---
layout: home
title: 작업한 프로젝트 목록
slug: /work
profile_picture:
  src: /assets/img/user/my-notion-face-portrait.png
  alt: 박순용 프로필 사진
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
    values: ["Java/Spring", "Python", "Dart/Flutter"]
  - name: 기타
    values: ["AWS", "Mysql", "Redis", "DynamoDB"]
certificates:
contact: yongsa0221@gmail.com 
---
## 프로젝트

### LittleWriter
> 생성형 AI를 사용한 동화 제작 서비스 / 2024.1 ~ 2024.6 / 3명 / API 서버 개발

- 캐시 기반 사용자 진행 상태 관리 기능 개발
- 생성형 AI 프롬프팅 파이프라인 구현
- 트랜잭션 경계 분리를 통한 응답 속도 개선
- JPA 연관관계 제거를 통한 조회 성능 개선
- Redis `SETNX` 기반 사용자 동시 요청 제어

<br>

### Barlow
> 국회 법안 조회 서비스 / 2025.1 ~ / 2명 / API 서버 개발, 앱 개발 및 스토어 관리

- 공통 인증 모듈 구현
- 생성형 AI 요약 배치 작업 구현
- Github Actions 기반 Play Store 자동 배포 환경 구성
- Feature-first 기반 Clean Architecture 구조 적용

<br>

### Barlow Automation
> Slack 기반 Agentic 이슈 생성 시스템 / 2026.3 / 1명 / 설계 및 구현 전담

- Human-in-the-Loop 기반 Agentic 워크플로우 설계
- DynamoDB 기반 서버리스 상태 저장 구조 설계
- Slack 3초 제한 대응을 위한 Ack/Worker 분리 아키텍처 구현
- Ack Lambda cold start 분석 및 keep-warm 전략 수립
