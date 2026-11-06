"""SciPy/NumPy 독립 구현과 교차 검증.

실행: uv run --no-project --with scipy --with numpy python -I tests/verify/crossval.py
"""
import json, subprocess, sys, os
import numpy as np
from scipy import stats

rng = np.random.default_rng(20261106)
HERE = os.path.dirname(os.path.abspath(__file__))
cases, ref = [], []

def horwitz(pct):
    return 0.67 * 2 ** (1 - 0.5 * np.log10(pct / 100))

# 1) 회귀 (1000건) — 농도 범위·잡음·점 수 무작위
for _ in range(1000):
    n = int(rng.integers(3, 15))
    x = np.sort(rng.uniform(0.01, 500, n)); x[0] = x[0] * rng.choice([0, 1])
    slope = 10 ** rng.uniform(-2, 5); icpt = rng.normal(0, slope * 5)
    y = slope * x + icpt + rng.normal(0, slope * 10 ** rng.uniform(-3, 1), n)
    lr = stats.linregress(x, y)
    resid = y - (lr.slope * x + lr.intercept)
    # linregress 의 stderr 는 sqrt(1-r^2) 식이라 r≈1 에서 부정확 → 잔차 기반 정확식 사용 (mpmath 50자리로 검증됨)
    sres = np.sqrt((resid ** 2).sum() / (n - 2)); sxx = ((x - x.mean()) ** 2).sum()
    sS = sres / np.sqrt(sxx); sI = sres * np.sqrt(1 / n + x.mean() ** 2 / sxx)
    t = lr.intercept / sI
    cases.append({"kind": "reg", "x": x.tolist(), "y": y.tolist()})
    ref.append({"slope": lr.slope, "intercept": lr.intercept, "r": lr.rvalue, "sSlope": sS,
                "sIntercept": sI, "sres": sres,
                "pInt": 2 * stats.t.sf(abs(t), n - 2)})

# 2) 분포 함수 (1000건)
for _ in range(1000):
    df = int(rng.integers(1, 200)); p = float(rng.uniform(0.001, 0.999))
    tv = float(rng.normal(0, 4)); d1 = int(rng.integers(1, 30)); d2 = int(rng.integers(1, 100)); f = float(rng.exponential(2))
    cases.append({"kind": "dist", "p": p, "df": df, "t": tv, "f": f, "d1": d1, "d2": d2})
    ref.append({"tinv": stats.t.ppf(p, df), "tcdf": stats.t.cdf(tv, df), "fsf": stats.f.sf(f, d1, d2)})

# 3) 기술통계·Grubbs (1000건)
for _ in range(1000):
    n = int(rng.integers(3, 30))
    v = rng.normal(rng.uniform(0.01, 100), rng.uniform(0.001, 2), n)
    if rng.random() < 0.3: v[0] += rng.uniform(3, 8) * v.std()
    m, s = v.mean(), v.std(ddof=1)
    G = np.max(np.abs(v - m)) / s
    tt = stats.t.ppf(1 - 0.05 / (2 * n), n - 2)
    Gc = (n - 1) / np.sqrt(n) * np.sqrt(tt ** 2 / (n - 2 + tt ** 2))
    cases.append({"kind": "desc", "v": v.tolist()})
    ref.append({"mean": m, "sd": s, "rsd": s / abs(m) * 100, "ci": stats.t.ppf(0.975, n - 1) * s / np.sqrt(n), "G": G, "Gcrit": Gc})

# 4) 일원분산분석 정밀성 (1000건, 불균형 포함)
for _ in range(1000):
    k = int(rng.integers(2, 6))
    groups = [rng.normal(5 + rng.normal(0, 0.05), rng.uniform(0.005, 0.1), int(rng.integers(2, 8))) for _ in range(k)]
    F, p = stats.f_oneway(*groups)
    N = sum(len(g) for g in groups); gm = np.concatenate(groups).mean()
    msw = sum(((g - g.mean()) ** 2).sum() for g in groups) / (N - k)
    msb = sum(len(g) * (g.mean() - gm) ** 2 for g in groups) / (k - 1)
    n0 = (N - sum(len(g) ** 2 for g in groups) / N) / (k - 1)
    sL2 = max(0, (msb - msw) / n0)
    cases.append({"kind": "anova", "groups": [g.tolist() for g in groups]})
    ref.append({"F": F, "p": p, "sr": np.sqrt(msw), "sIP": np.sqrt(msw + sL2)})

# 5) 전체 파이프라인 (300건) — run() 결과를 독립 계산과 비교
tpl = json.load(open(os.path.join(HERE, "..", "..", "templates", "input_template.json")))
for _ in range(300):
    C = float(10 ** rng.uniform(-1.5, 1.9))
    d = json.loads(json.dumps(tpl)); d["meta"]["nominal_content_percent"] = C
    conc = [60, 80, 100, 120, 140]; sl = rng.uniform(100, 1e5)
    d["linearity"] = [{"conc": c, "response": float(sl * c + rng.normal(0, sl))} for c in conc]
    acc = [{"level": lv, "added": C * f, "found": float(C * f * rng.normal(1, 0.01))} for lv, f in [("90%", .9), ("100%", 1), ("110%", 1.1)] for _ in range(3)]
    d["accuracy"] = acc
    rep = rng.normal(C, C * rng.uniform(0.001, 0.03), 6); d["repeatability"] = rep.tolist()
    g1, g2 = rng.normal(C, C * 0.01, 6), rng.normal(C, C * 0.01, 6)
    d["intermediate_precision"] = {"a": g1.tolist(), "b": g2.tolist()}
    lr = stats.linregress(conc, [p["response"] for p in d["linearity"]])
    recs = np.array([a["found"] / a["added"] * 100 for a in acc])
    rsd = rep.std(ddof=1) / rep.mean() * 100
    gs = [g1, g2]; N = 12; gm = np.concatenate(gs).mean()
    msw = sum(((g - g.mean()) ** 2).sum() for g in gs) / (N - 2)
    msb = sum(6 * (g.mean() - gm) ** 2 for g in gs)
    sIP = np.sqrt(msw + max(0, (msb - msw) / 6))
    cases.append({"kind": "full", "input": d})
    ref.append({"slope": lr.slope, "r": lr.rvalue, "recMean": recs.mean(), "repRsd": rsd,
                "hr": rsd / horwitz(rep.mean()), "ipRsd": sIP / gm * 100})

import tempfile
path = os.path.join(tempfile.mkdtemp(), "cases.json")
json.dump(cases, open(path, "w"))
ours = json.loads(subprocess.run(["node", os.path.join(HERE, "ours.js"), path], capture_output=True, check=True, text=True).stdout)

worst, fails = {}, []
for i, (o, r) in enumerate(zip(ours, ref)):
    for k, rv in r.items():
        ov = o[k]
        rv = float(rv)
        if not np.isfinite(rv) and not (ov is None or not np.isfinite(ov)):
            fails.append((i, cases[i]["kind"], k, ov, rv)); continue
        if not np.isfinite(rv): continue
        rel = abs(ov - rv) / max(abs(rv), 1e-12)
        absd = abs(ov - rv)
        err = min(rel, absd if abs(rv) < 1e-6 else rel)
        key = f'{cases[i]["kind"]}.{k}'
        worst[key] = max(worst.get(key, 0), err)
        if err > 1e-8: fails.append((i, cases[i]["kind"], k, ov, rv))

print(f"케이스 {len(cases)}건, 비교 값 {sum(len(r) for r in ref)}개")
for k in sorted(worst): print(f"  {k:22s} 최대 상대오차 {worst[k]:.2e}")
print(f"허용오차(1e-8) 초과: {len(fails)}건")
for f in fails[:15]: print("  ", f)
sys.exit(1 if fails else 0)
