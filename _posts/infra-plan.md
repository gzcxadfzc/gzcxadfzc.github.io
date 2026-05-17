# 인프라 구성 계획 (Lambda 마이그레이션)

> **목적**: SQS → Lambda → Redis 비동기 파이프라인 인프라 추가
> **기반**: 기존 `infra/main.tf` (VPC, EC2 앱서버, EC2 Redis, RDS)

---

## 1. 현재 인프라 구조

```
VPC (10.0.0.0/16)
  public-a (10.0.1.0/24)
    EC2 app-server (t3.small)   ← Spring Boot
    EC2 redis     (t3.micro)    ← Redis 6379
  public-b (10.0.2.0/24)
    RDS MySQL     (db.t3.micro)
```

---

## 2. 추가 후 목표 구조

```
VPC (10.0.0.0/16)
  public-a (10.0.1.0/24)
    EC2 app-server (t3.small)
    EC2 redis     (t3.micro)    ← 6379 public open
  public-b (10.0.2.0/24)
    RDS MySQL

Lambda bip-generator            ← VPC 없음 (public internet)
  │ SQS polling (public endpoint)
  │ Redis 접근 (public IP)
  ▼

SQS FIFO (리전 서비스, public endpoint)

S3 lambda-artifacts 버킷        ← 신규 (Lambda JAR 저장)
```

**Lambda는 VPC에 붙이지 않는다.**
- VPC 없는 Lambda: 인터넷 직접 접근 → SQS public endpoint 접근 가능
- Redis: public IP로 열어두고 Lambda에서 직접 접속
- private 서브넷, NAT Gateway, VPC Endpoint 모두 불필요

---

## 3. 신규 리소스 목록

### 3-1. SQS

| 항목 | 설정값 |
|------|--------|
| Queue 이름 | `littlewriter-bip-generation.fifo` |
| Type | FIFO |
| ContentBasedDeduplication | false (MessageDeduplicationId 직접 지정) |
| VisibilityTimeout | 300초 |
| MessageRetentionPeriod | 86400초 (1일) |
| DLQ | `littlewriter-bip-dlq.fifo` |
| maxReceiveCount | 3 |

### 3-2. Lambda

| 항목 | 설정값 |
|------|--------|
| 함수명 | `littlewriter-bip-generator` |
| Runtime | `java21` |
| Handler | `com.pkg.lambda.BipGeneratorHandler::handleRequest` |
| Memory | 512 MB |
| Timeout | 300초 (SQS VisibilityTimeout과 동일) |
| VPC | **없음** |
| 패키지 | S3에서 JAR 로드 (`lambda-artifacts` 버킷) |

**Event Source Mapping**:
- Source: `littlewriter-bip-generation.fifo`
- BatchSize: 1 (FIFO MessageGroup 직렬 처리 보장)
- FunctionResponseTypes: `ReportBatchItemFailures`

### 3-3. IAM

**Lambda Execution Role** (`littlewriter-lambda-role`):
```
AWSLambdaBasicExecutionRole      ← CloudWatch 로그 (VPC 없으므로 Basic으로 충분)
SQS: ReceiveMessage, DeleteMessage, GetQueueAttributes
     (bip-generation.fifo, bip-dlq.fifo)
```

**EC2 app-server** (기존 인스턴스에 추가):
```
SQS: SendMessage (bip-generation.fifo)
```
→ IAM Instance Profile로 부여 (EC2에 Role 연결)

### 3-4. S3 (Lambda 아티팩트)

| 항목 | 값 |
|------|-----|
| 버킷명 | `littlewriter-lambda-artifacts-{account_id}-ap-northeast-2` |
| 용도 | Lambda JAR 업로드 (`bip-generator.jar`) |
| Versioning | 활성화 (롤백 대응) |

---

## 4. 기존 리소스 변경

### 4-1. `aws_security_group.redis` 인바운드 규칙 추가

```hcl
ingress {
  description = "Redis public access for Lambda"
  from_port   = 6379
  to_port     = 6379
  protocol    = "tcp"
  cidr_blocks = ["0.0.0.0/0"]
}
```

### 4-2. outputs.tf 추가

```
sqs-queue-url        → app-server 환경변수용
lambda-function-name → 배포 스크립트용
redis-public-ip      → Lambda 환경변수용
```

---

## 5. Lambda 환경변수

```
REDIS_HOST     ← aws_instance.redis.public_ip
REDIS_PORT     ← 6379
MOCK_SLEEP_MS  ← 3000  (Mock: 3초 sleep)
```

---

## 6. Terraform 파일 구조

```
infra/
  main.tf       ← 기존 (네트워크, EC2, RDS) + redis SG 규칙 추가
  sqs.tf        ← 신규: SQS + DLQ
  lambda.tf     ← 신규: Lambda 함수, Event Source Mapping
  iam.tf        ← 신규: Lambda role, EC2 Instance Profile + SQS 권한
  s3.tf         ← 신규: lambda-artifacts 버킷
  variables.tf  ← 기존 유지
  outputs.tf    ← 기존 + SQS URL, Lambda ARN, Redis public IP 추가
```

---

## 7. 배포 순서

```
1. terraform apply
   → SQS, Lambda(임시 placeholder ZIP), IAM, S3 버킷 생성
   → Redis SG에 6379 public 규칙 추가

2. Lambda JAR 빌드
   → ./gradlew :lambda:shadowJar

3. S3에 JAR 업로드 + Lambda 코드 업데이트
   → aws s3 cp build/libs/bip-generator.jar s3://...
   → aws lambda update-function-code --s3-key ...

4. 메인 앱 환경변수에 SQS_QUEUE_URL 추가 후 재기동
```

---

## 8. 비용 추정

| 항목 | 예상 비용 |
|------|----------|
| SQS FIFO | ~$0 (월 100만 건 이하 무료 티어) |
| Lambda | ~$0 (테스트 규모) |
| S3 (artifacts) | ~$0 |
| **합계** | **~$0/월 추가** |

> VPC Endpoint, NAT Gateway 제거로 이전 안 대비 ~$7/월 절감.
