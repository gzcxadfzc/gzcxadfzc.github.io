---
layout: post
title: "바로 - 별점 통계 리팩터링과 캐싱 안정화 구현"
date: 2026-05-05 10:30:40
---

# 들어가며

[설명 문서]({% post_url 2026-05-05-baro-starpoint-stats %})에서 다룬 별점 통계 기능의 실제 구현 변경을 정리한다.

# 1. 문제가 있던 응답 구조

기존 통계 응답 DTO는 대략 다음과 같은 형태였다 — 분포별 버킷마다 개인 식별 정보 리스트를 함께 들고 있었다.

```kotlin
// 문제가 있던 구조 (개념적 예시)
class CustomerStatistics(
    val ageRange: Map<Int, List<CustomerIdAndName>>,
    val gender: Map<Gender, List<CustomerIdAndName>>,
    val politicalTendency: Map<PoliticalTendency, List<CustomerIdAndName>>,
    val district: Map<String, Map<String, Map<String, List<CustomerIdAndName>>>>
)
```

인증 없이 호출 가능한 `GET` 통계 엔드포인트가 이 구조를 그대로 반환하고 있었고, 페이지네이션도 없어서 응답 한 번에 전체 사용자 분포와 실명·customerId 조합이 노출됐다.

# 2. 수정 방향: 개수 집계로 전환 + 관리자 경로 분리

## 2.1 공개 응답에서 개인 식별 정보 제거

공개 통계 응답은 리스트가 아니라 **개수(count) 집계**만 반환하도록 구조를 바꿨다.

```kotlin
// 수정 후 (개념적 예시)
class CustomerStatistics(
    val ageRange: Map<Int, Int>,
    val gender: Map<Gender, Int>,
    val politicalTendency: Map<PoliticalTendency, Int>,
    val district: Map<String, Map<String, Map<String, Int>>>
)
```

개인 식별이 필요한 경우(관리자 조회 등)는 별도의 관리자 전용 엔드포인트로 분리했다.

## 2.2 대표자 단위 통계 계산 로직

대표자별 별점 통계를 계산하는 로직을 `StarPointService`로 새로 구현했다. 처음에는 서비스 클래스 내부에 계산 로직을 직접 두었다가, 이후 여러 곳에서 재사용할 수 있도록 별도 Util 클래스(`CalculateStatisticsUtils`)로 분리하는 리팩터링을 거쳤다. 통계 집계 자체는 애플리케이션 레벨에서 처리하는 방식을 택했고, 이후 대용량 데이터 상황에서 DB 집계 쿼리 방식과 성능을 비교해볼 여지를 남겨뒀다.

## 2.3 입력 검증 추가

별점 UPDATE 요청에 point 값의 범위 검증을 추가하고, 별점 등록 요청 DTO에도 입력 필드 검증을 추가했다. 두 경로 모두 관련 테스트 케이스를 함께 작성해 회귀를 방지했다.

## 2.4 캐싱 안정화

통계 응답은 반복 조회가 많은 특성상 캐시가 필요했는데, 두 가지 문제가 있었다.

- 통계 캐시 설정 자체가 누락되어 있던 부분을 추가
- Redis에 캐싱된 통계 응답을 역직렬화하는 과정에서 오류가 발생하던 문제를 수정 — 응답 DTO 구조가 바뀌면서 기존 캐시 역직렬화 방식과 맞지 않게 된 부분이 원인이었다

## 2.5 엔드포인트 구조 정리

관리자/공개 통계 집계 엔드포인트를 추가하면서, 응답 DTO 이름도 통계 용도에 맞게 정리했다. 기존에는 범용 이름을 쓰고 있어 통계 전용 응답이라는 것이 이름만으로 드러나지 않았던 부분을 명확히 했다.

# 3. 검증

- 통계 엔드포인트별(공개/관리자) 테스트 보강
- point 범위 검증 및 등록 요청 DTO 검증에 대한 테스트 추가
- 공개 통계 응답에 개인 식별 필드가 더 이상 포함되지 않는지 확인

# 4. 정리

이번 작업에서 확인한 원칙은 단순했다 — **집계 응답은 원본 개인 식별 데이터를 절대 포함하지 않아야 하고, 개인 단위 조회가 필요하면 그 자체를 별도의, 인증이 걸린 경로로 분리해야 한다.** 응답 DTO를 설계할 때 "이 필드가 개인을 특정할 수 있는가"를 점검하는 습관이 이 작업 이후 자연스럽게 붙었다.
