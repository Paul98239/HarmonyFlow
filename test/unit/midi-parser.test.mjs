// ============================================================
//  midi-parser.test.mjs — src/midi/midiParser.js 的回歸測試（純 Node，無瀏覽器）
//
//  沒有測試框架，跟 test/browser/smoke-test.mjs 同一套風格：run()／assert() 是整個專案
//  唯一的測試慣例。用法：node test/unit/midi-parser.test.mjs
//
//  聲部切分（Part／staff）的規則見 midiParser.js 的 groupTracks() 說明；這裡的手工檔模仿 MuseScore
//  匯出器的軌佈局：一個譜表一條 track，只有樂器最上行譜的 track 在 tick 0 對樂器的每個 channel 寫初始化區塊
//  （CC121、[Bank]、Program Change、CC7、CC10、CC91、CC93）。
// ============================================================

import { readFileSync } from 'node:fs';
import { parseMidi, midiNoteName, gmProgramNameZh } from '../../src/midi/midiParser.js';

function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── 手工組一個最小 MIDI 檔的工具：header + 一或多軌，每軌是 { deltaTick, bytes } 事件清單 ──
function u32(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
function u16(n) { return [(n >>> 8) & 0xff, n & 0xff]; }
function vlq(n) {
  const bytes = [n & 0x7f]; n >>>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>>= 7; }
  return bytes;
}
function track(events) {
  const body = [];
  for (const e of events) { body.push(...vlq(e.deltaTick), ...e.bytes); }
  body.push(...vlq(0), 0xff, 0x2f, 0x00); // End of Track
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body]; // "MTrk"
}
function midiFile(tracks, { division = 480, format = 1 } = {}) {
  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(division)];
  return new Uint8Array([...header, ...tracks.flat()]);
}

const enc = new TextEncoder();
const nameEv = (s) => { const b = [...enc.encode(s)]; return { deltaTick: 0, bytes: [0xff, 0x03, b.length, ...b] }; };
const tempoEv = (us, deltaTick = 0) => ({ deltaTick, bytes: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
const portEv = (p) => ({ deltaTick: 0, bytes: [0xff, 0x21, 1, p] });
const cc = (ch, n, v, deltaTick = 0) => ({ deltaTick, bytes: [0xb0 | ch, n, v] });
const pc = (ch, program, deltaTick = 0) => ({ deltaTick, bytes: [0xc0 | ch, program] });
// MuseScore 的初始化區塊：只寫在樂器最上行譜的 track，樂器的每個 channel 各一份。
const initBlock = (ch, program, { vol = 100, pan = 64, rev = 0, cho = 0, bank = null } = {}) => [
  cc(ch, 121, 0),
  ...(bank ? [cc(ch, 0, bank[0]), cc(ch, 32, bank[1])] : []),
  pc(ch, program),
  cc(ch, 7, vol), cc(ch, 10, pan), cc(ch, 91, rev), cc(ch, 93, cho),
];
// 依序彈 pitches：每顆 dur tick，首尾相接；start 是第一顆音的起點。
const notes = (ch, pitches, { start = 0, dur = 480 } = {}) => pitches.flatMap((p, i) => [
  { deltaTick: i === 0 ? start : 0, bytes: [0x90 | ch, p, 100] },
  { deltaTick: dur, bytes: [0x80 | ch, p, 0] },
]);

// ── 聲部切分：Part（MuseScore 的樂器）與 staff（一個譜表 × 一個樂器 channel）──

run('鋼琴兩行譜：下行譜沒有初始化區塊、軌名相同、同 channel → 1 個 part、2 個 staff', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Piano'), ...initBlock(0, 0), ...notes(0, [60, 62])]), // 上行譜
    track([nameEv('Piano'), ...notes(0, [48, 50])]),                     // 下行譜
  ]));
  assert(parsed.parts.length === 1, `預期 1 個 part，實際 ${parsed.parts.length}：${parsed.parts.map((p) => p.name)}`);
  const part = parsed.parts[0];
  assert(part.name === '大鋼琴', `名稱應為「大鋼琴」，實際「${part.name}」`);
  assert(part.staves.map((v) => v.id).join() === 't0c0,t1c0', `staff 應為 t0c0、t1c0，實際 ${part.staves.map((v) => v.id)}`);
  assert(part.noteCount === 4 && part.staves.every((v) => v.noteCount === 2), `音符數：part 4、每個 staff 2，實際 ${part.noteCount}／${part.staves.map((v) => v.noteCount)}`);
  assert(parsed.notes.every((n) => n.partId === part.id), '每顆音的 partId 都應該是這個 part');
  assert(parsed.notes.filter((n) => n.staffId === 't1c0').length === 2, '下行譜的音應標 staffId t1c0');
  assert(part.staves[1].program === 0 && part.staves[1].init?.volume === 100, '下行譜沿用上行譜（首軌）對這個 channel 的初始化');
});

run('staff 記下自己最低與最高的音高（分譜清單顯示譜表音域用）', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Piano'), ...initBlock(0, 0), ...notes(0, [60, 72, 64])]),
    track([nameEv('Piano'), ...notes(0, [36, 48])]),
  ]));
  const [upper, lower] = parsed.parts[0].staves;
  assert(upper.minPitch === 60 && upper.maxPitch === 72, `上行譜音域應為 60~72，實際 ${upper.minPitch}~${upper.maxPitch}`);
  assert(lower.minPitch === 36 && lower.maxPitch === 48, `下行譜音域應為 36~48，實際 ${lower.minPitch}~${lower.maxPitch}`);
});

run('音名：中央 C ＝ 60 ＝ C4，升記號用 #；超出 0~127 或不是整數回傳空字串', () => {
  const cases = [[60, 'C4'], [57, 'A3'], [88, 'E6'], [0, 'C-1'], [127, 'G9'], [61, 'C#4'], [36, 'C2']];
  for (const [n, name] of cases) assert(midiNoteName(n) === name, `${n} 應為 ${name}，實際 ${midiNoteName(n)}`);
  assert(midiNoteName(-1) === '' && midiNoteName(128) === '' && midiNoteName(60.5) === '' && midiNoteName(NaN) === '', '非法音高要回傳空字串');
});

run('音色名用台灣用語且全表一致：128 個音色都有名字、沒有重複、沒有大陸用語', () => {
  const names = Array.from({ length: 128 }, (_, p) => gmProgramNameZh(p));
  assert(names.every((n) => typeof n === 'string' && n.length > 0), '每個 program 都要有名字');
  assert(new Set(names).size === 128, '128 個名字不可重複：' + names.filter((n, i) => names.indexOf(n) !== i));
  const banned = ['原聲', '鋪底', '主音', '教堂', '合成貝斯', '合成弦樂', '合成銅管', '筒鼓', '人聲「'];
  for (const n of names) for (const b of banned) assert(!n.includes(b), `「${n}」含有非台灣用語「${b}」`);
  assert(gmProgramNameZh(0) === '大鋼琴' && gmProgramNameZh(19) === '管風琴' && gmProgramNameZh(32) === '原音貝斯' && gmProgramNameZh(80) === '方波主奏' && gmProgramNameZh(88) === '新世紀音墊', '代表性的幾個名字');
  assert(gmProgramNameZh(0, true) === '標準鼓組' && gmProgramNameZh(40, true) === '鼓刷鼓組', '鼓組名');
});

run('弓弦樂器三個 channel（normal／pizzicato／tremolo）：只有 normal 有音符 → 1 個 staff；pizzicato 也有音 → 2 個 staff', () => {
  const init = [...initBlock(0, 40), ...initBlock(1, 45), ...initBlock(2, 44)];
  const onlyNormal = parseMidi(midiFile([track([nameEv('Violin'), ...init, ...notes(0, [67])])]));
  assert(onlyNormal.parts.length === 1 && onlyNormal.parts[0].staves.length === 1, `只有 ch0 有音：預期 1 part 1 staff，實際 ${onlyNormal.parts.length}／${onlyNormal.parts[0]?.staves.length}`);
  const withPizz = parseMidi(midiFile([track([nameEv('Violin'), ...init, ...notes(0, [67, 69]), ...notes(1, [71])])]));
  const part = withPizz.parts[0];
  assert(withPizz.parts.length === 1 && part.staves.length === 2, `pizzicato 有音：預期 1 part 2 staff，實際 ${withPizz.parts.length}／${part.staves.length}`);
  assert(part.staves.map((v) => v.program).join() === '40,45', `兩個 staff 的音色應為 40、45，實際 ${part.staves.map((v) => v.program)}`);
  assert(part.name === '小提琴', `part 名稱取主 staff（音符最多）的音色：預期「小提琴」，實際「${part.name}」`);
});

run('兩個小提琴 Part（各自有初始化區塊）→ 2 個 part，命名「小提琴 1」「小提琴 2」', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Violin 1'), ...initBlock(0, 40), ...notes(0, [67])]),
    track([nameEv('Violin 2'), ...initBlock(1, 40), ...notes(1, [64])]),
  ]));
  assert(parsed.parts.map((p) => p.name).join() === '小提琴 1,小提琴 2', `名稱應依總譜順序加序號，實際 ${parsed.parts.map((p) => p.name)}`);
  assert(parsed.parts[0].id !== parsed.parts[1].id, '兩個 part 的 id 不同');
});

run('兩台鋼琴同名、同一個軌內 channel、各自有初始化區塊（第二台在 port 1）→ 2 個 part，不會併成一個', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Piano'), portEv(0), ...initBlock(0, 0), ...notes(0, [60])]),
    track([nameEv('Piano'), portEv(1), ...initBlock(0, 0), ...notes(0, [64])]),
  ]));
  assert(parsed.parts.map((p) => p.name).join() === '大鋼琴 1,大鋼琴 2', `有初始化區塊的 track 一定是新樂器的第一行譜，實際 ${parsed.parts.map((p) => p.name)}`);
});

run('軌名是空的、沒有初始化區塊、但用的是這組沒有的 channel → 另成一個 part（不是下行譜）', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Violin'), ...initBlock(0, 40), ...notes(0, [67])]),
    track([nameEv(''), ...notes(5, [48])]),
  ]));
  assert(parsed.parts.length === 2, `下行譜只會用上行譜已知的 channel，實際 ${parsed.parts.length} 個 part：${parsed.parts.map((p) => p.name)}`);
  // 用別的 channel、但自己送了同 GM family 的 Program Change（小提琴 40 → 41）：樂器類別相同，不會被「依樂器類別拆 part」補救，
  // 所以只能靠「channel 要在上行譜已知的範圍內」這條擋住併組。
  const sameFamily = parseMidi(midiFile([
    track([nameEv('Violin'), ...initBlock(0, 40), ...notes(0, [67])]),
    track([nameEv(''), { deltaTick: 0, bytes: [0xc5, 41] }, ...notes(5, [48])]),
  ]));
  assert(sameFamily.parts.length === 2, `別的 channel 不併入上一組（即使同一個 GM family），實際 ${sameFamily.parts.length} 個 part`);
});

run('part 名稱取音符最多的 staff 的音色（不是第一個 staff）：pizzicato channel 音符較多就叫「撥奏弦樂」', () => {
  const init = [...initBlock(0, 40), ...initBlock(1, 45)];
  const parsed = parseMidi(midiFile([track([nameEv('Violin'), ...init, ...notes(0, [67]), ...notes(1, [60, 62, 64])])]));
  assert(parsed.parts[0].staves.length === 2 && parsed.parts[0].name === '撥奏弦樂', `實際「${parsed.parts[0].name}」`);
});

run('基底名稱本身以數字結尾（弦樂合奏 1）：區分用全形括號，不疊成雙重數字', () => {
  const mk = (ch) => track([nameEv(`Strings ${ch}`), ...initBlock(ch, 48), ...notes(ch, [60])]);
  const parsed = parseMidi(midiFile([mk(0), mk(1)]));
  assert(parsed.parts.map((p) => p.name).join() === '弦樂合奏 1（1）,弦樂合奏 1（2）', `實際 ${parsed.parts.map((p) => p.name)}`);
});

run('打擊樂器在 port 1：絕對 channel 25（port 出現順序 +16）、percussionKit、名稱「標準鼓組」', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Piano'), portEv(0), ...initBlock(0, 0), ...notes(0, [60])]),
    track([nameEv('Drumset'), portEv(1), ...initBlock(9, 0), ...notes(9, [36, 38])]),
  ]));
  assert(parsed.parts.length === 2, `預期 2 個 part，實際 ${parsed.parts.length}`);
  const drum = parsed.parts[1];
  assert(drum.name === '標準鼓組', `名稱應為「標準鼓組」，實際「${drum.name}」`);
  const v = drum.staves[0];
  assert(v.channel === 25 && v.percussionKit === true, `打擊 staff 應在絕對 channel 25 且 percussionKit，實際 ${v.channel}／${v.percussionKit}`);
  assert(parsed.notes.filter((n) => n.partId === drum.id).every((n) => n.channel === 25), '打擊 part 的音符 channel 應為 25');
  assert(parsed.notes.find((n) => n.partId === parsed.parts[0].id).channel === 0, 'port 0 的音符 channel 維持 0');
});

run('初始化區塊取出：staff.init＝{volume, pan, reverb, chorus}、program、bank', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Flute'), ...initBlock(0, 73, { vol: 90, pan: 30, rev: 20, cho: 10, bank: [0, 4] }), ...notes(0, [72])]),
  ]));
  const v = parsed.parts[0].staves[0];
  assert(JSON.stringify(v.init) === JSON.stringify({ volume: 90, pan: 30, reverb: 20, chorus: 10 }), `init 實際 ${JSON.stringify(v.init)}`);
  assert(v.program === 73 && v.bank.msb === 0 && v.bank.lsb === 4, `program／bank 實際 ${v.program}／${JSON.stringify(v.bank)}`);
});

run('沒有初始化區塊的 staff：init 為 null；bank 沒送過就用 GM2 規格預設（旋律 121、打擊 channel 9 是 120）', () => {
  const parsed = parseMidi(midiFile([
    track([pc(0, 40), ...notes(0, [60])]),
    track([...notes(9, [36])]),
  ]));
  const [melodic, drum] = parsed.parts.map((p) => p.staves[0]);
  assert(melodic.init === null && melodic.program === 40, `旋律 staff：init 應為 null、program 40，實際 ${JSON.stringify(melodic.init)}／${melodic.program}`);
  assert(melodic.bank.msb === 121 && melodic.bank.lsb === 0 && melodic.percussionKit === false, `旋律 staff 的預設 bank 應為 121／0，實際 ${JSON.stringify(melodic.bank)}`);
  assert(drum.init === null && drum.bank.msb === 120 && drum.percussionKit === true, `channel 9 的預設 bank 應為 120（打擊），實際 ${JSON.stringify(drum.bank)}／${drum.percussionKit}`);
});

// ── 曲庫的佈局變體（全部走同一條規則）──

run('Meta 軌佈局：不含音符的第一軌被忽略，不成為 part', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Meta'), tempoEv(500000)]),
    track([nameEv('Oboe'), ...initBlock(0, 68), ...notes(0, [72])]),
  ]));
  assert(parsed.parts.length === 1 && parsed.parts[0].name === '雙簧管', `預期只有「雙簧管」，實際 ${parsed.parts.map((p) => p.name)}`);
});

run('〈蝸牛與黃鸝鳥〉的結構（使用者用原始 MuseScore 檔確認過）：長笛＋鋼琴（上行譜有初始化區塊、下行譜只有 Program Change）→ 2 個 part，鋼琴 2 個 staff', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Metadata'), tempoEv(500000)]),                                        // 不含音符的 Meta 軌
    track([nameEv(''), ...initBlock(0, 73), ...notes(0, [76, 77])]),                     // 長笛：軌名是空的
    track([nameEv('Piano'), ...initBlock(1, 0), ...notes(1, [60, 64])]),                 // 鋼琴上行譜
    track([nameEv('Piano'), pc(1, 0), ...notes(1, [48, 52])]),                           // 鋼琴下行譜：只有 Program Change
  ]));
  assert(parsed.parts.map((p) => p.name).join() === '長笛,大鋼琴', `應為「長笛、大鋼琴」，實際 ${parsed.parts.map((p) => p.name)}`);
  assert(parsed.parts[1].staves.length === 2, `鋼琴應有 2 個 staff（兩個譜表），實際 ${parsed.parts[1].staves.length}`);
});

run('第一個樂器軌名稱是空的、下行譜有名稱：併入同一個 part（任一方軌名為空都算相同）', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Meta'), tempoEv(500000)]),
    track([nameEv(''), ...initBlock(0, 0), ...notes(0, [60])]),
    track([nameEv('Piano'), ...notes(0, [48])]),
  ]));
  assert(parsed.parts.length === 1, `預期 1 個 part，實際 ${parsed.parts.length}：${parsed.parts.map((p) => p.name)}`);
});

run('舊檔（沒有初始化區塊、軌名 Right Hand／Left Hand 不同）：2 個 part，同音色命名「大鋼琴 1」「大鋼琴 2」', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Right Hand'), pc(0, 0), ...notes(0, [72])]),
    track([nameEv('Left Hand'), pc(0, 0), ...notes(0, [48])]),
  ]));
  assert(parsed.parts.map((p) => p.name).join() === '大鋼琴 1,大鋼琴 2', `實際 ${parsed.parts.map((p) => p.name)}`);
});

run('名稱只依 program：不採信軌名、不放高低音譜／旋律伴奏／bank 的任何描述', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Bass Guitar'), ...initBlock(0, 24, { bank: [0, 1] }), ...notes(0, [40])]), // 軌名說是貝斯，program 是尼龍弦吉他
  ]));
  assert(parsed.parts[0].name === '尼龍弦吉他', `名稱只依 program，實際「${parsed.parts[0].name}」`);
});

run('canon 金標準：2 個 part（小提琴／大提琴）、各 1 個 staff、513／453 顆音、init＝100／64／0／0、零警告', () => {
  const buf = readFileSync(new URL('../../src/assets/canon-violin-cello.mid', import.meta.url));
  const parsed = parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert(parsed.parts.map((p) => p.name).join() === '小提琴,大提琴', `實際 ${parsed.parts.map((p) => p.name)}`);
  assert(parsed.parts.every((p) => p.staves.length === 1), 'canon 每個 part 只有 1 個 staff');
  assert(parsed.parts.map((p) => p.noteCount).join() === '513,453', `音符數應為 513、453，實際 ${parsed.parts.map((p) => p.noteCount)}`);
  for (const p of parsed.parts) {
    assert(JSON.stringify(p.staves[0].init) === JSON.stringify({ volume: 100, pan: 64, reverb: 0, chorus: 0 }), `${p.name} 的 init 實際 ${JSON.stringify(p.staves[0].init)}`);
  }
  assert(parsed.warnings.length === 0, `canon 不該有任何警告，實際 ${parsed.warnings}`);
});

// ── 資料形狀：刪掉的欄位不再出現 ──

run('已刪除的欄位（clef／role／medianNote／trackName…）不再出現在 part、staff、note 上', () => {
  const parsed = parseMidi(midiFile([track([nameEv('Piano'), ...initBlock(0, 0), ...notes(0, [60])])]));
  const gone = ['clef', 'role', 'medianNote', 'polyphonyAvg', 'lowestNote', 'highestNote', 'programs', 'programName', 'trackName', 'instrumentName', 'isDrum'];
  for (const k of gone) assert(!(k in parsed.parts[0]), `part 不該再有 ${k}`);
  for (const k of ['onEvent', 'offVelocity', 'program']) assert(!(k in parsed.notes[0]), `note 不該再有 ${k}`);
});

// ── program／bank 依時間軸查詢（沒有初始化區塊時；不是依軌道處理順序）──
// 修正對象：collectNotes()／collectParts() 曾經把 currentProgram 依「檔案裡的軌序」逐軌
// 處理，讀到的是「前面各軌處理完畢時留下的值」，不是「這顆音那個時間點該有的值」。

run('情境 A：音符在無 PC 的軌、PC 在另一軌——依時間軸查詢，不是依軌序', () => {
  const trackNotes = track([
    { deltaTick: 480, bytes: [0x90, 60, 100] }, // tick 480: note on C4, ch0（無 PC）
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ]);
  const trackPC = track([pc(0, 40)]); // tick 0: PC 40, ch0
  const parsed = parseMidi(midiFile([trackNotes, trackPC]));
  assert(parsed.notes.length === 1, `預期 1 顆音符，實際 ${parsed.notes.length}`);
  assert(parsed.parts[0].staves[0].program === 40, `依時間軸查詢應該是 program 40，實際 ${parsed.parts[0].staves[0].program}`);
});

run('情境 B：同一 channel 兩次 PC，音符夾在中間', () => {
  const trackNotes = track([
    { deltaTick: 480, bytes: [0x90, 60, 100] },
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ]);
  const trackPC = track([pc(0, 40), pc(0, 41, 960)]);
  const parsed = parseMidi(midiFile([trackNotes, trackPC]));
  assert(parsed.notes.length === 1, '預期 1 顆音符');
  assert(parsed.parts[0].staves[0].program === 40, `音符落在 PC40 之後、PC41 之前，應該是 40，實際 ${parsed.parts[0].staves[0].program}`);
});

run("情境 B'：自己軌自己送過 PC 時優先採用，不查全曲時間軸", () => {
  const trackA = track([
    pc(0, 5),
    { deltaTick: 480, bytes: [0x90, 60, 100] },
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ]);
  const trackB = track([pc(0, 99)]); // 同 channel，不該影響 A
  const parsed = parseMidi(midiFile([trackA, trackB]));
  assert(parsed.notes.length === 1, '預期 1 顆音符');
  assert(parsed.parts[0].staves[0].program === 5, `自己軌的 PC5 應該優先，實際 ${parsed.parts[0].staves[0].program}`);
});

run('有初始化區塊的 staff：program 只看 tick 0，之後 tick>0 的 Program Change 被忽略', () => {
  const parsed = parseMidi(midiFile([
    track([...initBlock(0, 40), ...notes(0, [60]), pc(0, 41, 480), ...notes(0, [62])]),
  ]));
  assert(parsed.parts.length === 1 && parsed.parts[0].staves.length === 1, `同一個 (track, channel) 只有 1 個 staff，實際 ${parsed.parts.length}／${parsed.parts[0]?.staves.length}`);
  assert(parsed.parts[0].staves[0].program === 40, `program 應為 tick 0 的 40，實際 ${parsed.parts[0].staves[0].program}`);
});

run('有初始化區塊的 staff：tick>0 的 Program Change 就算在第一顆音之前出現也被忽略', () => {
  const parsed = parseMidi(midiFile([
    track([...initBlock(0, 40), pc(0, 41, 240), ...notes(0, [60], { start: 240 })]), // tick 240 換成 41，第一顆音在 tick 480
  ]));
  assert(parsed.parts[0].staves[0].program === 40, `program 應為 tick 0 的 40，實際 ${parsed.parts[0].staves[0].program}`);
});

// ── 時間軸與 port 的對齊（跟官方 SpessaSynth 一致；差異測試 oracle.test.mjs 另外對照）──

run('同 tick 的速度衝突：後出現者生效（跟官方一致）', () => {
  const parsed = parseMidi(midiFile([
    track([tempoEv(500000), tempoEv(750000, 480), { deltaTick: 480, bytes: [0x90, 60, 100] }, { deltaTick: 480, bytes: [0x80, 60, 0] }]),
    track([tempoEv(1000000, 480)]), // 同樣在 tick 480，後出現（軌序在後）
  ]));
  // tick 0~480 以 120 BPM（0.5s）；tick 480 起後出現的 60 BPM（1s／四分音符）生效，tick 960 起音＝0.5 + 1 = 1.5s
  assert(Math.abs(parsed.notes[0].startSeconds - 1.5) < 1e-9, `起音應為 1.5s（後出現者生效），實際 ${parsed.notes[0].startSeconds}`);
});

run('MuseScore 的空譜表：鋼琴只有一行譜有音、另一行是空的（有初始化區塊或只有軌名），仍是一個 part、一個 staff，初始音量取首軌的', () => {
  const partsOf = (tracks) => parseMidi(midiFile(tracks)).parts;
  // 上行譜只有初始化區塊（空）、下行譜有音：staff 只有下行譜那一個，音量 90 取自首軌（上行譜）的初始化區塊
  const upperEmpty = partsOf([track([nameEv('Piano'), ...initBlock(0, 0, { vol: 90 })]), track([nameEv('Piano'), ...notes(0, [48, 50, 52])])]);
  assert(upperEmpty.length === 1 && upperEmpty[0].staves.length === 1 && upperEmpty[0].staves[0].init?.volume === 90,
    `上行譜空、下行譜有音：1 個 part、1 個 staff、音量 90，實際 ${JSON.stringify(upperEmpty.map((p) => [p.name, p.staves.map((v) => [v.id, v.init?.volume])]))}`);
  // 下行譜整條空軌（只有軌名）：不多出 staff，也不影響後面的長笛
  const lowerEmpty = partsOf([track([nameEv('Piano'), ...initBlock(0, 0, { vol: 90 }), ...notes(0, [72, 74])]), track([nameEv('Piano')]), track([nameEv('Flute'), ...initBlock(1, 73), ...notes(1, [80])])]);
  assert(lowerEmpty.length === 2 && lowerEmpty[0].staves.length === 1 && lowerEmpty[1].staves.length === 1, `鋼琴（一個 staff）＋長笛，實際 ${lowerEmpty.length} 個 part`);
  // 鋼琴兩行譜都空：整個樂器不成 part
  const bothEmpty = partsOf([track([nameEv('Piano'), ...initBlock(0, 0, { vol: 90 })]), track([nameEv('Piano')]), track([nameEv('Flute'), ...initBlock(1, 73), ...notes(1, [80])])]);
  assert(bothEmpty.length === 1 && bothEmpty[0].staves.length === 1, `兩行譜都空的鋼琴不成 part，只剩長笛，實際 ${bothEmpty.length} 個 part`);
});

run('同 tick 的拍號與調號衝突：後出現者生效（跟速度表、官方一致），不重複列出同一個 tick', () => {
  const timeSig = (nn, dd, deltaTick = 0) => ({ deltaTick, bytes: [0xff, 0x58, 4, nn, dd, 24, 8] });
  const keySig = (sf) => ({ deltaTick: 0, bytes: [0xff, 0x59, 2, sf, 0] });
  const parsed = parseMidi(midiFile([
    track([timeSig(4, 2), timeSig(3, 2, 480), keySig(1), { deltaTick: 480, bytes: [0x90, 60, 100] }, { deltaTick: 480, bytes: [0x80, 60, 0] }]),
    track([timeSig(6, 3, 480), keySig(2)]), // tick 480 的拍號與 tick 480 的調號都是這一軌後出現
  ]));
  const at480 = parsed.timeSignatures.filter((t) => t.ticks === 480);
  assert(at480.length === 1 && at480[0].numerator === 6 && at480[0].denominator === 8, `tick 480 只該有一筆 6/8（後出現者），實際 ${JSON.stringify(at480)}`);
  assert(parsed.timeSignatures.length === 2, `tick 0 與 tick 480 各一筆，實際 ${parsed.timeSignatures.length} 筆`);
  const keys480 = parsed.keySignatures.filter((k) => k.ticks === 480 || k.ticks === 0);
  assert(keys480.at(-1).sharpsFlats === 2, `同 tick 的調號後出現者生效（2 個升記號），實際 ${JSON.stringify(parsed.keySignatures)}`);
});

run('port 絕對 channel：依軌序第一次出現的 port 各 +16，沒有指定 port 的軌用最小的已指定 port', () => {
  const parsed = parseMidi(midiFile([
    track([portEv(2), ...initBlock(0, 0), ...notes(0, [60])]),   // 第一個出現的 port（值 2）→ offset 0
    track([portEv(5), ...initBlock(0, 40), ...notes(0, [62])]),  // 第二個 port → offset 16
    track([...initBlock(1, 73), ...notes(1, [64])]),             // 沒指定 port → 最小的已指定 port（2）→ offset 0
  ]));
  const chOf = (name) => parsed.notes.find((n) => n.partId === parsed.parts.find((p) => p.name === name).id).channel;
  assert(chOf('大鋼琴') === 0 && chOf('小提琴') === 16 && chOf('長笛') === 1, `絕對 channel 應為 0／16／1，實際 ${chOf('大鋼琴')}／${chOf('小提琴')}／${chOf('長笛')}`);
});

run('沒有初始化區塊的 staff 查 program：只看同一個絕對 channel，不吃到別的 port 同號 channel 的 Program Change', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Violin'), portEv(0), ...initBlock(0, 40), ...notes(0, [60])]), // port 0 的 channel 0＝絕對 channel 0，program 40
    track([nameEv('Other'), portEv(1), ...notes(0, [62])]),                       // port 1 的 channel 0＝絕對 channel 16，從沒收過 Program Change
  ]));
  const other = parsed.parts.find((p) => p.staves[0].id === 't1c16');
  assert(other, `應該有一個 staff 叫 t1c16，實際 ${parsed.parts.map((p) => p.staves.map((s) => s.id))}`);
  assert(other.staves[0].program === 0, `絕對 channel 16 沒有任何 Program Change，應該是規格預設 0，實際 ${other.staves[0].program}（被 port 0 的 channel 0 汙染）`);
  // 對照：同一個 port 內沒有自己的 Program Change 時，仍沿用同 channel 更早的 Program Change（原本的行為不變）
  const samePort = parseMidi(midiFile([
    track([nameEv('Violin'), portEv(0), ...initBlock(0, 40), ...notes(0, [60])]),
    track([nameEv('Other'), portEv(0), ...notes(0, [62])]),
  ]));
  assert(samePort.parts.find((p) => p.staves[0].id === 't1c0').staves[0].program === 40, '同一個 port 的同號 channel 仍要沿用 program 40');
});

// ── segments：全曲的垂直切片（同一個 startTick 的所有音，跨聲部、跨譜表）──

run('segments：相同 startTick 的音（跨 part、跨 staff）併成一個 segment，每顆音恰好在一個 segment，ticks 嚴格遞增', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Piano'), ...initBlock(0, 0), ...notes(0, [60, 62, 64])]),        // 上行譜：tick 0、480、960
    track([nameEv('Piano'), ...notes(0, [48, 50], { start: 0, dur: 960 })]),        // 下行譜：tick 0、960
    track([nameEv('Flute'), ...initBlock(1, 73), ...notes(1, [72], { start: 480 })]), // 長笛：tick 480
  ]));
  const startTicks = [...new Set(parsed.notes.map((n) => n.startTick))].sort((a, b) => a - b);
  assert(parsed.segments.map((s) => s.ticks).join() === startTicks.join() && startTicks.join() === '0,480,960', `segment 的 ticks 應為 0,480,960，實際 ${parsed.segments.map((s) => s.ticks)}`);
  assert(parsed.segments.map((s) => s.notes.length).join() === '2,2,2', `tick 0＝上＋下行譜、480＝上行譜＋長笛、960＝上＋下行譜，實際 ${parsed.segments.map((s) => s.notes.length)}`);
  const flat = parsed.segments.flatMap((s) => s.notes);
  assert(flat.length === parsed.notes.length && new Set(flat).size === parsed.notes.length, '每顆音恰好在一個 segment（同一個物件，不是複本）');
  assert(parsed.segments.every((s) => s.notes.every((n) => n.startTick === s.ticks)), 'segment 裡每顆音的 startTick 都等於 segment.ticks');
  assert(parsed.segments.every((s, i) => i === 0 || s.ticks > parsed.segments[i - 1].ticks), 'segment 的 ticks 嚴格遞增');
  assert(new Set(parsed.segments[0].notes.map((n) => n.partId)).size === 1 && new Set(parsed.segments[1].notes.map((n) => n.partId)).size === 2, 'tick 0 只有鋼琴（一個 part、兩個 staff），tick 480 有鋼琴與長笛兩個 part');
});

run('segments：沒有音符的檔案回空陣列', () => {
  const parsed = parseMidi(midiFile([track([tempoEv(500000)])]));
  assert(Array.isArray(parsed.segments) && parsed.segments.length === 0, `應為空陣列，實際 ${JSON.stringify(parsed.segments)}`);
});

// ── secondsToMIDITicks：midiTicksToSeconds 的反函數（分段線性，跨多次速度變化）──

run('secondsToMIDITicks 與 midiTicksToSeconds 互為反函數（跨多次速度變化，含區段邊界）', () => {
  const parsed = parseMidi(midiFile([
    track([tempoEv(500000), tempoEv(1000000, 480), tempoEv(250000, 960), { deltaTick: 2000, bytes: [0x90, 60, 100] }, { deltaTick: 480, bytes: [0x80, 60, 0] }]),
  ]));
  for (const t of [0, 1, 240, 479, 480, 481, 1000, 1439, 1440, 1441, 2000, 4000, 5000]) {
    const back = parsed.secondsToMIDITicks(parsed.midiTicksToSeconds(t));
    assert(Math.abs(back - t) < 1e-6, `tick ${t} → 秒 → tick 應回到 ${t}，實際 ${back}`);
  }
  for (const s of [0, 0.25, 0.5, 0.75, 1.5, 2, 3.7]) {
    const back = parsed.midiTicksToSeconds(parsed.secondsToMIDITicks(s));
    assert(Math.abs(back - s) < 1e-9, `${s}s → tick → 秒 應回到 ${s}，實際 ${back}`);
  }
  // 手算驗證：tick 0~480 以 0.5s／四分音符 → 0.5s 在 tick 480；480~960 以 1s／四分音符 → 1.0s 在 tick 720、1.5s 在 tick 960
  assert(Math.abs(parsed.secondsToMIDITicks(1) - 720) < 1e-9 && Math.abs(parsed.secondsToMIDITicks(1.5) - 960) < 1e-9, `1s 應為 tick 720、1.5s 應為 tick 960，實際 ${parsed.secondsToMIDITicks(1)}／${parsed.secondsToMIDITicks(1.5)}`);
});

run('secondsToMIDITicks：SMPTE division 直接乘 ticksPerSecond（速度事件不參與）', () => {
  // division 0xE728：-25 fps、每格 40 tick → 1000 tick／秒
  const parsed = parseMidi(midiFile([track([tempoEv(1000000), ...notes(0, [60], { dur: 500 })])], { division: 0xe728 }));
  assert(parsed.secondsToMIDITicks(2) === 2000 && parsed.midiTicksToSeconds(parsed.secondsToMIDITicks(1.25)) === 1.25, `SMPTE 應為 1000 tick／秒，實際 ${parsed.secondsToMIDITicks(2)}`);
});

// ── 沒有 note on 的 note off：MuseScore 的演奏法 channel ──

run('MuseScore 補送的 note off（同軌、同 tick、同音高、別的 channel 有 note on）認出來就不警告，音符不受影響', () => {
  // ch0 是普通演奏（有音），ch1、ch2 是同一樂器的撥奏／震音 channel：每個音起音時各補一個同音高的 note off。
  // ch1 用 0x80，ch2 用「力度 0 的 note on」（MuseScore 實際匯出的寫法）；60、64 先寫 note on，62 先寫補送的 note off，
  // 驗證認定跟同一個 tick 內的事件順序無關。
  const strayOff = (ch, p) => ({ deltaTick: 0, bytes: [0x80 | ch, p, 0] });
  const strayVel0 = (ch, p) => ({ deltaTick: 0, bytes: [0x90 | ch, p, 0] });
  const on = (p) => ({ deltaTick: 0, bytes: [0x90, p, 100] });
  const events = [nameEv('Violin'), ...initBlock(0, 40), ...initBlock(1, 45), ...initBlock(2, 44)];
  [60, 62, 64].forEach((p) => {
    if (p === 62) events.push(strayOff(1, p), strayVel0(2, p), on(p));
    else events.push(on(p), strayOff(1, p), strayVel0(2, p));
    events.push({ deltaTick: 480, bytes: [0x80, p, 0] });
  });
  const parsed = parseMidi(midiFile([track(events)]));
  const warns = parsed.warnings.filter((w) => w.includes('沒有對應的 note on'));
  assert(parsed.notes.length === 3 && parsed.parts.length === 1, `3 顆音、1 個 part 不受影響，實際 ${parsed.notes.length} 顆／${parsed.parts.length} 個 part`);
  assert(warns.length === 0, `每個 note off 都在同 tick 同音高的別的 channel 找得到 note on，不該警告，實際 ${warns.length} 則：${warns}`);
});

run('對不上 MuseScore 模式的孤立 note off（音高不同、tick 不同）照舊依「軌＋channel」彙整成一則警告，位置取第一個對不上的', () => {
  const strayOff = (ch, p, delta = 0) => ({ deltaTick: delta, bytes: [0x80 | ch, p, 0] });
  const events = [nameEv('Violin'), ...initBlock(0, 40), ...initBlock(1, 45), ...initBlock(2, 44),
    { deltaTick: 0, bytes: [0x90, 60, 100] },
    strayOff(1, 60),                                  // 配得上：ch0 在 tick 0 有音高 60 的 note on，不警告
    strayOff(1, 61), strayOff(1, 62),                 // 同 tick 但沒有這個音高的 note on，對不上
    { deltaTick: 480, bytes: [0x80, 60, 0] },
    strayOff(2, 60)];                                 // 音高對但 tick 不同（ch0 在 tick 480 只有 note off），對不上
  const parsed = parseMidi(midiFile([track(events)]));
  const warns = parsed.warnings.filter((w) => w.includes('沒有對應的 note on'));
  assert(parsed.notes.length === 1, `音符不受影響，實際 ${parsed.notes.length} 顆`);
  assert(warns.length === 2, `ch1、ch2 各一則（共 2 則），實際 ${warns.length} 則：${warns}`);
  const w1 = warns.find((w) => w.includes('channel 1：')), w2 = warns.find((w) => w.includes('channel 2：'));
  assert(w1 && w1.includes('2 個') && w1.includes('tick 0') && w1.includes('音高 61'), `ch1 要寫 2 個（配得上的那個不算），位置取第一個對不上的（tick 0、音高 61），實際 ${w1}`);
  assert(w2 && w2.includes('1 個') && w2.includes('tick 480') && w2.includes('音高 60'), `ch2 要寫 1 個、tick 480、音高 60，實際 ${w2}`);
});

run('孤立 note off 只認「別的 channel」的 note on：同一個 channel 在同 tick 同音高重新起音不算配對，要警告', () => {
  const events = [nameEv('Violin'), ...initBlock(0, 40),
    { deltaTick: 0, bytes: [0x90, 60, 100] }, { deltaTick: 480, bytes: [0x80, 60, 0] },
    { deltaTick: 0, bytes: [0x80, 60, 0] },           // 前一顆已收掉，這個 note off 沒有對應的 note on
    { deltaTick: 0, bytes: [0x90, 60, 100] }, { deltaTick: 480, bytes: [0x80, 60, 0] }];
  const parsed = parseMidi(midiFile([track(events)]));
  const warns = parsed.warnings.filter((w) => w.includes('沒有對應的 note on'));
  assert(parsed.notes.length === 2, `2 顆音不受影響，實際 ${parsed.notes.length} 顆`);
  assert(warns.length === 1 && warns[0].includes('channel 0：') && warns[0].includes('1 個'), `同 channel 不算配對，要警告 1 則，實際 ${warns}`);
});

// ── 容器容錯：RMID 外包裝、檔頭雜訊、tick 過大（只改「怎麼讀」，音符資料不動）──

const u32le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const smfSample = () => midiFile([track([nameEv('Violin'), ...initBlock(0, 40), ...notes(0, [60, 62, 64])])]);

run('RMID 外包裝（RIFF…RMID…data）：取出裡面的 Standard MIDI File，結果跟裸檔一樣，並警告', () => {
  const smf = smfSample();
  const pad = smf.length % 2 ? [0] : [];                                  // RIFF chunk 要對齊到偶數位元組
  const body = [...enc.encode('RMID'), ...enc.encode('data'), ...u32le(smf.length), ...smf, ...pad];
  const rmid = new Uint8Array([...enc.encode('RIFF'), ...u32le(body.length), ...body]);
  const plain = parseMidi(smf), wrapped = parseMidi(rmid);
  assert(wrapped.notes.length === 3 && JSON.stringify(wrapped.notes.map((n) => [n.midiNote, n.startTick, n.endTick])) === JSON.stringify(plain.notes.map((n) => [n.midiNote, n.startTick, n.endTick])), 'RMID 解出來的音符要跟裸檔完全一樣');
  assert(wrapped.warnings.some((w) => w.includes('RMID')), `應該有一則提到 RMID 的警告，實際 ${wrapped.warnings}`);
});

run('RIFF 但不是 RMID（例如 WAVE）：仍然丟錯，訊息說清楚', () => {
  const wave = new Uint8Array([...enc.encode('RIFF'), ...u32le(4), ...enc.encode('WAVE')]);
  let err = null;
  try { parseMidi(wave); } catch (e) { err = e; }
  assert(err && err.name === 'MidiParseError' && err.message.includes('不是 RMID'), `應丟 MidiParseError 並說「不是 RMID」，實際 ${err?.message}`);
});

run('檔頭前有雜訊（例如別的格式的檔頭殘留）：在前 4KB 內找 MThd，略過雜訊並警告；超過 4KB 找不到就丟錯', () => {
  const smf = smfSample();
  const junk = Array.from({ length: 37 }, (_, i) => (i * 7) & 0x7f);
  const parsed = parseMidi(new Uint8Array([...junk, ...smf]));
  assert(parsed.notes.length === 3, `略過雜訊後照常解析，實際 ${parsed.notes.length} 顆音`);
  assert(parsed.warnings.some((w) => w.includes('37') && w.includes('MThd')), `警告要寫出雜訊的位元組數與 MThd，實際 ${parsed.warnings}`);
  let err = null;
  try { parseMidi(new Uint8Array([...new Array(5000).fill(0x20), ...smf])); } catch (e) { err = e; }
  assert(err && err.name === 'MidiParseError', '雜訊超過 4KB 還找不到 MThd：丟 MidiParseError');
});

run('tick 超過 1e7：警告「可能損毀」（pretty_midi 同樣視為損毀），但照常解析', () => {
  const parsed = parseMidi(midiFile([track([nameEv('Piano'), ...initBlock(0, 0), ...notes(0, [60], { start: 20000000 })])]));
  assert(parsed.notes.length === 1 && parsed.notes[0].startTick === 20000000, '音符照常解析');
  assert(parsed.warnings.some((w) => w.includes('損毀')), `應該警告可能損毀，實際 ${parsed.warnings}`);
});

// ── 多 channel 的軌：依 GM family 拆 part（format 0、同軌混多樂器），MuseScore 的演奏法 channel 維持同一個 part ──

run('format 0 同一條軌混多種樂器（鋼琴／小提琴／打擊，各自有 Program Change）：依 GM family 拆成 3 個 part，id 與 staff 對得上', () => {
  const parsed = parseMidi(midiFile([track([
    pc(0, 0), pc(1, 40), pc(9, 0),
    ...notes(0, [60, 62]), ...notes(1, [72, 74]), ...notes(9, [36, 38]),
  ])], { format: 0 }));
  assert(parsed.parts.length === 3, `3 個 part，實際 ${parsed.parts.length}：${parsed.parts.map((p) => p.name)}`);
  assert(parsed.parts.map((p) => p.name).join() === '大鋼琴,小提琴,標準鼓組', `名稱依 GM 音色，實際 ${parsed.parts.map((p) => p.name)}`);
  assert(parsed.parts.map((p) => p.id).join() === 'p0,p0.1,p0.2', `part id 依序為 p0、p0.1、p0.2，實際 ${parsed.parts.map((p) => p.id)}`);
  assert(parsed.parts.map((p) => p.staves.map((v) => v.id).join()).join('|') === 't0c0|t0c1|t0c9', `staff 各一個，實際 ${parsed.parts.map((p) => p.staves.map((v) => v.id))}`);
  assert(parsed.parts[2].staves[0].percussionKit, '打擊 channel 是打擊 staff');
  assert(parsed.notes.length === 6 && parsed.segments.reduce((a, s) => a + s.notes.length, 0) === 6, '音符一顆不少、segments 照舊涵蓋全部');
  assert(parsed.notes.filter((n) => n.partId === 'p0.1').every((n) => n.staffId === 't0c1'), '音符的 partId 與 staffId 對應');
  assert(parsed.warnings.some((w) => w.includes('3 個') && w.includes('part')), `要有一則說明拆成 3 個 part 的警告，實際 ${parsed.warnings}`);
});

run('MuseScore 的演奏法 channel（小提琴 40／撥奏 45／震音 44，同一個 GM family）維持同一個 part，不被誤拆', () => {
  const parsed = parseMidi(midiFile([track([nameEv('Violin'), ...initBlock(0, 40), ...initBlock(1, 45), ...initBlock(2, 44),
    ...notes(0, [60, 62]), ...notes(1, [64], { start: 2400 }), ...notes(2, [65], { start: 3600 })])]));
  assert(parsed.parts.length === 1 && parsed.parts[0].staves.length === 3, `1 個 part、3 個 staff，實際 ${parsed.parts.length} 個 part`);
  assert(!parsed.warnings.some((w) => w.includes('拆成')), '沒有拆 part 就不該有拆分的警告');
});

run('下行譜自己送了不同的 Program Change：判定樂器類別跟 staff 音色一樣以首軌為準，仍是同一個 part（〈卡門〉的下行譜曾被誤拆）', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Violin'), ...initBlock(0, 40), ...notes(0, [72, 74])]),       // 上行譜：有初始化區塊，小提琴
    track([nameEv('Violin'), pc(0, 0), ...notes(0, [60, 62])]),                  // 下行譜：只有一個 Program Change（0），沒有初始化區塊
  ]));
  assert(parsed.parts.length === 1 && parsed.parts[0].staves.length === 2, `仍是 1 個 part、2 個 staff，實際 ${parsed.parts.length} 個 part：${parsed.parts.map((p) => p.name)}`);
  assert(parsed.parts[0].staves.every((v) => v.program === 40), '下行譜的 staff 沿用首軌的音色（小提琴 40）');
});

// ── 警告彙整：速度／拍號出現在非第一軌 ──

run('速度／拍號出現在非第一軌：與第一軌完全相同的不報（照樣有效），不同的依種類彙整成一則', () => {
  const timeSig = (nn, dd) => ({ deltaTick: 0, bytes: [0xff, 0x58, 4, nn, dd, 24, 8] });
  const same = parseMidi(midiFile([track([timeSig(4, 2), tempoEv(500000)]), track([nameEv('A'), timeSig(4, 2), ...notes(0, [60])]), track([nameEv('B'), timeSig(4, 2), ...notes(1, [62])])]));
  assert(!same.warnings.some((w) => w.includes('非第一軌')), `跟第一軌相同的拍號不該警告，實際 ${same.warnings}`);
  const diff = parseMidi(midiFile([track([timeSig(4, 2)]), track([nameEv('A'), timeSig(3, 2), ...notes(0, [60])]), track([nameEv('B'), timeSig(3, 2), tempoEv(400000), ...notes(1, [62])]), track([nameEv('C'), tempoEv(300000), ...notes(2, [64])])]));
  const sig = diff.warnings.filter((w) => w.includes('Time Signature') && w.includes('非第一軌')), tempo = diff.warnings.filter((w) => w.includes('Set Tempo') && w.includes('非第一軌'));
  assert(sig.length === 1 && sig[0].includes('2 次'), `拍號 2 次彙整成 1 則，實際 ${sig}`);
  assert(tempo.length === 1 && tempo[0].includes('2 次'), `速度 2 次彙整成 1 則，實際 ${tempo}`);
});

// ── running status 寬鬆讀取 ──
// 修正對象：parseTrack() 曾經在遇到 meta／SysEx 事件後把 runningStatus 清成 0，
// 導致緊接著沿用 running status 的檔案被整軌截斷。

run('情境 C：running status 跨過 meta 事件仍能正確讀取，不再截斷整軌', () => {
  const trackNotes = track([
    { deltaTick: 0, bytes: [0x90, 60, 100] },
    { deltaTick: 10, bytes: [0xff, 0x01, 0x03, 0x61, 0x62, 0x63] }, // FF01 文字事件
    { deltaTick: 10, bytes: [62, 100] },  // note on D4，沿用 running status
    { deltaTick: 480, bytes: [60, 0] },   // note off C4，沿用 running status
    { deltaTick: 0, bytes: [62, 0] },     // note off D4，沿用 running status
  ]);
  const parsed = parseMidi(midiFile([trackNotes]));
  assert(parsed.notes.length === 2, `預期 2 顆音符（C4、D4），實際 ${parsed.notes.length}`);
  const pitches = parsed.notes.map((n) => n.midiNote).sort();
  assert(pitches[0] === 60 && pitches[1] === 62, `音高應該是 60、62，實際 ${pitches}`);
  const hasWarning = parsed.warnings.some((w) => w.includes('running status 沿用跨過了'));
  assert(hasWarning, '應該要有一則「running status 沿用跨過了 meta／SysEx」的警告');
  const warnCount = parsed.warnings.filter((w) => w.includes('running status 沿用跨過了')).length;
  assert(warnCount === 1, `這則警告每軌只該出現一次，實際 ${warnCount} 次`);
});

run('情境 D：一般 running status 沿用（沒有穿過 meta）不會誤發警告', () => {
  const trackNotes = track([
    { deltaTick: 0, bytes: [0x90, 60, 100] },
    { deltaTick: 480, bytes: [60, 0] },
    { deltaTick: 0, bytes: [62, 100] },
    { deltaTick: 480, bytes: [62, 0] },
  ]);
  const parsed = parseMidi(midiFile([trackNotes]));
  assert(parsed.notes.length === 2, '預期 2 顆音符');
  assert(!parsed.warnings.some((w) => w.includes('running status 沿用跨過了')), '正常沿用不該觸發警告');
});

// ── 警告 ──

run('鼓組非標準 program 的警告不再斷言會退回 Standard Kit', () => {
  const trackDrum = track([
    cc(0, 0, 120),    // ch0 Bank Select MSB=120（節奏 bank）
    pc(0, 1),         // ch0 PC=1（不是 GM_DRUM_KITS 裡的標準編號）
    ...notes(0, [36]),
  ]);
  const parsed = parseMidi(midiFile([trackDrum]));
  const w = parsed.warnings.find((x) => x.includes('鼓組 program'));
  assert(w, '應該要有鼓組相關警告');
  assert(!w.includes('會退回播放 Standard Kit'), `警告不該再斷言「會退回播放 Standard Kit」：${w}`);
  assert(w.includes('取決於載入的 SoundFont'), `警告應該改成中性措辭：${w}`);
});

run('同一個 staff 內同音高重疊會警告（先進先出配對）', () => {
  const parsed = parseMidi(midiFile([track([
    { deltaTick: 0, bytes: [0x90, 60, 100] },
    { deltaTick: 240, bytes: [0x90, 60, 90] },
    { deltaTick: 240, bytes: [0x80, 60, 0] },
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ])]));
  assert(parsed.notes.length === 2, `預期 2 顆音，實際 ${parsed.notes.length}`);
  assert(parsed.warnings.some((w) => w.includes('同音高重疊')), `應該有「同音高重疊」警告，實際 ${parsed.warnings}`);
});

console.log('\n全部測試跑完。');
