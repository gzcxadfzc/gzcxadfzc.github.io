---
layout: post
title: "LittleWriter - 이미지 생성"
date: 2024-08-21 12:00:40
---
* TOC
{:toc}

<br>

## 1. 이미지 생성하기

비용과 성능 사이에서 어떤 모델을 사용해야 할지 잘 선택하는 것이 중요합니다.
프로젝트를 진행하는 도중에도 모델의 개선이 이루어졌고, 처음 기획할 당시에 없었던 모델인 GPT-4 Turbo가 추가되기도 하였습니다.
(2024년 4월 기준)


### 1.1 캐릭터 이미지 생성하기

Little Writer에서는 다음과 같은 방식을 통해 사용자가 자신만의 캐릭터를 생성 할 수 있습니다.
이를 통해 자신이 만든 등장인물을 사용하여 동화 이야기를 이어나갈 수 있는 기능을 제공합니다.

```

[사용자가 캐릭터 스케치] → [성격, 이름 등 캐릭터 정보 입력] → [AI를 통해 완성된 캐릭터 저장]

이후 자신이 생성한 캐릭터를 통해 동화 생성

```

>**요구사항**
>- 생성된 캐릭터는 일관된 그림체를 가져야 한다.
>- 생성된 캐릭터는 사용자의 그림을 기반으로 만들어져야 한다.
>- 생성된 캐릭터로 동화를 만들 수 있어야 한다.
>

#### 1.1.1 모델 선택하기

캐릭터 생성에 있어 모델 선택의 가장 큰 기준을 다음 항목을 설정했습니다.

>1. 얼마나 비슷한 그림체로 생성되는가
>2. 사용자의 그림을 얼마나 잘 인식 하는가

`Stable Diffusion`은 LoRA를 적용하여 동일한 스타일을 반복적으로 유지하기 용이하며, ControlNet의 Canny 조건을 통해 사용자가 입력하신 스케치 라인을 통해 일관된 그림체의 캐릭터 이미지 생성이 가능했습니다. DALL·E의 경우 당시 모델의 image-to-image 기능의 성능이 기준에 부합하지 않아 사용하지 않았습니다.

![stableDiffusion예시](/assets/img/content/2024-08-21/그림2.png){: width="500"}_사용자 입력의 스케치(좌) 와 stable diffusion을 사용하여 변환한 이미지(우)_

#### 1.1.2 `appearance_keyword`와 캐릭터 생성 전략

이 과정에서 캐릭터 엔티티에는 이미지에서 추출한 외형 설명 텍스트를 appearance_keyword로 함께 저장합니다.
`appearance_keyword`는 _머리 색과 스타일, 피부 톤, 상·하의의 종류와 색상, 신발 및 소품(모자·가방 등), 표정과 포즈_ 와 같은 요소를 텍스트 형식으로 추출하여 저장하며, 이후 삽화 생성 시 text-to-image 프롬프트로 재사용되어 img2img와 text2img 환경을 자연스럽게 연결해 줍니다.

생성할 이미지에서 사용자가 그린 등장인물 포함하게 하는 방식으로 다음과 같은 방식을 검토했습니다.

>1. image-to-image 방식을 사용하여 생성된 캐릭터에 배경을 생성하기
>2. text-to-image를 사용하여 캐릭터 특징을 텍스트로 추출 후 프롬프트로만 생성하기

최종적으로 text-to-image 방식을 채택하였습니다.

**이유**
- image-to-image는 추론 시간이 급격히 증가하고, 모델 상태/리소스에 따라 성능 편차가 큼.
- 한 페이지 생성에 수 분이 소요되면 사용자 경험 측면에서 매우 적합하지 않음.
- text-to-image는 appearance_keyword만 잘 추출된다면 LLM과의 연계가 용이함.

**프롬프트 예시**
```
you're a helpful assistant who depict character's appearance.
depict with details only using only nouns and adjectives seperated by comma, so that can redraw it with keywords again.
depict with details using given description with only keywords seperated by comma without line break.
you must depict
- hairstyle
- top
- pants
- shoes
- hair color and length

example : a boy with brown short hair, red shirt, blue shoes, brown pants if you cannot distinguish image return blank space
```

<br>

**최종 파이프 라인**
```
[사용자 스케치] → [stable diffusion을 통한 생성] → [gpt vision을 통한 키워드 텍스트 추출] → [저장]

이후 appearance_keyword와 캐릭터 테이블의 다른 속성을 조합하여 삽화에서 등장인물을 생성
```


### 1.2 동화 삽화 생성하기

동화의 삽화는 사용자의 입력을 기반으로 생성되며, 해당 입력을 묘사하는 그림 속에는 반드시 등장인물이 포함됩니다. 삽화를 생성할 때 다음의 기준을 중요한 원칙으로 설정하였습니다.

>**얼마나 일관된 그림체로 생성되는가**

- 삽화 전체가 동일한 화풍과 스타일을 유지하여 동화의 연속성이 보장되어야 합니다.

<br>

>**주인공이 삽화에 잘 나타나는가**

- 사용자가 직접 그린 캐릭터라고 인식될 수 있을 만큼 주인공의 특징이 명확히 표현되어야 하며 어색하지 않아야 합니다.

<br>

>**현재 진행되고 있는 내용을 얼마나 잘 표현하는가**

- 사용자의 입력 내용이 삽화 속 상황으로 자연스럽게 반영되어, 줄거리와 그림이 조화를 이루어야 합니다.

<br>

>**생성 속도가 얼마나 빠른가**

- 이미지를 생성하기까지의 시간이 사용자 경험을 해치지 않는 선에서 끝나야 합니다.

<br>

이 기준을 중심으로 여러 방식의 삽화 생성 방법을 비교·검토하였습니다.


#### 1.2.1 stable diffusion
삽화 생성 시 Stable Diffusion을 활용하면 `LoRA`를 적용하여 **일관된 그림체로 결과물을 만들 수 있습니다.** 동화의 분위기에 맞는 화풍을 유지할 수 있기 때문에 서비스의 **완성도와 통일성을 높이는 장점**이 있습니다.

![stableDiffusion예시](/assets/img/content/2024-08-21/1.png){: width="500"}_stable diffusion예시_

**장점**
- lora를 통해 일관된 화풍의 그림으로 생성이 가능하다

**단점**
- 느린 생성 속도
    - 평균적으로 20초 + 시간이 생성되고 이전의 전처리 동작까지 포함하면 삽화 하나에 30초 ~ 1분의 시간이 소요됩니다.
- 텍스트 인식 성능
    - dalle에 비해 프롬프트 이해도가 현저히 떨어지기때문에 텍스트를 통한 장면 묘사가 부실합니다. 특히 삽화의 구도가 거의 항상 고정되어서 나오는 특징이 있습니다.

#### 1.2.2 dall-e와 stable-diffusion 같이 사용하기
Stable Diffusion을 단독으로 사용할 경우, LoRA를 적용하여 화풍을 통일할 수 있다는 장점이 있습니다. 그러나 텍스트만으로 사용자가 원하는 장면이나 분위기를 정확히 묘사하기에는 한계가 존재합니다. 특히 동화의 삽화는 단순히 캐릭터 이미지를 생성하는 것을 넘어, 특정 장면과 상황을 표현해야 하기 때문에 구도와 세부 묘사가 매우 중요합니다. Stable Diffusion은 이러한 구도를 다양하게 반영하는 데 약점을 보이며, 결과물이 자주 고정된 형태로 생성되는 문제가 있습니다.

반대로, DALL·E는 텍스트 이해 능력이 우수하여 사용자가 작성한 프롬프트를 기반으로 다양한 구도와 장면을 잘 표현할 수 있습니다. 즉, 텍스트 기반 장면 해석력은 DALL·E가 강점을 가지는 부분입니다. 하지만 DALL·E는 스타일의 일관성이 떨어지고, 삽화 전체를 하나의 화풍으로 통일하는 데는 적합하지 않습니다.

따라서 두 모델을 결합하는 접근을 고려할 수 있습니다. 먼저 DALL·E를 활용하여 프롬프트 기반으로 장면의 기본 구도와 배치를 생성하고, 이후 Stable Diffusion을 사용해 LoRA를 적용한 채색과 스타일 보정을 수행하는 방식입니다. 이렇게 하면 DALL·E의 장점인 텍스트 이해와 구도 생성 능력과 Stable Diffusion의 강점인 화풍 통일성과 세부 표현력을 동시에 활용할 수 있습니다.

이 방식은 다소 복잡한 파이프라인을 요구하지만, 최종적으로는 사용자가 원하는 동화풍의 일관된 삽화를 확보하면서도 각 장면마다 달라지는 상황적 표현을 담을 수 있다는 점에서 서비스의 완성도를 높일 수 있는 가능성이 있습니다.

![통합예시](/assets/img/content/2024-08-21/4.png){: width="800"}_통합 워크플로우 예시_

**단계1. 프롬프트 추출**

system promt
```
you're a helpful assistant that depict details to generate image.
using given json, depict "currentContext" scene.
you should follow
- depict current scene in "mainCharacter"'s perspect of view
- do not contain any information of "mainCharacter"
- depict info must follow one of these format
  [character] is [character's posture], in [background], [lights]
  [object] is in [background], [lights]
- answer must be in english
```

input
```
{
    "previousContext" : "순용이는 오두막을 발견했습니다. 오두막은 어두웠고 거기에는 곰이 살고 있었습니다.곰은 말했습니다. "안녕?" 순용이는 곰에게 꿀을 나누어주었습니다",
    "currentContext" : "곰은 꿀을 맛있게 먹었습니다.",
    "whereStoryBegins" : "오두막",
    "mainCharacterName" :"순용"
}
```

output
```
The bear is sitting and eating honey, in a dimly lit cabin.
```

<br>

**단계2. 스케치 생성**

dalle를 통해 이미지의 스케치 즉 윤곽선을 생성하고 이를 `controlnet:canny`를 사용하여 stable diffusion을 사용해 변환합니다.
단계1.의 output에 사전정의된 프롬프트(_"do a sketch"_ 와 같이)를 추가하여 이미지를 생성할 수 있습니다.

![통합예시](/assets/img/content/2024-08-21/5.png){: width="500"}_Revised Prompt from Dalle3 - A full sized image in black and white line sketch style, depicting a bear comfortably seated inside a dimly lit, rustic log cabin, indulging in a sweet jar of honey. The interior ambiance of the cabin shows minimal light sources creating natural shadows and highlights, perfectly resulting in a calm and serene atmosphere._

**단계3. 스케치를 통해 삽화 완성**

![통합예시](/assets/img/content/2024-08-21/6.png){: width="500"}_stable-diffusion에 의해 완성된 이미지_

<br>

**장점**
- 다양한 구도의 이미지를 생성 가능합니다.
    - dalle 의 텍스트 이해도가 stable diffusion보다 높기에 즉 다양한 구도의 스케치를 통해 완성하는 방식을 사용할 수 있습니다.
- 이미지 묘사 텍스트[`depictScenary`]의 결과를 공통적으로 재사용 가능합니다.
- 어느정도 일관된 그림체(같은 lora적용)로 삽화가 생성됩니다.

**단점**
- 생성 시간 소모가 매우 늘어납니다.
    -  이 방식에서는 하나의 이미지를 생성하기 위해 생성형 AI를 3번이나 사용해야 한다. 채색된 이미지를 생성하기까지 거의 1분이 넘는 시간이 소요되기에 동화를 만드는 과정에는 스케치된 이미지만 보여준 후 동화를 완성하면 채색된 이미지를 보여줍니다.

- deformation된 이미지가 계속해서 검출됩니다.
    -  밑그림을 그리고 stable-diffusion으로 이미지를 생성하여도 deformation문제를 완전히 해결할 수는 없었습니다.

- 더욱 복잡해지는 파이프라인
    - 이러한 구조는 복잡하고 유지 보수 측면에서도 상당히 별로였다. 무엇보다 생성형 AI를 사용하는 과정에서 어느 한 단계라도 문제가 생기면 다시 과정을 반복해야 하는 문제가 생깁니다.

#### 1.2.3 Dall-e만 사용하기

이방식은 방식1과 동일하나 dall-e-3만을 사용하여 삽화를 생성합니다.

```
private static final ChatMessage SYSTEM_MESSAGE = new ChatMessage("system",
        """
                you're a helpful assistant that depict details to generate image.
                 using given json, depict "currentContext" scene.
               - choose random format given below
                 [whole context of appearanceKeyword] is [what main character is doing], in [background], [lights]
                 [other character] is [what they're doing], in [background], [lights]
                 [object] is in [background], [lights]
                 [background], [lights]
               - answer must be in english"""
);
```

**장점**
- 생성속도가 가장 빠른 방식입니다.
- 텍스트 이해도가 가장 높아 묘사할 수 있는 능력이 가장 뛰어납니다.

**단점**
- `appearance_keyword`항목이 잘못 입력된다면 이상하게 출력되는 단점이 있습니다.
- 등장인물이 조금씩 다르게 그려지고 다소 일관적이지 못한 그림체로 생성됩니다.

동화 서비스의 핵심은 **실시간으로 한 페이지씩 생성하여 사용자에게 제공**하는 기능입니다. 따라서 무엇보다도 이 과정에서의 사용자 경험이 가장 중요한 요소로 고려되었습니다.

이에 따라 삽화 생성 과정에서는 일관된 그림체 유지보다 **생성 속도와 텍스트 이해도를 우선**시하였습니다. 한 페이지 생성에 과도한 시간이 소요된다면 서비스 사용성이 떨어질 수 있기 때문입니다. 따라서 프로젝트를 진행하며 방식3을 사용하였습니다.

## 2. 마치며
### 2.1 한계

아래의 예시는 전시 당시 실제 사용자가 만들어낸 삽화입니다.

![통합예시](/assets/img/content/2024-08-21/8.png){: width="500"}_워크플로우 전체, 사용자입력에서 캐릭터 생성은 몸 전체 이미지 생성을 강제했음_

**그림의 일관성 문제**

본 프로젝트에서는 Stable Diffusion과 DALL·E를 병행하여 삽화를 제작하였습니다. 그러나 이미지 생성 방식으로 img2img와 text2img를 혼용하다 보니 초기 이미지가 가지고 있던 세부적인 디테일이 점차 손실되는 현상이 발생했습니다. 특히 동일한 캐릭터를 반복적으로 등장시켜야 하는 동화 제작의 특성상, 그림체와 외형이 매번 달라지는 문제가 뚜렷하게 나타났습니다.

이러한 결과는 당시(2024년 4월 기준) 이미지 생성 모델이 전반적으로 일관성을 유지하기 어려운 수준에 머물러 있었음을 보여줍니다. 즉, 캐릭터나 배경의 주요 속성을 동일하게 유지하면서 장면을 이어나가는 것이 기술적으로 쉽지 않았습니다. 따라서 억지스럽게 보일 수 있는 결과물도 적지 않았으며, 사용자가 기대하는 '연속성 있는 동화 삽화'를 구현하기에는 모델의 성능이 아직 부족했던 것이 사실입니다.

더불어 실시간으로 사용자의 입력을 받아 즉시 삽화를 생성해야 하는 특성을 가지고 있었기 때문에 별도의 세밀한 후처리를 거칠 여유가 없었습니다. 이러한 제약 속에서 이미지의 일관성을 유지하는 것은 더욱 어려웠고, 결과적으로 생성된 삽화가 다소 부자연스럽게 보이는 한계가 있었습니다.

**실질적 비용의 한계**

또한 LLM과 이미지 생성 모델은 로컬 환경에서 직접 구동하기 어려웠기 때문에, 외부 서비스를 통한 호스팅 비용 혹은 API 호출 비용이 필연적으로 발생했습니다. 프로젝트 당시 기준으로 Stable Diffusion은 한 달 약 47달러의 비용이 필요했으며, OpenAI API의 경우 GPT-4 모델을 활용해 동화를 100회 생성할 때 약 20달러의 비용이 발생했습니다(2024년 6월 기준).

이러한 구조에서는 특별한 비즈니스 모델(BM) 없이 서비스를 지속적으로 운영하기가 사실상 어려웠습니다. 더구나 프로젝트가 학생 신분에서 진행된 만큼 고성능 모델을 장기간 안정적으로 활용하기에는 경제적 부담이 컸습니다. 따라서 성능을 더 끌어올리거나 고급 모델을 적용하는 데에는 현실적인 제약이 존재했고, 이는 서비스 확장 가능성을 제한하는 중요한 요인으로 작용했습니다.

### 2.2 Little-Writer v2

**개인 프로젝트 전환 계획**

**프로젝트 전환 배경**
팀 프로젝트 종료 이후에도 서비스가 단순히 사라지기엔 아쉬움이 남습니다. 또한 전시에서 실제 사용자들이 직접 동화를 만들어본 기록을 남겨두고 싶습니다. 그래서 초심을 되새기고 기록을 남기기 위한 목적으로 개인 프로젝트 형태로 전환하고자 합니다.

**개선 사항**
> 파이프라인 안정성 강화
- 생성 실패 시 처리 로직을 더욱 안전하게 보완하여, 사용자 경험에 문제가 없도록 개선한다.

> 운영 비용 한계 고려
- 실제 호스팅을 위해서는 크레딧 기반 결제가 필요한데, 이는 개인사업자 등록이 필수이나 취업 시 불이익을 받을만한 여지를 남기고 싶지 않음.
- 따라서 상업적 운영보다 제한적으로 생성할 수 있게 구성할 예정.

현재 작업 진행중이며 변경사항 발생시 관련 문서를 통해 정리할 예정입니다.
