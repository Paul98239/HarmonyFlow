// ============================================================
//  rate-eval.mjs — 估速方法的模擬評估（手動執行，不進 CI，純 Node）
//
//  問題：scheduler.js 要用「你的按鍵」估出你現在的速度（playbackRate），才能預測下一個 driver 起音大約什麼時候來、
//  把電腦聲部排好。估得不準：預測的這一段比實際長 → 電腦最後幾個音晚收尾（尾巴晚收）；比實際短 → 電腦先放完、
//  靜靜等你（先放完等你）。這支工具用曲庫實際的樂譜當輸入、模擬不同的演奏者，比較幾種估速方法的誤差。
//
//  樂譜：每首歌「音符最多的非打擊 part」的起音（driver segment）時間，只取起音 ≥ 60 個的歌。
//  演奏者模型：按鍵間隔是樂譜間隔的 k 倍（k 可以隨曲子進行變化），再加上每次按鍵時刻的高斯誤差（手抖，毫秒）。
//  誤差：預測這一段的真實長度 − 實際按鍵間隔（毫秒）；> 0 → 尾巴晚收、< 0 → 先放完等你。表中是每首平均後的中位數。
//
//  另外比較兩種文獻上的估速（Kalman 濾波：Raphael 的 Music Plus One 用類似的模型預測獨奏者的下一個音；離群濾除：Coda Music 的專利
//  「速度變化超過 25% 的音不拿來估速」），並多報「起算後前 3 段」的誤差——按鍵還不到 8 個時（開頭）估得準不準。
//
//  用法：node test/tools/rate-eval.mjs [--dir=資料夾（預設：test/tools/library 加上 src/assets 的 .mid）]
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { estimatePlaybackRate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE } from '../../src/midi/pressTiming.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const dirs = args.dir ? [resolve(args.dir)] : [join(ROOT, 'test/tools/library'), join(ROOT, 'src/assets')];
const files = dirs.filter(existsSync).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.mid')).map((f) => join(d, f)));

// ── 樂譜 ──
const songs = [];
for (const f of files) {
  const b = readFileSync(f);
  let s;
  try { s = parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { continue; }
  const main = s.parts.filter((p) => !p.staves.every((v) => v.percussionKit)).sort((a, b2) => b2.noteCount - a.noteCount)[0];
  if (!main) continue;
  const secs = [...new Set(s.notes.filter((n) => n.partId === main.id).map((n) => n.startTick))].sort((a, b2) => a - b2).map((t) => s.midiTicksToSeconds(t));
  if (secs.length >= 60) songs.push(secs);
}
console.log(`曲數（主聲部起音 ≥ 60 個）：${songs.length}`);

// ── 估速方法（r＝樂譜秒 ÷ 真實秒）。`i` 是剛按下的按鍵序號，s／t 是到目前為止的樂譜秒與真實秒陣列 ──
const clamp = (x) => Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, x));
const interval = (s, t, i) => clamp((s[i] - s[i - 1]) / Math.max(1e-3, t[i] - t[i - 1]));
const estimators = {
  '固定 1×（檔案速度）': () => 1,
  '最近 1 個間隔（舊計畫）': (s, t, i) => (i < 1 ? 1 : interval(s, t, i)),
  'EMA α=0.5（對數域）': (s, t, i, st) => { if (i < 1) return 1; const x = Math.log(interval(s, t, i)); st.v = st.v === undefined ? x : 0.5 * x + 0.5 * st.v; return Math.exp(st.v); },
  'EMA α=0.25（對數域）': (s, t, i, st) => { if (i < 1) return 1; const x = Math.log(interval(s, t, i)); st.v = st.v === undefined ? x : 0.25 * x + 0.75 * st.v; return Math.exp(st.v); },
  '最近 4 個間隔的頭尾比值': (s, t, i) => { if (i < 1) return 1; const j = Math.max(0, i - 4); return clamp((s[i] - s[j]) / Math.max(1e-3, t[i] - t[j])); },
  '最近 3 秒的頭尾比值': (s, t, i) => { if (i < 1) return 1; let j = i - 1; while (j > 0 && t[i] - t[j - 1] <= 3) j--; return clamp((s[i] - s[j]) / Math.max(1e-3, t[i] - t[j])); },
  '最近 6 個按鍵的最小平方斜率': (s, t, i) => { if (i < 2) return 1; const j = Math.max(0, i - 5), n = i - j + 1; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let k = j; k <= i; k++) { sx += t[k]; sy += s[k]; sxx += t[k] * t[k]; sxy += t[k] * s[k]; } const d = n * sxx - sx * sx; return d > 0 ? clamp((n * sxy - sx * sy) / d) : 1; },
  // 實際採用的（src/midi/pressTiming.js）：最近 8 個間隔的頭尾比值
  '最近 8 個間隔的頭尾比值（採用）': (s, t, i, st) => { (st.h ??= []).push({ scoreSec: s[i], ms: t[i] * 1000 }); return estimatePlaybackRate(st.h, 1); },
  // Kalman 濾波（狀態＝對數速度，隨機漫步；觀測＝每個間隔的對數速度）。先驗＝檔案速度 1×（x＝0）、變異數 P0 大，所以前幾下增益大、快速收斂；
  // 之後增益收斂到穩態（約 sqrt(q/r)）。q＝每個間隔速度自己漂移的變異數、r＝單一間隔觀測的變異數（手抖）。
  'Kalman（P0=0.5, q=0.002, r=0.015）': (s, t, i, st) => kalman(s, t, i, st, 0.5, 0.002, 0.015),
  'Kalman（P0=0.5, q=0.005, r=0.015）': (s, t, i, st) => kalman(s, t, i, st, 0.5, 0.005, 0.015),
  'Kalman（P0=0.2, q=0.002, r=0.015）': (s, t, i, st) => kalman(s, t, i, st, 0.2, 0.002, 0.015),
  // 離群濾除（Coda）：單一間隔的速度跟目前估計差超過 25% 就不拿來估速（只丟這一下）；連續 2 下同方向才接受（不然真的突然變速永遠學不到）。
  '8 個間隔頭尾比值＋離群濾除（>25%）': (s, t, i, st) => {
    const h = (st.h ??= []);
    if (i >= 1 && h.length >= 2) {
      const cur = estimatePlaybackRate(h, 1), x = (s[i] - s[i - 1]) / Math.max(1e-3, t[i] - t[i - 1]);
      const dir = Math.sign(Math.log(x / cur));
      const out = Math.abs(Math.log(x / cur)) > Math.log(1.25);
      if (out && st.lastOut !== dir) { st.lastOut = dir; return cur; }      // 第一次離群：丟掉這一下，估計不變
      st.lastOut = 0;
    }
    h.push({ scoreSec: s[i], ms: t[i] * 1000 });
    return estimatePlaybackRate(h, 1);
  },
};

function kalman(s, t, i, st, P0, q, r) {
  if (i < 1) return 1;
  if (st.x === undefined) { st.x = 0; st.P = P0; }                // 對數速度的估計與變異數
  const z = Math.log(interval(s, t, i));
  st.P += q;                                                      // 預測：速度隨機漂移
  const K = st.P / (st.P + r);                                    // Kalman 增益：變異數大（還不確定）＝更相信新觀測
  st.x += K * (z - st.x);
  st.P *= 1 - K;
  return clamp(Math.exp(st.x));
}

// ── 演奏者模型 ──
const players = {
  '穩定 1.0×，手抖 15ms': { k: () => 1, jit: 15 },
  '穩定 1.0×，手抖 40ms': { k: () => 1, jit: 40 },
  '手抖 80ms（不熟悉的人）': { k: () => 1, jit: 80 },
  '穩定慢 1.4×，手抖 40ms': { k: () => 1.4, jit: 40 },
  '穩定快 0.7×，手抖 40ms': { k: () => 0.7, jit: 40 },
  '越彈越快（1.0→0.6×），手抖 40ms': { k: (p) => 1 - 0.4 * p, jit: 40 },
  '中途突然變快（前半 1.0×、後半 0.6×）': { k: (p) => (p < 0.5 ? 1 : 0.6), jit: 40 },
  '極慢 4×，手抖 100ms': { k: () => 4, jit: 100 },
  '超慢 10×，手抖 200ms': { k: () => 10, jit: 200 },
};

const rng = (seed) => { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * 0.5)];

function simulate(secs, player, estimator, seed) {
  const r = rng(seed), m = secs.length;
  const ideal = new Array(m).fill(0);
  for (let i = 1; i < m; i++) ideal[i] = ideal[i - 1] + (secs[i] - secs[i - 1]) * player.k(i / m);
  const t = ideal.map((x, i) => (i ? x + (gauss(r) * player.jit) / 1000 : x));
  for (let i = 1; i < m; i++) t[i] = Math.max(t[i], t[i - 1] + 0.01);
  const st = {};
  let late = 0, stall = 0, bigLate = 0, early3 = 0;
  for (let i = 0; i < m - 1; i++) {
    const rate = estimator(secs, t, i, st);                      // 第 i 次按鍵之後的估計，用來預測第 i→i+1 這一段
    const e = ((secs[i + 1] - secs[i]) / rate - (t[i + 1] - t[i])) * 1000;
    late += Math.max(0, e); stall += Math.max(0, -e); if (e > 60) bigLate++;
    if (i < 3) early3 += Math.abs(e) / 3;                        // 起算後前 3 段（開頭按鍵還不到 8 個）的平均絕對誤差
  }
  return { late: late / (m - 1), stall: stall / (m - 1), bigLate: bigLate / (m - 1), early3 };
}

for (const [pName, player] of Object.entries(players)) {
  console.log(`\n【${pName}】  尾巴晚收 ms ｜ 先放完等你 ms ｜ 尾巴晚 >60ms 的段佔比 ｜ 起算後前 3 段 |誤差| ms（${songs.length} 首的中位數）`);
  for (const [eName, est] of Object.entries(estimators)) {
    const res = songs.map((s, i) => simulate(s, player, est, 1000 + i));
    console.log(`  ${eName.padEnd(30)}`, String(median(res.map((x) => x.late)).toFixed(0)).padStart(4), '｜', String(median(res.map((x) => x.stall)).toFixed(0)).padStart(4), '｜', `${(median(res.map((x) => x.bigLate)) * 100).toFixed(0)}%`.padStart(4), '｜', String(median(res.map((x) => x.early3)).toFixed(0)).padStart(5));
  }
}
