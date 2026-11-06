#!/usr/bin/env node
// 엑셀 → 입력 JSON 변환
//   node excel_to_json.js 파일.xlsx              → 입력 양식(템플릿)을 채운 파일을 입력 JSON으로 (stdout)
//   node excel_to_json.js 파일.xlsx -o out.json  → 파일로 저장
//   node excel_to_json.js 파일.xlsx --dump        → 아무 엑셀이나 시트별 표(셀 주소 포함)로 펼쳐 보기
"use strict";
const fs = require("fs");
const { readXlsx, colName } = require("./lib/xlsx");

// ───────── 양식 정의 (양식 생성기와 공유) ─────────
// kv: A열=항목, B열=설명, C열부터=값 (값이 여러 칸이면 배열)
const KV = {
  기본정보: [
    ["제목", "meta.title", "보고서 제목"],
    ["분석 대상", "meta.analyte", "유효성분명 (CAS 번호)"],
    ["제품", "meta.product", "제품명 또는 코드명"],
    ["제형", "meta.formulation_type", "예: SL(액제), EC(유제), WP(수화제)"],
    ["표시 함량 (% w/w)", "meta.nominal_content_percent", "필수. 숫자만 (예: 5)"],
    ["함량 값 단위", "meta.content_unit", "반복성·정밀성 값의 단위. 기본 % w/w (그 외: g/kg, % of label)"],
    ["목표 농도", "meta.target_conc", "시험액 중 목표 농도 (직선성 ±20% 판정)"],
    ["농도 단위", "meta.conc_unit", "예: µg/mL"],
    ["반응값 단위", "meta.response_unit", "예: peak area"],
    ["장비", "meta.instrument", "예: HPLC-UV, 220 nm"],
    ["컬럼", "meta.column", ""],
    ["이동상", "meta.mobile_phase", ""],
    ["시험법 번호", "meta.sop_no", ""],
    ["시험자", "meta.analyst", ""],
    ["검토자", "meta.reviewer", ""],
    ["승인자", "meta.approver", ""],
    ["일자", "meta.date", "예: 2026-11-06"],
    ["판정 기준", "criteria.preset", "inhouse(연구자 기준, 기본) / sanco3030 / ich / custom"],
    ["기준 근거 (선택)", "criteria.basis", "비우면 적용 수치로 자동 작성"],
    ["목적 (선택)", "narrative.purpose", "비우면 자동 작성"],
    ["시험 방법 요약", "narrative.method_summary", "전처리, 표준액 조제, 분석 조건"],
    ["결론 (선택)", "narrative.conclusion", "비우면 판정 결과로 자동 작성"],
    ["비고", "narrative.notes", ""],
  ],
  "기준(선택)": [
    ["r_min", "criteria.custom.r_min", "최소 상관계수 (예: 0.995)"],
    ["recovery_range", "criteria.custom.recovery_range", "평균 회수율 하한, 상한을 C·D열에 (예: 98 | 102)"],
    ["rsd_max", "criteria.custom.rsd_max", "정밀성 RSD 상한(%). 넣으면 Horrat 대신 RSD로 판정"],
    ["ss_area_rsd_max", "criteria.custom.ss_area_rsd_max", "시스템 적합성 면적 RSD 상한 (기본 2.0)"],
    ["ss_tailing_max", "criteria.custom.ss_tailing_max", "테일링 상한 (기본 2.0)"],
    ["ss_plates_min", "criteria.custom.ss_plates_min", "이론단수 하한 (기본 2000)"],
    ["ss_resolution_min", "criteria.custom.ss_resolution_min", "분리도 하한 (기본 2.0)"],
    ["robustness_max_diff", "criteria.custom.robustness_max_diff", "완건성 허용 차이 % (기본 2.0)"],
  ],
  시스템적합성: [
    ["반복 주입 면적", "system_suitability.area_values", "C열부터 오른쪽으로 5~6개"],
    ["테일링 계수", "system_suitability.tailing", ""],
    ["이론단수", "system_suitability.plates", ""],
    ["분리도", "system_suitability.resolution", ""],
    ["비고", "system_suitability.note", ""],
  ],
  특이성: [
    ["간섭 (%)", "specificity.interference_pct", "총 피크면적 대비 간섭 %. SANCO 기준 ≤ 3%"],
    ["시험자 판정", "specificity.pass", "적합 / 부적합 (ICH 기준일 때 필요)"],
    ["피크 순도", "specificity.peak_purity", "예: DAD purity angle < threshold"],
    ["분리도", "specificity.resolution", "인접 피크와의 분리도"],
    ["비고", "specificity.note", "blank·placebo·표준·시료 크로마토그램 비교 결과"],
  ],
  LOD_LOQ: [
    ["방법", "lod_loq.method", "calibration(검량선, 자동 계산) / sn(S/N) / input(직접 입력). 함량 시험이면 비워도 됨"],
    ["LOD", "lod_loq.lod", "sn·input일 때"],
    ["LOQ", "lod_loq.loq", "sn·input일 때"],
  ],
};
// table: 1행=머리글
const TABLES = {
  직선성: { header: ["농도", "반응값 1", "반응값 2", "반응값 3"], note: "한 행 = 독립 조제 1건. 같은 용액 반복 주입은 반응값 1·2·3 칸에 (평균 처리). 독립 조제 2회면 같은 농도로 행 2개." },
  정확성: { header: ["수준", "첨가량", "측정량", "초기량 (선택)"], note: "첨가량·측정량·초기량은 같은 단위. 초기량은 원래 들어 있던 양(표준첨가)일 때만." },
  반복성: { header: ["측정값"], note: "독립 칭량 결과(함량). SANCO 기준 5회 이상." },
  실험실내정밀성: { header: ["1일차_시험자A", "2일차_시험자B"], note: "1행에 조건 이름, 아래로 측정값. 조건 2개 이상(열 추가 가능)." },
  완건성: { header: ["변경 조건", "기준 조건 결과", "변경 조건 결과", "결과 (서술)"], note: "숫자 두 개를 넣으면 차이 % 자동 계산. 숫자가 없으면 서술만." },
};
const SHEET_ORDER = ["기본정보", "기준(선택)", "시스템적합성", "특이성", "직선성", "정확성", "반복성", "실험실내정밀성", "완건성", "LOD_LOQ"];

// ───────── 변환 ─────────
const norm = s => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const isBlank = v => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const cellVal = v => (v && typeof v === "object" && "error" in v ? v.error : typeof v === "string" ? v.trim() : v);

function setPath(obj, path, val) {
  const ks = path.split(".");
  let o = obj;
  ks.slice(0, -1).forEach(k => { o[k] = o[k] && typeof o[k] === "object" ? o[k] : {}; o = o[k]; });
  o[ks[ks.length - 1]] = val;
}
// 엑셀 날짜 일련번호 → YYYY-MM-DD
const serialToDate = n => new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);

// 표 시트의 폭: 1행 머리글이 처음 비는 열 전까지 (오른쪽 "작성 안내" 칸 제외)
function tableWidth(sh) {
  const h = sh.rows[0] || [];
  let w = 0;
  while (w < h.length && !isBlank(h[w])) w++;
  return w;
}

function isTemplate(sheets) {
  const names = sheets.map(s => s.name);
  return ["기본정보", "직선성", "정확성", "반복성"].filter(n => names.includes(n)).length >= 3;
}

function fromWorkbook(sheets) {
  const d = {};
  const warn = [];
  const byName = Object.fromEntries(sheets.map(s => [s.name, s]));
  // key-value 시트
  for (const [sheet, defs] of Object.entries(KV)) {
    const sh = byName[sheet];
    if (!sh) continue;
    const map = Object.fromEntries(defs.map(([label, path]) => [norm(label), path]));
    sh.rows.forEach((row, r) => {
      if (r === 0) return;                                         // 머리글
      const label = row[0];
      if (isBlank(label)) return;
      // 양식 배치: A=항목, B=설명, C열부터=값
      const vals = row.slice(2).map(cellVal).filter(v => !isBlank(v));
      const path = map[norm(label)];
      if (!path) { if (vals.length) warn.push(`엑셀 '${sheet}' 시트 ${r + 1}행: 알 수 없는 항목 '${label}' — 무시함`); return; }
      if (!vals.length) return;
      const multi = path === "system_suitability.area_values" || path === "criteria.custom.recovery_range";
      if (!multi && vals.length > 1) warn.push(`엑셀 '${sheet}' 시트 ${r + 1}행 '${label}': 값이 여러 칸 — 첫 값(${vals[0]})만 사용`);
      let v = multi ? vals : vals[0];
      if (path === "specificity.pass") v = /^(적합|pass|true|o|예|yes)$/i.test(String(v)) ? true : /^(부적합|fail|false|x|아니오|no)$/i.test(String(v)) ? false : v;
      if (path === "meta.date" && typeof v === "number" && v > 20000 && v < 80000) v = serialToDate(v);
      if (path === "criteria.preset") v = String(v).trim().toLowerCase();
      setPath(d, path, v);
    });
  }
  // 직선성: 농도 | 반응값...
  const lin = byName["직선성"];
  if (lin) {
    const rows = [];
    lin.rows.forEach((row, r) => {
      if (r === 0) return;
      const conc = cellVal(row[0]);
      const resp = row.slice(1, Math.max(2, tableWidth(lin))).map(cellVal).filter(v => !isBlank(v));
      if (isBlank(conc) && !resp.length) return;
      rows.push({ conc, response: resp.length === 1 ? resp[0] : resp });
    });
    if (rows.length) d.linearity = rows;
  }
  // 정확성: 수준 | 첨가량 | 측정량 | 초기량
  const acc = byName["정확성"];
  if (acc) {
    const rows = [];
    acc.rows.forEach((row, r) => {
      if (r === 0) return;
      const [level, added, found, initial] = [0, 1, 2, 3].map(i => cellVal(row[i]));
      if ([level, added, found, initial].every(isBlank)) return;
      const o = { level: isBlank(level) ? "-" : level, added, found };
      if (!isBlank(initial)) o.initial = initial;
      rows.push(o);
    });
    if (rows.length) d.accuracy = rows;
  }
  // 반복성: 1열
  const rep = byName["반복성"];
  if (rep) {
    const vals = rep.rows.slice(1).map(r => cellVal(r[0])).filter(v => !isBlank(v));
    if (vals.length) d.repeatability = vals;
  }
  // 실험실 내 정밀성: 1행 = 조건명, 아래 = 값
  const ip = byName["실험실내정밀성"];
  if (ip && ip.rows.length) {
    const head = (ip.rows[0] || []).slice(0, tableWidth(ip));
    const groups = {};
    head.forEach((h, c) => {
      if (isBlank(h)) return;
      const vals = ip.rows.slice(1).map(r => cellVal(r[c])).filter(v => !isBlank(v));
      if (vals.length) groups[String(h).trim()] = vals;
    });
    if (Object.keys(groups).length) d.intermediate_precision = groups;
  }
  // 완건성
  const rb = byName["완건성"];
  if (rb) {
    const rows = [];
    rb.rows.forEach((row, r) => {
      if (r === 0) return;
      const [condition, ref, val, text] = [0, 1, 2, 3].map(i => cellVal(row[i]));
      if ([condition, ref, val, text].every(isBlank)) return;
      const o = { condition: isBlank(condition) ? "-" : condition };
      if (!isBlank(ref)) o.reference_value = ref;
      if (!isBlank(val)) o.result_value = val;
      if (!isBlank(text)) o.result = text;
      rows.push(o);
    });
    if (rows.length) d.robustness = rows;
  }
  // 엑셀 오류값(#DIV/0! 등) 안내
  sheets.forEach(sh => sh.rows.forEach((row, r) => row.forEach((v, c) => {
    if (v && typeof v === "object" && "error" in v) warn.push(v.error === "#NOCACHE"
      ? `엑셀 '${sh.name}' ${colName(c)}${r + 1}: 수식 계산값이 저장되어 있지 않음 — 엑셀에서 파일을 열어 한 번 저장한 뒤 다시 시도`
      : `엑셀 '${sh.name}' ${colName(c)}${r + 1}: 오류값 ${v.error} — 수식 확인`);
  })));
  if (warn.length) d.import_warnings = warn;
  return d;
}

// 아무 엑셀이나 펼쳐 보기 (Claude가 항목을 매핑할 때 사용)
function dump(sheets, maxRows = 300) {
  const out = [];
  for (const sh of sheets) {
    const width = Math.max(0, ...sh.rows.map(r => r.length));
    const used = sh.rows.map((r, i) => [i, r]).filter(([, r]) => r.some(v => !isBlank(v)));
    out.push(`## 시트: ${sh.name} (${used.length}행 × ${width}열)`);
    if (!used.length) { out.push("(비어 있음)\n"); continue; }
    out.push(`| 행 | ${Array.from({ length: width }, (_, c) => colName(c)).join(" | ")} |`);
    out.push(`|---|${"---|".repeat(width)}`);
    used.slice(0, maxRows).forEach(([i, r]) => out.push(`| ${i + 1} | ${Array.from({ length: width }, (_, c) => { const v = cellVal(r[c]); return isBlank(v) ? "" : String(v).replace(/\|/g, "\\|").replace(/\n/g, " "); }).join(" | ")} |`));
    if (used.length > maxRows) out.push(`… (${used.length - maxRows}행 더 있음)`);
    out.push("");
  }
  return out.join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    console.log("사용법: node excel_to_json.js <파일.xlsx> [-o out.json] [--dump]");
    process.exit(args.length ? 0 : 1);
  }
  let sheets;
  try { sheets = readXlsx(args[0]); } catch (e) { console.error(`엑셀을 읽을 수 없음: ${e.message}`); process.exit(2); }
  if (args.includes("--dump")) { console.log(dump(sheets)); return; }
  if (!isTemplate(sheets)) {
    console.error("입력 양식(기본정보·직선성·정확성·반복성 시트)이 아님 — --dump 로 내용을 펼쳐 보고 항목을 매핑하세요.");
    process.exit(4);
  }
  const json = JSON.stringify(fromWorkbook(sheets), null, 2);
  const oi = args.indexOf("-o");
  if (oi >= 0 && args[oi + 1]) { fs.writeFileSync(args[oi + 1], json); console.error(`저장: ${args[oi + 1]}`); }
  else console.log(json);
}

if (require.main === module) main(process.argv);
module.exports = { KV, TABLES, SHEET_ORDER, fromWorkbook, isTemplate, dump, readXlsx };
