// 실행: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const S = require("../scripts/lib/stats");
const { run, toHtml, sancoRecoveryRange } = require("../scripts/calc_validation");
const template = require("../templates/input_template.json");

const SCRIPT = path.join(__dirname, "..", "scripts", "calc_validation.js");
const clone = o => JSON.parse(JSON.stringify(o));
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);
const rowOf = (r, prefix) => r.summary.find(s => s.item.startsWith(prefix));

test("t 분포 분위수 = 표값", () => {
  close(S.tinv(0.975, 10), 2.2281, 1e-4);
  close(S.tinv(0.975, 4), 2.7764, 1e-4);
  close(S.tinv(0.95, 30), 1.6973, 1e-4);
});

test("Grubbs 임계값(양측 α=0.05) = 표값", () => {
  const table = { 3: 1.155, 5: 1.715, 6: 1.887, 10: 2.290, 20: 2.709 };
  for (const [n, g] of Object.entries(table)) {
    const a = Array.from({ length: +n }, (_, i) => i);
    close(S.grubbs(a).Gcrit, g, 2e-3);
  }
});

test("Grubbs: 명백한 이상치 검출", () => {
  const g = S.grubbs([5.00, 5.01, 4.99, 5.02, 4.98, 5.40]);
  assert.equal(g.outlier, true);
  assert.equal(g.value, 5.40);
});

test("수정 Horwitz RSDr", () => {
  close(S.horwitzRSDr(100), 1.34, 1e-9);           // c=1 → 0.67×2
  close(S.horwitzRSDr(5), 2.103, 1e-3);
});

test("SANCO 회수율 구간 경계값 (App.2 표)", () => {
  assert.deepEqual(sancoRecoveryRange(10), [97, 103]);
  assert.deepEqual(sancoRecoveryRange(9.99), [90, 110]);
  assert.deepEqual(sancoRecoveryRange(1), [90, 110]);
  assert.deepEqual(sancoRecoveryRange(0.1), [80, 120]);
  assert.deepEqual(sancoRecoveryRange(0.05), [75, 125]);
  assert.deepEqual(sancoRecoveryRange(0.005), [70, 130]);
});

test("일원분산분석 정밀성: 조건 간 차이 없으면 sIP ≈ sr", () => {
  const a = S.anovaPrecision([[1, 2, 3], [1, 2, 3]]);
  close(a.sr, 1, 1e-12);
  close(a.sIP, 1, 1e-12);
  close(a.F, 0, 1e-12);
});

test("템플릿 예시: 전 항목 적합", () => {
  const r = run(clone(template));
  assert.deepEqual(r.errors, []);
  assert.equal(r.overall, "적합");
  close(r.linearity.reg.r, 0.99999, 1e-5);
});

test("직선성 r 미달 → 부적합", () => {
  const d = clone(template);
  d.linearity = [{ conc: 60, response: 600 }, { conc: 80, response: 900 }, { conc: 100, response: 950 }, { conc: 120, response: 1300 }, { conc: 140, response: 1250 }];
  const r = run(d);
  assert.equal(rowOf(r, "직선성").verdict, "부적합");
  assert.equal(r.overall, "부적합");
});

test("직선성 범위가 목표 ±20% 미포함 → 조건부 + 경고", () => {
  const d = clone(template);
  // 90–120 → 하한이 80 미만으로 내려가지 않음
  d.linearity = [90, 100, 105, 110, 120].map(c => ({ conc: c, response: [c * 10000 + 50, c * 10000 - 40] }));
  const r = run(d);
  assert.equal(rowOf(r, "직선성").verdict, "조건부 적합");
  assert.ok(r.warnings.some(w => w.includes("범위 미달")));
});

test("반복성 Horrat 1–2 → 조건부 적합", () => {
  const d = clone(template);
  d.repeatability = [5.0, 5.15, 4.85, 5.1, 4.9, 5.0];   // RSD ≈ 2.2% (5% 기준 RSDr 2.10%)
  const r = run(d);
  const row = rowOf(r, "반복성");
  assert.equal(row.verdict, "조건부 적합");
  assert.ok(r.repeatability.judge.hr > 1 && r.repeatability.judge.hr <= 2);
});

test("custom rsd_max 는 Horrat 대신 RSD 로 판정", () => {
  const d = clone(template);
  d.criteria.custom = { rsd_max: 0.3 };
  const r = run(d);
  assert.equal(rowOf(r, "반복성").verdict, "부적합");
  assert.match(rowOf(r, "반복성").criterion, /RSD ≤ 0.3%/);
});

test("ICH preset: 회수율 98–102%, r ≥ 0.999", () => {
  const d = clone(template);
  d.criteria.preset = "ich";
  const r = run(d);
  assert.deepEqual(r.accuracy.range, [98, 102]);
  assert.match(rowOf(r, "직선성").criterion, /0\.999/);
});

test("회수율: 평균 기준 판정, 함량 10% 이상은 97–103%", () => {
  const d = clone(template);
  d.meta.nominal_content_percent = 25;
  d.accuracy = [{ level: "100%", added: 25, found: 25.9 }, { level: "100%", added: 25, found: 25.8 }];  // 103.6, 103.2
  const r = run(d);
  assert.equal(rowOf(r, "정확성").verdict, "부적합");
  d.accuracy = [{ level: "100%", added: 25, found: 25.5 }, { level: "100%", added: 25, found: 24.9 }];  // 102.0, 99.6
  assert.equal(rowOf(run(d), "정확성").verdict, "적합");
});

test("회수율: 초기 함량 > 첨가량 10% → marginal recovery", () => {
  const d = clone(template);
  d.accuracy = [{ level: "SA", initial: 5.0, added: 2.0, found: 6.98 }, { level: "SA", initial: 5.0, added: 2.0, found: 7.02 }];
  const r = run(d);
  assert.equal(r.accuracy.rows[0].type, "marginal");
  close(r.accuracy.rows[0].rec, 99.0, 1e-9);
  close(r.accuracy.rows[1].rec, 101.0, 1e-9);
});

test("필수 항목 누락 → 미완료", () => {
  const d = clone(template);
  delete d.specificity;
  const r = run(d);
  assert.match(r.overall, /미완료/);
});

test("잘못된 숫자 → 입력 오류, CLI 종료코드 3", () => {
  const d = clone(template);
  d.repeatability = [5.0, "오타", 5.01, 4.99, 5.02];
  const r = run(d);
  assert.equal(r.overall, "입력 오류");
  const p = spawnSync(process.execPath, [SCRIPT, "/dev/stdin"], { input: JSON.stringify(d) });
  assert.equal(p.status, 3);
});

test("문자열 숫자·천단위 콤마 허용", () => {
  const d = clone(template);
  d.linearity = d.linearity.map(p => ({ conc: String(p.conc), response: p.response.map(v => v.toLocaleString("en-US")) }));
  const r = run(d);
  assert.deepEqual(r.errors, []);
  close(r.linearity.reg.r, 0.99999, 1e-5);
});

test("HTML: 그래프 포함, 입력값 이스케이프", () => {
  const d = clone(template);
  d.meta.title = "<script>alert(1)</script>";
  const html = toHtml(run(d));
  assert.ok(html.includes("<svg"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("CLI --json 출력이 JSON", () => {
  const out = execFileSync(process.execPath, [SCRIPT, path.join(__dirname, "..", "templates", "input_template.json"), "--json"]);
  const r = JSON.parse(out);
  assert.equal(r.overall, "적합");
});

// ───────── 코드 리뷰 지적사항 회귀 테스트 ─────────
const { num } = require("../scripts/calc_validation");

test("[리뷰1] 표시 함량 없고 회수율 나쁨 → 적합이 아님", () => {
  const d = clone(template);
  delete d.meta.nominal_content_percent;
  d.accuracy[0].found = 3.0;
  const r = run(d);
  assert.notEqual(r.overall, "적합");
  assert.match(r.overall, /보류/);
});

test("[리뷰1] 특이성 서술만 → 판정 보류, interference '<0.1' → 입력 오류", () => {
  const d = clone(template);
  d.specificity = "간섭 없음";
  assert.match(run(d).overall, /보류/);
  d.specificity = { interference_pct: "<0.1" };
  assert.equal(run(d).overall, "입력 오류");
});

test("[리뷰2] SANCO 최소 시료 수 미달 → 부적합", () => {
  const d = clone(template);
  d.repeatability = [5.0, 5.01];
  assert.equal(rowOf(run(d), "반복성").verdict, "부적합");
  const d2 = clone(template);
  d2.accuracy = [{ level: "100%", added: 5, found: 5.0 }];
  assert.equal(rowOf(run(d2), "정확성").verdict, "부적합");
});

test("[리뷰3] 소수점 콤마는 오류, 천단위 콤마만 허용", () => {
  assert.ok(Number.isNaN(num("5,02")));
  assert.ok(Number.isNaN(num("1,0024")));
  assert.equal(num("1,002,450"), 1002450);
  assert.equal(num("-3.5e2"), -350);
  const d = clone(template);
  d.repeatability = ["5,02", "4,98", "5,01", "4,97", "5,03"];
  assert.equal(run(d).overall, "입력 오류");
});

test("[리뷰3] 단위 % w/w인데 평균 > 100 → 입력 오류", () => {
  const d = clone(template);
  d.repeatability = [502, 498, 501, 497, 503];
  assert.equal(run(d).overall, "입력 오류");
});

test("[리뷰4] null 섹션·요소가 있어도 중단되지 않음", () => {
  for (const k of ["intermediate_precision", "specificity", "system_suitability", "lod_loq", "robustness", "repeatability"]) {
    const d = clone(template); d[k] = null;
    assert.doesNotThrow(() => run(d), k);
  }
  const d = clone(template);
  d.linearity[0] = null; d.accuracy[0] = null; d.robustness[0] = null;
  assert.doesNotThrow(() => run(d));
  assert.equal(run(d).overall, "입력 오류");
});

test("[리뷰5] SANCO: 참고 항목(완건성·시스템 적합성 관행값) 미달은 종합 판정에 반영 안 함", () => {
  const d = clone(template);
  d.robustness[0].result_value = 5.3;          // 6% 차이
  d.system_suitability.tailing = 2.5;
  const r = run(d);
  assert.equal(r.overall, "적합");
  assert.ok(r.warnings.some(w => w.includes("완건성")));
  assert.ok(r.warnings.some(w => w.includes("시스템 적합성")));
  d.criteria.custom = { ss_tailing_max: 2.0 };   // 사내 기준을 넣으면 반영
  assert.equal(run(d).overall, "부적합");
});

test("[리뷰5] SANCO: 실험실 내 정밀성은 참고(정보)로만 표시", () => {
  const d = clone(template);
  d.intermediate_precision = { a: [5.0, 5.3, 4.7], b: [5.4, 4.6, 5.0] };
  const r = run(d);
  assert.equal(rowOf(r, "실험실 내 정밀성").verdict, "정보");
  assert.equal(r.overall, "적합");
});

test("[리뷰6] content_unit '% of label' → Horwitz는 표시 함량 사용", () => {
  const d = clone(template);
  d.meta.content_unit = "% of label";
  d.repeatability = [100.4, 99.6, 100.2, 99.4, 100.6, 100.0];
  const r = run(d);
  close(r.repeatability.judge.rsdr, 2.103, 1e-3);
  assert.equal(r.repeatability.ofLabel, undefined);
});

test("[리뷰7] 반복 주입은 독립 조제로 치지 않음", () => {
  const d = clone(template);
  d.linearity = [80, 100, 120].map(c => ({ conc: c, response: [c * 1e4, c * 1e4 + 30] }));   // 3농도 × 주입 2회
  const r = run(d);
  assert.equal(r.linearity.designOk, false);
  assert.equal(rowOf(r, "직선성").verdict, "조건부 적합");
  d.linearity = [80, 80, 100, 100, 120, 120].map((c, i) => ({ conc: c, response: c * 1e4 + i * 10 }));  // 3농도 × 독립 2회
  assert.equal(run(d).linearity.designOk, true);
});

test("[리뷰8] ICH: 간섭 수치만 있으면 보류, pass:true면 적합", () => {
  const d = clone(template);
  d.criteria.preset = "ich";
  d.linearity = [60, 80, 100, 120, 140].map(c => ({ conc: c, response: c * 10000 + 3600 }));
  d.accuracy = d.accuracy.map(a => ({ ...a, found: a.added }));
  let r = run(d);
  assert.equal(rowOf(r, "특이성").verdict, "확인 필요");
  assert.match(r.overall, /보류/);
  d.specificity.pass = true;
  r = run(d);
  assert.equal(rowOf(r, "특이성").verdict, "적합");
  assert.equal(r.overall, "적합");
});

test("[리뷰9] Horrat 원값 비교 (1.004 → 조건부)", () => {
  const { toMarkdown } = require("../scripts/calc_validation");
  const d = clone(template);
  // RSDr(5%) = 2.1030 → RSD ≈ 2.11% 이면 Hr ≈ 1.004 → 조건부
  const m = 5, s = 0.07465;   // SD = s·√2 ≈ 0.10557
  d.repeatability = [m - 2 * s, m - s, m, m, m + s, m + 2 * s].map(v => +v.toFixed(4));
  const r = run(d);
  assert.ok(r.repeatability.judge.hr > 1 && r.repeatability.judge.hr < 1.01, `hr=${r.repeatability.judge.hr}`);
  assert.equal(r.repeatability.judge.verdict, "조건부 적합");
  assert.ok(toMarkdown(r).length > 0);
});

test("[리뷰10] 0 농도 점은 잔차(%) 경고에서 제외", () => {
  const d = clone(template);
  d.linearity = [{ conc: 0, response: 150 }, ...d.linearity];
  const r = run(d);
  assert.ok(!r.warnings.some(w => w.includes("최대 잔차")));
  assert.ok(Number.isNaN(r.linearity.resPct[0]));
});

test("[리뷰11] 조건 내 분산 0, 조건 간 차이 → 유의함", () => {
  const a = S.anovaPrecision([[5, 5, 5], [5.1, 5.1, 5.1]]);
  assert.equal(a.p, 0);
});

test("[리뷰12] 표시 함량 '5%' → 입력 오류, 회수율 구간 미적용", () => {
  const d = clone(template);
  d.meta.nominal_content_percent = "5%";
  const r = run(d);
  assert.equal(r.overall, "입력 오류");
  assert.equal(r.accuracy.range, null);
});

test("십진 반올림 (이진 오차·지수 표기·음수)", () => {
  const { round } = require("../scripts/calc_validation");
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(round(2.675, 2), 2.68);
  assert.equal(round(-1.005, 2), -1.01);
  assert.equal(round(1e-7, 2), 0);
  assert.equal(round(1.23e21, 1), 1.23e21);
  assert.equal(round(103.04, 1), 103.0);
});

// ───────── 재검증 신규 결함 회귀 테스트 ─────────
test("[N1] 직선성 빈 response 배열 → 입력 오류", () => {
  const d = clone(template);
  d.linearity[0].response = [];
  assert.equal(run(d).overall, "입력 오류");
});

test("[N2] 참고 항목 미달 시 결론 문구에 명시", () => {
  const d = clone(template);
  d.robustness[0].result_value = 5.5;
  const r = run(d);
  assert.equal(r.overall, "적합");
  const html = toHtml(r);
  assert.ok(html.includes("참고 항목(완건성)"));
  assert.ok(!html.includes("모든 밸리데이션 항목이"));
});

test("[N3] 반복성 0 이하 값 → 입력 오류", () => {
  const d = clone(template);
  d.repeatability = [0, 0, 0, 0, 0];
  assert.equal(run(d).overall, "입력 오류");
  d.repeatability = [-5, -5.1, -4.9, -5, -5.05];
  assert.equal(run(d).overall, "입력 오류");
});

test("[N4] 객체 level 은 JSON 문자열로 표시", () => {
  const d = clone(template);
  d.accuracy[0].level = { p: 1 };
  const { toMarkdown } = require("../scripts/calc_validation");
  assert.ok(!toMarkdown(run(d)).includes("[object Object]"));
});

test("[N5] custom.ss_scored 명시값 존중", () => {
  const d = clone(template);
  d.system_suitability.tailing = 2.5;
  d.criteria.custom = { ss_scored: true };
  assert.equal(run(d).overall, "부적합");
});
