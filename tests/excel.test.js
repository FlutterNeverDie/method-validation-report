// 엑셀 입출력 테스트 — 실행: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { readXlsx, writeXlsx, zip, unzip } = require("../scripts/lib/xlsx");
const X = require("../scripts/excel_to_json");
const { buildSheets } = require("../scripts/make_excel_template");
const { run } = require("../scripts/calc_validation");

const ROOT = path.join(__dirname, "..");
const TPL_JSON = path.join(ROOT, "templates", "input_template.json");
const TPL_XLSX = path.join(ROOT, "templates", "input_template.xlsx");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mvr-"));
const node = (...a) => spawnSync(process.execPath, a, { cwd: ROOT, encoding: "utf8" });
const clean = o => {   // 빈 문자열·빈 객체 제거 (엑셀에서는 빈칸)
  if (Array.isArray(o)) return o.map(clean);
  if (o && typeof o === "object") {
    const r = {};
    for (const [k, v] of Object.entries(o)) { const c = clean(v); if (c === "" || (c && typeof c === "object" && !Array.isArray(c) && !Object.keys(c).length)) continue; r[k] = c; }
    return r;
  }
  return o;
};

test("저장소의 엑셀 양식이 생성기 출력과 같음 (양식 갱신 누락 방지)", () => {
  const p = path.join(tmp, "gen.xlsx");
  writeXlsx(p, buildSheets(JSON.parse(fs.readFileSync(TPL_JSON, "utf8"))));
  assert.ok(fs.readFileSync(p).equals(fs.readFileSync(TPL_XLSX)), "templates/input_template.xlsx 를 make_excel_template.js 로 다시 생성하세요");
});

test("JSON → 엑셀 양식 → JSON 왕복 일치", () => {
  const d = X.fromWorkbook(readXlsx(TPL_XLSX));
  assert.deepEqual(clean(d), clean(JSON.parse(fs.readFileSync(TPL_JSON, "utf8"))));
});

test("엑셀 양식 직접 입력 → JSON 입력과 같은 계산 결과", () => {
  const a = JSON.parse(node("scripts/calc_validation.js", TPL_XLSX, "--json").stdout);
  const b = JSON.parse(node("scripts/calc_validation.js", TPL_JSON, "--json").stdout);
  assert.equal(a.overall, b.overall);
  assert.deepEqual(a.summary, b.summary);
});

test("빈 양식 → 크래시 없이 '미완료'", () => {
  const p = path.join(tmp, "blank.xlsx");
  writeXlsx(p, buildSheets(null));
  const d = X.fromWorkbook(readXlsx(p));
  const r = run(d);
  assert.match(r.overall, /미완료/);
});

test("엑셀 오류값(#DIV/0!) → 경고 + 입력 오류", () => {
  const sheets = buildSheets(JSON.parse(fs.readFileSync(TPL_JSON, "utf8")));
  const rep = sheets.find(s => s.name === "반복성");
  const p = path.join(tmp, "err.xlsx");
  writeXlsx(p, sheets);
  // 반복성 A3 셀을 오류값으로 바꾼 xlsx 를 직접 조립
  const z = unzip(fs.readFileSync(p));
  const idx = sheets.indexOf(rep) + 1;
  const names = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", ...sheets.map((_, i) => `xl/worksheets/sheet${i + 1}.xml`)];
  const files = names.map(n => ({ name: n, data: z.text(n) }));
  const f = files.find(x => x.name === `xl/worksheets/sheet${idx}.xml`);
  f.data = f.data.replace(/<c r="A3"[^>]*>[\s\S]*?<\/c>/, '<c r="A3" t="e"><f>1/0</f><v>#DIV/0!</v></c>');
  fs.writeFileSync(p, zip(files));
  const d = X.fromWorkbook(readXlsx(p));
  assert.ok(d.import_warnings.some(w => w.includes("#DIV/0!") && w.includes("A3")));
  const r = run(d);
  assert.equal(r.overall, "입력 오류");
  assert.ok(r.warnings.some(w => w.includes("#DIV/0!")));
});

test("공유 문자열의 윗주(rPh) 제외, 엔티티·이모지 복원, 계산값 없는 수식 표시", () => {
  const files = [
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/workbook.xml", data: '<workbook xmlns:r="r"><sheets><sheet name="S&amp;1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/a.xml"/></Relationships>' },
    { name: "xl/sharedStrings.xml", data: '<sst><si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si><si><r><t>A&amp;</t></r><r><t xml:space="preserve"> B &#x1F600;</t></r></si><si/></sst>' },
    { name: "xl/worksheets/a.xml", data: '<worksheet><sheetData><row r="2"><c r="B2" t="s"><v>0</v></c><c r="D2" t="s"><v>1</v></c><c r="E2"><f>A1*2</f></c><c r="F2" t="b"><v>1</v></c><c r="G2"><v>1.5E-3</v></c><c r="H2" t="s"><v>2</v></c></row></sheetData></worksheet>' },
  ];
  const p = path.join(tmp, "rph.xlsx");
  fs.writeFileSync(p, zip(files));
  const [s] = readXlsx(p);
  assert.equal(s.name, "S&1");
  assert.equal(s.rows[1][1], "東京");
  assert.equal(s.rows[1][3], "A& B 😀");
  assert.deepEqual(s.rows[1][4], { error: "#NOCACHE" });
  assert.equal(s.rows[1][5], true);
  assert.equal(s.rows[1][6], 0.0015);
  assert.equal(s.rows[1][7], "");
});

test("양식이 아닌 엑셀: 계산은 종료코드 4, --dump 로 셀 주소와 값을 펼침", () => {
  const p = path.join(tmp, "raw.xlsx");
  writeXlsx(p, [{ name: "HPLC 결과", rows: [["Sample", "Area"], ["STD-1", 1002450], ["STD-2", 999800]] }]);
  assert.equal(node("scripts/calc_validation.js", p).status, 4);
  const out = node("scripts/excel_to_json.js", p, "--dump").stdout;
  assert.match(out, /시트: HPLC 결과/);
  assert.match(out, /\| 3 \| STD-2 \| 999800 \|/);
});

test(".xls 구형식·깨진 파일 → 친절한 오류 (크래시 아님)", () => {
  const xls = path.join(tmp, "old.xls");
  fs.writeFileSync(xls, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const r1 = node("scripts/calc_validation.js", xls);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /\.xlsx/);
  // 정상 양식을 무작위로 손상시켜도 Error 로만 끝나야 함
  const good = fs.readFileSync(TPL_XLSX);
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 300; i++) {
    const b = Buffer.from(good);
    const k = 1 + Math.floor(rnd() * 20);
    for (let j = 0; j < k; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    const cut = rnd() < 0.2 ? b.subarray(0, Math.floor(rnd() * b.length)) : b;
    try { const sh = readXlsx(cut); if (X.isTemplate(sh)) run(X.fromWorkbook(sh)); }
    catch (e) { assert.ok(e instanceof Error, String(e)); }
  }
});
