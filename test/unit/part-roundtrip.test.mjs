// ============================================================
//  part-roundtrip.test.mjs — 分合合分：總譜切成分譜、再合回總譜，音符與聲部結構不變（純 Node，離線）
//
//  切分／合併工具在 test/tools/part-io.mjs（只給開發測試用，不在 src/）。驗證四件事：
//    1. 切分互斥完整：每顆音恰好屬於一個 part／staff，staves 的音符聯集 == parsed.notes。
//    2. 標準答案：canon 總譜切出來的小提琴／大提琴，音符與 canon-violin-cello-Violin／Violoncello.mid 完全一致。
//    3. 分 → 合 → 再解析：音符多重集合、速度表、拍號、各 part 的名稱／音數／staff 的音色與混音初始值都一致。
//    4. encodeMidi() 本身（parsed → 位元組 → 再解析）不改音符與速度表。
//  本機有曲庫（test/tools/library/，不進 git）時整個掃一遍。
//  用法：node test/unit/part-roundtrip.test.mjs
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { splitByPart, mergeParts, toBytes, noteMultiset } from '../tools/part-io.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '../../src/assets');
const FIXTURES = join(__dirname, '../fixtures');
const LIBRARY = join(__dirname, '../tools/library');

function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const parseFile = (path) => {
  const b = readFileSync(path);
  return parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const reparse = (bytes) => parseMidi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

/* ═══════════════════════════════════════════
   手工組的 MuseScore 形狀譜（跟 playability.test.mjs 同一套匯出器佈局）：鋼琴兩行譜、弓弦含 pizzicato、port 1 打擊
   ═══════════════════════════════════════════ */
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const vlq = (n) => { const b = [n & 0x7f]; n >>>= 7; while (n > 0) { b.unshift((n & 0x7f) | 0x80); n >>>= 7; } return b; };
const track = (events) => {
  const body = events.flatMap((e) => [...vlq(e.d), ...e.b]).concat([...vlq(0), 0xff, 0x2f, 0x00]);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
};
const midiFile = (tracks, format = 1) => new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, format, 0, tracks.length, 0x01, 0xe0, ...tracks.flat()]);
const enc = new TextEncoder();
const nameEv = (s) => { const b = [...enc.encode(s)]; return { d: 0, b: [0xff, 0x03, b.length, ...b] }; };
const portEv = (p) => ({ d: 0, b: [0xff, 0x21, 1, p] });
const tempoEv = (usPerQuarter, d = 0) => ({ d, b: [0xff, 0x51, 3, (usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255] });
const cc = (c, n, v) => ({ d: 0, b: [0xb0 | c, n, v] });
const initBlock = (c, program, { vol = 100, pan = 64, rev = 0, cho = 0 } = {}) =>
  [cc(c, 121, 0), { d: 0, b: [0xc0 | c, program] }, cc(c, 7, vol), cc(c, 10, pan), cc(c, 91, rev), cc(c, 93, cho)];
const notes = (c, pitches, { start = 0, dur = 479 } = {}) => pitches.flatMap((p, i) => [
  { d: i === 0 ? start : 1, b: [0x90 | c, p, 90 + i] }, { d: dur, b: [0x80 | c, p, 0] }]);

const museScoreShaped = () => parseMidi(midiFile([
  track([nameEv('Piano'), tempoEv(500000), ...initBlock(0, 0, { vol: 90 }), ...notes(0, [72, 74, 76, 77, 79, 81, 83, 84])]),
  track([nameEv('Piano'), ...notes(0, [48, 50, 52, 53, 55, 57, 59, 60])]),
  track([nameEv('Violin'), ...initBlock(1, 40), ...initBlock(2, 45, { vol: 80, pan: 30, rev: 20, cho: 10 }), ...initBlock(3, 44),
    ...notes(1, [67, 69, 71, 72]), ...notes(2, [60, 62, 64, 65], { start: 2400 })]),
  track([nameEv('Drumset'), portEv(1), ...initBlock(9, 0), ...notes(9, [36, 38, 36, 38, 36, 38, 36, 38], { dur: 100 })]),
]));

// format 0、同一軌混多種樂器（A14 依樂器類別拆 part）、速度中途改變
const format0Mixed = () => parseMidi(midiFile([
  track([tempoEv(500000), ...initBlock(0, 0), ...initBlock(1, 40), ...notes(0, [60, 62, 64, 65]), ...notes(1, [48, 50], { start: 100 }), tempoEv(400000, 960), ...notes(0, [67, 69], { start: 0 })]),
], 0));

// 一條沒有音符的 Meta 軌（只有軌名與速度）＋兩個樂器
const withMetaTrack = () => parseMidi(midiFile([
  track([nameEv('Meta'), tempoEv(600000)]),
  track([nameEv('Flute'), ...initBlock(0, 73), ...notes(0, [72, 74, 76, 77])]),
  track([nameEv('Cello'), ...initBlock(1, 42), ...notes(1, [48, 50, 52, 53])]),
]));

/* ═══════════════════════════════════════════
   比對
   ═══════════════════════════════════════════ */
const partSummary = (p) => ({
  name: p.name, noteCount: p.noteCount,
  staves: p.staves.map((s) => ({ program: s.program, bank: s.bank, percussionKit: s.percussionKit, init: s.init, noteCount: s.noteCount })),
});

// 分 → 合 → 位元組 → 再解析，跟原譜比：音符多重集合、速度表、拍號、各 part 結構
function roundTripProblems(original) {
  const problems = [];
  const splits = splitByPart(original);
  const merged = reparse(toBytes(mergeParts(splits)));
  const a = noteMultiset(original.notes), b = noteMultiset(merged.notes);
  if (a.length !== b.length) problems.push(`音符數 ${a.length} → ${b.length}`);
  else if (a.some((k, i) => k !== b[i])) problems.push(`音符內容不同（第一個差異 ${a.find((k, i) => k !== b[i])} vs ${b.find((k, i) => k !== a[i])}）`);
  const strip = (t) => t.map(({ ticks, microsecondsPerQuarter }) => ({ ticks, microsecondsPerQuarter }));
  if (JSON.stringify(strip(original.tempoMap)) !== JSON.stringify(strip(merged.tempoMap))) problems.push('速度表不同');
  if (JSON.stringify(original.timeSignatures) !== JSON.stringify(merged.timeSignatures)) problems.push('拍號不同');
  if (JSON.stringify(original.parts.map(partSummary)) !== JSON.stringify(merged.parts.map(partSummary))) problems.push('part／staff 結構不同');
  return problems;
}

/* ═══════════════════════════════════════════
   1. 切分互斥完整
   ═══════════════════════════════════════════ */
function partitionProblems(score) {
  const problems = [];
  const staffToPart = new Map();
  for (const p of score.parts) for (const s of p.staves) {
    if (staffToPart.has(s.id)) problems.push(`staff ${s.id} 出現在兩個 part`);
    staffToPart.set(s.id, p.id);
  }
  let total = 0;
  for (const n of score.notes) {
    if (staffToPart.get(n.staffId) !== n.partId) problems.push(`音符 ${n.staffId}/${n.partId} 找不到對應的 staff／part`);
    total++;
  }
  const staffSum = score.parts.reduce((a, p) => a + p.staves.reduce((x, s) => x + s.noteCount, 0), 0);
  if (staffSum !== total) problems.push(`staves 音數合計 ${staffSum} ≠ notes ${total}`);
  if (score.parts.reduce((a, p) => a + p.noteCount, 0) !== total) problems.push('parts 音數合計 ≠ notes');
  return problems.slice(0, 5);
}

const canon = parseFile(join(ASSETS, 'canon-violin-cello.mid'));
const samples = [
  ['canon 樣本', canon],
  ['MuseScore 形狀的手工譜', museScoreShaped()],
  ['format 0 同軌混樂器、速度中途改變', format0Mixed()],
  ['含 Meta 軌（無音符）', withMetaTrack()],
];

for (const [label, score] of samples) {
  run(`${label}：每顆音恰好屬於一個 part／staff，聯集 == 全部音符`, () => {
    const problems = partitionProblems(score);
    assert(problems.length === 0, problems.join('；'));
  });
  run(`${label}：分 → 合 → 位元組 → 再解析，音符、速度表、拍號、part／staff 結構不變`, () => {
    assert(score.parts.length >= 1, '至少 1 個 part');
    const problems = roundTripProblems(score);
    assert(problems.length === 0, problems.join('；'));
  });
}

/* ═══════════════════════════════════════════
   2. 標準答案：canon 的分譜檔
   ═══════════════════════════════════════════ */
for (const [name, file] of [['小提琴', 'canon-violin-cello-Violin.mid'], ['大提琴', 'canon-violin-cello-Violoncello.mid']]) {
  run(`canon 總譜切出的「${name}」，音符與 ${file} 完全一致`, () => {
    const split = splitByPart(canon).find((s) => s.name === name);
    assert(split, `找不到 part「${name}」`);
    const fromSplit = reparse(toBytes(split.model));
    const golden = parseFile(join(FIXTURES, file));
    const a = noteMultiset(fromSplit.notes), b = noteMultiset(golden.notes);
    assert(a.length === b.length, `音符數 ${a.length} vs ${b.length}`);
    assert(a.every((k, i) => k === b[i]), '音符內容不同');
    assert(JSON.stringify(fromSplit.tempoMap.map((t) => t.microsecondsPerQuarter)) === JSON.stringify(golden.tempoMap.map((t) => t.microsecondsPerQuarter)), '速度不同');
  });
}

/* ═══════════════════════════════════════════
   4. encodeMidi 本身
   ═══════════════════════════════════════════ */
for (const [label, score] of samples) {
  run(`${label}：parsed.tracks → encodeMidi → 再解析，音符與速度表不變`, () => {
    const again = reparse(toBytes({ format: score.format, division: score.division, tracks: score.tracks.map((t) => t.events) }));
    const a = noteMultiset(score.notes), b = noteMultiset(again.notes);
    assert(a.length === b.length && a.every((k, i) => k === b[i]), '音符不同');
    assert(JSON.stringify(score.tempoMap) === JSON.stringify(again.tempoMap), '速度表不同');
  });
}

/* ═══════════════════════════════════════════
   本機曲庫
   ═══════════════════════════════════════════ */
if (existsSync(LIBRARY)) {
  const files = readdirSync(LIBRARY).filter((f) => f.endsWith('.mid'));
  files.push(...['piano_sonata_332_1_(c)oguri.mid'].map((f) => `../../../src/assets/${f}`));
  run(`本機曲庫 ${files.length} 首：切分互斥完整、分 → 合 → 再解析一致`, () => {
    const bad = [];
    for (const f of files) {
      let score;
      try { score = parseFile(join(LIBRARY, f)); } catch (err) { bad.push(`${f}：解析失敗 ${err.message}`); continue; }
      const problems = [...partitionProblems(score), ...roundTripProblems(score)];
      if (problems.length) bad.push(`${f}：${problems.join('；')}`);
    }
    assert(bad.length === 0, `${bad.length} 首不一致：\n    ${bad.slice(0, 8).join('\n    ')}`);
  });
} else {
  console.log('\n（沒有 test/tools/library/，略過曲庫掃描；用 node test/tools/library-scan.mjs --download 抓取）');
}

console.log('\n全部測試跑完。');
