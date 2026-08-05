---
layout: post
title: "바로 - UI 디자인 시스템 구현"
date: 2026-05-14 10:00:40
---

# 들어가며

[설명 문서]({% post_url 2026-05-12-baro-design-system %})에서 다룬 디자인 시스템의 실제 컴포넌트 구조를 정리한다.

# 1. 디렉토리 구조

```
apps/mobile/components/ui/
  TopBar.tsx
  Border.tsx
  Divider.tsx
  TabBar.tsx
  BottomNavBar.tsx
  Card/
    index.tsx
    CardHeader.tsx
    CardBody.tsx
  SegmentControl.tsx
  ChipSelector.tsx
  Pill.tsx
  ListSection/
    index.tsx
    ListRow.tsx
  ui-rules.md
```

# 2. 기본 프리미티브: TopBar / Border / Divider

가장 먼저 만든 건 TopBar, Border, Divider였다. 화면 대부분이 상단바를 필요로 했고, 구조도 단순해서 디자인 시스템의 첫 조각으로 적합했다. 탭 레이아웃에 바로 적용해 실제 사용 패턴을 검증한 뒤 다음 컴포넌트로 넘어갔다.

# 3. TabBar / BottomNavBar 추출

각 탭 화면에 흩어져 있던 TabBar 구현을 공통 컴포넌트로 추출했다. 이 과정에서 단순히 코드를 옮기는 것에 그치지 않고 렌더링 성능도 함께 점검했다 — 탭 전환마다 불필요하게 리렌더링되던 부분을 정리해 BottomNavBar를 공통화하면서 같이 개선했다.

# 4. Card compound 컴포넌트

카드 종류(입법/소식/Election)마다 내부 구성이 다르다는 문제를 compound 패턴으로 풀었다. 개념적으로는 다음과 같은 형태다 (실제 구현을 단순화한 예시):

```tsx
// 개념적 예시 — 실제 소스 아님
function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.cardContainer}>{children}</View>;
}

Card.Header = function CardHeader({ title, subtitle }: CardHeaderProps) {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>{title}</Text>
      {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
};

Card.Body = function CardBody({ children }: { children: React.ReactNode }) {
  return <View style={styles.body}>{children}</View>;
};

// 사용하는 쪽
<Card>
  <Card.Header title={bill.title} subtitle={bill.status} />
  <Card.Body>
    <BillSummary bill={bill} />
  </Card.Body>
</Card>
```

카드 레이아웃/여백/보더 같은 공통 스타일은 `Card` 자체가 책임지고, 각 카드 종류는 필요한 하위 컴포넌트만 조합한다. 처음엔 여러 카드 타입에 걸쳐 인터페이스가 중복돼 있었는데, 이후 정리 커밋에서 공통 인터페이스로 통합했다. Election 카드도 개별 스타일 값 대신 디자인 시스템 토큰(색상/간격)을 쓰도록 전환했다.

# 5. SegmentControl / ChipSelector / Pill

필터·선택 UI였던 SegmentControl과 ChipSelector·Pill을 홈 화면 탭에 먼저 적용한 뒤, explore/digest 등 다른 화면에도 같은 컴포넌트로 확대 적용했다. 화면마다 각자 만들던 "선택 가능한 칩/세그먼트" UI가 하나의 컴포넌트로 수렴됐다.

# 6. ListSection compound 컴포넌트

리스트 화면(입법 목록, 정치인 목록 등)에서 반복되는 "섹션 헤더 + 리스트 아이템" 패턴을 `ListSection`과 `ListRow.SimpleText`로 뽑아냈다. Card와 같은 이유로 compound 패턴을 적용했다:

```tsx
// 개념적 예시
<ListSection>
  <ListSection.Header title="이번 주 발의 법안" />
  <ListSection.Item>
    <ListRow.SimpleText text={bill.title} onPress={() => goToBill(bill.id)} />
  </ListSection.Item>
</ListSection>
```

우리동네 탭에 먼저 이 패턴을 적용해보고, ListHeader/ListSection API를 다듬은 뒤 다른 화면으로 확장했다.

# 7. 컴포넌트 작성 규칙 (`ui-rules.md`)

이번 작업에서 정리한 패턴을 규칙으로 문서화했다. 핵심은 세 가지다.

1. **여러 하위 요소를 조합해야 하는 컴포넌트는 compound 패턴을 우선 고려한다** (Card, ListSection의 사례)
2. **스타일 값은 직접 쓰지 않고 디자인 시스템 토큰을 참조한다** (Election 카드 전환 사례)
3. **새 컴포넌트는 반드시 하나 이상의 실제 화면에 적용해보고 API를 확정한다** — 추상적으로 먼저 설계하지 않는다

# 8. 마무리

TopBar부터 ListSection까지 순서대로 뽑아내면서 화면 적용 → API 조정 → 다음 컴포넌트로 이어지는 흐름을 반복했다. 이 흐름과 여기서 정리한 규칙은 이후 광고 배너 시스템처럼 새 기능을 붙일 때도 동일하게 적용됐다.
