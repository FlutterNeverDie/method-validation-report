# 판정 기준 근거

## SANCO/3030/99 rev.5 (2019-03-22 발행, 2019-10-01 시행)
"Technical active substance and plant protection products: Guidance for generating and reporting methods of analysis…"
원문: https://food.ec.europa.eu/system/files/2019-03/pesticides_ppp_app-proc_guide_phys-chem-ana_3030.pdf

제제(plant protection product) 중 유효성분 시험법은 **4.2.1절**과 **Appendix 2·3** 기준을 따른다.

| 항목 | 원문 요지 | 위치 |
|---|---|---|
| 특이성 | 제제 중 다른 성분의 간섭이 각 유효성분 총 피크면적의 **3%를 넘지 않아야** 함. blank(유효성분 없는 제제), 표준, 시료 크로마토그램 제출 | 4.2.1 (i) |
| 직선성 | 최저·최고 공칭 농도의 **±20% 이상**을 포함. **독립 칭량 2회 × 3농도 이상** 또는 **단일 × 5농도 이상**. r < 0.99면 설명 제출, 단 **r² ≥ 0.98**이면 인정 | 4.1.1 (ii) |
| 회수율 | 대표 제제 시료로 **독립 칭량 2회 이상**, 목표 농도의 90–110% 수준. 평균 회수율과 RSD(n > 2) 보고 | 4.2.1 (iii) |
| 회수율 기준 (평균) | ≥10%: 97–103 / ≥1–<10%: 90–110 / ≥0.1–<1%: 80–120 / ≥0.01–<0.1%: 75–125 / <0.01%: 70–130 | App. 2, 7.1 |
| 회수율 계산식 | 초기 함량(CU)이 첨가량(CA)의 약 10% 미만이면 total = 100·CF/(CU+CA), 초과면 marginal = 100·(CF−CU)/CA | App. 2, 7.1 |
| 반복성 | 같은 농도에서 **독립 칭량 5회 이상**, 평균·%RSD·n 보고 | 4.1.1 (iv) |
| 반복성 기준 | %RSDr = 0.67 × 2^(1−0.5·log c), Hr = %RSD / %RSDr. **Hr ≤ 1 적합 / 1 < Hr ≤ 2 사유 기재 시 적합 / Hr > 2 부적합** | App. 2, 7.2 |
| 이상치 | Grubbs 또는 Dixon 검정. 제외 시 사유 명시, **수준당 최대 1개**. 2개 이상이면 추가 측정 | 4.1.1 (iv) |
| LOQ | 유효성분에는 실험적 결정이 필요 없음 | App. 3 |

c는 질량분율(소수)이다. 예: 5% w/w → c = 0.05 → RSDr = 2.10%.

## ICH Q2(R2) (2023)
ICH는 수치 판정 기준을 정하지 않는다. 함량시험(assay)의 평가 항목은 특이성, 직선성, 범위, 정확성, 정밀성(반복성, 실험실 내 정밀성)이다. 스크립트의 `ich` preset 값(r ≥ 0.999, 회수율 98–102%, RSD ≤ 2%)은 **제약 업계에서 널리 쓰는 관행값**일 뿐 ICH 원문 수치가 아니다.

## 공통 관행값 (근거 문서가 아닌 일반 관행)
- 시스템 적합성: 면적 RSD ≤ 2.0% (5–6회 주입), 테일링 계수 ≤ 2.0, 이론단수 ≥ 2000, 분리도 ≥ 2.0 (FDA Reviewer Guidance: Validation of Chromatographic Methods, 1994 권고 수준)
- 완건성: 기준 조건 대비 결과 차이 ≤ 2%

→ 사내 SOP 값이 있으면 `criteria.custom`으로 덮어쓴다.

## custom 키
| 키 | 의미 | 예 |
|---|---|---|
| `r_min` | 최소 상관계수 | 0.995 |
| `r2_alt` | r 미달 시 대체 r² 기준 (null이면 사용 안 함) | null |
| `recovery_range` | 평균 회수율 허용 범위 | [98, 102] |
| `rsd_max` | 정밀성 RSD 상한 (지정하면 Horrat 대신 RSD로 판정) | 2.0 |
| `rep_min_n`, `acc_min_n` | 최소 측정 수 | 6, 9 |
| `lin_min_levels`, `lin_dup_min_levels` | 직선성 최소 농도 수 (단일 측정 / 2회 측정) | 5, 3 |
| `lin_range_pct` | 목표 농도 대비 필요한 범위(±%) | 20 |
| `interference_max` | 특이성 간섭 상한(%) | 3 |
| `ss_area_rsd_max`, `ss_tailing_max`, `ss_plates_min`, `ss_resolution_min` | 시스템 적합성 기준 | 2.0, 2.0, 2000, 2.0 |
| `robustness_max_diff` | 완건성 허용 차이(%) | 2.0 |
| `grubbs_alpha` | Grubbs 유의수준 | 0.05 |
