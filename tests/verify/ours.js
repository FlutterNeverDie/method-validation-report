// crossval.py 보조: 이 저장소 구현으로 케이스를 계산해 JSON 출력
const S = require("../../scripts/lib/stats.js");
const { run } = require("../../scripts/calc_validation.js");
const cases = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const out = cases.map(c => {
  const r = {};
  if (c.kind === "reg") {
    const g = S.linreg(c.x, c.y);
    Object.assign(r, { slope: g.slope, intercept: g.intercept, r: g.r, sSlope: g.sSlope, sIntercept: g.sIntercept, sres: g.sres });
    const t = g.intercept / g.sIntercept;
    r.pInt = 2 * (1 - S.tcdf(Math.abs(t), g.df));
  } else if (c.kind === "dist") {
    r.tinv = S.tinv(c.p, c.df);
    r.tcdf = S.tcdf(c.t, c.df);
    r.fsf = S.fsf(c.f, c.d1, c.d2);
  } else if (c.kind === "desc") {
    Object.assign(r, { mean: S.mean(c.v), sd: S.sd(c.v), rsd: S.rsd(c.v), ci: S.ci95(c.v) });
    const g = S.grubbs(c.v);
    r.G = g.G; r.Gcrit = g.Gcrit;
  } else if (c.kind === "anova") {
    const a = S.anovaPrecision(c.groups);
    Object.assign(r, { F: a.F, p: a.p, sr: a.sr, sIP: a.sIP });
  } else if (c.kind === "full") {
    const res = run(c.input);
    r.slope = res.linearity.reg.slope; r.r = res.linearity.reg.r;
    r.recMean = res.accuracy.overall.mean;
    r.repRsd = res.repeatability.rsd; r.hr = res.repeatability.judge.hr;
    r.ipRsd = res.intermediate.anova.rsdIP;
  }
  return r;
});
process.stdout.write(JSON.stringify(out));
