// ============================================================
//  follow-eval.mjs — 電腦聲部「貼著你走」的估速策略：模擬評估（手動執行，不進 CI，純 Node）
//
//  原則：你的不規律（亂按、手抖、很慢）是你的事，電腦聲部要做的是「每次按鍵都從那個 tick 重新對時」，並把估速的誤差
//  降到最小；估不準只能來自資料不足或規則誤判，不能靠濾掉你的節奏來解決。
//
//  量法：跟 early-eval.mjs 一樣的「事後內插理想時刻」——電腦音的理想時刻＝在你實際按的兩個起音之間，依樂譜位置等比例
//  內插；實際排好的時刻＝上一次按鍵時刻 + 樂譜秒差 ÷ 當時估到的速度。誤差＝|排好 − 理想|（毫秒）。
//  只看落在你相鄰兩個起音之間的電腦音（跟你同 tick 的在按鍵呼叫內同刻發聲，誤差恆為 0，不算；前奏與曲末不算）。
//  人為插入的停手（見下「停手重啟」）那一段不算誤差：電腦聲部放完就靜止，沒有「理想時刻」可言。
//
//  模擬的排程器行為（照 scheduler.js 的 _release()）：
//    · 速度＝ estimatePlaybackRate(歷史)，歷史不足 2 個按鍵時維持上一個值（一開始是 1）。
//    · 停手判斷：這次按鍵時，播放頭停在你的下一個起音已經多久（＝實際間隔 − 依「上一次錨點速度」預測的間隔）超過
//      IDLE_MS（800ms）就視為停手，歷史清空、這一下不拿來估速。這是「舊規則」；表中標「採用」的是現在 scheduler.js 的 _isIdleBreak()。
//  策略（idleRule × shrink）：
//    舊規則          ：停手＝停格 > 800ms（採用新規則之前的 scheduler.js）
//    不判停手        ：永遠不清歷史（對照用：看停手判斷到底幫了多少）
//    停格 > 800ms 且 > m × 預測間隔 ：預測太快（低估你的間隔）時停格會跟著變大，不該算停手；m＝2、3、4；
//      採用的是 m ＝ 1 ÷ MIN_PLAYBACK_RATE ＝ 10（慢到速度下限都學得到；3 倍時慢過 4× 的人每一下都被當成停手、速度永遠停在 1×）
//    ＋收縮 K         ：估到的速度跟「清空前的速度（沒有就 1）」依資料量加權（對數域）：w ＝ n ÷ (n + K)，n＝間隔數
//  演奏者：穩定／亂按（每個間隔各乘一個對數常態隨機倍率）／年長者穩定極慢（3×、4×、6×、8×）／由快到慢／停手重啟（每 40 下停 2.5 秒，
//  速度也跟著變）／開頭停手（第 2 下前停 6 秒：10 倍的門檻會把它當成慢，代價見表），手抖都是高斯誤差。
//
//  用法：node test/tools/follow-eval.mjs [--dir=資料夾（預設：test/tools/library 加上 src/assets 的 .mid）]
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { estimatePlaybackRate } from '../../src/midi/pressTiming.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const dirs = args.dir ? [resolve(args.dir)] : [join(ROOT, 'test/tools/library'), join(ROOT, 'src/assets')];
const files = dirs.filter(existsSync).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.mid')).map((f) => join(d, f)));
const IDLE_MS = 800; // 同 scheduler.js

// ── 樂譜：你的聲部起音（樂譜秒）與電腦音（樂譜秒），同 early-eval.mjs ──
const songs = [];
for (const f of files) {
  const b = readFileSync(f);
  let s;
  try { s = parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { continue; }
  const main = s.parts.filter((p) => !p.staves.every((v) => v.percussionKit)).sort((a, b2) => b2.noteCount - a.noteCount)[0];
  if (!main) continue;
  const driverTicks = [...new Set(s.notes.filter((n) => n.partId === main.id).map((n) => n.startTick))].sort((a, b2) => a - b2);
  if (driverTicks.length < 60) continue;
  const tickSet = new Set(driverTicks);
  const secs = driverTicks.map((t) => s.midiTicksToSeconds(t));
  const follow = s.notes.filter((n) => n.partId !== main.id && !tickSet.has(n.startTick)).map((n) => s.midiTicksToSeconds(n.startTick)).sort((a, b2) => a - b2);
  songs.push({ secs, follow });
}
console.log(`曲數（主聲部起音 ≥ 60 個）：${songs.length}`);

// ── 隨機數 ──
const rng = (seed) => { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * 0.5)] : NaN);
const pct = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] : NaN);

// ── 演奏者：k(p, i, r)＝第 i 個間隔的「真實 ÷ 樂譜」倍率（p＝曲子進度 0~1），jit＝按鍵時刻高斯誤差（毫秒），
//    pauseEvery／pauseSec＝每隔幾個按鍵停手幾秒（停手之後的 k 由 k 自己依 i 決定）
const players = {
  '穩定 1.0×，手抖 40ms': { k: () => 1, jit: 40 },
  '亂按（每個間隔 ×lognormal σ=0.5），手抖 40ms': { k: (p, i, r) => Math.exp(0.5 * gauss(r)), jit: 40 },
  '年長者穩定極慢 3×，手抖 60ms': { k: () => 3, jit: 60 },
  '年長者穩定極慢 4×，手抖 100ms': { k: () => 4, jit: 100 },
  '穩定極慢 6×，手抖 150ms': { k: () => 6, jit: 150 },
  '穩定極慢 8×，手抖 200ms': { k: () => 8, jit: 200 },
  '開頭停手（第 2 下前停 6 秒，之後 1.0×）': { k: () => 1, jit: 40, pauseAt: [1], pauseSec: 6 },
  '由快到慢（0.7→2.5×），手抖 40ms': { k: (p) => 0.7 + 1.8 * p, jit: 40 },
  '停手重啟（每 40 下停 2.5 秒，速度 1.0×→2.0× 交替）': { k: (p, i) => (Math.floor(i / 40) % 2 ? 2 : 1), jit: 40, pauseEvery: 40, pauseSec: 2.5 },
};

// ── 策略：idle(stallMs, expectedMs, intervals)＝是不是停手（intervals＝清空後目前累積的有效間隔數：不足時速度還沒學到，
//    「實際間隔 − 預測間隔」大可能只是預測太快，不是你停手） ──
const strategies = {
  '舊規則（停格 > 800ms 就清歷史）': { idle: (stall) => stall > IDLE_MS },
  '不判停手（永遠不清歷史）': { idle: () => false },
  '停格 > 800ms 且 > 3×預測間隔': { idle: (stall, exp) => stall > IDLE_MS && stall > 3 * exp },
  '≥ 3 個間隔才判停手（之前不判）': { idle: (stall, exp, n) => n >= 3 && stall > IDLE_MS },
  '≥ 3 個間隔用 800ms；之前要停格 > 4 秒': { idle: (stall, exp, n) => stall > (n >= 3 ? IDLE_MS : 4000) },
  '≥ 3 個間隔用 800ms；之前要停格 > 3×預測間隔（舊採用）': { idle: (stall, exp, n) => stall > (n >= 3 ? IDLE_MS : Math.max(IDLE_MS, 3 * exp)) },
  '≥ 3 個間隔用 800ms；之前要停格 > 10×預測間隔（採用，跟速度下限 0.1× 連動）': { idle: (stall, exp, n) => stall > (n >= 3 ? IDLE_MS : Math.max(IDLE_MS, 10 * exp)) },
};

function evaluate(song, player, strat, seed) {
  const { secs, follow } = song, m = secs.length, r = rng(seed);
  // 按鍵時刻：樂譜間隔 × k ＋ 手抖；停手＝額外加一段停頓，這一段標記為不算誤差
  const t = new Array(m).fill(0), paused = new Array(m).fill(false);
  for (let i = 1; i < m; i++) {
    t[i] = t[i - 1] + (secs[i] - secs[i - 1]) * player.k(i / m, i, r);
    if ((player.pauseEvery && i % player.pauseEvery === 0) || player.pauseAt?.includes(i)) { t[i] += player.pauseSec; paused[i] = true; }
  }
  const tj = t.map((x, i) => (i ? x + (gauss(r) * player.jit) / 1000 : x));
  for (let i = 1; i < m; i++) tj[i] = Math.max(tj[i], tj[i - 1] + 0.01);

  let hist = [], rate = 1, anchorRate = 1, clears = 0;
  let fi = 0;
  const errs = [], early = []; // early＝每次（重新）起算後前 3 段的誤差
  let sinceStart = 0;
  for (let i = 0; i < m - 1; i++) {
    if (i > 0) {
      const expectedMs = ((secs[i] - secs[i - 1]) / anchorRate) * 1000;
      const stallMs = (tj[i] - tj[i - 1]) * 1000 - expectedMs;
      if (strat.idle(Math.max(0, stallMs), expectedMs, Math.max(0, hist.length - 1))) { hist = []; clears++; sinceStart = 0; }
    }
    hist.push({ scoreSec: secs[i], ms: tj[i] * 1000 });
    rate = estimatePlaybackRate(hist, rate);
    anchorRate = rate;
    sinceStart++;
    if (paused[i + 1]) continue; // 下一段是人為停手：電腦放完就靜止，不算誤差
    while (fi < follow.length && follow[fi] <= secs[i]) fi++;
    for (let j = fi; j < follow.length && follow[j] < secs[i + 1]; j++) {
      const off = follow[j] - secs[i];
      const ideal = tj[i] + (off / (secs[i + 1] - secs[i])) * (tj[i + 1] - tj[i]);
      const e = Math.abs(tj[i] + off / rate - ideal) * 1000;
      errs.push(e);
      if (sinceStart <= 3) early.push(e);
    }
  }
  return { errs, early, finalRate: rate, clears: clears / m };
}

const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');
for (const [pname, player] of Object.entries(players)) {
  console.log(`\n── ${pname} ──`);
  console.log('策略'.padEnd(36) + '|誤差|中位／p90（ms）  起算後前 3 段中位（ms）  清歷史次數／每百下');
  for (const [sname, strat] of Object.entries(strategies)) {
    const res = songs.map((s, i) => evaluate(s, player, strat, 1000 + i));
    const med = res.map((x) => median(x.errs)).filter(Number.isFinite);
    const p90 = res.map((x) => pct(x.errs, 0.9)).filter(Number.isFinite);
    const early = res.map((x) => median(x.early)).filter(Number.isFinite);
    const cw = [...sname].filter((c) => c.charCodeAt(0) > 255).length; // 全形字寬補償
    console.log(sname.padEnd(38 - cw) + `${fmt(median(med)).padStart(6)} ／ ${fmt(median(p90)).padEnd(6)}  ${fmt(median(early)).padStart(14)}      ${fmt(median(res.map((x) => x.clears * 100), 1)).padStart(6)}`);
  }
}
