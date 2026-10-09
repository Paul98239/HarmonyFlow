// ============================================================
//  early-eval.mjs — 你早按時電腦聲部怎麼辦：電腦段鎖的模擬評估（手動執行，不進 CI，純 Node）
//
//  問題：電腦音是在你上一次按鍵時，依估到的速度一次排好的。你這一次比預測早按，上一段就有幾顆電腦音還沒輪到響。若下一段
//  （含跟你同一個 tick 的電腦音）從「現在」起算，樂譜比較後面的電腦音會比前面的先響＝電腦聲部往前跳（倒序）。
//    無段鎖  ：舊做法（KB Pages 與電腦段鎖之前的版本）：每一段都從你按下的那一刻起算，上一段沒放完的音照原時刻放。
//    段鎖 c  ：下一段的錨點接在上一段最後一顆電腦音的排定時刻後面，兩者之間那段樂譜間距、以及有落後的這一段整段，都用 c 倍速度
//              追趕（c＝1 不追趕，c＝2 是 scheduler.js 的 CATCHUP）。你的音不受影響，仍在按鍵當下發聲。
//    剩貨 l  ：另外把上一段還沒發聲的電腦音，從按下的那一刻起把剩下的時間壓縮 l 倍（l＝1 不壓縮，l＝4 是 scheduler.js 的 LEFTOVER_CATCHUP）。
//
//  樂譜：每首歌「音符最多的非打擊 part」的起音當你的聲部（跟 rate-eval 同一組），其餘所有音（含打擊）當電腦音，只看落在
//  你相鄰兩個起音之間的電腦音（前奏與曲末不算）。演奏者：跟 rate-eval 同一組模型（速度、手抖）。速度估計用實際採用的
//  estimatePlaybackRate()（最近 8 個間隔）；音長與起音都依速度等比例縮放（跟 scheduler.js 一樣）。
//  理想時刻（事後諸葛）：電腦音在「你實際按的兩個起音之間依樂譜位置等比例內插」的時刻。誤差＝實際發聲時刻 − 理想時刻。
//
//  表中每列：倒序％＝發聲時刻比樂譜上更早的某顆電腦音還早的音佔全部的％（段鎖應為 0）；有落後的按鍵％＝電腦這一段比你按下的
//  時刻晚的按鍵佔所有按鍵的％（每首歌各算一次再取平均）；落後 中位／p90＝只算有落後的按鍵（毫秒，每首歌各算一次再取中位數）；
//  |誤差| 中位／p90（毫秒，每首歌各算一次再取中位數）。
//
//  用法：node test/tools/early-eval.mjs [--dir=資料夾（預設：test/tools/library 加上 src/assets 的 .mid）]
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

// ── 樂譜：你的聲部起音（樂譜秒）與電腦音（樂譜秒） ──
const songs = [];
for (const f of files) {
  const b = readFileSync(f);
  let s;
  try { s = parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { continue; }
  const main = s.parts.filter((p) => !p.staves.every((v) => v.percussionKit)).sort((a, b2) => b2.noteCount - a.noteCount)[0];
  if (!main) continue;
  const driverTicks = [...new Set(s.notes.filter((n) => n.partId === main.id).map((n) => n.startTick))].sort((a, b2) => a - b2);
  if (driverTicks.length < 60) continue;
  const secs = driverTicks.map((t) => s.midiTicksToSeconds(t));
  const follow = s.notes.filter((n) => n.partId !== main.id).map((n) => s.midiTicksToSeconds(n.startTick)).sort((a, b2) => a - b2);
  songs.push({ secs, follow });
}
console.log(`曲數（主聲部起音 ≥ 60 個）：${songs.length}`);

// ── 演奏者模型（跟 rate-eval.mjs 同一組） ──
const players = {
  '穩定 1.0×，手抖 15ms': { k: () => 1, jit: 15 },
  '穩定 1.0×，手抖 40ms': { k: () => 1, jit: 40 },
  '手抖 80ms（不熟悉的人）': { k: () => 1, jit: 80 },
  '穩定慢 1.4×，手抖 40ms': { k: () => 1.4, jit: 40 },
  '穩定快 0.7×，手抖 40ms': { k: () => 0.7, jit: 40 },
  '越彈越快（1.0→0.6×），手抖 40ms': { k: (p) => 1 - 0.4 * p, jit: 40 },
  '中途突然變快（前半 1.0×、後半 0.6×）': { k: (p) => (p < 0.5 ? 1 : 0.6), jit: 40 },
  '快 3.3×，抖動 ±30％（連續快彈）': { k: () => 0.3, jit: 0, rel: 0.3 },
  '慢 3×，抖動 ±30％（連續慢彈）': { k: () => 3, jit: 0, rel: 0.3 },
  '極慢 4×，抖動 ±15％': { k: () => 4, jit: 0, rel: 0.15 },
};
// 段鎖的追趕倍率 c（null＝無段鎖）與剩貨壓縮倍率 l
const policies = {
  '無段鎖（KB Pages）': { c: null, l: 1 },
  '段鎖 c＝2，剩貨不壓縮': { c: 2, l: 1 },
  '段鎖 c＝2，剩貨 2×': { c: 2, l: 2 },
  '段鎖 c＝2，剩貨 4×（採用）': { c: 2, l: 4 },
  '段鎖 c＝2，剩貨 6×': { c: 2, l: 6 },
};

const rng = (seed) => { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * 0.5)] : NaN);
const pct = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] : NaN);

// 一首歌、一種演奏者、一種處理：模擬每次按鍵時各段電腦音的排程，回傳 { total, reversed, lags[], presses, errs[] }
function evaluate(song, player, seed, { c, l }) {
  const { secs, follow } = song, m = secs.length, r = rng(seed);
  const ideal = new Array(m).fill(0);
  for (let i = 1; i < m; i++) ideal[i] = ideal[i - 1] + (secs[i] - secs[i - 1]) * player.k(i / m) * (player.rel ? 1 + player.rel * (r() * 2 - 1) : 1);
  const t = ideal.map((x, i) => (i ? x + (gauss(r) * player.jit) / 1000 : x));
  for (let i = 1; i < m; i++) t[i] = Math.max(t[i], t[i - 1] + 0.01);
  const hist = [], dues = [];                       // dues：[樂譜秒, 發聲時刻, 理想時刻（跟你同 tick 的是 null）]，依排程順序
  const lags = [], errs = [];
  let fi = 0, lastDue = -Infinity, lastScore = 0;
  for (let i = 0; i < m - 1; i++) {
    hist.push({ scoreSec: secs[i], ms: t[i] * 1000 });
    const rate = estimatePlaybackRate(hist, 1);
    const pressSec = t[i];
    // 錨點與這一段的速度
    if (c !== null && l > 1 && lastDue > pressSec) {              // 剩貨壓縮：還沒發聲的電腦音（發聲時刻在按下之後）從按下起把剩下的時間壓縮 l 倍
      for (let q = dues.length - 1; q >= 0 && dues[q][1] > pressSec; q--) dues[q][1] = pressSec + (dues[q][1] - pressSec) / l;
      lastDue = pressSec + (lastDue - pressSec) / l;
    }
    let anchor = pressSec, sliceRate = rate;
    if (c !== null && lastDue > pressSec) {
      anchor = lastDue + Math.max(0, secs[i] - lastScore) / (rate * Math.max(c, l));   // 間距也是「剩下的時間」，跟剩貨一起壓縮
      sliceRate = rate * c;
    }
    lags.push((anchor - pressSec) * 1000);
    while (fi < follow.length && follow[fi] < secs[i]) fi++;
    for (let j = fi; j < follow.length && follow[j] < secs[i + 1]; j++) {
      const off = follow[j] - secs[i];
      const due = anchor + off / sliceRate;
      dues.push([follow[j], due, off > 0 ? t[i] + (off / (secs[i + 1] - secs[i])) * (t[i + 1] - t[i]) : null]);   // 跟你同 tick 的（off＝0）不算誤差
      lastDue = Math.max(lastDue, due); lastScore = follow[j];
    }
  }
  for (const [, due, ideal] of dues) if (ideal !== null) errs.push(Math.abs(due - ideal) * 1000);
  // 倒序：樂譜位置較後的電腦音，發聲時刻比前面（樂譜位置較前）任何一顆更早
  let reversed = 0, maxDue = -Infinity;
  for (let k = 0; k < dues.length; ) {
    let e = k; while (e < dues.length && dues[e][0] === dues[k][0]) e++;
    for (let q = k; q < e; q++) if (dues[q][1] < maxDue - 1e-9) reversed++;
    for (let q = k; q < e; q++) maxDue = Math.max(maxDue, dues[q][1]);
    k = e;
  }
  return { total: dues.length, reversed, lags, errs };
}

const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');
for (const [pname, player] of Object.entries(players)) {
  console.log(`\n── ${pname} ──`);
  console.log('處理方式'.padEnd(30) + '倒序％  有落後的按鍵％  落後 中位／p90（ms）  |誤差| 中位／p90（ms）');
  for (const [name, pol] of Object.entries(policies)) {
    const rev = [], lagged = [], lagMed = [], lagP90 = [], errMed = [], errP90 = [];
    songs.forEach((song, si) => {
      const e = evaluate(song, player, 1000 + si, pol);
      if (!e.total) return;
      rev.push((100 * e.reversed) / e.total);
      const pos = e.lags.filter((x) => x > 0);
      lagged.push((100 * pos.length) / e.lags.length);
      if (pos.length) { lagMed.push(median(pos)); lagP90.push(pct(pos, 0.9)); }
      errMed.push(median(e.errs)); errP90.push(pct(e.errs, 0.9));
    });
    const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    console.log(name.padEnd(32 - [...name].filter((ch) => ch.charCodeAt(0) > 255).length) + `${fmt(mean(rev), 2).padStart(6)}  ${fmt(mean(lagged), 1).padStart(13)}    ${fmt(median(lagMed)).padStart(5)} ／ ${fmt(median(lagP90)).padEnd(6)}    ${fmt(median(errMed)).padStart(5)} ／ ${fmt(median(errP90))}`);
  }
}
