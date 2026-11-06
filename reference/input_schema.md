# 입력 JSON 필드 설명

예시: `templates/input_template.json`. 숫자는 문자열이나 천 단위 콤마(`"1,002,450"`)로 넣어도 된다. **소수점은 반드시 마침표**(`5.02`). `"5,02"`는 오류로 처리한다. 없는 항목은 키를 빼면 된다.

## meta (기본 정보)
| 키 | 필수 | 설명 |
|---|---|---|
| `title` | | 보고서 제목 |
| `analyte` | | 유효성분명 (CAS 번호) |
| `product`, `formulation_type` | | 제품명(코드명 가능), 제형 (SL, EC, WP 등) |
| `nominal_content_percent` | **SANCO 필수** | 표시 함량 (% w/w). 회수율 구간과 Horwitz 기준 결정 |
| `content_unit` | | 반복성·정밀성 측정값의 단위. 기본 `% w/w`. `% w/w`나 `g/kg`이면 측정 평균으로 Horwitz를 계산하고, 그 외(`% of label`, `% w/v` 등)에는 표시 함량을 쓴다 |
| `target_conc` | 권장 | 시험액 중 목표 농도 (직선성 ±20% 범위 판정) |
| `conc_unit`, `response_unit` | | 예: `µg/mL`, `peak area` |
| `instrument`, `column`, `mobile_phase`, `sop_no` | | 분석 조건, 시험법 번호 |
| `analyst`, `reviewer`, `approver`, `date` | | 서명란과 일자 |

## criteria
`preset`: `inhouse` (템플릿 기본, 연구자 기준) / `sanco3030` / `ich` / `custom`. `custom` 객체로 개별 기준 덮어쓰기, `basis`(문자열)로 보고서의 기준 근거 문장 직접 지정 → `reference/criteria.md`

## narrative (보고서 문장)
`purpose`, `method_summary`, `conclusion`(비우면 자동 생성), `notes`

## 측정 데이터
| 키 | 형식 | 비고 |
|---|---|---|
| `system_suitability` | `{area_values:[…], tailing, plates, resolution, note}` 또는 문자열 | 반복 주입 면적 5–6회 |
| `specificity` | `{interference_pct, pass?, peak_purity, resolution, note}` 또는 문자열 | SANCO: `interference_pct`로 자동 판정. ICH: 시험자 판단을 `pass: true/false`로 입력. 서술만 있으면 "확인 필요" |
| `linearity` | `[{conc, response}]`. **한 행 = 독립 조제 1건**. `response` 배열 = 같은 용액의 반복 주입 → 평균을 한 점으로 사용 | 독립 조제 2회는 같은 `conc`로 행 두 개 입력. 반복 주입은 독립 조제로 치지 않음 |
| `accuracy` | `[{level, added, found, initial?}]` | `initial`(초기 함량)이 첨가량의 10%를 넘으면 marginal recovery로 계산. added·found·initial은 같은 단위로 |
| `repeatability` | `[값, …]` | 독립 칭량 결과 (함량). SANCO는 5개 미만이면 부적합 |
| `intermediate_precision` | `{"조건명": [값, …], …}` | 2개 이상 조건 (일자, 시험자, 장비) |
| `lod_loq` | `{method:"calibration", sigma?:"residual"\|"intercept"}` 또는 `{method:"sn"\|"input", lod, loq}` | 함량 시험에서는 생략 가능 |
| `robustness` | `[{condition, reference_value?, result_value?, result?}]` | 숫자 두 개를 주면 차이(%) 자동 계산, 아니면 `result`에 서술 |

## 판정 값
| 판정 | 의미 |
|---|---|
| 적합 / 부적합 | 기준과 비교한 결과 |
| 조건부 적합 | Horrat 1–2 (사유 기재 필요), 직선성 설계·범위 미달 |
| 확인 필요 | 필수 항목인데 자동 판정할 근거가 부족함 (표시 함량 누락, 특이성 서술만 있음 등) |
| 정보 | 수치만 보고 (LOD/LOQ, SANCO의 실험실 내 정밀성) |
| 미실시 | 데이터 없음 |

항목 이름에 **(참고)**가 붙은 행은 종합 판정에 반영하지 않는다. 시스템 적합성과 완건성은 사내 기준(`criteria.custom`의 `ss_*`, `robustness_max_diff`)을 넣으면 종합 판정에 반영된다.

**종합 판정 순서:** 입력 오류 → 부적합 → 미완료(필수 항목 누락) → 판정 보류(확인 필요) → 조건부 적합 → 적합
