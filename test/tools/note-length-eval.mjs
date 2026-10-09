// ============================================================
//  note-length-eval.mjs — 鍵盤模式的實際音長 vs 等比例縮放的理想音長：量測（手動執行，不進 CI，純 Node，不出聲）
//
//  問題：鍵盤彈的音長跟試聽（官方 Sequencer，原速）不同。排程器的音長是「檔案音長 ÷ 你的速度」（整份譜用你的 BPM 演奏），再加上
//  hold（結尾對齊或橫跨你下一個起音的音，等你按）。這支只量「排程器」這一段造成多少差距，用 sim.mjs 的假合成器記下
//  每顆音實際 noteOn／noteOff 的假時間（假時間以 12ms 為一個 tick，跟 midiPlayer.js 一致），所以量不到合成器的 release 尾巴、
//  humanGain 增益與 compressor（那些要用耳朵 A/B）。
//
//  怎麼判讀：演奏者的按鍵間隔是樂譜間隔的 factor 倍（>1 慢、<1 快），所以理想音長（等比例縮放）＝檔案音長 × factor。每顆音算兩個差
//  （毫秒，正＝比預期長）：「對理想」＝實際音長 − 檔案音長 × factor；「對檔案」＝實際音長 − 檔案音長（如果音長不依速度換算會是 0）。
//  極慢（factor 4）時對檔案會大幅偏正（音放長了才是對的，連斷奏之間的比例也維持）；極快（factor 0.25）時對檔案偏負。hold 著的音
//  （結尾對齊你的下一個起音）會一直響到你按下去，差很多的長音多半是 hold，不在「收音有沒有準時」的範圍內。
//  聲部：每首歌音符最多的非打擊 part 當你的聲部（跟 rate-eval／early-eval 同一組），其餘是電腦音。沒有撐住，音多出來的
//  長度只會是 tick 粒度（≤ 12ms：收音要等到下一個 tick 才送）。
//  再依檔案音長分「短音（< 250ms）」「長音（≥ 250ms）」：tick 粒度對短音的比例影響大。
//
//  錄製式的檔（例如 oguri）相鄰起音只差幾 ms，完美演奏者的按鍵會被去抖擋掉、40ms 後重按，尾端數字會被它拉大；要看一般檔的行為用 --exclude=oguri。
//
//  用法：node test/tools/note-length-eval.mjs [--dir=資料夾（預設：src/assets 加上 test/tools/library 前 --limit 首）] [--limit=30] [--exclude=檔名片段]
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { simulate, rankedParts, driverSecs, onsetPresses, makeRng } from './sim.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const limit = Number(args.limit ?? 30);
const listMid = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.mid')).map((f) => join(d, f)) : []);
const allFiles = args.dir ? listMid(resolve(args.dir)) : [...listMid(join(ROOT, 'src/assets')), ...listMid(join(ROOT, 'test/tools/library')).slice(0, limit)];
const files = typeof args.exclude === 'string' ? allFiles.filter((f) => !f.includes(args.exclude)) : allFiles;

const SCENARIOS = [
  { name: '完美：1.0×、無手抖', factor: 1, jitter: 0 },
  { name: '1.0×、手抖 15%', factor: 1, jitter: 0.15 },
  { name: '慢 1.4×、手抖 15%', factor: 1.4, jitter: 0.15 },
  { name: '快 0.7×、手抖 15%', factor: 0.7, jitter: 0.15 },
  { name: '極慢 4×、手抖 15%', factor: 4, jitter: 0.15 },
  { name: '慢 2×、手抖 15%', factor: 2, jitter: 0.15 },
  { name: '快 2×（factor 0.5）、手抖 15%', factor: 0.5, jitter: 0.15 },
  { name: '極快 4×（factor 0.25）、手抖 15%', factor: 0.25, jitter: 0.15 },
];
const SHORT_MS = 250;

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : NaN);
const f0 = (x) => (Number.isFinite(x) ? String(Math.round(x)).padStart(5) : '    -');
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%`.padStart(4) : '   -');

// 每個情境、每種音（你的相連／你的其他／電腦的 × 短／長）累積樣本
const GROUPS = [['human', '你的'], ['assist', '電腦']]; // r.label：human＝你的聲部、assist＝電腦聲部
const acc = SCENARIOS.map(() => Object.fromEntries(GROUPS.map(([g]) => [g, { short: [], long: [], shortFile: [], longFile: [] }])));
let songs = 0;
for (const f of files) {
  const b = readFileSync(f);
  let score;
  try { score = parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { continue; }
  const main = rankedParts(score)[0];
  if (!main) continue;
  const secs = driverSecs(score, [main.id]);
  if (secs.length < 60) continue;
  songs++;
  SCENARIOS.forEach((sc, i) => {
    const presses = onsetPresses(secs, { factor: sc.factor, jitter: sc.jitter, rnd: makeRng(1234 + songs) });
    const sim = simulate(score, [{ partIds: [main.id], presses, keepGoing: true }]);
    for (const r of sim.records) {
      if (r.offMs == null) continue;
      const fileMs = (r.note.endSeconds - r.note.startSeconds) * 1000;
      if (fileMs <= 0) continue;
      const actual = r.offMs - r.onMs;
      const group = r.label;
      const kind = fileMs < SHORT_MS ? 'short' : 'long';
      acc[i][group][kind].push(actual - fileMs * sc.factor);       // 對理想（等比例縮放）
      acc[i][group][kind + 'File'].push(actual - fileMs);         // 對檔案
    }
  });
}
console.log(`曲數（主聲部起音 ≥ 60 個）：${songs}；差值單位 ms，正＝實際比預期長；「對理想」＝等比例縮放（檔案音長 × 按鍵間隔倍率）、「對檔案」＝不換算\n`);

for (const [i, sc] of SCENARIOS.entries()) {
  console.log(`■ ${sc.name}`);
  console.log('  種類        音數   對理想 p50  p90  p99    >12ms  >30ms  >100ms  <-30ms     對檔案 p50  p90');
  for (const [label, title] of GROUPS) {
    for (const len of ['short', 'long']) {
      const s = acc[i][label][len];
      const a = [...s].sort((x, y) => x - y);
      const name = `${title}${len === 'short' ? '短音' : '長音'}`.padEnd(10);
      console.log(`  ${name}${String(s.length).padStart(9)}   ${f0(quantile(a, 0.5))} ${f0(quantile(a, 0.9))} ${f0(quantile(a, 0.99))}   `
        + `${pct(a.filter((x) => x > 12).length, a.length)}   ${pct(a.filter((x) => x > 30).length, a.length)}    ${pct(a.filter((x) => x > 100).length, a.length)}    ${pct(a.filter((x) => x < -30).length, a.length)}`
        + `     ${f0(quantile([...acc[i][label][len + 'File']].sort((x, y) => x - y), 0.5))} ${f0(quantile([...acc[i][label][len + 'File']].sort((x, y) => x - y), 0.9))}`);
    }
  }
  console.log('');
}
