// ============================================================
//  range-eval.mjs — 估速「速度區間」與估計器的評估（手動執行，不進 CI，純 Node）
//
//  問題：playbackRate 要在「瘋狂快～瘋狂慢」的按法下都估得準、也不能被停手／變速騙到。這支工具用曲庫實際的樂譜（你的聲部起音）、
//  Weber 定律的噪聲模型與一組「轉換情境」，比較幾種追蹤器（估計器＋停手／變速閘門），指標是**對數域的相對誤差**
//  |ln(估到的速度 ÷ 真正的速度)|（不用毫秒：快慢差幾十倍時毫秒誤差沒有可比性）。
//
//  噪聲模型（Wing & Kristofferson 1973；廣義 Weber 定律）：每個按鍵時刻有與間隔無關的加性誤差 σ_a（動作／鍵盤，毫秒），每個間隔另有
//  與間隔成正比的對數常態誤差（Weber 比例 w，加上看譜起伏 0.15）。σ_a／w 預設 10ms／0.05，「重」＝20ms／0.10。
//
//  情境（r＝真正的速度倍率；g＝這首歌的典型起音間隔，I＝兩次按鍵的真實間隔，r ＝ g ÷ I）：
//    穩定 I＝10／3／1／0.3／0.12 秒 ｜ 連按轉極慢（0.11s×40 → 10s×20）｜ 極慢轉快（10s×15 → 0.3s×40）｜
//    彈到一半停手 6 秒（I＝0.4s，第 30 下前多停 6 秒，真正的速度不變）｜ 突然變 3× 快／慢（I＝1s ↔ 0.33s，第 30 下）｜ 漸變 ×10（I 由 0.1s 到 1s）
//  指標：穩定情境＝第 8 下之後的 |誤差| 中位／p90，與前 3 下的平均；轉換情境＝變化點之後 10 下的平均 |誤差|，與「連續 3 下 |誤差| < ln 1.25」
//  需要幾下（上限 30）。每個格子是各曲平均後的中位數。
//
//  追蹤器（update(scoreSec, ms) → 這一下之後估到的速度）：
//    現行    ：8 個間隔頭尾比值、夾在 [0.1, 4]、舊的停手規則（800ms／學到 3 個間隔／10 倍／連續兩次長空檔）
//    區間＋W8：8 個間隔頭尾比值、每首歌自己的區間、新閘門（見下）
//    區間＋WA：視窗依真實時間跨度自適應 N ＝ clamp(⌈4 秒 ÷ 平均間隔⌉, 3, 16)、新閘門
//    區間＋KF：對數域 Kalman（量測噪聲隨間隔變：R ＝ 2σ_a²/I² ＋ w² ＋ 看譜起伏²）、新閘門
//    區間＋TS：Theil–Sen（視窗內成對斜率的中位數，N 同 WA）、新閘門
//  新閘門：隱含速度 x ＝ Δ樂譜秒 ÷ Δ真實秒。x < 區間下緣（空檔超過 30 秒對應的長度）＝停手（歷史清掉、速度不變）；已學到速度（≥ 3 個間隔）
//  時 |ln(x ÷ 估計)| > ln 3 先不信（驚訝）——下一下的隱含速度若跟它差在 ×1.6 以內就兩下一起接受（真的變速，歷史從驚訝那一下重新開始），
//  否則（下一下回到原本的速度）當成停手／失誤。還沒學到速度時一律接受。
//
//  用法：node test/tools/range-eval.mjs [--songs=30]
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { estimatePlaybackRate, rateBoundsFor } from '../../src/midi/pressTiming.js';
import { rankedParts, driverSecs } from './sim.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const MAX_SONGS = Number(args.songs ?? 30);
const dirs = [join(ROOT, 'test/tools/library'), join(ROOT, 'src/assets')];
const files = dirs.filter(existsSync).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.mid')).map((f) => join(d, f)));

// ── 樂譜 ──
const songs = [];
for (const f of files) {
  const b = readFileSync(f);
  let s;
  try { s = parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { continue; }
  const rp = rankedParts(s);
  if (!rp.length) continue;
  const secs = driverSecs(s, [rp[0].id]);
  if (secs.length < 130) continue;
  const gaps = secs.slice(1).map((t, i) => t - secs[i]);
  const bounds = rateBoundsFor(gaps);
  const good = gaps.filter((g) => g >= 0.02).sort((a, c) => a - c);
  songs.push({ secs: secs.slice(0, 130), bounds, g: good[Math.floor((good.length - 1) / 2)] });
}
const step = Math.max(1, Math.floor(songs.length / MAX_SONGS));
const picked = songs.filter((_, i) => i % step === 0).slice(0, MAX_SONGS);
console.log(`曲數（起音 ≥ 130 個）：${songs.length}，取 ${picked.length} 首`);

const rng = (seed) => { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * 0.5)] : NaN);
const pct = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] : NaN);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const LN3 = Math.log(3), LN16 = Math.log(1.6), LN125 = Math.log(1.25);

// ── 追蹤器 ──
// 現行：照 scheduler.js 目前的 _isIdleBreak（800ms、學到 3 個間隔、未學到 10 倍、連續兩次長空檔），夾在 [0.1, 4]
function currentTracker() {
  const B = { lo: 0.1, hi: 4 };
  const st = { H: [], rate: 1, anchorRate: 1, last: null, afterIdle: false };
  return {
    update(s, t) {
      if (st.last) {
        const dT = (t - st.last.t) * 1000, P = ((s - st.last.s) / st.anchorRate) * 1000, stall = Math.max(0, dT - P);
        const learned = st.H.length - 1 >= 3;
        let idle = false;
        if (stall > 800) idle = learned ? true : st.afterIdle ? false : stall > 10 * P;
        st.afterIdle = idle;
        if (idle) st.H = [];
      }
      st.H.push({ scoreSec: s, ms: t * 1000 });
      st.rate = estimatePlaybackRate(st.H, st.rate, B);
      st.anchorRate = st.rate;
      st.last = { s, t };
      return st.rate;
    },
  };
}

function windowN(H) {
  const k = Math.min(H.length - 1, 16);
  const meanI = (H[H.length - 1].ms - H[H.length - 1 - k].ms) / k / 1000;
  return Math.min(16, Math.max(3, Math.ceil(4 / Math.max(meanI, 1e-3))));
}
const estimators = {
  W8: (H, rate, B) => estimatePlaybackRate(H, rate, B),
  WA: (H, rate, B) => {
    if (H.length < 2) return rate;
    const N = windowN(H), first = H[Math.max(0, H.length - 1 - N)], last = H[H.length - 1];
    return Math.min(B.hi, Math.max(B.lo, (last.scoreSec - first.scoreSec) / Math.max(1e-3, (last.ms - first.ms) / 1000)));
  },
  TS: (H, rate, B) => {
    if (H.length < 2) return rate;
    const N = windowN(H), w = H.slice(Math.max(0, H.length - 1 - N)), sl = [];
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) sl.push((w[j].scoreSec - w[i].scoreSec) / Math.max(1e-3, (w[j].ms - w[i].ms) / 1000));
    return Math.min(B.hi, Math.max(B.lo, median(sl)));
  },
};

// 新閘門＋指定的估計器（W8／WA／TS）或 Kalman（KF）
function gatedTracker(kind, B) {
  const st = { H: [], rate: 1, last: null, pending: null, x: 0, P: 0.5 };
  const P0 = 0.5, Q = 0.03 ** 2, SIG_A = 0.012, W = 0.06, RUB = 0.15;
  const kfUpdate = (dS, dT) => {
    const z = Math.log(Math.min(B.hi, Math.max(B.lo, dS / dT)));
    const R = (2 * SIG_A ** 2) / (dT * dT) + W * W + RUB * RUB;
    st.P += Q;
    const K = st.P / (st.P + R);
    st.x += K * (z - st.x);
    st.P *= 1 - K;
    st.rate = Math.min(B.hi, Math.max(B.lo, Math.exp(st.x)));
  };
  return {
    update(s, t) {
      const p = { scoreSec: s, ms: t * 1000 };
      if (!st.last) { st.last = { s, t }; st.H = [p]; return st.rate; }
      const dS = s - st.last.s, dT = Math.max(1e-3, t - st.last.t), x = dS / dT;
      const learned = st.H.length - 1 >= 3;
      const prev = st.last;
      st.last = { s, t };
      if (x < B.lo) { st.H = [p]; st.pending = null; return st.rate; }               // 空檔超過區間：停手
      if (learned && Math.abs(Math.log(x / st.rate)) > LN3) {
        if (st.pending && Math.abs(Math.log(x / st.pending.x)) < LN16) {             // 兩下一致的驚訝：真的變速
          st.H = [st.pending.p, p];
          st.pending = null;
          if (kind === 'KF') { st.P = P0; st.x = Math.log(Math.min(B.hi, Math.max(B.lo, x))); st.rate = Math.exp(st.x); return st.rate; }
        } else { st.pending = { x, p }; return st.rate; }                              // 先不信這一下
      } else {
        if (st.pending) { st.H = [st.pending.p]; st.pending = null; }                 // 上一下是停手／失誤：歷史從那一下重新開始
        st.H.push(p);
        if (kind === 'KF') { const lastH = st.H[st.H.length - 2]; if (lastH) kfUpdate(s - lastH.scoreSec, Math.max(1e-3, (p.ms - lastH.ms) / 1000)); return st.rate; }
      }
      if (kind !== 'KF') st.rate = estimators[kind](st.H, st.rate, B);
      return st.rate;
    },
  };
}

const trackers = {
  '現行（[0.1, 4]、舊閘門）': () => currentTracker(),
  '區間＋W8＋新閘門': (B) => gatedTracker('W8', B),
  '區間＋WA（自適應視窗）': (B) => gatedTracker('WA', B),
  '區間＋KF（對數 Kalman）': (B) => gatedTracker('KF', B),
  '區間＋TS（Theil–Sen）': (B) => gatedTracker('TS', B),
};

// ── 情境：seq(i, n) → { I: 第 i 個間隔的目標真實間隔（秒）, extra: 額外停頓（秒，不算在速度裡）}；change＝變化點 ──
const scenarios = [
  ...[10, 3, 1, 0.3, 0.12].map((I) => ({ name: `穩定 I＝${I}s`, n: 80, steady: true, seq: () => ({ I }) })),
  { name: '連按轉極慢（0.11s×40 → 10s×20）', n: 60, change: 40, seq: (i) => ({ I: i < 40 ? 0.11 : 10 }) },
  { name: '極慢轉快（10s×15 → 0.3s×40）', n: 55, change: 15, seq: (i) => ({ I: i < 15 ? 10 : 0.3 }) },
  { name: '彈到一半停手 6 秒（I＝0.4s）', n: 70, change: 30, seq: (i) => ({ I: 0.4, extra: i === 29 ? 6 : 0 }) },
  { name: '突然變快 3×（I＝1s → 0.33s）', n: 70, change: 30, seq: (i) => ({ I: i < 30 ? 1 : 1 / 3 }) },
  { name: '突然變慢 3×（I＝0.33s → 1s）', n: 70, change: 30, seq: (i) => ({ I: i < 30 ? 1 / 3 : 1 }) },
  { name: '漸變 ×10（I 由 0.1s 到 1s）', n: 60, seq: (i) => ({ I: 0.1 * 10 ** (i / 59) }) },
];

function runOne(song, sc, noise, seed) {
  const r = rng(seed), B = song.bounds, trk = null;
  const tracker = (Object.values(trackers)[sc.__k])(B);
  const n = Math.min(sc.n, song.secs.length - 1);
  let t = 0;
  const T = [0];
  const truth = [];
  for (let i = 0; i < n; i++) {
    const { I, extra = 0 } = sc.seq(i);
    const rate = song.g / I;                                          // 這一格真正的速度（樂譜秒 ÷ 真實秒）
    truth.push(rate);
    const dS = song.secs[i + 1] - song.secs[i];
    t += (dS / rate) * Math.exp(Math.hypot(noise.w, 0.15) * gauss(r)) + extra;
    T.push(t);
  }
  const errs = [];
  let lastT = -Infinity;
  for (let i = 0; i <= n; i++) {
    const tj = Math.max(lastT + 0.01, T[i] + (noise.sa / 1000) * gauss(r));
    lastT = tj;
    const est = tracker.update(song.secs[i], tj);
    if (i < n) errs.push(Math.abs(Math.log(est / truth[i])));          // 這一下之後估到的速度預測下一格
  }
  return errs;
}

function summarize(sc, perSong) {
  if (sc.steady) {
    const settled = perSong.map((e) => e.slice(8)), first = perSong.map((e) => mean(e.slice(0, 3)));
    return `|ln誤差| 中位 ${median(settled.map(median)).toFixed(2)}／p90 ${median(settled.map((e) => pct(e, 0.9))).toFixed(2)}；前 3 下 ${median(first).toFixed(2)}`;
  }
  const c = sc.change ?? 10;
  const post = perSong.map((e) => mean(e.slice(c, c + 10)));
  const conv = perSong.map((e) => { for (let k = c; k + 2 < e.length; k++) if (e[k] < LN125 && e[k + 1] < LN125 && e[k + 2] < LN125) return k - c; return 30; });
  if (!sc.change) return `全程平均 |ln誤差| ${median(perSong.map(mean)).toFixed(2)}`;
  return `變化後 10 下平均 ${median(post).toFixed(2)}；收斂需 ${median(conv).toFixed(0)} 下（上限 30）`;
}

for (const [label, noise] of [['一般噪聲 σ_a＝10ms、w＝0.05', { sa: 10, w: 0.05 }], ['重噪聲 σ_a＝20ms、w＝0.10', { sa: 20, w: 0.10 }]]) {
  console.log(`\n══════ ${label} ══════`);
  for (const sc0 of scenarios) {
    console.log(`\n── ${sc0.name} ──`);
    Object.keys(trackers).forEach((name, k) => {
      const sc = { ...sc0, __k: k };
      const perSong = picked.map((s, i) => runOne(s, sc, noise, 500 + i));
      console.log(`  ${name.padEnd(30 - [...name].filter((ch) => ch.charCodeAt(0) > 255).length)} ${summarize(sc0, perSong)}`);
    });
  }
}
