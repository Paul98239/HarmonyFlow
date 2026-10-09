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
};

// ── 演奏者模型 ──
const players = {
  '穩定 1.0×，手抖 15ms': { k: () => 1, jit: 15 },
  '穩定 1.0×，手抖 40ms': { k: () => 1, jit: 40 },
  '手抖 80ms（不熟悉的人）': { k: () => 1, jit: 80 },
  '穩定慢 1.4×，手抖 40ms': { k: () => 1.4, jit: 40 },
  '穩定快 0.7×，手抖 40ms': { k: () => 0.7, jit: 40 },
  '越彈越快（1.0→0.6×），手抖 40ms': { k: (p) => 1 - 0.4 * p, jit: 40 },
  '中途突然變快（前半 1.0×、後半 0.6×）': { k: (p) => (p < 0.5 ? 1 : 0.6), jit: 40 },
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
  let late = 0, stall = 0, bigLate = 0;
  for (let i = 0; i < m - 1; i++) {
    const rate = estimator(secs, t, i, st);                      // 第 i 次按鍵之後的估計，用來預測第 i→i+1 這一段
    const e = ((secs[i + 1] - secs[i]) / rate - (t[i + 1] - t[i])) * 1000;
    late += Math.max(0, e); stall += Math.max(0, -e); if (e > 60) bigLate++;
  }
  return { late: late / (m - 1), stall: stall / (m - 1), bigLate: bigLate / (m - 1) };
}

for (const [pName, player] of Object.entries(players)) {
  console.log(`\n【${pName}】  尾巴晚收 ms ｜ 先放完等你 ms ｜ 尾巴晚 >60ms 的段佔比（${songs.length} 首的中位數）`);
  for (const [eName, est] of Object.entries(estimators)) {
    const res = songs.map((s, i) => simulate(s, player, est, 1000 + i));
    console.log(`  ${eName.padEnd(30)}`, String(median(res.map((x) => x.late)).toFixed(0)).padStart(4), '｜', String(median(res.map((x) => x.stall)).toFixed(0)).padStart(4), '｜', `${(median(res.map((x) => x.bigLate)) * 100).toFixed(0)}%`.padStart(4));
  }
}
