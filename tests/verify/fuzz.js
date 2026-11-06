// 사용법: node tests/verify/fuzz.js [건수]
// 무작위로 망가뜨린 입력 → 크래시·출력 오염·판정 불변식 위반 검사
const path = require("path");
const SK = path.join(__dirname, "..", "..");
const { run, toMarkdown, toHtml } = require(SK + "/scripts/calc_validation.js");
const tpl = require(SK + "/templates/input_template.json");

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = a => a[Math.floor(rnd() * a.length)];
const junk = () => pick([null, undefined, "", "abc", "5,02", "1,002,450", "<0.1", "5%", -1, 0, 1e308, -0, [], {}, [null], { a: 1 }, true, "  7.5 ", "1e3", NaN, Infinity, [1], [1, 2], ["x", 2]]);

function mutate(o, depth = 0) {
  if (Array.isArray(o)) {
    let a = o.map(v => (rnd() < 0.15 ? junk() : mutate(v, depth + 1)));
    if (rnd() < 0.05) a = [];
    if (rnd() < 0.1) a = a.slice(0, Math.floor(rnd() * a.length));
    return a;
  }
  if (o && typeof o === "object") {
    const r = {};
    for (const [k, v] of Object.entries(o)) {
      const x = rnd();
      if (x < 0.06) continue;                 // 키 삭제
      r[k] = x < 0.14 ? junk() : mutate(v, depth + 1);
    }
    return r;
  }
  if (typeof o === "number" && rnd() < 0.1) return o * pick([-1, 0, 10, 0.001, 100]);
  return o;
}

const bad = { crash: 0, dirty: 0, invariant: 0 };
const examples = [];
const N = +process.argv[2] || 20000;
for (let i = 0; i < N; i++) {
  const d = mutate(JSON.parse(JSON.stringify(tpl)));
  if (rnd() < 0.2 && d.criteria) d.criteria = { preset: pick(["ich", "sanco3030", "inhouse", "custom"]), custom: rnd() < 0.5 ? {} : { rsd_max: 2, ss_tailing_max: 2 } };
  let r, md, html;
  try { r = run(d); md = toMarkdown(r); html = toHtml(r); }
  catch (e) {
    if (/criteria\.preset/.test(e.message)) continue;   // 잘못된 preset 은 의도된 오류
    bad.crash++; if (examples.length < 8) examples.push(["crash", e.stack.split("\n").slice(0, 3).join(" | "), JSON.stringify(d).slice(0, 300)]); continue;
  }
  // 출력 오염: undefined / NaN / [object Object] / Infinity
  const strip = s => s.replace(/<style>[\s\S]*?<\/style>/, "");
  const dirty = [md, strip(html)].some(s => /undefined|\bNaN\b|\[object Object\]|Infinity/.test(s));
  if (dirty) { bad.dirty++; if (examples.length < 8) { const s = [md, strip(html)].join("\n"); const m = s.match(/.{0,80}(undefined|\bNaN\b|\[object Object\]|Infinity).{0,40}/); examples.push(["dirty", m && m[0]]); } }
  // 불변식: 종합 '적합'이면 오류 0, 필수 항목 모두 적합/조건부X, 반영 항목 부적합 없음
  if (r.overall === "적합") {
    const v = r.errors.length || r.summary.some(s => (s.required && s.verdict !== "적합") || (s.scored && (s.verdict === "부적합" || s.verdict === "조건부 적합")))
      || !["특이성", "직선성", "정확성", "반복성"].every(k => r.summary.some(s => s.item.startsWith(k) && s.verdict === "적합"));
    if (v) { bad.invariant++; if (examples.length < 8) examples.push(["invariant", JSON.stringify(r.summary.map(s => [s.item, s.verdict]))]); }
  }
  if (r.errors.length && r.overall !== "입력 오류") { bad.invariant++; if (examples.length < 8) examples.push(["invariant-err", r.overall]); }
}
console.log(`퍼징 ${N}건 → 크래시 ${bad.crash}, 출력 오염 ${bad.dirty}, 판정 불변식 위반 ${bad.invariant}`);
examples.forEach(e => console.log("  ", e.join(" :: ")));
process.exit(bad.crash + bad.dirty + bad.invariant ? 1 : 0);
