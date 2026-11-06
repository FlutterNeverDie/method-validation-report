"""엑셀 입출력 교차 검증 — 독립 라이브러리(openpyxl, python-calamine)와 비교.

실행: uv run --no-project --with openpyxl --with python-calamine python -I tests/verify/xlsx_crosscheck.py

1) 이 저장소가 만든 양식(.xlsx)을 openpyxl·calamine 으로 열어 셀 값이 같은지
2) openpyxl 로 '다른 프로그램이 만든 것 같은' 엑셀(공유 문자열, 수식 아님, 숫자 문자열, 빈 행)을
   만들어 이 저장소 리더로 읽고 계산 결과가 JSON 입력과 같은지
3) 무작위 셀 값 2000개를 openpyxl 로 써서 이 저장소 리더가 똑같이 읽는지
"""
import json, os, subprocess, sys, tempfile, random
import openpyxl
from python_calamine import CalamineWorkbook

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
TMP = tempfile.mkdtemp()
fails = []

def node(code, *args):
    return subprocess.run(["node", "-e", code, *args], capture_output=True, text=True, check=True, cwd=ROOT).stdout

def ours_read(path):
    return json.loads(node('const {readXlsx}=require("./scripts/lib/xlsx");'
                           'const s=readXlsx(process.argv[1]);'
                           'process.stdout.write(JSON.stringify(s.map(x=>({name:x.name,rows:x.rows}))))', path))

def norm(v):
    if v is None or v == "": return None
    if isinstance(v, float) and v.is_integer(): return int(v)
    return v

# 1) 우리 양식 → openpyxl / calamine
tpl = os.path.join(TMP, "tpl.xlsx")
subprocess.run(["node", "scripts/make_excel_template.js", tpl], cwd=ROOT, check=True, capture_output=True)
ours = {s["name"]: s["rows"] for s in ours_read(tpl)}
wb = openpyxl.load_workbook(tpl)
cal = CalamineWorkbook.from_path(tpl)
assert wb.sheetnames == list(ours.keys()) == cal.sheet_names, (wb.sheetnames, list(ours.keys()), cal.sheet_names)
ncell = 0
for name in wb.sheetnames:
    ws = wb[name]
    crow = cal.get_sheet_by_name(name).to_python(skip_empty_area=False)
    for r, row in enumerate(ws.iter_rows(values_only=True)):
        for c, v in enumerate(row):
            o = ours[name][r][c] if r < len(ours[name]) and c < len(ours[name][r]) else None
            k = crow[r][c] if r < len(crow) and c < len(crow[r]) else None
            if not (norm(v) == norm(o) == norm(k)):
                fails.append(("양식 셀 불일치", name, r + 1, c + 1, v, o, k))
            ncell += 1
print(f"[1] 양식 {len(wb.sheetnames)}개 시트, {ncell}칸: openpyxl·calamine·우리 리더 비교")

# 2) openpyxl 로 만든 채워진 통합문서 → 우리 변환기 → 계산 → JSON 입력 계산과 비교
src = json.load(open(os.path.join(ROOT, "templates", "input_template.json")))
wb2 = openpyxl.load_workbook(tpl)          # 양식 구조 그대로, openpyxl 이 다시 저장(공유 문자열 방식)
ws = wb2["반복성"]
for r in range(2, 20): ws.cell(r, 1).value = None
vals = [5.02, "4.98", 5.01, " 4.97 ", 5.03, 5.00]   # 숫자 + 숫자 문자열 혼합
for i, v in enumerate(vals): ws.cell(i + 2, 1).value = v
ws.insert_rows(4)                          # 중간 빈 행
filled = os.path.join(TMP, "filled_by_openpyxl.xlsx")
wb2.save(filled)
res_x = json.loads(subprocess.run(["node", "scripts/calc_validation.js", filled, "--json"], cwd=ROOT, capture_output=True, text=True).stdout)
src_path = os.path.join(TMP, "src.json"); json.dump(src, open(src_path, "w"), ensure_ascii=False)
res_j = json.loads(subprocess.run(["node", "scripts/calc_validation.js", src_path, "--json"], cwd=ROOT, capture_output=True, text=True).stdout)
for key in ["overall"]:
    if res_x[key] != res_j[key]: fails.append(("종합판정 불일치", res_x[key], res_j[key]))
pairs = [("linearity.reg.r", lambda r: r["linearity"]["reg"]["r"]), ("accuracy.mean", lambda r: r["accuracy"]["overall"]["mean"]),
         ("repeat.rsd", lambda r: r["repeatability"]["rsd"]), ("ip.rsd", lambda r: r["intermediate"]["anova"]["rsdIP"])]
for n, g in pairs:
    if abs(g(res_x) - g(res_j)) > 1e-12: fails.append(("계산 불일치", n, g(res_x), g(res_j)))
if res_x["errors"]: fails.append(("엑셀 입력 오류", res_x["errors"]))
print(f"[2] openpyxl 저장 파일 → 계산: 종합 '{res_x['overall']}' (JSON 입력: '{res_j['overall']}')")

# 3) 무작위 셀 값 왕복
rnd = random.Random(7)
wb3 = openpyxl.Workbook(); ws3 = wb3.active; ws3.title = "랜덤 시트&<>"
expect = {}
pool = ["가나다", "A&B <tag>", 'quote"s', "줄\n바꿈", "  공백  ", "µg/mL", "°C ±2", "😀", "=문자", "#DIV/0! 문자"]
for _ in range(2000):
    r, c = rnd.randint(1, 120), rnd.randint(1, 40)
    k = rnd.random()
    v = rnd.uniform(-1e6, 1e6) if k < .4 else rnd.randint(-10**9, 10**9) if k < .55 else rnd.choice(pool) if k < .9 else (rnd.random() < .5)
    ws3.cell(r, c).value = v
    expect[(r, c)] = v
rand = os.path.join(TMP, "rand.xlsx"); wb3.save(rand)
got = ours_read(rand)[0]
if got["name"] != "랜덤 시트&<>": fails.append(("시트명", got["name"]))
bad = 0
for (r, c), v in expect.items():
    o = got["rows"][r - 1][c - 1] if r - 1 < len(got["rows"]) and c - 1 < len(got["rows"][r - 1]) else None
    if isinstance(v, str) and v.startswith("="): ok = o == {"error": "#NOCACHE"}   # openpyxl 은 '=…' 를 계산값 없는 수식으로 저장
    elif isinstance(v, float): ok = isinstance(o, (int, float)) and abs(o - v) <= abs(v) * 1e-15
    else: ok = o == v
    if not ok:
        bad += 1
        if bad <= 5: fails.append(("랜덤 셀", r, c, repr(v), repr(o)))
print(f"[3] 무작위 셀 {len(expect)}개 왕복: 불일치 {bad}")

print(f"실패 {len(fails)}건")
for f in fails[:20]: print("  ", f)
sys.exit(1 if fails else 0)
