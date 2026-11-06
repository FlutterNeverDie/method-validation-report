#!/usr/bin/env node
// 시험법 밸리데이션 통계 계산 + 판정. 사용법: node calc_validation.js input.json
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const rsd = a => (sd(a) / mean(a)) * 100;
const f = (x, n = 3) => (x === undefined || x === null || isNaN(x) ? "-" : Number(x).toFixed(n));
const pass = ok => (ok ? "적합" : "**부적합**");

const meta = d.meta || {};
const C = meta.nominal_content_percent;
const preset = (d.criteria && d.criteria.preset) || "sanco3030";
const custom = (d.criteria && d.criteria.custom) || {};

function horwitzRSDr(pct) {
  const c = pct / 100;
  return 0.67 * Math.pow(2, 1 - 0.5 * Math.log10(c));
}
function recoveryRange(pct) {
  if (preset === "ich") return [98, 102];
  if (pct > 10) return [98, 102];
  if (pct >= 1) return [90, 110];
  if (pct >= 0.1) return [80, 120];
  return [75, 125];
}
const crit = {
  r_min: custom.r_min ?? (preset === "ich" ? 0.999 : 0.99),
  rec: custom.recovery_range ?? (C !== undefined ? recoveryRange(C) : [98, 102]),
  rsd_max: custom.rsd_max ?? (preset === "ich" ? 2.0 : C !== undefined ? horwitzRSDr(C) : 2.0),
};

const out = [];
const summary = [];
out.push(`# 계산 결과 — ${meta.title || ""}`);
out.push(`기준 preset: \`${preset}\`${Object.keys(custom).length ? " (사내 기준으로 일부 덮어씀)" : ""} / 표시 함량: ${C ?? "-"}%\n`);

// 직선성
let reg = null;
if (Array.isArray(d.linearity) && d.linearity.length >= 3) {
  const x = d.linearity.map(p => p.conc), y = d.linearity.map(p => p.response), n = x.length;
  const mx = mean(x), my = mean(y);
  const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  const sxy = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  const syy = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const slope = sxy / sxx, intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  const resid = y.map((v, i) => v - (slope * x[i] + intercept));
  const sres = Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / (n - 2));
  const sIntercept = sres * Math.sqrt(1 / n + mx * mx / sxx);
  reg = { slope, intercept, r, sres, sIntercept };
  out.push(`## 직선성`);
  out.push(`| 농도 (${meta.conc_unit || ""}) | 반응값 | 계산값 | 잔차(%) |\n|---|---|---|---|`);
  x.forEach((v, i) => out.push(`| ${v} | ${y[i]} | ${f(slope * v + intercept, 1)} | ${f((resid[i] / (slope * v + intercept)) * 100, 2)} |`));
  out.push(`\n- 회귀식: y = ${f(slope, 4)}x ${intercept >= 0 ? "+" : "−"} ${f(Math.abs(intercept), 2)}`);
  out.push(`- r = ${f(r, 5)}, R² = ${f(r * r, 5)} (기준 r ≥ ${crit.r_min}) → ${pass(r >= crit.r_min)}`);
  out.push(`- 잔차 표준편차 σ = ${f(sres, 3)}, 절편 표준편차 = ${f(sIntercept, 3)}\n`);
  summary.push(["직선성", `r ≥ ${crit.r_min}`, `r = ${f(r, 5)}`, pass(r >= crit.r_min)]);
}

// 정확성
if (Array.isArray(d.accuracy) && d.accuracy.length) {
  out.push(`## 정확성 (회수율)`);
  out.push(`| 수준 | 첨가량 | 측정량 | 회수율(%) |\n|---|---|---|---|`);
  const recs = d.accuracy.map(a => ({ ...a, rec: (a.found / a.added) * 100 }));
  recs.forEach(a => out.push(`| ${a.level} | ${a.added} | ${a.found} | ${f(a.rec, 2)} |`));
  const levels = [...new Set(recs.map(a => a.level))];
  out.push(`\n| 수준 | 평균 회수율(%) | RSD(%) |\n|---|---|---|`);
  levels.forEach(l => {
    const v = recs.filter(a => a.level === l).map(a => a.rec);
    out.push(`| ${l} | ${f(mean(v), 2)} | ${v.length > 1 ? f(rsd(v), 2) : "-"} |`);
  });
  const all = recs.map(a => a.rec), m = mean(all);
  const okAll = recs.every(a => a.rec >= crit.rec[0] && a.rec <= crit.rec[1]);
  out.push(`\n- 전체 평균 ${f(m, 2)}%, RSD ${f(rsd(all), 2)}% (기준 개별 회수율 ${crit.rec[0]}–${crit.rec[1]}%) → ${pass(okAll)}\n`);
  summary.push(["정확성", `${crit.rec[0]}–${crit.rec[1]}%`, `${f(Math.min(...all), 2)}–${f(Math.max(...all), 2)}% (평균 ${f(m, 2)}%)`, pass(okAll)]);
}

// 정밀성
function precisionBlock(name, vals) {
  const m = mean(vals), s = sd(vals), rv = rsd(vals);
  out.push(`- ${name}: n=${vals.length}, 평균 ${f(m, 4)}, SD ${f(s, 4)}, RSD ${f(rv, 2)}% (기준 ≤ ${f(crit.rsd_max, 2)}%) → ${pass(rv <= crit.rsd_max)}`);
  summary.push([name, `RSD ≤ ${f(crit.rsd_max, 2)}%`, `${f(rv, 2)}%`, pass(rv <= crit.rsd_max)]);
}
if (Array.isArray(d.repeatability) && d.repeatability.length > 1) {
  out.push(`## 정밀성`);
  if (preset !== "ich" && C !== undefined && custom.rsd_max === undefined)
    out.push(`(수정 Horwitz RSDr, C = ${C}% → ${f(crit.rsd_max, 2)}%)`);
  precisionBlock("반복성", d.repeatability);
}
if (d.intermediate_precision && typeof d.intermediate_precision === "object") {
  const groups = Object.entries(d.intermediate_precision);
  groups.forEach(([k, v]) => out.push(`- ${k}: 평균 ${f(mean(v), 4)}, RSD ${f(rsd(v), 2)}%`));
  precisionBlock("실험실 내 정밀성(전체)", groups.flatMap(([, v]) => v));
}
out.push("");

// LOD/LOQ
const ll = d.lod_loq || {};
if (ll.method === "calibration" && reg) {
  const lod = (3.3 * reg.sres) / reg.slope, loq = (10 * reg.sres) / reg.slope;
  out.push(`## 검출한계/정량한계 (검량선법, σ = 잔차 SD)`);
  out.push(`- LOD = 3.3σ/S = ${f(lod, 3)} ${meta.conc_unit || ""}`);
  out.push(`- LOQ = 10σ/S = ${f(loq, 3)} ${meta.conc_unit || ""}\n`);
  summary.push(["LOD / LOQ", "산출", `${f(lod, 3)} / ${f(loq, 3)} ${meta.conc_unit || ""}`, "-"]);
} else if (ll.lod !== undefined) {
  out.push(`## 검출한계/정량한계 (${ll.method || "입력값"})\n- LOD = ${ll.lod}, LOQ = ${ll.loq}\n`);
  summary.push(["LOD / LOQ", ll.method || "입력값", `${ll.lod} / ${ll.loq}`, "-"]);
}

out.push(`## 결과 요약\n| 항목 | 기준 | 결과 | 판정 |\n|---|---|---|---|`);
summary.forEach(r => out.push(`| ${r.join(" | ")} |`));
console.log(out.join("\n"));
