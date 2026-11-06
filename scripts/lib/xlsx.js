// 외부 의존성 없는 최소 xlsx 읽기/쓰기 (Node 내장 zlib 사용)
// 읽기: 셀 값(숫자·문자·불리언·오류)만. 수식 셀은 Excel이 저장한 계산값을 읽는다.
// 쓰기: inline string, 굵은 머리글, 열 너비, 틀 고정 정도만 지원.
"use strict";
const fs = require("fs");
const zlib = require("zlib");

// ───────── ZIP ─────────
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("xlsx(zip) 형식이 아님 — 엑셀 파일(.xlsx)인지 확인 (.xls 구형식은 엑셀에서 .xlsx로 다시 저장)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("손상된 xlsx (central directory)");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (csize === 0xffffffff || local === 0xffffffff) throw new Error("ZIP64 xlsx는 지원하지 않음 (파일이 너무 큼)");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error("손상된 xlsx (local header)");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    files[name] = { method, data };
  }
  return {
    has: n => n in files,
    text: n => {
      const f = files[n];
      if (!f) return null;
      if (f.method === 0) return f.data.toString("utf8");
      if (f.method === 8) return zlib.inflateRawSync(f.data).toString("utf8");
      throw new Error(`지원하지 않는 압축 방식 (${f.method})`);
    },
  };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries) {   // entries: [{name, data: Buffer|string}]
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const comp = zlib.deflateRawSync(raw);
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ───────── XML 헬퍼 ─────────
function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === "#") { const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(cp); } catch { return m; } }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e];
  });
}
const attr = (s, name) => { const m = s.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`)); return m ? decode(m[1]) : undefined; };
// <si>/<is> 안의 텍스트: <t> 들을 이어붙이되 일본어/한국어 엑셀의 윗주(<rPh>)는 제외
function richText(x) {
  const noPh = x.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  noPh.replace(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g, (_, t) => { out += t ? decode(t) : ""; return ""; });
  return out;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
const colName = i => { let s = ""; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

// ───────── 읽기 ─────────
// 반환: [{ name, rows: [[값|null, ...], ...] }]  — rows[r][c], 0부터. 오류 셀은 {error:"#DIV/0!"}
function readXlsx(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const z = unzip(buf);
  const wb = z.text("xl/workbook.xml");
  if (!wb) throw new Error("엑셀 통합문서가 아님 (xl/workbook.xml 없음)");
  const rels = {};
  (z.text("xl/_rels/workbook.xml.rels") || "").replace(/<Relationship\b([^>]*)\/?>/g, (_, a) => { rels[attr(a, "Id")] = attr(a, "Target"); return ""; });
  const shared = [];
  const ss = z.text("xl/sharedStrings.xml");
  if (ss) ss.replace(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g, (_, body) => { shared.push(body ? richText(body) : ""); return ""; });
  const sheets = [];
  wb.replace(/<sheet\b([^>]*?)\/?>/g, (_, a) => {
    const name = attr(a, "name");
    const rid = attr(a, "r:id") ?? (a.match(/\b[\w]+:id="([^"]*)"/) || [])[1];
    let target = rels[rid];
    if (!target) return "";
    target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    const xml = z.text(target);
    if (xml == null) return "";
    sheets.push({ name, rows: parseSheet(xml, shared) });
    return "";
  });
  return sheets;
}

function parseSheet(xml, shared) {
  const rows = [];
  let autoRow = 0;
  const data = (xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/) || [])[1] || "";
  data.replace(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, (_, ra, body) => {
    const r = attr(ra, "r") ? Number(attr(ra, "r")) - 1 : autoRow;
    autoRow = r + 1;
    if (!body) return "";
    const row = rows[r] || (rows[r] = []);
    let autoCol = 0;
    body.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (__, ca, cb) => {
      const ref = attr(ca, "r");
      const c = ref ? colIndex(ref) : autoCol;
      autoCol = c + 1;
      if (!cb) return "";
      const t = attr(ca, "t") || "n";
      const vm = cb.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      const v = vm ? decode(vm[1]) : undefined;
      let val = null;
      // 수식은 있는데 계산값이 저장되지 않은 셀 (엑셀이 아닌 프로그램이 만든 파일) → 빈칸으로 넘기지 않고 표시
      if (v === undefined && /<f\b/.test(cb) && t !== "inlineStr") { row[c] = { error: "#NOCACHE" }; return ""; }
      if (t === "s") val = v !== undefined ? (shared[Number(v)] ?? "") : null;
      else if (t === "inlineStr") { const im = cb.match(/<is\b[^>]*>([\s\S]*?)<\/is>/); val = im ? richText(im[1]) : ""; }
      else if (t === "str") val = v ?? "";
      else if (t === "b") val = v === "1";
      else if (t === "e") val = { error: v ?? "#ERROR" };
      else if (v !== undefined && v !== "") { const n = Number(v); val = Number.isFinite(n) ? n : v; }
      row[c] = val;
      return "";
    });
    return "";
  });
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

// ───────── 쓰기 ─────────
// sheets: [{ name, rows: [[값, ...]], widths?: [열너비...], headerRows?: 1, freeze?: true, styles?: {"r,c": "note"|"input"} }]
function writeXlsx(path, sheets) {
  const sheetXml = sh => {
    const hdr = sh.headerRows ?? 1;
    const cols = sh.widths ? `<cols>${sh.widths.map((w, i) => (Number.isFinite(w) && w > 0 ? `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>` : "")).join("")}</cols>` : "";
    const pane = sh.freeze && hdr ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${hdr}" topLeftCell="A${hdr + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
    // 스타일만 있고 값이 없는 칸(빈 입력칸)도 저장되도록 행별 최대 열을 스타일까지 포함해 계산
    const styledMax = {};
    for (const k of Object.keys(sh.styles || {})) { const [r, c] = k.split(",").map(Number); styledMax[r] = Math.max(styledMax[r] ?? -1, c); }
    const nRows = Math.max(sh.rows.length, ...Object.keys(styledMax).map(r => Number(r) + 1));
    const rows = Array.from({ length: nRows }, (_, r) => sh.rows[r] || []).map((row0, r) => {
      const row = Array.from({ length: Math.max(row0.length, (styledMax[r] ?? -1) + 1) }, (_, c) => row0[c]);
      const cells = row.map((v, c) => {
        if (v === null || v === undefined || v === "") {
          const st = sh.styles && sh.styles[`${r},${c}`];
          return st ? `<c r="${colName(c)}${r + 1}" s="${STYLE[st]}"/>` : "";
        }
        const ref = `${colName(c)}${r + 1}`;
        const s = r < hdr ? 1 : (sh.styles && STYLE[sh.styles[`${r},${c}`]]) || 0;
        if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
        if (typeof v === "boolean") return `<c r="${ref}" s="${s}" t="b"><v>${v ? 1 : 0}</v></c>`;
        return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rows}</sheetData></worksheet>`;
  };
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  fs.writeFileSync(path, zip(files));
}

// 스타일: 0 기본, 1 머리글(굵게·회색), 2 입력칸(연노랑), 3 설명(회색 글씨·줄바꿈)
const STYLE = { header: 1, input: 2, note: 3 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font><font><sz val="10"/><color rgb="FF666666"/><name val="맑은 고딕"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7EAEE"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF8DC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBBBBBB"/></left><right style="thin"><color rgb="FFBBBBBB"/></right><top style="thin"><color rgb="FFBBBBBB"/></top><bottom style="thin"><color rgb="FFBBBBBB"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

module.exports = { readXlsx, writeXlsx, colName, colIndex, crc32, unzip, zip };
