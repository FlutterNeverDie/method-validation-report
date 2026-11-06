#!/usr/bin/env node
// 엑셀 입력 양식 생성
//   node make_excel_template.js out.xlsx                 → 예시 값이 채워진 양식 (templates/input_template.json 기준)
//   node make_excel_template.js out.xlsx --blank         → 빈 양식
//   node make_excel_template.js out.xlsx --from in.json  → 기존 입력 JSON 내용을 양식으로 내보내기
"use strict";
const fs = require("fs");
const path = require("path");
const { writeXlsx } = require("./lib/xlsx");
const { KV, TABLES, SHEET_ORDER } = require("./excel_to_json");

const get = (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);

function buildSheets(d) {
  const sheets = [{
    name: "사용법",
    headerRows: 1,
    widths: [100],
    rows: [
      ["시험법 밸리데이션 입력 양식 (method-validation-report)"],
      ["1. 노란 칸에 값을 넣으세요. 시트 이름과 A열 항목명은 바꾸지 마세요."],
      ["2. '기본정보'의 표시 함량(% w/w)과 목표 농도는 판정에 꼭 필요합니다."],
      ["3. 소수점은 마침표(.)로 입력하세요. 5,02 (X) → 5.02 (O)"],
      ["4. 해당 없는 시트는 비워 두면 됩니다. 시스템적합성·완건성·LOD_LOQ·실험실내정밀성은 선택 항목입니다."],
      ["5. 수식을 써도 됩니다. 저장된 계산값을 읽습니다 (#DIV/0! 같은 오류값은 입력 오류로 안내됩니다)."],
      ["6. 직선성: 한 행 = 독립 조제 1건. 같은 용액을 여러 번 주입했으면 반응값 1·2·3 칸에 넣으세요."],
      ["7. 다 채운 뒤 Claude(또는 Gemini CLI)에게 이 파일을 주고 '밸리데이션 보고서 써줘'라고 하면 됩니다."],
      [""],
      ["직접 실행: node scripts/calc_validation.js 이파일.xlsx --html 보고서.html"],
    ],
  }];
  for (const name of SHEET_ORDER) {
    if (KV[name]) {
      const rows = [["항목", "설명", "값"]];
      const styles = {};
      KV[name].forEach(([label, p, note], i) => {
        let v = d ? get(d, p) : undefined;
        if (p === "specificity.pass" && typeof v === "boolean") v = v ? "적합" : "부적합";
        const vals = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
        const width = p === "system_suitability.area_values" ? 6 : p === "criteria.custom.recovery_range" ? 2 : 1;
        rows.push([label, note, ...vals]);
        for (let c = 0; c < Math.max(width, vals.length); c++) styles[`${i + 1},${2 + c}`] = "input";
        styles[`${i + 1},1`] = "note";
      });
      const nCols = name === "시스템적합성" ? 6 : name === "기준(선택)" ? 2 : 1;
      sheets.push({ name, rows, widths: [22, 48, ...Array(nCols).fill(name === "기본정보" ? 44 : 14)], styles, freeze: true });
    } else {
      const t = TABLES[name];
      let header = t.header.slice(), body = [];
      if (d) {
        if (name === "직선성" && Array.isArray(d.linearity)) {
          const maxInj = Math.max(1, ...d.linearity.map(p => (Array.isArray(p.response) ? p.response.length : 1)));
          header = ["농도", ...Array.from({ length: Math.max(3, maxInj) }, (_, i) => `반응값 ${i + 1}`)];
          body = d.linearity.map(p => [p.conc, ...(Array.isArray(p.response) ? p.response : [p.response])]);
        } else if (name === "정확성" && Array.isArray(d.accuracy)) {
          body = d.accuracy.map(a => [a.level, a.added, a.found, a.initial ?? ""]);
        } else if (name === "반복성" && Array.isArray(d.repeatability)) {
          body = d.repeatability.map(v => [v]);
        } else if (name === "실험실내정밀성" && d.intermediate_precision && typeof d.intermediate_precision === "object") {
          header = Object.keys(d.intermediate_precision);
          const cols = Object.values(d.intermediate_precision);
          const n = Math.max(0, ...cols.map(c => c.length));
          body = Array.from({ length: n }, (_, r) => cols.map(c => c[r] ?? ""));
        } else if (name === "완건성" && Array.isArray(d.robustness)) {
          body = d.robustness.map(x => [x.condition, x.reference_value ?? "", x.result_value ?? "", x.result ?? ""]);
        }
      }
      const blankRows = Math.max(0, (name === "반복성" ? 8 : name === "정확성" ? 12 : 10) - body.length);
      for (let i = 0; i < blankRows; i++) body.push([]);
      const rows = [header.slice(), ...body.map(r => r.slice())];   // 머리글 배열을 복사 (안내 칸 추가가 header 를 바꾸지 않게)
      const styles = {};
      for (let r = 1; r < rows.length; r++) for (let c = 0; c < header.length; c++) styles[`${r},${c}`] = "input";
      const noteCol = header.length + 1;
      rows[0][noteCol] = "작성 안내";
      rows[1] = rows[1] || [];
      rows[1][noteCol] = t.note;
      styles[`1,${noteCol}`] = "note";
      sheets.push({ name, rows, widths: [...header.map((h, i) => (name === "완건성" && (i === 0 || i === 3) ? 26 : 16)), 3, 60], styles, freeze: true });
    }
  }
  return sheets;
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args[0].startsWith("-")) { console.log("사용법: node make_excel_template.js <out.xlsx> [--blank | --from in.json]"); process.exit(1); }
  const out = args[0];
  let d = null;
  if (!args.includes("--blank")) {
    const fi = args.indexOf("--from");
    const src = fi >= 0 ? args[fi + 1] : path.join(__dirname, "..", "templates", "input_template.json");
    d = JSON.parse(fs.readFileSync(src, "utf8"));
  }
  writeXlsx(out, buildSheets(d));
  console.error(`엑셀 양식 저장: ${path.resolve(out)}`);
}

if (require.main === module) main(process.argv);
module.exports = { buildSheets };
