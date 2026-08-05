---
layout: post
title: "Barlow - 테스트 환경/automation 인프라 구현"
date: 2026-03-23 10:30:40
---

# 들어가며

[설명 문서]({% post_url 2026-03-23-barlow-infra %})에서 다룬 두 인프라 작업의 실제 구현을 정리한다. AWS 계정 ID, 리소스 ARN 같은 실제 식별자는 이 글에서 다루지 않는다.

# 1. 테스트 환경 통합 스택

## 1.1 초기 버전에서 통합 스택으로

처음에는 EC2 스팟 인스턴스만 다루는 CloudFormation 템플릿(`ec2-test-template.yml`)으로 시작했다. 여기에 앱 스택을 자동 배포하는 git sync 워크플로우를 붙였다가, 곧바로 연결을 해제하고 mobile 동기화 관련 부분은 주석 처리했다 — 테스트 환경 자체의 안정성을 먼저 확보하는 게 우선이라고 판단해 범위를 좁힌 것이다.

이후 EC2 스팟 인스턴스와 RDS 스냅샷 복원을 하나의 스택으로 묶은 통합 템플릿을 새로 작성하고, 기존 단일 EC2 템플릿은 삭제했다.

## 1.2 보안그룹 정리

초기 보안그룹 설정에는 쓰지 않는 MySQL 인바운드 규칙이 남아있었다. 이를 제거하고, 대신 실제로 필요한 SSH 인바운드를 추가했다. LaunchTemplate에는 퍼블릭 IP 자동 할당을 설정해, 스택을 올릴 때마다 접근 가능한 상태로 바로 뜨도록 했다.

## 1.3 EC2 종료 → 자동 정리

핵심은 EC2 인스턴스가 종료되는 이벤트를 감지해서 관련 리소스 전체(스택)를 자동으로 삭제하는 것이었다. EC2 상태 변경 이벤트를 EventBridge로 받아 정리용 Lambda를 트리거하는 구조로 구현했다. IAM Role과 UserData, CreationPolicy를 추가해 인스턴스 부팅이 정상적으로 완료됐는지까지 CloudFormation이 추적할 수 있게 했고, 이후 Ubuntu 기준으로 UserData 스크립트를 수정하면서 EC2Role 권한도 함께 보완했다.

## 1.4 배포 상태 알림

UserData 안에 SSM 기반 Slack 알림 로직을 추가해서, 배포가 실패했을 때 바로 알 수 있게 했다. 이후 RDS `DBInstanceClass` 기본값을 `t4g.micro`로 낮추고 허용값 목록을 정리했으며, RDS 관련 환경변수 이름과 포트 누락을 수정하고, 헬스체크 경로와 Slack 알림 메시지를 다듬는 후속 수정이 이어졌다.

마지막으로 아키텍처 다이어그램과 함께 `TestEnvStack.md` 문서를 작성해, 이 스택이 어떻게 구성되고 왜 이런 구조를 택했는지 남겨두었다.

# 2. barlow-automation 인프라

## 2.1 최초 구성

Lambda, IAM, SQS, DynamoDB, CloudWatch, SSM으로 구성된 terraform 인프라를 처음부터 새로 작성했다. `.gitignore`를 추가하고 워크플로우 브랜치를 정리하는 것부터 시작해, 태그 정책을 정비하고 Lambda 배포 구조를 S3 기반으로 바꿨다 — 배포 아티팩트를 terraform apply 시점에 직접 패키징하는 대신, S3에 올려둔 산출물을 참조하는 방식이 배포 파이프라인과 더 깔끔하게 맞물렸다.

## 2.2 비용 관리 도구 도입과 정리

비용을 추적하기 위해 infracost를 도입했다가, 이후 CLI 전용 방식으로 전환했다. 동시에 태그 정책과 Graviton(ARM 기반 Lambda) 적용을 반영해서, 비용 추적과 실제 비용 절감 조치를 함께 가져갔다.

## 2.3 배포 브랜치명 정리 — 한 번 뒤집힘

배포 브랜치명을 `master`에서 `main`으로 통일했다가, `automation-deployer-role`의 허용 브랜치 설정은 다시 `main`에서 `master`로 되돌렸다. 코드/워크플로우 상의 브랜치명 통일과, 실제 운영 중인 배포 트리거가 바라보는 브랜치가 서로 어긋나면서 생긴 되돌림이었다.

## 2.4 deployer role 이름·신뢰 정책 정리

deployer role의 trust policy를 실제 automation 코드 저장소 주소에 맞게 수정하고, `barlow-deployer-role`이라는 이름을 `automation-deployer-role`로 리네이밍했다. 처음 이름을 지을 때는 이 role이 barlow 전체의 배포를 담당할 것처럼 지었지만, 실제로는 automation 배포에만 쓰인다는 게 명확해지면서 이름을 실제 책임 범위에 맞게 좁혔다. 사용하지 않는 Name 태그도 함께 정리했다.

## 2.5 IAM 권한 반복 조정

권한은 한 번에 완성하지 않고, 필요해질 때마다 추가하고 이후 정리하는 방식으로 수렴시켰다.

1. deployer role에 `s3:GetObject` 추가
2. deployer의 s3 권한을 리팩터링 (범위를 필요한 버킷/경로로 좁힘)
3. `ssm:PutParameter`의 리소스 ARN을 와일드카드가 아닌 구체적인 파라미터 경로로 수정
4. Lambda의 DynamoDB 접근 권한을 하나의 공용 정책 대신 역할별 최소 권한으로 분리

placeholder.zip 경로 문제로 Lambda 생성 자체가 실패하는 이슈도 있었는데, 초기 배포 시점에 실제 코드 아티팩트가 아직 준비되지 않아 자리만 차지하는 더미 zip을 참조하다 경로가 어긋나면서 발생한 문제였고, 경로를 바로잡아 해결했다.

## 2.6 Lambda 권한/환경변수 마무리

Lambda Function URL을 통한 호출을 위해 `lambda:InvokeFunction` 권한을 추가했다. Ack Lambda에는 `OPENAI_API_KEY` 환경변수를 추가했고, `barlow-slack-ack`가 사용하던 `GITHUB_TARGET_REPO` 변수명을 다른 Lambda와의 명명 일관성을 위해 `TARGET_REPO`로 통일했다. DynamoDB 테이블 이름도 하드코딩 대신 환경변수로 분리해, 이후 환경별로 다른 테이블을 바라보게 할 수 있는 여지를 남겼다.

마지막으로 완성된 인프라 구조를 README에 정리해서, 새로 합류하는 사람이 terraform 코드만 보고도 전체 그림을 파악할 수 있게 남겨두었다.

# 3. 정리

| 항목 | 테스트 환경 스택 | automation 인프라 |
|---|---|---|
| 핵심 리소스 | EC2 스팟 + RDS 스냅샷 복원 | Lambda + SQS + DynamoDB |
| 자동화 지점 | EC2 종료 → EventBridge → 정리 Lambda | S3 기반 배포 + IAM 최소 권한 수렴 |
| 반복된 시행착오 | git sync 워크플로우 연결/해제 | 배포 브랜치명 master↔main 되돌림 |

두 작업 모두 "처음부터 완벽한 설계"보다 "돌려보면서 필요한 만큼 좁혀가는" 방식으로 수렴했다는 공통점이 있었다. 특히 IAM 권한은 처음부터 정확히 예측하기보다, 실제 실행 로그에서 막히는 지점을 근거로 좁혀가는 쪽이 더 현실적이었다.
