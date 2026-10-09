// ============================================================
//  early-eval.mjs — 早按時「還沒響的電腦音」怎麼處理：模擬評估（手動執行，不進 CI，純 Node）
//
//  問題：電腦音是在你上一次按鍵時，依估到的速度一次排好的。你這一次比預測早按，就有幾顆在樂譜上比你這個音更早、
//  卻還沒輪到響的電腦音（下面叫「受影響的音」）。四種處理：
//    現況      ：照原來排好的時刻放完（晚於你的音，但不丟、不擠）。
//    丟        ：受影響的音不發聲。
//    追趕      ：受影響的音從你按下的那一刻起以 2 倍速放完（不丟、不擠）。
//    留餘裕 m  ：排程時把這一段內每顆音的位置壓縮到 (1−m)（m＝10％、20％），早按量 ≤ m 時一顆都不受影響；
//                還是受影響的照「現況」放完。
//
//  樂譜：每首歌「音符最多的非打擊 part」的起音當你的聲部（跟 rate-eval 同一組），其餘所有音（含打擊）當電腦音，只看落在
//  你相鄰兩個起音之間的電腦音（跟你同一個 tick 的在按鍵呼叫內同刻發聲、不受影響；前奏與曲末不算）。
//  演奏者：跟 rate-eval 同一組模型（速度、手抖）。速度估計用實際採用的 estimatePlaybackRate()（最近 8 個間隔）。
//  理想時刻（事後諸葛）：電腦音在「你實際按的兩個起音之間依樂譜位置等比例內插」的時刻——一個完美、事後才知道你按鍵時刻
//  的伴奏者會放的時刻。誤差＝實際發聲時刻 − 理想時刻（毫秒，正＝晚）。
//
//  表中每列：受影響＝落在你下一次按鍵之後才輪到響的電腦音佔全部的％；丟掉＝沒有發聲的％；在你的音之後響＝發聲時刻晚於
//  你的下一個音的％（樂譜上更早的音卻響在你的音後面）；誤差＝發聲的音的 |誤差| 中位數／90 百分位（每首歌各算一次，再取
//  所有歌的中位數）。晚於你的音＝「在你的音之後響」的那些音，比你的音晚多少毫秒（每首歌各算一次，再取中位數）：中位／p90／
//  在 50ms 內的％（50ms 是 lookahead 預計的「送出就取消不了」的範圍，見對話紀錄）。
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
  const tickSet = new Set(driverTicks);
  const secs = driverTicks.map((t) => s.midiTicksToSeconds(t));
  const follow = s.notes.filter((n) => n.partId !== main.id && !tickSet.has(n.startTick)).map((n) => s.midiTicksToSeconds(n.startTick)).sort((a, b2) => a - b2);
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
};
const CATCHUP = 2; // 追趕的速度倍率上限
// 處理方式：給「排好的時刻 sched」「你下一次按下的時刻 nextPress」，回傳這顆音實際發聲的時刻（null＝丟掉）；
// margin＝排程時壓縮的比例（排程階段的事，不是按下之後才處理）。
const policies = {
  '現況（照原時刻放完）': { margin: 0, act: (sched) => sched },
  '丟': { margin: 0, act: (sched, next) => (sched > next ? null : sched) },
  '追趕（2×）': { margin: 0, act: (sched, next) => (sched > next ? next + (sched - next) / CATCHUP : sched) },
  '留餘裕 10％（其餘照現況）': { margin: 0.1, act: (sched) => sched },
  '留餘裕 20％（其餘照現況）': { margin: 0.2, act: (sched) => sched },
};

const rng = (seed) => { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * 0.5)] : NaN);
const pct = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] : NaN);

// 一首歌、一種演奏者：回傳每個處理方式的 { 受影響, 丟掉, 之後響, 誤差們 }
function evaluate(song, player, seed) {
  const { secs, follow } = song, m = secs.length, r = rng(seed);
  const ideal = new Array(m).fill(0);
  for (let i = 1; i < m; i++) ideal[i] = ideal[i - 1] + (secs[i] - secs[i - 1]) * player.k(i / m);
  const t = ideal.map((x, i) => (i ? x + (gauss(r) * player.jit) / 1000 : x));
  for (let i = 1; i < m; i++) t[i] = Math.max(t[i], t[i - 1] + 0.01);
  const hist = [];
  const acc = Object.fromEntries(Object.keys(policies).map((k) => [k, { affected: 0, dropped: 0, after: 0, errs: [], lates: [] }]));
  let total = 0, fi = 0;
  for (let i = 0; i < m - 1; i++) {
    hist.push({ scoreSec: secs[i], ms: t[i] * 1000 });
    const rate = estimatePlaybackRate(hist, 1);
    while (fi < follow.length && follow[fi] <= secs[i]) fi++;
    for (let j = fi; j < follow.length && follow[j] < secs[i + 1]; j++) {
      const off = follow[j] - secs[i];
      const ideal_ = t[i] + (off / (secs[i + 1] - secs[i])) * (t[i + 1] - t[i]);
      total++;
      for (const [name, p] of Object.entries(policies)) {
        const sched = t[i] + (off * (1 - p.margin)) / rate;
        const a = acc[name];
        if (sched > t[i + 1]) a.affected++;
        const at = p.act(sched, t[i + 1]);
        if (at === null) { a.dropped++; continue; }
        if (at > t[i + 1]) { a.after++; a.lates.push((at - t[i + 1]) * 1000); }
        a.errs.push(Math.abs(at - ideal_) * 1000);
      }
    }
  }
  return { total, acc };
}

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
for (const [pname, player] of Object.entries(players)) {
  const perPolicy = Object.fromEntries(Object.keys(policies).map((k) => [k, { affected: [], dropped: [], after: [], med: [], p90: [], lateMed: [], lateP90: [], late50: [] }]));
  songs.forEach((song, si) => {
    const { total, acc } = evaluate(song, player, 1000 + si);
    if (!total) return;
    for (const [name, a] of Object.entries(acc)) {
      const p = perPolicy[name];
      p.affected.push((100 * a.affected) / total); p.dropped.push((100 * a.dropped) / total); p.after.push((100 * a.after) / total);
      p.med.push(median(a.errs)); p.p90.push(pct(a.errs, 0.9));
      if (a.lates.length) { p.lateMed.push(median(a.lates)); p.lateP90.push(pct(a.lates, 0.9)); p.late50.push((100 * a.lates.filter((x) => x <= 50).length) / a.lates.length); }
    }
  });
  console.log(`\n── ${pname} ──`);
  console.log('處理方式'.padEnd(28) + '受影響％  丟掉％  在你的音之後響％  |誤差| 中位／p90（ms）  晚於你的音 中位／p90（ms）／≤50ms％');
  for (const [name, p] of Object.entries(perPolicy)) {
    const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    console.log(name.padEnd(30 - [...name].filter((c) => c.charCodeAt(0) > 255).length) + `${fmt(mean(p.affected)).padStart(7)}  ${fmt(mean(p.dropped)).padStart(6)}  ${fmt(mean(p.after)).padStart(14)}    ${fmt(median(p.med), 0).padStart(5)} ／ ${fmt(median(p.p90), 0).padEnd(5)}   ${fmt(median(p.lateMed), 0)} ／ ${fmt(median(p.lateP90), 0)} ／ ${fmt(median(p.late50), 0)}`);
  }
}
