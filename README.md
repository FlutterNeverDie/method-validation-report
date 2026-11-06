# method-validation-report

살생물제·농약 제제의 유효성분 함량 시험법 **밸리데이션 보고서를 자동으로 작성**하는 [Claude Code](https://claude.com/claude-code) 스킬입니다.

원데이터를 엑셀에서 복사해 붙여넣으면 아래 순서로 처리합니다.
1. 통계 계산
2. **SANCO/3030/99 rev.5** 또는 **ICH Q2(R2)** 기준으로 판정
3. 그래프가 들어간 보고서(HTML → PDF) 작성

## 기능

| 항목 | 계산 / 판정 |
|---|---|
| 시스템 적합성 | 면적 RSD, 테일링, 이론단수, 분리도 |
| 특이성 | 간섭(총 피크면적 대비 %) ≤ 3% |
| 직선성 | 회귀식, r / r², 잔차(%), y절편 유의성, 설계 요건(5농도 단일 측정 또는 3농도 2회 측정), 목표 농도 ±20% 범위 |
| 정확성 | 회수율(total / marginal 자동 선택), 수준별 평균·RSD·95% 신뢰구간, 함량별 SANCO 기준 구간 |
| 반복성 | RSD, **수정 Horwitz RSDr과 Horrat**(≤1 적합 / 1–2 조건부 / >2 부적합), **Grubbs 이상치 검정** |
| 실험실 내 정밀성 | 일원분산분석(ISO 5725 방식)으로 반복성과 실험실 내 정밀성 RSD 분리, 조건 간 유의차 검정 |
| LOD / LOQ | 검량선법(잔차 또는 절편 SD) 또는 S/N 값 입력 |
| 완건성 | 기준 조건 대비 차이(%) |
| 보고서 | A4 인쇄용 HTML. 검량선·잔차 그래프, 결과 요약, 자동 결론, 검토 필요 사항, 서명란 포함 |

이상치는 절대 자동으로 제외하지 않습니다. 의심값과 처리 방법만 "검토 필요 사항"에 표시합니다.

## 판정 기준

| preset | 대상 | 비고 |
|---|---|---|
| `inhouse` (템플릿 기본) | 사내 SOP 없이 연구자가 기준을 정할 때 | SANCO 수치 준용 + 시스템 적합성·완건성을 연구자 기준으로 종합 판정에 반영. 기준 근거 문장 자동 생성 |
| `sanco3030` | 살생물제·농약 제제 | SANCO/3030/99 rev.5 원문 수치 (4.2.1절, Appendix 2·3). 관행값 항목은 참고만 |
| `ich` | 의약품 | ICH Q2(R2) 항목 + 업계 관행 수치 (r ≥ 0.999, 98–102%, RSD ≤ 2%) |
| `custom` | 사내 SOP | 개별 기준을 덮어쓰기 |

근거 원문과 custom 키 목록은 [`reference/criteria.md`](reference/criteria.md)에 있습니다.

> ⚠️ 최종 판정 전에 소속 기관 SOP와 제출처 요구사항을 대조하세요.

## 설치

```bash
git clone https://github.com/FlutterNeverDie/method-validation-report.git ~/.claude/skills/method-validation-report
```

Node.js 18 이상이 필요합니다. 외부 패키지는 쓰지 않습니다.

## 사용법

Claude Code에서 `/method-validation-report`를 입력하거나, "밸리데이션 보고서 써줘"라고 요청하고 데이터를 붙여넣으면 됩니다.

스크립트만 따로 쓸 수도 있습니다.

```bash
node scripts/calc_validation.js templates/input_template.json                  # 마크다운 결과
node scripts/calc_validation.js templates/input_template.json --html out.html  # HTML 보고서
node scripts/calc_validation.js templates/input_template.json --json           # JSON
```

입력 형식은 [`reference/input_schema.md`](reference/input_schema.md)를 참고하세요.

## 구성

```
SKILL.md                        # Claude 작업 지침
scripts/calc_validation.js      # 계산·판정·보고서 생성
scripts/lib/stats.js            # 통계 함수 (t/F 분포, Grubbs, ANOVA 등)
templates/input_template.json   # 입력 예시
templates/report_template.md    # 사내 양식용 목차
reference/criteria.md           # 판정 기준 근거
reference/input_schema.md       # 입력 필드 설명
tests/validation.test.js        # 테스트 (node --test tests/)
tests/verify/                   # SciPy 교차 검증, 퍼징
```

## 검증

| 방법 | 명령 | 결과 |
|---|---|---|
| 단위·회귀 테스트 (46개) | `node --test tests/` | 전부 통과 |
| SciPy/NumPy 독립 구현과 교차 검증 (무작위 4,300건, 값 21,800개) | `uv run --no-project --with scipy --with numpy python -I tests/verify/crossval.py` | 최대 상대오차 1.1×10⁻⁹, 허용오차(10⁻⁸) 초과 0건 |
| 퍼징: 망가진 입력 5만 건 | `node tests/verify/fuzz.js 50000` | 크래시 0, 출력 오염(NaN·undefined) 0, 판정 규칙 위반 0 |

- 회귀 표준오차는 SciPy `linregress`가 아니라 잔차 기반 식으로 계산합니다. `linregress`는 √(1−r²) 식을 써서 r ≈ 1일 때 상대오차가 10⁻³ 수준까지 커집니다. 50자리 정밀도(mpmath)로 계산한 정확값과 비교했을 때 이 구현의 오차는 10⁻¹⁰ 이하입니다.
- 퍼징의 판정 규칙: 종합 판정이 "적합"이면 입력 오류가 없어야 하고, 필수 4개 항목(특이성·직선성·정확성·반복성)이 모두 적합이어야 하며, 종합 판정에 반영되는 항목 중 부적합·조건부가 없어야 합니다.

## 참고 문헌
- SANCO/3030/99 rev.5 (2019). *Technical active substance and plant protection products: Guidance for generating and reporting methods of analysis…*
- ICH Q2(R2) (2023). *Validation of Analytical Procedures*
- ISO 5725-2. *Accuracy (trueness and precision) of measurement methods and results*
