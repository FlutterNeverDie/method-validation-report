// 외부 의존성 없는 통계 함수 모음
"use strict";

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const rsd = a => {
  const m = mean(a);
  return m === 0 ? NaN : (sd(a) / Math.abs(m)) * 100;
};

// 최소제곱 직선회귀
function linreg(x, y) {
  const n = x.length;
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
    syy += (y[i] - my) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  const fitted = x.map(v => slope * v + intercept);
  const resid = y.map((v, i) => v - fitted[i]);
  const df = n - 2;
  const sres = df > 0 ? Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / df) : NaN;
  const sSlope = sres / Math.sqrt(sxx);
  const sIntercept = sres * Math.sqrt(1 / n + (mx * mx) / sxx);
  return { n, slope, intercept, r, r2: r * r, fitted, resid, sres, sSlope, sIntercept, df };
}

// ln Γ(x) — Lanczos
function lgamma(x) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// 정규화 불완전 베타 I_x(a,b) — 연분수(Lentz)
function betacf(x, a, b) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(x, a, b)) / a : 1 - (bt * betacf(1 - x, b, a)) / b;
}

// Student t 누적분포 P(T <= t)
function tcdf(t, df) {
  const x = df / (df + t * t);
  const p = 0.5 * ibeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - p : p;
}
// t 분위수 (이분법)
function tinv(p, df) {
  let lo = -1e4, hi = 1e4;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tcdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
// F 분포 상측 확률 P(F > f)
function fsf(f, d1, d2) {
  if (f <= 0) return 1;
  return ibeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
}

// 평균의 95% 신뢰구간 반폭
function ci95(a) {
  if (a.length < 2) return NaN;
  return tinv(0.975, a.length - 1) * sd(a) / Math.sqrt(a.length);
}

// Grubbs 검정 (양측, 최대 1개 이상치). 반환: {G, Gcrit, index, value, outlier}
function grubbs(a, alpha = 0.05) {
  const n = a.length;
  if (n < 3) return null;
  const m = mean(a), s = sd(a);
  if (!(s > 0)) return { G: 0, Gcrit: NaN, index: -1, value: NaN, outlier: false };
  let idx = 0;
  a.forEach((v, i) => { if (Math.abs(v - m) > Math.abs(a[idx] - m)) idx = i; });
  const G = Math.abs(a[idx] - m) / s;
  const t = tinv(1 - alpha / (2 * n), n - 2);
  const Gcrit = ((n - 1) / Math.sqrt(n)) * Math.sqrt((t * t) / (n - 2 + t * t));
  return { G, Gcrit, index: idx, value: a[idx], outlier: G > Gcrit };
}

// 일원분산분석 기반 중간정밀성 (ISO 5725 방식)
function anovaPrecision(groups) {
  const k = groups.length;
  const all = groups.flat();
  const N = all.length;
  const gm = mean(all);
  let ssw = 0, ssb = 0;
  groups.forEach(g => {
    const m = mean(g);
    ssb += g.length * (m - gm) ** 2;
    g.forEach(v => { ssw += (v - m) ** 2; });
  });
  const dfb = k - 1, dfw = N - k;
  const msb = ssb / dfb, msw = ssw / dfw;
  const n0 = (N - groups.reduce((s, g) => s + g.length ** 2, 0) / N) / (k - 1);
  const sL2 = Math.max(0, (msb - msw) / n0);
  const sr = Math.sqrt(msw);
  const sIP = Math.sqrt(msw + sL2);
  const F = msb / msw;
  return {
    k, N, grandMean: gm, sr, sL: Math.sqrt(sL2), sIP,
    rsdr: (sr / gm) * 100, rsdIP: (sIP / gm) * 100,
    F, p: msw > 0 ? fsf(F, dfb, dfw) : msb > 0 ? 0 : 1, dfb, dfw,
  };
}

// 수정 Horwitz (SANCO/3030/99 rev.5 App.2): %RSDr = 0.67 × 2^(1 − 0.5·log10 c), c = 질량분율(소수)
const horwitzRSDr = pctWW => 0.67 * Math.pow(2, 1 - 0.5 * Math.log10(pctWW / 100));

module.exports = { mean, sd, rsd, linreg, lgamma, ibeta, tcdf, tinv, fsf, ci95, grubbs, anovaPrecision, horwitzRSDr };
