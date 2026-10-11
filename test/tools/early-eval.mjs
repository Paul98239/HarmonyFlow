// ============================================================
//  early-eval.mjs — 你早按時電腦聲部怎麼辦：KB Pages 與垂直切片的模擬評估（手動執行，不進 CI，純 Node）
//
//  問題：電腦音是在你上一次按鍵時，依估到的速度一次排好的。你這一次比預測早按，上一段就有幾顆電腦音還沒輪到響。
//    KB Pages：下一段（含跟你同一個 tick 的電腦音）從「現在」起算，上一段沒放完的音照原時刻放——樂譜比較後面的音會比同 tick 的
//              音先響、前面的音反而晚響（倒序）。
//    垂直切片（現行，scheduler.js 的 _chaseOrSkip）：按下 T_k 那一刻，樂譜上「T_k 這個垂直 tick 響著什麼」＝ T_k 的 segment ＋
//              從更早延續過來、endTick > T_k 的音。上一段還沒輪到的電腦音：結尾在 T_k 之後的追音（現在發聲）、整顆在身後的跳過。
//              同 tick 的電腦音永遠與你同刻，沒有任何落後。文獻：Antescofo 的 @tight＋@local、DAW 的 Chase Events、Dannenberg 1984 §8。
//
//  樂譜：每首歌「音符最多的非打擊 part」的起音當你的聲部（跟 rate-eval 同一組），其餘所有音（含打擊）當電腦音，只看落在
//  你相鄰兩個起音之間的電腦音（前奏與曲末不算）。演奏者：跟 rate-eval 同一組模型（速度、手抖）。速度估計用實際採用的
//  estimatePlaybackRate()（最近 8 個間隔）；音長與起音都依速度等比例縮放（跟 scheduler.js 一樣）。
//  理想時刻（事後諸葛）：電腦音在「你實際按的兩個起音之間依樂譜位置等比例內插」的時刻。誤差＝實際發聲時刻 − 理想時刻（只算有發聲的音）。
//
//  表中每列：倒序％＝發聲時刻比樂譜上更早的某顆電腦音還早的音佔全部的％；跳過％／追音％＝你早按時整顆在身後而跳過、T_k 還該響著而追音
//  的電腦音佔全部的％（每首歌各算一次再取平均）；同 tick 晚到＝跟你同 tick 的電腦音比你晚的最大毫秒（0＝與你同刻）；
//  |誤差| 中位／p90（毫秒，每首歌各算一次再取中位數）。模擬沒有 lookahead，實機上按下前 50ms 內已送出的電腦音取消不了，會殘留 ≤50ms 的倒序。
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
  const follow = s.notes.filter((n) => n.partId !== main.id).map((n) => ({ st: s.midiTicksToSeconds(n.startTick), en: s.midiTicksToSeconds(n.endTick) })).sort((a, b2) => a.st - b2.st);
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
const policies = { 'KB Pages（按下起算，剩貨照原時刻）': 'kb', '垂直切片（現行）': 'slice' };

const rng = (seed) => { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * 0.5)] : NaN);
const pct = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] : NaN);

// 一首歌、一種演奏者、一種處理：模擬每次按鍵時各段電腦音的排程，回傳 { total, reversed, skipped, chased, syncLate, errs[] }
function evaluate(song, player, seed, policy) {
  const { secs, follow } = song, m = secs.length, r = rng(seed);
  const ideal = new Array(m).fill(0);
  for (let i = 1; i < m; i++) ideal[i] = ideal[i - 1] + (secs[i] - secs[i - 1]) * player.k(i / m) * (player.rel ? 1 + player.rel * (r() * 2 - 1) : 1);
  const t = ideal.map((x, i) => (i ? x + (gauss(r) * player.jit) / 1000 : x));
  for (let i = 1; i < m; i++) t[i] = Math.max(t[i], t[i - 1] + 0.01);
  const hist = [], dues = [];                       // dues：[樂譜秒, 發聲時刻, 理想時刻（跟你同 tick 的是 null）]，只放有發聲的音，依排程順序
  let fi = 0, skipped = 0, chased = 0, syncLate = 0, total = 0;
  let prev = [];                                    // 上一段排好、還沒發聲的電腦音 [{ n, due }]
  for (let i = 0; i < m - 1; i++) {
    hist.push({ scoreSec: secs[i], ms: t[i] * 1000 });
    const rate = estimatePlaybackRate(hist, 1);
    const pressSec = t[i];
    // 上一段還沒輪到的電腦音（發聲時刻在按下之後）：KB Pages 照原時刻放；垂直切片追音或跳過
    for (const { n, due } of prev) {
      if (due <= pressSec) { dues.push([n.st, due, null]); continue; }          // 早就響了（模擬裡先放，下面統一補理想時刻）
      if (policy === 'kb') dues.push([n.st, due, null]);
      else if (n.en > secs[i]) { chased++; dues.push([n.st, pressSec, null]); }
      else skipped++;
    }
    prev = [];
    while (fi < follow.length && follow[fi].st < secs[i]) fi++;
    for (let j = fi; j < follow.length && follow[j].st < secs[i + 1]; j++) {
      const off = follow[j].st - secs[i];
      const due = pressSec + off / rate;                        // 兩種做法下一段都從按下的那一刻起算
      total++;
      if (off === 0) { dues.push([follow[j].st, due, null]); continue; }          // 跟你同 tick：與你同刻（syncLate 恆為 0）
      prev.push({ n: follow[j], due });
    }
  }
  for (const { n, due } of prev) dues.push([n.st, due, null]);
  // 理想時刻：事後依你實際按的兩個起音等比例內插；只有「有發聲」的音才有誤差
  const errs = [];
  for (const d of dues) {
    const k = secs.findLastIndex((x) => x <= d[0] + 1e-9);
    if (k < 0 || k >= m - 1 || d[0] === secs[k]) continue;
    const idealT = t[k] + ((d[0] - secs[k]) / (secs[k + 1] - secs[k])) * (t[k + 1] - t[k]);
    errs.push(Math.abs(d[1] - idealT) * 1000);
  }
  // 倒序：樂譜位置較後的電腦音，發聲時刻比前面（樂譜位置較前）任何一顆更早
  dues.sort((a, b) => a[0] - b[0]);
  let reversed = 0, maxDue = -Infinity;
  for (let k = 0; k < dues.length; ) {
    let e = k; while (e < dues.length && dues[e][0] === dues[k][0]) e++;
    for (let q = k; q < e; q++) if (dues[q][1] < maxDue - 1e-9) reversed++;
    for (let q = k; q < e; q++) maxDue = Math.max(maxDue, dues[q][1]);
    k = e;
  }
  return { total, reversed, skipped, chased, syncLate, errs, sounded: dues.length };
}

const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
for (const [pname, player] of Object.entries(players)) {
  console.log(`
── ${pname} ──`);
  console.log('處理方式'.padEnd(38) + '倒序％  跳過％  追音％  同 tick 晚到ms  |誤差| 中位／p90（ms）');
  for (const [name, pol] of Object.entries(policies)) {
    const rev = [], skip = [], chase = [], late = [], errMed = [], errP90 = [];
    songs.forEach((song, si) => {
      const e = evaluate(song, player, 1000 + si, pol);
      if (!e.total) return;
      rev.push((100 * e.reversed) / e.total);
      skip.push((100 * e.skipped) / e.total);
      chase.push((100 * e.chased) / e.total);
      late.push(e.syncLate);
      errMed.push(median(e.errs)); errP90.push(pct(e.errs, 0.9));
    });
    console.log(name.padEnd(40 - [...name].filter((ch) => ch.charCodeAt(0) > 255).length) + `${fmt(mean(rev), 2).padStart(6)}  ${fmt(mean(skip), 2).padStart(6)}  ${fmt(mean(chase), 2).padStart(6)}  ${fmt(Math.max(0, ...late)).padStart(12)}  ${fmt(median(errMed)).padStart(8)} ／ ${fmt(median(errP90))}`);
  }
}
