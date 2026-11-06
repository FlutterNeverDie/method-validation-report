# method-validation-report

살생물제·제품 유효성분 함량 시험법의 **밸리데이션 보고서를 자동으로 작성**하는 [Claude Code](https://claude.com/claude-code) 스킬입니다.

원데이터(직선성, 회수율, 반복 측정값 등)를 붙여넣으면 통계 계산 → 기준 판정 → 보고서 초안까지 만들어 줍니다.

## 기능

| 항목 | 계산 내용 |
|---|---|
| 직선성 | 회귀식, r, R², 잔차(%) |
| 정확성 | 개별/수준별 회수율, RSD |
| 정밀성 | 반복성, 실험실 내 정밀성 RSD |
| LOD / LOQ | 검량선법 (3.3σ/S, 10σ/S) 또는 입력값 |
| 특이성·완건성·시스템 적합성 | 서술형 결과 정리 |

### 판정 기준 preset
- `sanco3030` (기본) — SANCO/3030/99 rev.5 기반. 함량별 회수율 구간, 수정 Horwitz RSDr
- `ich` — ICH Q2(R2) 관행값 (r ≥ 0.999, 회수율 98–102%, RSD ≤ 2%)
- `custom` — 사내 SOP 기준으로 덮어쓰기 (`r_min`, `recovery_range`, `rsd_max`)

> ⚠️ 기준값은 참고용입니다. 최종 판정 전 소속 기관 SOP 및 제출 가이드라인 원문과 대조하세요.

## 설치

```bash
git clone https://github.com/FlutterNeverDie/method-validation-report.git ~/.claude/skills/method-validation-report
```

계산 스크립트 실행에 Node.js가 필요합니다 (외부 패키지 없음).

## 사용법

Claude Code에서:

```
/method-validation-report
```

또는 "밸리데이션 보고서 써줘", "회수율이랑 RSD 계산해줘"처럼 요청하고 데이터를 붙여넣으면 됩니다. 엑셀 표를 그대로 복사해도 됩니다.

스크립트만 단독으로 쓸 수도 있습니다:

```bash
node scripts/calc_validation.js templates/input_template.json
```

## 구성

```
SKILL.md                         # 스킬 작업 지침
templates/input_template.json    # 입력 데이터 예시
templates/report_template.md     # 보고서 목차
scripts/calc_validation.js       # 통계 계산 및 판정
```

## 참고 가이드라인
- SANCO/3030/99 rev.5 — Technical Active Substance and Plant Protection Products: Guidance for generating and reporting methods of analysis
- ICH Q2(R2) — Validation of Analytical Procedures
