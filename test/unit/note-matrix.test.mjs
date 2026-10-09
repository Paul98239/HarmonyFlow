// ============================================================
//  note-matrix.test.mjs — 所有音值 × tick 解析度 × 匯出器縮短 × 按鍵方式 的收音矩陣（純 Node，無瀏覽器）
//
//  MIDI 裡沒有「二分音符」「休止符」，只有每顆音的 startTick／endTick，休止是兩顆音之間的空檔。排程器的 loop（hold）規則只看
//  「這顆音的結尾落在你的起音序列的哪裡」，跟音值無關；這支測試把樂譜上會出現的每一種音值都做成音符，驗證它們的實際收音時刻：
//    · 倍全／全／二分／四分／八分／十六分／三十二／六十四／一二八分音符、附點、複附點、三連音／五連音／七連音、連結線（長音）；
//    · tick 解析度 96／192／480／960 與 SMPTE（沒有 tick per quarter，用固定秒數當容差上限）；
//    · 匯出器縮短：不縮短、少 1 tick（MuseScore 的相連音）、統一縮短約 5.4%（曲庫 54 首）；
//    · 你的聲部（driver）與電腦聲部（follower）的音一視同仁，而且同一個垂直 tick 上放一整串不同音值（和弦的每顆音各自判斷）；
//    · 按鍵方式：照拍穩定彈（慢 2×／準時／快 2×）、彈到一半停手 4 秒再回來、起音稀疏（中間有很長的休止）、手抖亂按。
//
//  期望值是照模型手算的封閉形式，不呼叫 scheduler 的內部函式（_holdOf 等）：
//    你穩定地每拍 I 毫秒，速度 r ＝ 500÷I（譜是 120 BPM，一拍 500ms）。音在 Ts 起音、檔案裡長 len tick、你的起音在拍位 O：
//      · 找結尾對齊或橫跨的起音：起音 o（相對這顆音起音的 tick 距離）≤ 結尾＋容差上限，且（o ≤ 結尾，或 o － 結尾 ≤ 容差 tol(o)），取最後一個，
//        tol(o) ＝ max(2, min(o÷8, 容差上限))，容差上限 ＝ 四分音符的 1/4（SMPTE 是 0.125 秒＝120 tick）；
//      · 有這種起音 o：收在「你按下 o 的那一刻 ＋ max(0, 結尾 － o) 對應的樂譜秒數 ÷ r」（對齊時剩餘 0＝按下去就收）；
//      · 沒有：Ts ＋ len 對應的樂譜秒數 ÷ r（等比例縮放）。
//    穩定彈時兩種收法的差別只有「結尾比起音早一點」的相連音（縮短的音）：hold 的收在起音，沒 hold 的收在自己的結尾。
//
//  用法：node test/unit/note-matrix.test.mjs
// ============================================================

import { Scheduler } from '../../src/midi/scheduler.js';
import { buildSegments } from '../../src/midi/midiParser.js';

const TICK_MS = 12;
const BEAT_SEC = 0.5;            // 120 BPM
const START_BEAT = 12;           // 長音從第 12 拍起音：速度看最近 8 個間隔，前面要有足夠的穩定按鍵才估得準
const TOL_MS = TICK_MS + 1;

function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ═══════════════════════════════════════════
   音值表（單位：四分音符＝1 拍）
   ═══════════════════════════════════════════ */
const VALUES = [
  ['倍全音符', 8], ['附點全音符', 6], ['全音符', 4], ['附點二分', 3], ['二分音符', 2], ['附點四分', 1.5], ['四分音符', 1],
  ['附點八分', 0.75], ['八分音符', 0.5], ['附點十六分', 0.375], ['十六分音符', 0.25], ['三十二分音符', 0.125], ['六十四分音符', 0.0625],
  ['複附點二分', 3.5], ['複附點四分', 1.75], ['複附點八分', 0.875],
  ['四分三連音', 2 / 3], ['八分三連音', 1 / 3], ['十六分三連音', 1 / 6], ['二分三連音', 4 / 3],
  ['十六分五連音', 1 / 5], ['八分五連音', 2 / 5], ['三十二分七連音', 1 / 14], ['八分七連音', 2 / 7],
  ['連結線 5 拍', 5], ['連結線 7 拍', 7], ['連結線 12 拍', 12], ['連結線 16 拍', 16], ['連結線 2.5 拍', 2.5], ['連結線 4.75 拍', 4.75],
];
// 匯出器縮短：[名稱, (len tick) → 縮短的 tick 數]
const SHORTEN = [['不縮短', () => 0], ['少 1 tick', () => 1], ['統一縮短 5.4%', (len) => Math.round(len * 0.054)]];
// tick 解析度：[名稱, 每拍幾 tick, 是否 SMPTE（timeDivision＝null）]
const RESOLUTIONS = [['96 tpq', 96, false], ['192 tpq', 192, false], ['480 tpq', 480, false], ['960 tpq', 960, false], ['SMPTE', 480, true]];

/* ═══════════════════════════════════════════
   譜面與假合成器
   ═══════════════════════════════════════════ */

// onsets：你的起音（拍位，小數 OK）；chord：{ part: 'me'|'cpu', beats, shorten } 的陣列，全部在 START_BEAT 起音
function buildScore({ tpq, smpte, onsets, values, shorten }) {
  const notes = [], parts = ['me', 'cpu'].map((id, pi) => ({ id, trackIndex: pi, channel: pi, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } }));
  const mk = (partId, pi, midiNote, startTick, endTick) => notes.push({
    partId, trackIndex: pi, channel: pi, program: 0, midiNote, velocity: 100, startTick, endTick,
    startSeconds: (startTick / tpq) * BEAT_SEC, endSeconds: (endTick / tpq) * BEAT_SEC, durationSeconds: ((endTick - startTick) / tpq) * BEAT_SEC,
  });
  const S = Math.round(START_BEAT * tpq);
  for (const b of onsets) mk('me', 0, 10, Math.round(b * tpq), Math.round(b * tpq) + Math.round(0.05 * tpq));   // 你的每個起音：很短的音
  const chord = [];
  values.forEach(([name, beats], i) => {
    const full = Math.max(1, Math.round(beats * tpq));
    const len = Math.max(1, full - shorten(full));
    for (const [part, pi, pitch] of [['me', 0, 20 + i], ['cpu', 1, 60 + i]]) {
      mk(part, pi, pitch, S, S + len);
      chord.push({ part, pitch, name, beats, lenTicks: len });
    }
  });
  notes.sort((a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex || a.midiNote - b.midiNote);
  const durationTicks = (Math.max(...onsets) + 40) * tpq;
  return {
    chord, S,
    score: {
      parts, notes, segments: buildSegments(notes),
      durationSeconds: (durationTicks / tpq) * BEAT_SEC, durationTicks, timeDivision: smpte ? null : tpq,
      timeSignatures: [{ ticks: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }],
      midiTicksToSeconds: (t) => (t / tpq) * BEAT_SEC,
      secondsToMIDITicks: (s) => (s / BEAT_SEC) * tpq,
    },
  };
}

// presses：你每個起音的按鍵時刻（毫秒，由早到晚，對應 onsets）。回傳 { on, off }：音名（label:音高）→ 時刻
function play(score, presses, endMs) {
  const log = [], clock = { ms: 0 };
  const rec = (label) => ({
    controllerChange() {}, programChange() {},
    noteOn: (ch, note) => log.push({ t: 'on', label, note, ms: clock.ms }),
    noteOff: (ch, note) => log.push({ t: 'off', label, note, ms: clock.ms }),
  });
  const hp = new Scheduler();
  hp.setSynths(rec('cpu'), rec('me'));
  hp.load(score, new Map([['me', 1]]));
  hp.play();
  hp.tick(0);
  const queue = presses.slice();
  while (clock.ms < endMs) {
    clock.ms += TICK_MS;
    while (queue.length && queue[0] <= clock.ms) { const t = queue.shift(); const keep = clock.ms; clock.ms = Math.max(t, keep - TICK_MS); hp.trigger(1, clock.ms); clock.ms = keep; }
    hp.tick(clock.ms);
  }
  const on = new Map(), off = new Map();
  for (const e of log) (e.t === 'on' ? on : off).set(`${e.label}:${e.note}`, (e.t === 'on' ? on : off).get(`${e.label}:${e.note}`) ?? e.ms);
  const released = hp.pressLog().filter((p) => p.released).map((p) => p.clockMs);
  return { on, off, hp, log, released };
}

// 期望的「結尾對齊或橫跨的起音」：回傳 { onsetBeat, tailTicks }，沒有回傳 null。onsetBeats＝你的起音拍位。
function expectedHold({ lenTicks, tpq, smpte, onsetBeats }) {
  const cap = smpte ? 120 : tpq / 4;                                  // SMPTE：0.125 秒＝120 tick（譜是 960 tick/秒 × ... 這裡 tpq 固定 480）
  const rel = onsetBeats.map((b) => Math.round(b * tpq) - Math.round(START_BEAT * tpq)).filter((o) => o > 0).sort((a, b) => b - a);
  for (const o of rel) {
    if (o > lenTicks + cap) continue;
    const tol = Math.max(2, Math.min(o / 8, cap));
    if (o <= lenTicks || o - lenTicks <= tol) return { onsetBeat: START_BEAT + o / tpq, tailTicks: Math.max(0, lenTicks - o) };
  }
  return null;
}

const near = (a, b, tol = TOL_MS) => Math.abs(a - b) <= tol;

/* ═══════════════════════════════════════════
   穩定地照拍彈（慢 2×／準時／快 2×）：每顆音的收音時刻都符合模型
   ═══════════════════════════════════════════ */

const denseOnsets = Array.from({ length: START_BEAT + 40 }, (_, i) => i);
// 起音稀疏：到第 12 拍每拍一下，之後每 8 拍一下（中間是很長的休止）
const sparseOnsets = [...Array.from({ length: START_BEAT + 1 }, (_, i) => i), ...Array.from({ length: 6 }, (_, i) => START_BEAT + 8 * (i + 1))];

for (const [layout, onsets] of [['每拍一個起音', denseOnsets], ['起音稀疏（第 12 拍之後每 8 拍一下）', sparseOnsets]]) {
  for (const I of [1000, 500, 250]) {
    for (const [resName, tpq, smpte] of RESOLUTIONS) {
      for (const [shName, shFn] of SHORTEN) {
        run(`穩定彈（${layout}、每拍 ${I}ms）× ${resName} × ${shName}：${VALUES.length} 種音值的收音時刻，你的音與電腦的一視同仁`, () => {
          const { score, chord, S } = buildScore({ tpq, smpte, onsets, values: VALUES, shorten: shFn });
          // 第一個間隔固定放慢到至少 350ms：速度還沒學到時（1×）按得太快會被去抖擋掉（已知行為），暖機後 8 個間隔的窗口全是穩定的
          const T0 = 100, shift = Math.max(0, 350 - I), at = (b) => T0 + (b > 0 ? shift : 0) + b * I;
          const presses = onsets.map(at);
          const endMs = at(Math.max(...onsets) + 4);
          const { on, off } = play(score, presses, endMs);
          const bad = [];
          for (const c of chord) {
            const key = `${c.part}:${c.pitch}`, Ts = at(START_BEAT);
            const hold = expectedHold({ lenTicks: c.lenTicks, tpq, smpte, onsetBeats: onsets });
            const want = hold ? at(hold.onsetBeat) + (hold.tailTicks / tpq) * I : Ts + (c.lenTicks / tpq) * I;
            if (!on.has(key)) { bad.push(`${c.part} ${c.name}：沒發聲`); continue; }
            if (!near(on.get(key), Ts)) bad.push(`${c.part} ${c.name}：起音應在 ${Ts}，實際 ${on.get(key)}`);
            if (!off.has(key)) { bad.push(`${c.part} ${c.name}：沒收（想要 ${want.toFixed(0)}）`); continue; }
            if (!near(off.get(key), want)) bad.push(`${c.part} ${c.name}（${hold ? `對齊／橫跨拍 ${hold.onsetBeat.toFixed(2)}、剩 ${hold.tailTicks} tick` : '照自己的結尾'}）：想要 ${want.toFixed(0)}，實際 ${off.get(key)}`);
          }
          assert(bad.length === 0, `${bad.length} 顆不符：\n    ${bad.slice(0, 6).join('\n    ')}`);
        });
      }
    }
  }
}

/* ═══════════════════════════════════════════
   彈到一半停手：hold 的音不被閒置切掉，照自己結尾收的音在停手期間照常收
   ═══════════════════════════════════════════ */
for (const [resName, tpq, smpte] of RESOLUTIONS) {
  for (const [shName, shFn] of SHORTEN) {
    run(`停手 4 秒再回來（第 ${START_BEAT + 1} 拍之後）× ${resName} × ${shName}：對齊／橫跨的音一直響到你按到它的起音，其餘照自己的結尾收`, () => {
      const { score, chord } = buildScore({ tpq, smpte, onsets: denseOnsets, values: VALUES, shorten: shFn });
      const I = 500, T0 = 100, stopAfter = START_BEAT + 1, R = T0 + stopAfter * I + 4000;
      const press = (b) => (b <= stopAfter ? T0 + b * I : R + (b - stopAfter - 1) * I);
      const { on, off } = play(score, denseOnsets.map(press), R + 60 * I);
      const bad = [];
      for (const c of chord) {
        const key = `${c.part}:${c.pitch}`;
        const hold = expectedHold({ lenTicks: c.lenTicks, tpq, smpte, onsetBeats: denseOnsets });
        if (!on.has(key) || !off.has(key)) { bad.push(`${c.part} ${c.name}：沒發聲或沒收`); continue; }
        const o = off.get(key);
        if (!hold) { if (!near(o, T0 + START_BEAT * I + (c.lenTicks / tpq) * I)) bad.push(`${c.part} ${c.name}：照自己的結尾，實際 ${o}`); continue; }
        const tail = (hold.tailTicks / tpq) * I;
        if (hold.onsetBeat <= stopAfter) { if (!near(o, press(hold.onsetBeat) + tail)) bad.push(`${c.part} ${c.name}：停手前就按過它的起音，應 ${press(hold.onsetBeat) + tail}，實際 ${o}`); continue; }
        // 停手期間（按過 stopAfter 之後到 R 之前）一直響：不能在 R 之前收；按到它的起音之後再響完剩餘長度（速度 0.25～4× 之間）
        if (o < R - 1) bad.push(`${c.part} ${c.name}：停手期間被收掉（${o} < ${R}）`);
        const pressed = press(hold.onsetBeat);
        if (o < pressed + tail / 4 - TOL_MS || o > pressed + tail * 4 + TOL_MS) bad.push(`${c.part} ${c.name}：按到起音（${pressed}）後應再響約 ${tail.toFixed(0)}ms，實際 ${o}`);
      }
      assert(bad.length === 0, `${bad.length} 顆不符：\n    ${bad.slice(0, 6).join('\n    ')}`);
    });
  }
}

/* ═══════════════════════════════════════════
   手抖亂按（隨機但固定種子）：你的音在你按下它的結尾起音的那一刻收（以你的聲部為準），電腦的對齊音不早於你的按鍵、
   所有音恰好發聲一次並收掉
   ═══════════════════════════════════════════ */
for (const [resName, tpq, smpte] of RESOLUTIONS) {
  run(`手抖亂按（±35%、固定種子）× ${resName}：你的對齊音收在你按下起音的那一刻，所有音恰好響一次、收乾淨`, () => {
    const { score, chord } = buildScore({ tpq, smpte, onsets: denseOnsets, values: VALUES, shorten: SHORTEN[1][1] });
    let r = 12345;
    const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
    const I = 500, T0 = 100, presses = [];
    let t = T0;
    for (const b of denseOnsets) { presses.push(t); t += I * (1 + 0.35 * (rnd() * 2 - 1)); }
    const { on, off, log, released } = play(score, presses, t + 20000);
    const bad = [];
    for (const c of chord) {
      const key = `${c.part}:${c.pitch}`;
      if (log.filter((e) => e.t === 'on' && `${e.label}:${e.note}` === key).length !== 1) { bad.push(`${c.part} ${c.name}：不是恰好發聲一次`); continue; }
      if (log.filter((e) => e.t === 'off' && `${e.label}:${e.note}` === key).length !== 1) { bad.push(`${c.part} ${c.name}：不是恰好收一次`); continue; }
      const hold = expectedHold({ lenTicks: c.lenTicks, tpq, smpte, onsetBeats: denseOnsets });
      if (c.part !== 'me' || !hold || hold.tailTicks > 0) continue;
      // 你的音：結尾對齊你的起音（剩餘 0）→ 剛好在你按下那個起音的那一刻收
      const pressedAt = released[Math.round(hold.onsetBeat)];   // 第 k 個被放行的按鍵放行的是第 k 個起音（被去抖擋掉的按鍵不算）
      if (off.get(key) !== pressedAt && !(off.get(key) >= pressedAt && off.get(key) <= pressedAt + 1)) bad.push(`me ${c.name}：應在你按下起音的那一刻（${pressedAt.toFixed(0)}）收，實際 ${off.get(key)}`);
    }
    assert(bad.length === 0, `${bad.length} 顆不符：\n    ${bad.slice(0, 6).join('\n    ')}`);
  });
}

/* ═══════════════════════════════════════════
   特例：零長度、結尾超過最後一個起音、極短音（1 tick）
   ═══════════════════════════════════════════ */
run('零長度的音（note on／off 同一個 tick）與 1 tick 的音：發聲後立刻收，不 hold、不擋下一個起音', () => {
  const tpq = 480, onsets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const notes = [], parts = ['me', 'cpu'].map((id, pi) => ({ id, trackIndex: pi, channel: pi, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } }));
  const mk = (partId, pi, midiNote, startTick, endTick) => notes.push({ partId, trackIndex: pi, channel: pi, program: 0, midiNote, velocity: 100, startTick, endTick, startSeconds: startTick / tpq * 0.5, endSeconds: endTick / tpq * 0.5, durationSeconds: (endTick - startTick) / tpq * 0.5 });
  for (const b of onsets) mk('me', 0, 10, b * tpq, b * tpq + 20);
  mk('cpu', 1, 60, 3 * tpq, 3 * tpq);              // 零長度，正好在你的起音上
  mk('cpu', 1, 61, 3 * tpq + 100, 3 * tpq + 100);  // 零長度，在兩個起音之間
  mk('cpu', 1, 62, 3 * tpq + 200, 3 * tpq + 201);  // 1 tick
  notes.sort((a, b) => a.startTick - b.startTick);
  const score = { parts, notes, segments: buildSegments(notes), durationSeconds: 20, durationTicks: 20 * tpq, timeDivision: tpq, timeSignatures: [], midiTicksToSeconds: (t) => t / tpq * 0.5, secondsToMIDITicks: (s) => s / 0.5 * tpq };
  const { on, off } = play(score, onsets.map((b) => 100 + b * 500), 8000);
  for (const n of [60, 61, 62]) assert(on.has(`cpu:${n}`) && off.has(`cpu:${n}`), `音 ${n} 要發聲並收掉`);
  assert(near(on.get('cpu:60'), 1600) && off.get('cpu:60') - on.get('cpu:60') <= TICK_MS, `零長度在你的起音上：與你的音同刻、立刻收，實際 on ${on.get('cpu:60')}／off ${off.get('cpu:60')}`);
  assert(off.get('cpu:61') - on.get('cpu:61') <= TICK_MS && off.get('cpu:62') - on.get('cpu:62') <= TICK_MS * 2, '兩個起音之間的零長度與 1 tick 的音不 hold，立刻收');
  for (const b of onsets) assert(on.has('me:10'), '你的起音沒有被擋住');
});

run('結尾超過最後一個起音的長音（沒有起音可等）：照自己的結尾（÷ 速度）收，不會永遠 hold', () => {
  const onsets = Array.from({ length: START_BEAT + 2 }, (_, i) => i);   // 最後一個起音在長音起音的下一拍
  const { score, chord } = buildScore({ tpq: 480, smpte: false, onsets, values: [['10 拍長音', 10], ['全音符', 4]], shorten: () => 0 });
  const I = 500, T0 = 100;
  const { on, off } = play(score, onsets.map((b) => T0 + b * I), T0 + 40 * I);
  const long = chord.find((c) => c.part === 'cpu' && c.beats === 10);
  assert(off.has(`cpu:${long.pitch}`), '長音要收');
  // 長音從拍 12 起音、結尾在拍 22，最後一個起音是拍 13：結尾在最後一個起音之後很遠，橫跨拍 13；按下拍 13 後再響完 9 拍
  assert(near(off.get(`cpu:${long.pitch}`), T0 + (START_BEAT + 1) * I + 9 * I), `橫跨最後一個起音：按下之後再響完 9 拍＝${T0 + (START_BEAT + 10) * I}，實際 ${off.get(`cpu:${long.pitch}`)}`);
});

console.log('\n全部測試跑完。');
