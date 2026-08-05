---
layout: post
title: "바로 인프라 마이그레이션 구현: CodeConnections 인증 실패와 Blue/Green 배포 안정화"
date: 2026-07-11 10:30:00
---

[설명 문서](/2026/07/11/baro-infra-migration)에서 다룬 Terraform 마이그레이션과 CI/CD 구축의 실제 구현 내용과, 그 과정에서 만난 문제들의 원인·해결을 정리합니다.

## 1. Terraform 구조

관심사별로 파일을 분리하고, 계정 ID·리전·VPC 같은 반복 값은 `data`/`locals`로 추상화했습니다. 상태 저장은 S3 backend + native lock을 사용해 별도 DynamoDB 락 테이블 없이 동시 apply를 방지하도록 구성했습니다. 리소스 네이밍 컨벤션을 문서화해두고 ECR 레포지토리 추가 시점부터 이 컨벤션을 강제했습니다.

## 2. Dev ALB + ASG

- ALB용 인증서를 와일드카드 ACM 인증서로 전환하고 dev 전용 타겟 그룹을 신규 생성
- Launch Template + ASG + Packer 기반 Golden AMI 빌드 파이프라인 구성
- backend CI/CD(buildspec, CodeBuild)를 구축하는 과정에서 앱 모듈을 `app/api-app` 구조로 재배치했는데, 이 재배치 시점에 타겟 그룹이 의도치 않게 재생성되며 ALB 연결이 끊기는 충돌이 발생 — 타겟 그룹을 모듈 경로와 분리된 리소스로 다시 정의해 재배치가 타겟 그룹 생명주기에 영향을 주지 않도록 수정
- Golden AMI 부트스트랩에 헬스체크, CORS, redis, CloudWatch Logs 설정을 추가
- WAF `DenyKnownRegion` 룰이 정상 리전의 직접 요청까지 차단하던 버그를 발견해 수정 (룰 매칭 조건이 의도한 것과 반대로 걸려 있었음)
- 비용 절감을 위해 dev ASG 야간 자동종료와 Slack `/dev-on`, `/dev-off` 커맨드를 추가

## 3. 레거시 배치 CI/CD — CodeConnections 인증 실패 (3회 반복)

배치 서버 CI/CD를 구축하며 가장 오래 걸린 문제입니다.

### 증상

CodeBuild가 GitHub 소스를 가져오지 못하고 `Access denied to connection` 에러로 실패했습니다.

### 잘못 짚은 원인들

처음에는 IAM 권한 문제로 의심해 `codeconnections:GetConnection`, `codeconnections:GetConnectionToken` 권한을 추가했지만 해결되지 않았습니다. 다음으로 connection 자체가 손상됐다고 보고 재생성을 시도했는데, us-east-1에서 한 번, ap-northeast-2에서 두 번, 총 세 번을 재생성해도 같은 에러가 반복됐습니다.

### 근본 원인

CodeBuild 프로젝트가 참조하는 connection ARN은 프로젝트 설정이 아니라 **계정/리전 레벨의 소스 자격증명 포인터**에 저장되어 있었습니다. connection을 아무리 새로 만들어도 CodeBuild는 여전히 예전에 끊긴 connection을 계속 참조하고 있었던 것입니다.

### 해결

```
aws codebuild import-source-credentials
```

이 명령으로 최신 connection ARN을 계정 레벨 자격증명 포인터에 다시 연결하고 나서야 해결됐습니다. connection을 새로 만드는 것과 CodeBuild가 그 connection을 실제로 참조하도록 만드는 것은 별개의 작업이라는 게 핵심이었습니다.

## 4. 아키텍처 불일치 (arm64 vs x86_64)

macmini는 Apple Silicon(arm64)인데 CodeBuild 기본 빌드 이미지는 x86_64였습니다. `ARM_CONTAINER` 컴퓨트 타입 + `aws/codebuild/amazonlinux-aarch64-standard:4.0` 이미지로 교체했고, 이 이미지가 실제로 Amazon Linux 2023 기반인지까지 GitHub 소스에서 확인해 검증했습니다. 빌드 산출물(Docker 이미지)의 아키텍처가 배포 대상과 다르면 이미지는 정상적으로 push되지만 macmini에서 실행 시점에야 실패하기 때문에, 이 검증을 CI 구축 단계에서 미리 끝내는 편이 디버깅 비용을 줄입니다.

## 5. 시크릿/설정 파일 로딩 경로

`spring.config.import`가 classpath 상대경로를 참조하고 있었는데, 해당 설정 파일은 gitignore되어 있어 CodeBuild 빌드 산출물 안에는 애초에 존재하지 않았습니다. `file:/app/config/...` 절대경로 참조로 바꾸고, macmini에서 볼륨마운트로 그 경로에 실제 파일을 주입하는 방식으로 전환했습니다. `FirebaseConfig`, `AwsSshCommandManager`처럼 `ClassPathResource`를 하드코딩해 쓰던 다른 지점들도 같은 이유로 `FileSystemResource` 참조로 바꿨습니다.

테스트 코드(`BatchApplicationTests`)는 `@SpringBootTest`로 전체 스프링 컨텍스트를 로딩하면서 실제 Postgres와 실제 시크릿을 요구하는 구조라 CI 환경에서 안전하게 돌릴 수 없었습니다. 이런 통합 테스트를 무리하게 CI에 태우기보다, buildspec에서 테스트 단계를 빼고 로컬 실행 전용으로 남겼습니다.

## 6. macmini 배포 실전 디버깅

- Docker 자격증명이 macOS Keychain에 저장을 시도하는데, SSH 세션에서는 Keychain과 상호작용이 불가능해 `errSecInteractionNotAllowed`가 발생 — `credsStore` 설정을 제거하고 `security unlock-keychain`으로 우회
- 헬스체크 엔드포인트가 실제 컨트롤러 응답 형식과 어긋나 있던 것을 발견 후 정정 (JSON이 아닌 순수 문자열 응답), DB 체크 엔드포인트도 별도로 추가
- macmini 파일 배치 경로를 `/opt`에서 기존 관습대로 `~/Desktop/app/`으로 변경 — macOS에서 `/opt`는 sudo 권한이 필요해 무인 배포 스크립트와 맞지 않았음

### 미해결로 남긴 문제

`docker compose up -d`는 이미지 태그가 바뀌지 않으면 컨테이너를 강제로 재시작하지 않습니다. 이게 Docker의 크래시루프 재시작 백오프 지연과 겹치면, 배포 스크립트의 30초 헬스체크 윈도우 안에 컨테이너 재시작이 실제로 일어나지 않아 정상 배포인데도 실패로 오판단할 수 있습니다. `--force-recreate` 플래그 추가가 해결책으로 파악됐지만 이 시점 기준으로는 아직 반영 전입니다.

## 7. Prd Blue/Green 안정화

Blue/Green 파이프라인을 처음 붙였을 때는 배포 자체보다 주변 설정 오류가 더 많이 발생했습니다.

- `codedeploy.create_deployment` 호출의 `s3Location` 파라미터 형식이 CodeDeploy가 기대하는 형식과 달라 배포 시작 자체가 실패
- rollback lambda에 `codedeploy:RegisterApplicationRevision` 권한이 빠져 있어, 정작 롤백이 필요한 순간에 롤백 lambda가 동작하지 않는 상태였음 — 이후 lambda의 CodeDeploy 읽기 권한을 `Get*`/`List*`/`Batch*`로 통합 정리
- Datadog Agent의 `DD_SITE`가 기본값으로 남아 있어 실제 리전(`us5.datadoghq.com`)으로 전송되지 않던 문제 수정

안정화 마지막 단계로 prd ASG의 소유권을 Terraform에서 CodeDeploy로 이관했습니다. 배포 도구(CodeDeploy)가 인스턴스 교체를 담당하는데 인프라 도구(Terraform)가 같은 ASG를 관리 대상으로 잡고 있으면, Terraform apply 시점에 CodeDeploy가 만든 인스턴스 구성을 되돌리거나 충돌시킬 수 있기 때문입니다. "누가 이 리소스의 원천인가"를 명확히 하나로 정리한 조치였습니다.

## 정리

이번 마이그레이션에서 반복적으로 확인한 패턴은, 겉보기 증상(connection 인증 실패, 타겟 그룹 충돌, 롤백 미동작)과 실제 원인(계정 레벨 자격증명 포인터, 리소스 소유권 중복, IAM 권한 누락)이 다른 계층에 있는 경우가 많았다는 점입니다. 특히 CodeConnections 문제처럼 "리소스를 재생성하면 해결되겠지"라는 직관이 틀렸던 사례는, 클라우드 리소스의 참조 관계가 항상 명시적이지 않다는 걸 다시 확인시켜준 경험이었습니다.
</content>
