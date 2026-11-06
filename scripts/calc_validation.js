#!/usr/bin/env node
// 시험법 밸리데이션 통계 계산 · 판정 · 보고서 생성
// 사용법:
//   node calc_validation.js input.json                 → 마크다운 결과 (stdout)
//   node calc_validation.js input.json --json          → JSON 결과 (stdout)
//   node calc_validation.js input.json --html out.html → 그래프 포함 HTML 보고서 파일 생성 (브라우저에서 PDF 인쇄 가능)
"use strict";
const fs = require("fs");
const path = require("path");
const S = require("./lib/stats");

// ───────────────────────── 기준(preset) ─────────────────────────
// sanco3030: SANCO/3030/99 rev.5 (2019) 4.2.1, Appendix 2·3 원문 기준
// ich: ICH Q2(R2) 항목 구성 + 제약 함량시험에서 통용되는 관행값 (ICH 자체는 수치 기준을 정하지 않음)
// 시스템 적합성·완건성 기본값은 일반 관행값 → 사내 SOP 값으로 덮어쓴 경우에만 종합 판정에 반영
function sancoRecoveryRange(pct) {
  if (pct >= 10) return [97, 103];
  if (pct >= 1) return [90, 110];
  if (pct >= 0.1) return [80, 120];
  if (pct >= 0.01) return [75, 125];
  return [70, 130];
}

function resolveCriteria(d) {
  const c = d.criteria || {};
  const preset = c.preset || "sanco3030";
  if (!["sanco3030", "ich", "custom"].includes(preset)) throw new Error(`criteria.preset 값이 잘못됨: ${preset} (sanco3030 | ich | custom)`);
  const o = c.custom || {};
  const C = num(d.meta && d.meta.nominal_content_percent);
  const base = preset === "ich"
    ? {
        label: "ICH Q2(R2) 항목 + 제약 함량시험 관행값",
        r_min: 0.999, r2_alt: null,
        lin_rule: "5개 농도 이상",
        lin_min_levels: 5, lin_dup_min_levels: null,
        recovery_range: [98, 102], acc_min_n: 9,
        precision_mode: "rsd", rsd_max: 2.0, rep_min_n: 6,
        min_n_hard: false,          // ICH 측정 수는 권고 → 경고만
        interference_max: null,     // ICH는 수치 기준 없음 → 시험자 판단(pass) 필요
        ip_scored: true,
      }
    : {
        label: preset === "custom" ? "사내 기준(custom)" : "SANCO/3030/99 rev.5",
        r_min: 0.99, r2_alt: 0.98,
        lin_rule: "독립 조제 1회 × 5농도 이상 또는 독립 조제 2회 × 3농도 이상",
        lin_min_levels: 5, lin_dup_min_levels: 3,
        recovery_range: Number.isFinite(C) ? sancoRecoveryRange(C) : null, acc_min_n: 2,
        precision_mode: "horrat", rsd_max: null, rep_min_n: 5,
        min_n_hard: true,           // SANCO "must be made" → 미달 시 부적합
        interference_max: 3,
        ip_scored: false,           // SANCO 필수 아님, Horrat은 반복성 전용
      };
  const common = {
    lin_range_pct: 20,
    ss_area_rsd_max: 2.0, ss_tailing_max: 2.0, ss_plates_min: 2000, ss_resolution_min: 2.0,
    robustness_max_diff: 2.0,
    grubbs_alpha: 0.05,
  };
  const crit = { preset, ...common, ...base };
  for (const [k, v] of Object.entries(o)) crit[k] = v;
  if (o.rsd_max !== undefined) { crit.precision_mode = "rsd"; if (o.ip_scored === undefined) crit.ip_scored = true; }
  // 관행값 항목은 사내 기준을 넣었을 때만 종합 판정에 반영
  if (o.ss_scored === undefined) crit.ss_scored = preset === "custom" || Object.keys(o).some(k => k.startsWith("ss_"));
  if (o.robustness_scored === undefined) crit.robustness_scored = preset === "custom" || o.robustness_max_diff !== undefined;
  if (Object.keys(o).length && preset !== "custom") crit.label += " (일부 사내 기준으로 덮어씀)";
  return crit;
}

// ───────────────────────── 유틸 ─────────────────────────
// 숫자 변환: 천 단위 콤마("1,002,450")만 허용. "5,02" 같은 소수점 콤마는 오류(NaN)로 처리
// 절댓값 1e15 초과는 측정값으로 비현실적이고 분산 계산에서 넘침(Infinity)을 일으키므로 오류로 처리
const MAX_ABS = 1e15;
function num(v) {
  const n = parseNum(v);
  return n !== undefined && Math.abs(n) > MAX_ABS ? NaN : n;
}
function parseNum(v) {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string") return NaN;
  let s = v.trim();
  if (s.includes(",")) {
    if (!/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return NaN;
    s = s.replace(/,/g, "");
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return NaN;
  return Number(s);
}
const isNum = v => typeof v === "number" && Number.isFinite(v);
// 이진 오차 없는 십진 반올림, 0.5는 0에서 먼 쪽으로 (1.005 → 1.01, -1.005 → -1.01, 1e-7 → 0)
function round(x, n) {
  x = Number(x);
  if (!Number.isFinite(x)) return x;
  const [m, e] = Math.abs(x).toExponential().split("e");
  const [rm, re] = String(Math.round(Number(`${m}e${Number(e) + n}`))).split("e");
  return (x < 0 ? -1 : 1) * Number(`${rm}e${(Number(re) || 0) - n}`);
}
const f = (x, n = 3) => (x === undefined || x === null || Number.isNaN(x) ? "-" : round(x, n).toFixed(n));
const V = { PASS: "적합", COND: "조건부 적합", FAIL: "부적합", REVIEW: "확인 필요", INFO: "정보", NA: "미실시" };
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
// 오류 메시지에 사용자 입력을 보여줄 때
const showVal = v => (v === undefined ? "빈 값" : typeof v === "number" && !Number.isFinite(v) ? "유효하지 않은 수" : JSON.stringify(v));
// 문장 필드: 문자열·유한한 숫자만 허용. 그 외(객체, 배열, NaN 등)는 오류로 알리고 제거
function cleanText(obj, keys, name, ctx) {
  if (!isObj(obj)) return;
  for (const k of keys || Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null || typeof v === "string" || isNum(v)) continue;
    ctx.err(`${name}.${k}: 문자 또는 숫자여야 함 (${showVal(v)})`);
    delete obj[k];
  }
}
function sanitizeTextFields(d, ctx) {
  cleanText(d.meta, null, "meta", ctx);
  cleanText(d.narrative, null, "narrative", ctx);
  cleanText(d.system_suitability, ["note"], "system_suitability", ctx);
  cleanText(d.specificity, ["note", "peak_purity", "resolution"], "specificity", ctx);
  if (Array.isArray(d.accuracy)) d.accuracy.forEach((a, i) => cleanText(a, ["level"], `accuracy[${i}]`, ctx));
  if (Array.isArray(d.robustness)) d.robustness.forEach((a, i) => cleanText(a, ["condition", "result"], `robustness[${i}]`, ctx));
}

class Ctx {
  constructor() { this.errors = []; this.warnings = []; this.summary = []; }
  err(m) { this.errors.push(m); }
  warn(m) { this.warnings.push(m); }
  // required: 필수 항목(판정 못 하면 종합 판정 보류) / scored: 종합 판정 반영 여부
  row(item, criterion, result, verdict, { required = false, scored = true } = {}) {
    this.summary.push({ item: scored ? item : `${item} (참고)`, criterion, result, verdict, required, scored });
  }
}

function numArray(arr, name, ctx) {
  if (!Array.isArray(arr)) { ctx.err(`${name}: 배열이어야 함`); return []; }
  const out = [];
  arr.forEach((v, i) => {
    const n = num(v);
    if (n === undefined || Number.isNaN(n)) ctx.err(`${name}[${i}]: 숫자가 아니거나 범위 밖 (${showVal(v)})${typeof v === "string" && /\d,\d/.test(v) ? " — 소수점은 마침표(.)로 입력" : ""}`);
    else out.push(n);
  });
  return out;
}

// 시험자 판단 플래그(pass: true/false) → 판정
const passFlag = p => (p === true ? V.PASS : p === false ? V.FAIL : undefined);

// ───────────────────────── 항목별 계산 ─────────────────────────
function calcSystemSuitability(d, crit, ctx) {
  const ss = d.system_suitability;
  if (ss == null) return null;
  const opt = { scored: crit.ss_scored };
  if (typeof ss === "string") { ctx.row("시스템 적합성", "-", ss, V.INFO, opt); return { text: ss }; }
  if (!isObj(ss)) { ctx.err("system_suitability: 객체 또는 문자열이어야 함"); return null; }
  const res = { note: ss.note, checks: [] };
  if (ss.area_values != null) {
    const a = numArray(ss.area_values, "system_suitability.area_values", ctx);
    if (a.length >= 2) {
      const r = S.rsd(a);
      res.area = { n: a.length, mean: S.mean(a), rsd: r };
      if (a.length < 5) ctx.warn(`시스템 적합성: 반복 주입이 ${a.length}회로, 일반적인 5–6회보다 적음`);
      res.checks.push(["면적 RSD (%)", `≤ ${crit.ss_area_rsd_max}`, f(r, 2), round(r, 2) <= crit.ss_area_rsd_max]);
    }
  }
  const chk = (key, label, op, lim, dec) => {
    const v = num(ss[key]);
    if (v === undefined) return;
    if (Number.isNaN(v)) return ctx.err(`system_suitability.${key}: 숫자가 아님`);
    const ok = op === "<=" ? round(v, dec) <= lim : round(v, dec) >= lim;
    res.checks.push([label, `${op === "<=" ? "≤" : "≥"} ${lim}`, f(v, dec), ok]);
  };
  chk("tailing", "테일링 계수", "<=", crit.ss_tailing_max, 2);
  chk("plates", "이론단수", ">=", crit.ss_plates_min, 0);
  chk("resolution", "분리도", ">=", crit.ss_resolution_min, 2);
  res.checks.forEach(([l, c, r, ok]) => ctx.row(`시스템 적합성 – ${l}`, c, r, ok ? V.PASS : V.FAIL, opt));
  if (!crit.ss_scored && res.checks.some(c => !c[3])) ctx.warn("시스템 적합성: 일반 관행값 기준으로 미달 항목 있음 — 사내 SOP 기준을 criteria.custom(ss_*)에 넣으면 종합 판정에 반영됨");
  return res;
}

function calcSpecificity(d, crit, ctx) {
  const sp = d.specificity;
  const req = { required: true };
  const critText = crit.interference_max != null ? `간섭 ≤ ${crit.interference_max}% (총 피크면적 대비)` : "간섭 없음 (시험자 판단)";
  if (sp == null) { ctx.warn("특이성 데이터 없음 — 필수 항목 (blank·표준·시료 크로마토그램 비교)"); ctx.row("특이성", critText, "-", V.NA, req); return null; }
  if (typeof sp === "string") {
    ctx.row("특이성", critText, sp, V.REVIEW, req);
    ctx.warn(crit.interference_max != null
      ? `특이성: 서술만 있어 자동 판정 불가 — specificity.interference_pct(총 피크면적 대비 %)를 넣으면 SANCO 기준(≤ ${crit.interference_max}%)으로 판정`
      : "특이성: 서술만 있어 자동 판정 불가 — 시험자 판단 결과를 specificity.pass(true/false)로 넣어야 함");
    return { text: sp };
  }
  if (!isObj(sp)) { ctx.err("specificity: 객체 또는 문자열이어야 함"); return null; }
  const ip = num(sp.interference_pct);
  if (Number.isNaN(ip)) { ctx.err(`specificity.interference_pct: 숫자가 아님 (${showVal(sp.interference_pct)}) — "<0.1"처럼 부등호가 있으면 숫자(0.1)로 넣고 note에 설명`); return { ...sp }; }
  if (ip !== undefined && crit.interference_max != null) {
    const ok = round(ip, 2) <= crit.interference_max;
    ctx.row("특이성 (간섭)", critText, `${f(ip, 2)}%`, ok ? V.PASS : V.FAIL, req);
  } else if (passFlag(sp.pass)) {
    ctx.row("특이성", critText, ip !== undefined ? `간섭 ${f(ip, 2)}%` : (sp.note || "-"), passFlag(sp.pass), req);
  } else {
    ctx.row("특이성", critText, ip !== undefined ? `간섭 ${f(ip, 2)}%` : (sp.note || "-"), V.REVIEW, req);
    ctx.warn("특이성: 판정 근거 부족 — " + (crit.interference_max != null ? "interference_pct" : "pass(true/false)") + " 필요");
  }
  return { ...sp };
}

function calcLinearity(d, crit, ctx) {
  const L = d.linearity;
  const req = { required: true };
  if (!Array.isArray(L) || !L.length) { ctx.warn("직선성 데이터 없음 — 필수 항목"); ctx.row("직선성", "-", "-", V.NA, req); return null; }
  // 각 행 = 독립 조제(칭량) 1건. response 배열은 같은 용액의 반복 주입 → 평균을 한 점으로 사용
  const x = [], y = [], inj = [];
  L.forEach((p, i) => {
    if (!isObj(p)) return ctx.err(`linearity[${i}]: {conc, response} 객체여야 함`);
    const c = num(p.conc);
    if (c === undefined || Number.isNaN(c)) return ctx.err(`linearity[${i}].conc: 숫자가 아님`);
    const rs = numArray(Array.isArray(p.response) ? p.response : [p.response], `linearity[${i}].response`, ctx);
    if (!rs.length) return ctx.err(`linearity[${i}].response: 값이 없음`);
    x.push(c); y.push(S.mean(rs)); inj.push(rs.length);
  });
  const distinct = [...new Set(x)].sort((a, b) => a - b);
  if (distinct.length < 3) { ctx.err(`직선성: 농도 수준이 ${distinct.length}개 — 최소 3개 필요`); ctx.row("직선성", "-", "-", V.NA, req); return null; }
  const reg = S.linreg(x, y);
  if (!(reg.slope > 0)) ctx.warn("직선성: 기울기가 0 이하 — 농도/반응값 입력 확인");

  // 설계 요건 (독립 조제 수 기준)
  const minRep = Math.min(...distinct.map(c => x.filter(v => v === c).length));
  const designOk = distinct.length >= crit.lin_min_levels || (crit.lin_dup_min_levels != null && distinct.length >= crit.lin_dup_min_levels && minRep >= 2);
  if (!designOk) ctx.warn(`직선성 설계 미달: ${distinct.length}개 농도 × 독립 조제 최소 ${minRep}회 (기준: ${crit.lin_rule}). 같은 용액의 반복 주입은 독립 조제로 치지 않음 — 독립 조제는 같은 conc로 행을 따로 입력`);

  // 범위 (목표 농도 ±20%)
  const target = num(d.meta && d.meta.target_conc);
  let rangeOk = null;
  if (isNum(target) && target > 0) {
    const lo = distinct[0], hi = distinct[distinct.length - 1];
    const need = crit.lin_range_pct / 100;
    rangeOk = lo <= target * (1 - need) + 1e-12 && hi >= target * (1 + need) - 1e-12;
    if (!rangeOk) ctx.warn(`직선성 범위 미달: ${lo}–${hi} ${d.meta.conc_unit || ""}, 목표 농도 ${target}의 ±${crit.lin_range_pct}%(${f(target * (1 - need), 3)}–${f(target * (1 + need), 3)})를 포함해야 함`);
  } else {
    if (Number.isNaN(target)) ctx.err("meta.target_conc: 숫자가 아님");
    ctx.warn("meta.target_conc(시험액 중 목표 농도)가 없어 직선성 범위(±20%) 충족 여부를 판정하지 못함");
  }

  // 판정 — 원값으로 비교 (반올림으로 경계값이 통과하지 않도록)
  let ok = reg.r >= crit.r_min;
  if (!ok && crit.r2_alt != null && reg.r2 >= crit.r2_alt) ok = true;
  const critText = `r ≥ ${crit.r_min}` + (crit.r2_alt != null ? ` (또는 r² ≥ ${crit.r2_alt})` : "");
  let verdict = ok ? V.PASS : V.FAIL;
  if (ok && (!designOk || rangeOk === false)) verdict = V.COND;
  ctx.row("직선성", critText, `r = ${f(reg.r, 5)}, r² = ${f(reg.r2, 5)}`, verdict, req);

  // 참고 지표: 잔차(%)는 반응값이 0 근처인 점(예: 0 농도)은 제외
  const maxFit = Math.max(...reg.fitted.map(Math.abs));
  const resPct = reg.resid.map((e, i) => (Math.abs(reg.fitted[i]) < 0.01 * maxFit ? NaN : (e / reg.fitted[i]) * 100));
  const valid = resPct.filter(v => !Number.isNaN(v));
  const maxRes = valid.length ? Math.max(...valid.map(Math.abs)) : NaN;
  if (maxRes > 2) ctx.warn(`직선성: 최대 잔차가 ${f(maxRes, 2)}%로 큼 — 해당 점 재확인 또는 범위 조정 검토`);
  let interceptPct;
  if (isNum(target) && target > 0) {
    interceptPct = (reg.intercept / (reg.slope * target + reg.intercept)) * 100;
    if (Math.abs(interceptPct) > 2) ctx.warn(`직선성: y절편이 목표 농도 반응값의 ${f(interceptPct, 2)}% — 2% 초과 시 단일점 검량 사용에 주의`);
  }
  const tInt = reg.sIntercept > 0 ? reg.intercept / reg.sIntercept : NaN;
  const pInt = reg.df > 0 && isNum(tInt) ? 2 * (1 - S.tcdf(Math.abs(tInt), reg.df)) : NaN;
  return { points: { x, y }, injections: inj, distinct, reg, resPct, maxRes, designOk, rangeOk, target, interceptPct, pInt };
}

function calcAccuracy(d, crit, ctx) {
  const A = d.accuracy;
  const req = { required: true };
  if (!Array.isArray(A) || !A.length) { ctx.warn("정확성(회수율) 데이터 없음 — 필수 항목"); ctx.row("정확성", "-", "-", V.NA, req); return null; }
  const rows = [];
  A.forEach((a, i) => {
    if (!isObj(a)) return ctx.err(`accuracy[${i}]: {level, added, found} 객체여야 함`);
    const added = num(a.added), found = num(a.found), initial = num(a.initial) ?? 0;
    if (![added, found].every(isNum)) return ctx.err(`accuracy[${i}]: added/found 가 숫자가 아님`);
    if (Number.isNaN(initial)) return ctx.err(`accuracy[${i}].initial: 숫자가 아님`);
    if (added <= 0) return ctx.err(`accuracy[${i}].added: 0보다 커야 함`);
    // SANCO App.2: 초기 함량이 첨가량의 약 10% 초과 → marginal, 이하 → total recovery
    const marginal = initial > 0.1 * added;
    const rec = marginal ? ((found - initial) / added) * 100 : (found / (initial + added)) * 100;
    rows.push({ level: (typeof a.level === "object" && a.level !== null) ? JSON.stringify(a.level) : String(a.level ?? "-"), added, found, initial, type: marginal ? "marginal" : "total", rec });
  });
  if (!rows.length) { ctx.row("정확성", "-", "-", V.NA, req); return null; }
  const levels = [...new Set(rows.map(r => r.level))].map(l => {
    const v = rows.filter(r => r.level === l).map(r => r.rec);
    const g = v.length >= 3 ? S.grubbs(v, crit.grubbs_alpha) : null;
    if (g && g.outlier) ctx.warn(`정확성 ${l}: Grubbs 검정상 이상치 의심 (${f(g.value, 2)}%, G=${f(g.G, 3)} > ${f(g.Gcrit, 3)}) — 임의 제외 금지, 원인 확인 필요`);
    return { level: l, n: v.length, mean: S.mean(v), rsd: v.length > 1 ? S.rsd(v) : NaN, ci: S.ci95(v) };
  });
  const all = rows.map(r => r.rec);
  const overall = { n: all.length, mean: S.mean(all), rsd: S.rsd(all), ci: S.ci95(all), min: Math.min(...all), max: Math.max(...all) };

  const short = all.length < crit.acc_min_n;
  if (short) ctx.warn(`정확성: 측정 수 ${all.length}회 — 기준 최소 ${crit.acc_min_n}회${crit.preset === "ich" ? " (3농도 × 3회 권장)" : " 독립 칭량 (SANCO 4.2.1 iii)"}`);
  const rr = crit.recovery_range;
  const resText = `평균 ${f(overall.mean, 1)}% (수준별 ${levels.map(l => f(l.mean, 1)).join(" / ")}), n=${all.length}`;
  if (!rr) {
    ctx.warn("meta.nominal_content_percent(표시 함량 % w/w)가 없어 SANCO 회수율 기준 구간을 정하지 못함 → 판정 불가");
    ctx.row("정확성 (평균 회수율)", "표시 함량 필요", resText, V.REVIEW, req);
  } else {
    // 기준은 '평균 회수율'에 적용 (SANCO App.2). 보고 자릿수(소수 1자리)로 반올림 후 비교
    const inR = v => round(v, 1) >= rr[0] && round(v, 1) <= rr[1];
    const ok = inR(overall.mean) && levels.every(l => inR(l.mean));
    let verdict = ok ? V.PASS : V.FAIL;
    if (ok && short && crit.min_n_hard) verdict = V.FAIL;
    ctx.row("정확성 (평균 회수율)", `${rr[0]}–${rr[1]}%` + (crit.min_n_hard ? `, n ≥ ${crit.acc_min_n}` : ""), resText + (ok && short && crit.min_n_hard ? " — 측정 수 부족" : ""), verdict, req);
    const outIndiv = rows.filter(r => !inR(r.rec));
    if (ok && outIndiv.length) ctx.warn(`정확성: 평균은 적합하나 개별 회수율 ${outIndiv.length}개가 ${rr[0]}–${rr[1]}% 밖 (${outIndiv.map(r => f(r.rec, 1) + "%").join(", ")})`);
  }
  if (rows.some(r => r.type === "marginal")) ctx.warn("정확성: 일부 시료의 초기 함량이 첨가량의 10%를 넘어 marginal recovery((CF−CU)/CA)로 계산함");
  return { rows, levels, overall, range: rr };
}

function precisionJudge(rsdVal, contentPct, crit) {
  if (crit.precision_mode === "rsd") {
    const ok = round(rsdVal, 2) <= crit.rsd_max;
    return { critText: `RSD ≤ ${crit.rsd_max}%`, verdict: ok ? V.PASS : V.FAIL };
  }
  if (!isNum(contentPct) || contentPct <= 0) return { critText: "Horrat ≤ 1 (함량 정보 필요)", verdict: V.REVIEW };
  const rsdr = S.horwitzRSDr(contentPct);
  const hr = rsdVal / rsdr;   // 원값 비교 (1.004는 조건부)
  const verdict = hr <= 1 ? V.PASS : hr <= 2 ? V.COND : V.FAIL;
  return { critText: `Horrat ≤ 1 (RSDr ≤ ${f(rsdr, 2)}%)`, verdict, rsdr, hr };
}

// Horwitz 농도 c(% w/w): 측정값 단위가 % w/w 또는 g/kg 일 때만 측정 평균 사용, 그 외엔 표시 함량
function contentForHorwitz(d, values) {
  const unit = String((d.meta && d.meta.content_unit) || "% w/w").trim();
  if (values && values.length) {
    if (/^%\s*\(?w\s*\/\s*w\)?$/i.test(unit)) return S.mean(values);
    if (/^g\s*\/\s*kg$/i.test(unit)) return S.mean(values) / 10;
  }
  return num(d.meta && d.meta.nominal_content_percent);
}
const isWW = d => /^%\s*\(?w\s*\/\s*w\)?$/i.test(String((d.meta && d.meta.content_unit) || "% w/w").trim());

function calcRepeatability(d, crit, ctx) {
  const R = d.repeatability;
  const req = { required: true };
  if (R == null) { ctx.warn("반복성 데이터 없음 — 필수 항목"); ctx.row("반복성", "-", "-", V.NA, req); return null; }
  const v = numArray(R, "repeatability", ctx);
  if (v.length < 2) { ctx.err("반복성: 2개 이상 값 필요"); ctx.row("반복성", "-", "-", V.NA, req); return null; }
  if (v.some(x => x <= 0)) ctx.err("반복성: 함량 값은 0보다 커야 함 — 입력 확인");
  if (isWW(d) && S.mean(v) > 100) ctx.err(`반복성: 단위가 % w/w인데 평균이 ${f(S.mean(v), 2)} — 단위(meta.content_unit)나 소수점 입력 확인`);
  const short = v.length < crit.rep_min_n;
  if (short) ctx.warn(`반복성: n=${v.length} — 기준 최소 ${crit.rep_min_n}회 독립 칭량`);
  const C = contentForHorwitz(d, v);
  const r = S.rsd(v);
  const j = precisionJudge(r, C, crit);
  const g = v.length >= 3 ? S.grubbs(v, crit.grubbs_alpha) : null;
  if (g && g.outlier) ctx.warn(`반복성: Grubbs 검정상 이상치 의심 (${g.value}, G=${f(g.G, 3)} > ${f(g.Gcrit, 3)}). SANCO: 통계적으로 확인된 이상치는 수준당 최대 1개까지 사유를 적고 제외 가능`);
  if (j.verdict === V.COND) ctx.warn(`반복성: Horrat ${f(j.hr, 3)} (1 < Hr ≤ 2) — 보고서에 사유 설명이 있어야 적합으로 인정됨`);
  if (j.verdict === V.REVIEW) ctx.warn("반복성: Horwitz 기준 계산에 함량(% w/w)이 필요 — meta.nominal_content_percent 입력");
  let verdict = j.verdict;
  if (short && crit.min_n_hard && verdict !== V.REVIEW) verdict = V.FAIL;
  const nominal = num(d.meta && d.meta.nominal_content_percent);
  const ofLabel = isNum(nominal) && nominal > 0 && isWW(d) ? (S.mean(v) / nominal) * 100 : undefined;
  ctx.row("반복성", j.critText + (crit.min_n_hard ? `, n ≥ ${crit.rep_min_n}` : ""), `n=${v.length}, RSD ${f(r, 2)}%` + (j.hr !== undefined ? `, Horrat ${f(j.hr, 3)}` : "") + (short && crit.min_n_hard ? " — 측정 수 부족" : ""), verdict, req);
  return { values: v, n: v.length, mean: S.mean(v), sd: S.sd(v), rsd: r, ci: S.ci95(v), judge: j, grubbs: g, ofLabel, C };
}

function calcIntermediate(d, crit, ctx) {
  const IP = d.intermediate_precision;
  if (IP == null) {
    if (crit.preset === "ich") ctx.warn("실험실 내 정밀성(중간정밀성) 데이터 없음 — ICH 함량시험 권장 항목");
    return null;
  }
  if (!isObj(IP)) { ctx.err('intermediate_precision: {"조건명": [값, …]} 형태여야 함'); return null; }
  const groups = Object.entries(IP).map(([k, arr]) => ({ name: k, values: numArray(arr, `intermediate_precision.${k}`, ctx) }));
  if (groups.length < 2 || groups.some(g => g.values.length < 2)) { ctx.err("실험실 내 정밀성: 2개 이상 조건(일자/시험자 등), 조건별 2개 이상 값 필요"); return null; }
  const a = S.anovaPrecision(groups.map(g => g.values));
  const means = groups.map(g => S.mean(g.values));
  const spread = ((Math.max(...means) - Math.min(...means)) / a.grandMean) * 100;
  if (a.p < 0.05) ctx.warn(`실험실 내 정밀성: 조건 간 평균 차이가 통계적으로 유의함 (ANOVA p=${f(a.p, 3)}, 최대 차이 ${f(spread, 2)}%) — 시험자/일자 영향 확인`);
  let j;
  if (crit.ip_scored && crit.precision_mode === "rsd") {
    j = precisionJudge(a.rsdIP, undefined, crit);
    ctx.row("실험실 내 정밀성", j.critText, `RSD ${f(a.rsdIP, 2)}%`, j.verdict);
  } else {
    j = { verdict: V.INFO };
    ctx.row("실험실 내 정밀성", "SANCO 필수 아님", `RSD ${f(a.rsdIP, 2)}%, 조건 간 p = ${f(a.p, 3)}`, V.INFO, { scored: false });
  }
  return { groups: groups.map((g, i) => ({ ...g, mean: means[i], rsd: S.rsd(g.values) })), anova: a, judge: j, spread };
}

function calcLodLoq(d, crit, lin, ctx) {
  const ll = d.lod_loq;
  if (ll == null) return null;
  if (!isObj(ll)) { ctx.err("lod_loq: 객체여야 함"); return null; }
  const unit = (d.meta && d.meta.conc_unit) || "";
  const opt = { scored: false };
  if (ll.method === "calibration") {
    if (!lin) { ctx.err("LOD/LOQ 검량선법: 직선성 데이터 필요"); return null; }
    const sigmaType = ll.sigma === "intercept" ? "intercept" : "residual";
    const sigma = sigmaType === "intercept" ? lin.reg.sIntercept : lin.reg.sres;
    const lod = (3.3 * sigma) / lin.reg.slope, loq = (10 * sigma) / lin.reg.slope;
    const lo = lin.distinct[0];
    if (lo > 10 * loq) ctx.warn(`LOD/LOQ: 검량선 최저 농도(${lo})가 산출 LOQ(${f(loq, 3)})보다 훨씬 높음 — 고농도 검량선에서 구한 값이라 참고용. 정확한 값은 저농도 검량선 또는 S/N 법으로 확인`);
    ctx.row("LOD / LOQ", "검량선법 3.3σ/S, 10σ/S", `${f(lod, 4)} / ${f(loq, 4)} ${unit}`, V.INFO, opt);
    return { method: `검량선법 (σ = ${sigmaType === "intercept" ? "절편 표준편차" : "잔차 표준편차"})`, lod, loq, unit, sigma };
  }
  const lod = num(ll.lod), loq = num(ll.loq);
  if (!isNum(lod) || !isNum(loq)) { ctx.err("lod_loq: method가 calibration이 아니면 lod, loq 숫자가 필요"); return null; }
  ctx.row("LOD / LOQ", ll.method === "sn" ? "S/N 3 / 10" : "입력값", `${f(lod, 4)} / ${f(loq, 4)} ${unit}`, V.INFO, opt);
  return { method: ll.method === "sn" ? "S/N 비 (3 / 10)" : "입력값", lod, loq, unit };
}

function calcRobustness(d, crit, ctx) {
  const R = d.robustness;
  if (!Array.isArray(R) || !R.length) return null;
  const rows = [];
  R.forEach((r, i) => {
    if (!isObj(r)) return ctx.err(`robustness[${i}]: 객체여야 함`);
    const rv = num(r.result_value), ref = num(r.reference_value);
    if (isNum(rv) && isNum(ref) && ref !== 0) {
      const diff = ((rv - ref) / ref) * 100;
      rows.push({ ...r, diff, ok: Math.abs(round(diff, 2)) <= crit.robustness_max_diff });
    } else rows.push({ ...r });
  });
  const opt = { scored: crit.robustness_scored };
  const judged = rows.filter(r => r.ok !== undefined);
  if (judged.length) {
    const ok = judged.every(r => r.ok);
    const maxD = Math.max(...judged.map(r => Math.abs(r.diff)));
    ctx.row("완건성", `기준 조건 대비 차이 ≤ ${crit.robustness_max_diff}%`, `최대 ${f(maxD, 2)}%`, ok ? V.PASS : V.FAIL, opt);
    if (!ok && !crit.robustness_scored) ctx.warn("완건성: 참고 기준(2%) 초과 조건 있음 — 사내 기준이 있으면 criteria.custom.robustness_max_diff 로 지정");
  } else {
    ctx.row("완건성", "-", `${rows.length}개 조건 (서술형)`, V.INFO, { scored: false });
  }
  return { rows };
}

// ───────────────────────── 종합 판정 ─────────────────────────
function overallVerdict(summary, errors) {
  if (errors.length) return "입력 오류";
  const scored = summary.filter(s => s.scored);
  if (scored.some(s => s.verdict === V.FAIL)) return V.FAIL;
  if (summary.some(s => s.required && s.verdict === V.NA)) return "미완료 (필수 항목 누락)";
  if (summary.some(s => s.required && (s.verdict === V.REVIEW || s.verdict === V.INFO))) return "판정 보류 (확인 필요 항목 있음)";
  if (scored.some(s => s.verdict === V.COND)) return V.COND;
  return V.PASS;
}

// ───────────────────────── 전체 실행 ─────────────────────────
function run(d) {
  const ctx = new Ctx();
  if (!isObj(d)) throw new Error("입력 JSON이 객체가 아님");
  d.meta = isObj(d.meta) ? d.meta : {};
  d.narrative = isObj(d.narrative) ? d.narrative : {};
  sanitizeTextFields(d, ctx);
  const C = num(d.meta.nominal_content_percent);
  if (Number.isNaN(C)) ctx.err(`meta.nominal_content_percent: 숫자가 아님 (${showVal(d.meta.nominal_content_percent)}) — "5%"가 아니라 5로 입력`);
  else if (C !== undefined && (C <= 0 || C > 100)) ctx.err(`meta.nominal_content_percent: 0–100 사이여야 함 (${C})`);
  const crit = resolveCriteria(d);
  const r = { meta: d.meta, narrative: d.narrative, criteria: crit };
  r.system_suitability = calcSystemSuitability(d, crit, ctx);
  r.specificity = calcSpecificity(d, crit, ctx);
  r.linearity = calcLinearity(d, crit, ctx);
  r.accuracy = calcAccuracy(d, crit, ctx);
  r.repeatability = calcRepeatability(d, crit, ctx);
  r.intermediate = calcIntermediate(d, crit, ctx);
  r.lodloq = calcLodLoq(d, crit, r.linearity, ctx);
  r.robustness = calcRobustness(d, crit, ctx);
  r.overall = overallVerdict(ctx.summary, ctx.errors);
  r.summary = ctx.summary; r.warnings = ctx.warnings; r.errors = ctx.errors;
  return r;
}


// ───────────────────────── 마크다운 출력 ─────────────────────────
function toMarkdown(r) {
  const m = r.meta, o = [];
  const cu = m.conc_unit || "";
  o.push(`# 계산 결과 — ${m.title || ""}`);
  o.push(`- 판정 기준: **${r.criteria.label}**`);
  o.push(`- 표시 함량: ${m.nominal_content_percent ?? "-"}% w/w, 목표 농도: ${m.target_conc ?? "-"} ${cu}`);
  o.push(`- 비교 규칙: 회수율(소수 1자리)·RSD·간섭(2자리)은 보고 자릿수로 반올림 후 비교, r·r²·Horrat은 원값으로 비교\n`);
  if (r.errors.length) { o.push(`## ⛔ 입력 오류`); r.errors.forEach(e => o.push(`- ${e}`)); o.push(""); }

  const ss = r.system_suitability;
  if (ss) {
    o.push(`## 시스템 적합성`);
    if (ss.text) o.push(ss.text);
    if (ss.checks && ss.checks.length) { o.push(`| 항목 | 기준 | 결과 | 판정 |\n|---|---|---|---|`); ss.checks.forEach(([l, c, v, ok]) => o.push(`| ${l} | ${c} | ${v} | ${ok ? V.PASS : V.FAIL} |`)); }
    if (ss.note) o.push(`\n${ss.note}`);
    o.push("");
  }
  if (r.specificity) {
    o.push(`## 특이성`);
    const sp = r.specificity;
    if (sp.text) o.push(sp.text);
    else {
      if (sp.interference_pct !== undefined) o.push(`- 간섭: 총 피크면적 대비 ${sp.interference_pct}%`);
      if (sp.peak_purity) o.push(`- 피크 순도: ${sp.peak_purity}`);
      if (sp.resolution !== undefined) o.push(`- 인접 피크와의 분리도: ${sp.resolution}`);
      if (sp.note) o.push(`- ${sp.note}`);
    }
    o.push("");
  }
  const L = r.linearity;
  if (L) {
    o.push(`## 직선성`);
    o.push(`| 농도 (${cu}) | 반응값 | 계산값 | 잔차(%) |\n|---|---|---|---|`);
    L.points.x.forEach((v, i) => o.push(`| ${v} | ${L.points.y[i]} | ${f(L.reg.fitted[i], 1)} | ${f(L.resPct[i], 2)} |`));
    o.push(`\n- 회귀식: y = ${f(L.reg.slope, 4)}x ${L.reg.intercept >= 0 ? "+" : "−"} ${f(Math.abs(L.reg.intercept), 4)}`);
    o.push(`- r = ${f(L.reg.r, 5)}, r² = ${f(L.reg.r2, 5)}, 농도 ${L.distinct.length}개 · 총 ${L.reg.n}점`);
    o.push(`- 범위 ${Math.min(...L.distinct)}–${Math.max(...L.distinct)} ${cu}` + (L.target ? ` (목표 ${L.target}의 ${f(Math.min(...L.distinct) / L.target * 100, 0)}–${f(Math.max(...L.distinct) / L.target * 100, 0)}%)` : ""));
    o.push(`- 잔차 표준편차 ${f(L.reg.sres, 4)}, 기울기 SD ${f(L.reg.sSlope, 4)}, 절편 SD ${f(L.reg.sIntercept, 4)}, 절편 유의성 p = ${f(L.pInt, 3)}` + (L.interceptPct !== undefined ? `, 절편/목표반응 = ${f(L.interceptPct, 2)}%` : ""));
    o.push("");
  }
  const A = r.accuracy;
  if (A) {
    o.push(`## 정확성 (회수율)`);
    o.push(`| 수준 | 초기량 | 첨가량 | 측정량 | 회수율(%) | 계산식 |\n|---|---|---|---|---|---|`);
    A.rows.forEach(a => o.push(`| ${a.level} | ${a.initial || "-"} | ${a.added} | ${a.found} | ${f(a.rec, 2)} | ${a.type} |`));
    o.push(`\n| 수준 | n | 평균 회수율(%) | RSD(%) | 95% CI |\n|---|---|---|---|---|`);
    A.levels.forEach(l => o.push(`| ${l.level} | ${l.n} | ${f(l.mean, 2)} | ${f(l.rsd, 2)} | ${Number.isNaN(l.ci) ? "-" : `${f(l.mean - l.ci, 2)}–${f(l.mean + l.ci, 2)}`} |`));
    o.push(`| **전체** | ${A.overall.n} | **${f(A.overall.mean, 2)}** | ${f(A.overall.rsd, 2)} | ${f(A.overall.mean - A.overall.ci, 2)}–${f(A.overall.mean + A.overall.ci, 2)} |`);
    if (A.range) o.push(`\n기준: 평균 회수율 ${A.range[0]}–${A.range[1]}%`);
    o.push("");
  }
  const P = r.repeatability;
  if (P) {
    o.push(`## 정밀성`);
    o.push(`### 반복성`);
    o.push(`- 측정값: ${P.values.join(", ")}`);
    o.push(`- n=${P.n}, 평균 ${f(P.mean, 4)}, SD ${f(P.sd, 4)}, RSD ${f(P.rsd, 2)}%, 95% CI ${f(P.mean - P.ci, 4)}–${f(P.mean + P.ci, 4)}`);
    if (P.ofLabel !== undefined) o.push(`- 표시 함량 대비 ${f(P.ofLabel, 1)}%`);
    if (P.judge.rsdr !== undefined) o.push(`- 수정 Horwitz RSDr (c = ${f(P.C, 3)}%) = ${f(P.judge.rsdr, 2)}%, Horrat = ${f(P.judge.hr, 3)} → ${P.judge.verdict}  (≤1 적합 / 1–2 사유 기재 시 적합 / >2 부적합)`);
    if (P.grubbs) o.push(`- Grubbs (α=0.05): G = ${f(P.grubbs.G, 3)}, 임계값 ${f(P.grubbs.Gcrit, 3)} → ${P.grubbs.outlier ? "**이상치 의심**" : "이상치 없음"}`);
    o.push("");
  }
  const I = r.intermediate;
  if (I) {
    o.push(`### 실험실 내 정밀성`);
    o.push(`| 조건 | n | 평균 | RSD(%) |\n|---|---|---|---|`);
    I.groups.forEach(g => o.push(`| ${g.name} | ${g.values.length} | ${f(g.mean, 4)} | ${f(g.rsd, 2)} |`));
    o.push(`\n- 일원분산분석: 반복성 RSD ${f(I.anova.rsdr, 2)}%, **실험실 내 정밀성 RSD ${f(I.anova.rsdIP, 2)}%**, 조건 간 F = ${f(I.anova.F, 2)} (p = ${f(I.anova.p, 3)}), 조건 평균 최대 차이 ${f(I.spread, 2)}%`);
    if (I.judge.hr !== undefined) o.push(`- Horrat = ${f(I.judge.hr, 2)} → ${I.judge.verdict}`);
    o.push("");
  }
  const LL = r.lodloq;
  if (LL) { o.push(`## 검출한계 / 정량한계`); o.push(`- 방법: ${LL.method}`); o.push(`- LOD = ${f(LL.lod, 4)} ${LL.unit}, LOQ = ${f(LL.loq, 4)} ${LL.unit}\n`); }
  const RB = r.robustness;
  if (RB) {
    o.push(`## 완건성`);
    o.push(`| 변경 조건 | 결과 | 기준 조건 대비 차이 |\n|---|---|---|`);
    RB.rows.forEach(x => o.push(`| ${x.condition || "-"} | ${x.result ?? x.result_value ?? "-"} | ${x.diff !== undefined ? f(x.diff, 2) + "%" : "-"} |`));
    o.push("");
  }
  o.push(`## 결과 요약\n| 항목 | 기준 | 결과 | 판정 |\n|---|---|---|---|`);
  r.summary.forEach(s => o.push(`| ${s.item} | ${s.criterion} | ${s.result} | ${s.verdict === V.FAIL ? "**부적합**" : s.verdict} |`));
  o.push(`\n**종합 판정: ${r.overall}**\n`);
  if (r.warnings.length) { o.push(`## 검토 필요 사항`); r.warnings.forEach(w => o.push(`- ${w}`)); }
  return o.join("\n");
}

// ───────────────────────── HTML 보고서 ─────────────────────────
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 1·2·5 단위의 보기 좋은 눈금
function niceTicks(lo, hi, target = 5) {
  if (!(hi > lo)) { const d = Math.abs(lo) || 1; lo -= d * 0.1; hi += d * 0.1; }
  const raw = (hi - lo) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const start = Math.ceil(lo / step - 1e-9) * step;
  const out = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step / mag === 2.5 ? 1 : 0));
  return { ticks: out, dec };
}

function svgScatter({ xs: xs0, ys: ys0, line, w = 520, h = 300, xLabel, yLabel, zeroLine = false }) {
  // 그릴 수 없는 점(NaN, 예: 0 농도의 잔차%)은 제외
  const keep = xs0.map((x, i) => isNum(x) && isNum(ys0[i]));
  const xs = xs0.filter((_, i) => keep[i]), ys = ys0.filter((_, i) => keep[i]);
  if (!xs.length) return `<p class="small">(그래프로 표시할 점 없음)</p>`;
  const pad = { l: 78, r: 16, t: 14, b: 44 };
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (zeroLine) { const a = Math.max(Math.abs(ymin), Math.abs(ymax)) || 1; ymin = -a * 1.25; ymax = a * 1.25; }
  else { const span = ymax - ymin || 1; ymin -= span * 0.08; ymax += span * 0.08; }
  const xspan = xmax - xmin || 1;
  const x0 = xmin - xspan * 0.06, x1 = xmax + xspan * 0.06;
  const X = v => pad.l + ((v - x0) / (x1 - x0)) * (w - pad.l - pad.r);
  const Y = v => h - pad.b - ((v - ymin) / (ymax - ymin)) * (h - pad.t - pad.b);
  const fmt = (v, dec) => Number(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">`;
  const yt = niceTicks(ymin, ymax), xt = niceTicks(x0, x1);
  yt.ticks.forEach(t => { s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${pad.l - 6}" y="${Y(t) + 4}" text-anchor="end" class="tick">${fmt(t, yt.dec)}</text>`; });
  xt.ticks.forEach(t => { s += `<text x="${X(t)}" y="${h - pad.b + 16}" text-anchor="middle" class="tick">${fmt(t, xt.dec)}</text>`; });
  s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${h - pad.b}" y2="${h - pad.b}" class="axis"/><line x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${h - pad.b}" class="axis"/>`;
  if (zeroLine) s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/>`;
  if (line) { const [a, b] = [xmin, xmax]; s += `<line x1="${X(a)}" y1="${Y(line.slope * a + line.intercept)}" x2="${X(b)}" y2="${Y(line.slope * b + line.intercept)}" class="fit"/>`; }
  xs.forEach((v, i) => { s += `<circle cx="${X(v)}" cy="${Y(ys[i])}" r="4" class="pt"/>`; });
  s += `<text x="${(pad.l + w - pad.r) / 2}" y="${h - 6}" text-anchor="middle" class="lab">${esc(xLabel)}</text>`;
  s += `<text transform="translate(14 ${(pad.t + h - pad.b) / 2}) rotate(-90)" text-anchor="middle" class="lab">${esc(yLabel)}</text></svg>`;
  return s;
}

function table(head, rows) {
  return `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
const badge = v => `<span class="b ${v === V.PASS ? "ok" : v === V.FAIL ? "ng" : v === V.COND ? "cd" : "na"}">${esc(v)}</span>`;

function toHtml(r) {
  const m = r.meta, n = r.narrative, cu = m.conc_unit || "";
  const sec = [];
  let no = 0;
  const H = t => `<h3>3.${++no} ${esc(t)}</h3>`;
  if (r.system_suitability) {
    const ss = r.system_suitability;
    let h = H("시스템 적합성");
    if (ss.text) h += `<p>${esc(ss.text)}</p>`;
    if (ss.checks && ss.checks.length) h += table(["항목", "기준", "결과", "판정"], ss.checks.map(([l, c, v, ok]) => [esc(l), esc(c), esc(v), badge(ok ? V.PASS : V.FAIL)]));
    if (ss.note) h += `<p>${esc(ss.note)}</p>`;
    sec.push(h);
  }
  if (r.specificity) {
    const sp = r.specificity;
    let h = H("특이성");
    if (sp.text) h += `<p>${esc(sp.text)}</p>`;
    else h += `<ul>${sp.interference_pct !== undefined ? `<li>간섭: 총 피크면적 대비 ${esc(sp.interference_pct)}% (기준 ≤ ${esc(r.criteria.interference_max ?? "-")}%)</li>` : ""}${sp.peak_purity ? `<li>피크 순도: ${esc(sp.peak_purity)}</li>` : ""}${sp.resolution !== undefined ? `<li>분리도: ${esc(sp.resolution)}</li>` : ""}${sp.note ? `<li>${esc(sp.note)}</li>` : ""}</ul>`;
    sec.push(h);
  }
  const L = r.linearity;
  if (L) {
    let h = H("직선성");
    h += table([`농도 (${cu})`, `반응값 (${m.response_unit || ""})`, "계산값", "잔차(%)"], L.points.x.map((v, i) => [v, L.points.y[i], f(L.reg.fitted[i], 1), f(L.resPct[i], 2)]));
    h += `<p class="eq">y = ${f(L.reg.slope, 4)}x ${L.reg.intercept >= 0 ? "+" : "−"} ${f(Math.abs(L.reg.intercept), 4)} &nbsp; | &nbsp; r = ${f(L.reg.r, 5)}, r² = ${f(L.reg.r2, 5)}</p>`;
    h += `<div class="charts"><figure>${svgScatter({ xs: L.points.x, ys: L.points.y, line: L.reg, xLabel: `농도 (${cu})`, yLabel: m.response_unit || "반응값" })}<figcaption>그림 1. 검량선</figcaption></figure>`;
    h += `<figure>${svgScatter({ xs: L.points.x, ys: L.resPct, zeroLine: true, xLabel: `농도 (${cu})`, yLabel: "잔차 (%)" })}<figcaption>그림 2. 잔차 분포</figcaption></figure></div>`;
    sec.push(h);
  }
  const A = r.accuracy;
  if (A) {
    let h = H("정확성 (회수율)");
    h += table(["수준", "초기량", "첨가량", "측정량", "회수율(%)"], A.rows.map(a => [esc(a.level), a.initial || "-", a.added, a.found, f(a.rec, 2)]));
    h += table(["수준", "n", "평균 회수율(%)", "RSD(%)", "95% 신뢰구간"], [...A.levels.map(l => [esc(l.level), l.n, f(l.mean, 2), f(l.rsd, 2), Number.isNaN(l.ci) ? "-" : `${f(l.mean - l.ci, 2)} – ${f(l.mean + l.ci, 2)}`]),
      ["<b>전체</b>", A.overall.n, `<b>${f(A.overall.mean, 2)}</b>`, f(A.overall.rsd, 2), `${f(A.overall.mean - A.overall.ci, 2)} – ${f(A.overall.mean + A.overall.ci, 2)}`]]);
    if (A.range) h += `<p>기준: 평균 회수율 ${A.range[0]}–${A.range[1]}%</p>`;
    sec.push(h);
  }
  const P = r.repeatability, I = r.intermediate;
  if (P || I) {
    let h = H("정밀성");
    if (P) {
      h += `<h4>반복성</h4>` + table(["n", "평균", "SD", "RSD(%)", "95% 신뢰구간"], [[P.n, f(P.mean, 4), f(P.sd, 4), f(P.rsd, 2), `${f(P.mean - P.ci, 4)} – ${f(P.mean + P.ci, 4)}`]]);
      h += `<p class="small">측정값: ${P.values.map(esc).join(", ")}${P.ofLabel !== undefined ? ` · 표시 함량 대비 ${f(P.ofLabel, 1)}%` : ""}</p>`;
      if (P.judge.rsdr !== undefined) h += `<p class="small">수정 Horwitz RSDr = ${f(P.judge.rsdr, 2)}%, Horrat = ${f(P.judge.hr, 3)} (≤1 적합, 1–2 사유 기재 시 적합, &gt;2 부적합)</p>`;
      if (P.grubbs) h += `<p class="small">Grubbs 검정(α=0.05): G = ${f(P.grubbs.G, 3)}, 임계값 ${f(P.grubbs.Gcrit, 3)} → ${P.grubbs.outlier ? "<b>이상치 의심</b>" : "이상치 없음"}</p>`;
    }
    if (I) {
      h += `<h4>실험실 내 정밀성</h4>` + table(["조건", "n", "평균", "RSD(%)"], I.groups.map(g => [esc(g.name), g.values.length, f(g.mean, 4), f(g.rsd, 2)]));
      h += `<p class="small">일원분산분석: 반복성 RSD ${f(I.anova.rsdr, 2)}%, 실험실 내 정밀성 RSD <b>${f(I.anova.rsdIP, 2)}%</b>, F = ${f(I.anova.F, 2)} (p = ${f(I.anova.p, 3)})</p>`;
    }
    sec.push(h);
  }
  if (r.lodloq) { const x = r.lodloq; sec.push(H("검출한계 및 정량한계") + `<p>${esc(x.method)}: LOD = ${f(x.lod, 4)} ${esc(x.unit)}, LOQ = ${f(x.loq, 4)} ${esc(x.unit)}</p>`); }
  if (r.robustness) sec.push(H("완건성") + table(["변경 조건", "결과", "기준 조건 대비 차이"], r.robustness.rows.map(x => [esc(x.condition), esc(x.result ?? x.result_value ?? "-"), x.diff !== undefined ? f(x.diff, 2) + "%" : "-"])));

  const refFail = r.summary.filter(s => !s.scored && s.verdict === V.FAIL).map(s => s.item.replace(/ \(참고\)$/, ""));
  const conclusion = n.conclusion || (r.overall === V.PASS
    ? (refFail.length
        ? `판정 기준(${r.criteria.label})의 필수 항목이 모두 적합하므로, 본 시험법은 ${m.product || "해당 제품"} 중 ${m.analyte || "유효성분"}의 함량 측정에 적합한 것으로 판단한다. 다만 참고 항목(${refFail.join(", ")})이 일반 관행 기준에 미달하므로 원인을 확인할 필요가 있다.`
        : `모든 밸리데이션 항목이 판정 기준(${r.criteria.label})에 적합하므로, 본 시험법은 ${m.product || "해당 제품"} 중 ${m.analyte || "유효성분"}의 함량 측정에 적합한 것으로 판단한다.`)
    : `종합 판정: ${r.overall}. 부적합·조건부·누락 항목은 아래 검토 필요 사항을 참고하여 보완이 필요하다.`);

  const info = [["분석 대상", m.analyte], ["시료", m.product ? `${m.product}${m.formulation_type ? ` (${m.formulation_type})` : ""}` : ""], ["표시 함량", m.nominal_content_percent !== undefined ? `${m.nominal_content_percent}% w/w` : ""], ["목표 농도", m.target_conc !== undefined ? `${m.target_conc} ${cu}` : ""], ["장비 / 조건", [m.instrument, m.column, m.mobile_phase].filter(Boolean).join(", ")], ["시험법 번호", m.sop_no], ["시험자 / 일자", [m.analyst, m.date].filter(Boolean).join(" / ")], ["판정 기준", r.criteria.label]].filter(([, v]) => v);

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${esc(m.title || "시험법 밸리데이션 보고서")}</title><style>
@page{size:A4;margin:18mm 16mm}
body{font-family:"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;color:#1a1a1a;max-width:860px;margin:24px auto;padding:0 20px;font-size:13.5px;line-height:1.6}
h1{font-size:22px;text-align:center;margin:8px 0 18px}h2{font-size:16px;border-bottom:2px solid #333;padding-bottom:4px;margin-top:28px}h3{font-size:14.5px;margin:20px 0 6px}h4{font-size:13.5px;margin:12px 0 4px}
table{border-collapse:collapse;width:100%;margin:6px 0 10px}th,td{border:1px solid #999;padding:4px 8px;text-align:center}th{background:#eef0f3}
table.info td:first-child{background:#f5f6f8;width:22%;font-weight:600}table.info td{text-align:left}
.b{padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}.ok{background:#e3f4e8;color:#16632f}.ng{background:#fde4e4;color:#a11}.cd{background:#fff3d6;color:#8a5a00}.na{background:#eceff3;color:#555}
.charts{display:flex;gap:10px;flex-wrap:wrap}figure{flex:1;min-width:300px;margin:0}figcaption{text-align:center;font-size:12px;color:#555}
.chart{width:100%;height:auto}.grid{stroke:#e4e6ea}.axis{stroke:#333}.zero{stroke:#888;stroke-dasharray:4 3}.fit{stroke:#2b6cb0;stroke-width:1.6}.pt{fill:#d9480f}.tick{font-size:10px;fill:#555}.lab{font-size:11px;fill:#333}
.eq{text-align:center;font-family:Menlo,monospace}.small{font-size:12.5px;color:#333}.overall{font-size:15px;font-weight:700;margin:8px 0}
.sign td{height:56px;width:33%}.warn li{margin-bottom:3px}
@media print{body{margin:0;max-width:none}h2{break-after:avoid}figure,table{break-inside:avoid}}
</style></head><body>
<h1>${esc(m.title || "시험법 밸리데이션 보고서")}</h1>
<table class="info"><tbody>${info.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</tbody></table>
<h2>1. 목적</h2><p>${esc(n.purpose || `${m.product || "해당 제품"} 중 ${m.analyte || "유효성분"} 함량 시험법이 사용 목적에 적합함을 검증한다.`)}</p>
<h2>2. 시험 방법</h2><p>${esc(n.method_summary || "(전처리, 표준액 조제, 분석 조건을 기재)")}</p>
<h2>3. 밸리데이션 결과</h2>${sec.join("\n")}
<h2>4. 결과 요약</h2>${table(["항목", "기준", "결과", "판정"], r.summary.map(s => [esc(s.item), esc(s.criterion), esc(s.result), badge(s.verdict)]))}
<p class="overall">종합 판정: ${badge(r.overall)}</p>
<h2>5. 결론</h2><p>${esc(conclusion)}</p>
${r.warnings.length || r.errors.length ? `<h2>6. 검토 필요 사항</h2><ul class="warn">${r.errors.map(e => `<li><b>[입력 오류]</b> ${esc(e)}</li>`).join("")}${r.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
${n.notes ? `<p>${esc(n.notes)}</p>` : ""}
<table class="sign"><thead><tr><th>작성</th><th>검토</th><th>승인</th></tr></thead><tbody><tr><td>${esc(m.analyst || "")}</td><td>${esc(m.reviewer || "")}</td><td>${esc(m.approver || "")}</td></tr></tbody></table>
<p class="small" style="text-align:right;color:#777">회수율·RSD는 보고 자릿수 반올림 후, r·Horrat은 원값으로 판정 · method-validation-report</p>
</body></html>`;
}

// ───────────────────────── CLI ─────────────────────────
function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    console.log("사용법: node calc_validation.js <input.json> [--json] [--html <out.html>]");
    process.exit(args.length ? 0 : 1);
  }
  const input = args[0];
  let d;
  try { d = JSON.parse(fs.readFileSync(input, "utf8")); }
  catch (e) { console.error(`입력 파일을 읽을 수 없음: ${e.message}`); process.exit(2); }
  let r;
  try { r = run(d); }
  catch (e) { console.error(`오류: ${e.message}`); process.exit(2); }
  const hi = args.indexOf("--html");
  if (hi >= 0) {
    const out = args[hi + 1];
    if (!out) { console.error("--html 다음에 출력 파일 경로가 필요함"); process.exit(1); }
    fs.writeFileSync(out, toHtml(r));
    console.error(`HTML 보고서 저장: ${path.resolve(out)}`);
  }
  if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else console.log(toMarkdown(r));
  if (r.errors.length) process.exit(3);
}

if (require.main === module) main(process.argv);
module.exports = { run, toMarkdown, toHtml, resolveCriteria, sancoRecoveryRange, overallVerdict, num, round };
