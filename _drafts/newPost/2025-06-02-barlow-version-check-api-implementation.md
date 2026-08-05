---
layout: post
title: "Barlow - 클라이언트 버전 확인 API 구현"
date: 2025-06-02 10:00:40
---

# 들어가며

[설명 문서]({% post_url 2025-05-26-barlow-version-check-api %})에서 다룬 설계를 실제로 어떻게 구현했는지 정리한다.

# 1. 저장 구조

버전 정보는 플랫폼 단위로 관리된다.

```
client_version
+----------------------+
| PK  no                |
|     device_os         |
|     minimum_supported |
|     latest            |
+----------------------+

예시)
1 | ANDROID | 1.2.0 | 1.5.3
2 | IOS     | 1.3.0 | 1.4.1
```

`ClientVersionJpaEntity`로 이 테이블을 매핑하고, 최소 지원 버전과 최신 버전을 플랫폼별로 한 row씩 관리한다.

# 2. 도메인 계층

## 2.1 SemanticVersion

버전 표기는 정규식으로 형식을 검증하고, `isLessThan()`으로 다른 `SemanticVersion`과의 하위 버전 여부를 판단한다.

- 정식 릴리즈: `<major>.<minor>.<patch>` (예: `1.0.0`, `1.2.1`, `1.14.9`)
- 비공식 릴리즈: `<major>.<minor>.<patch>-<suffix>` (예: `1.0.0-alpha`, `1.2.1-rc`)
- 지원 suffix: `snapshot` < `alpha` < `beta` < `rc` < 정식 릴리즈(suffix 없음)

즉 `1.0.0-alpha`는 `1.0.0-beta`, `1.0.0-rc`, `1.0.0` 모두보다 낮은 버전으로 취급된다.

## 2.2 AvailableClientVersion과 상태 판별

`AvailableClientVersion`이 플랫폼의 `minimum_supported`/`latest`를 감싸고, 요청 버전과 비교해 상태를 반환한다.

```
LATEST            : 요청 버전 == latest
UPDATE_AVAILABLE  : minimum_supported <= 요청 버전 < latest
NEED_FORCE_UPDATE : 요청 버전 < minimum_supported
INVALID           : 비공식 버전이 정책상 차단된 경우
```

## 2.3 릴리즈 허용 전략

```
AllowUnofficialReleaseStrategy      # 기본값 — 비공식 릴리즈 전부 허용
AllowOnlyOfficialReleaseStrategy    # @Profile로 전환 — 비공식 릴리즈는 INVALID 처리
```

지금은 `AllowUnofficialReleaseStrategy`를 기본으로 쓰고 있고, 운영 환경에서 비공식 버전을 막고 싶어지면 `AllowOnlyOfficialReleaseStrategy`에 프로파일 설정만 얹으면 되도록 구현해뒀다.

# 3. API 계층

`ClientVersionCheckController`가 `api/v1/client-version/check` 엔드포인트를 제공한다.

**요청**: 헤더의 `X-Device-Os`, `X-App-Version`으로 플랫폼과 현재 버전을 전달받는다.

**응답**:
```json
{
  "needForceUpdate": false,
  "isUpdateAvailable": true
}
```

`needForceUpdate`/`isUpdateAvailable` 두 boolean으로만 구성해, 클라이언트가 상태 enum을 직접 해석할 필요 없이 바로 분기할 수 있게 했다. 현재는 `X-App-Version` 헤더를 통한 별도 핸들러는 구현하지 않았고, 버전 확인은 이 엔드포인트 하나를 통해서만 가능하다.

# 4. 구현 중 있었던 일: 브랜치 사고와 재구현

최초 구현은 도메인(`SemanticVersion`, `AvailableClientVersion`, 릴리즈 전략) → 저장소(`ClientVersionJpaEntity`) → 컨트롤러 순으로 이어붙이는 식으로 진행됐다. 그런데 이 작업 브랜치(`issue/97`)에 의도치 않은 커밋이 잘못 푸시되는 사고가 발생했고, 이를 정리하기 위해 이미 만들어둔 구현 전체를 되돌렸다.

이후 PR #98에서 도메인/저장소/컨트롤러 전체를 처음부터 다시 구현해 병합했다(+518/-0). 설계 방향 자체는 되돌리기 전과 동일했지만, 결과적으로 전체 스택을 한 번 더 작성한 셈이었다 — 브랜치 정리를 위한 되돌림이 구현을 처음부터 다시 쓰는 결정으로 이어진 사례였다.

# 5. 남은 과제

PR 본문에 명시적으로 남겨둔 두 가지가 있다.

- **storage 계층 테스트 미확인**: 당시 배치 설정 파일이 없어 storage 계층 테스트 코드를 실행해보지 못한 상태로 병합됐다. 별도 확인이 필요하다.
- **버전 정보 캐싱 전략**: 현재는 `repositoryAdapter`를 통해 초기에 불러온 버전 정보를 단순 캐싱해서 쓰고 있다. 캐시 무효화 전략을 정교하게 다듬거나 다른 방식을 검토할 필요가 있다.

버전 정보가 DB로 관리되고, 표기법에 따른 예외 처리는 도메인 계층이 전담하는 구조이기 때문에 — 운영 중 버전 정보를 직접 수정할 일이 있다면 SemVer 표기법을 정확히 지켜서 넣어야 판별 로직이 의도대로 동작한다.
