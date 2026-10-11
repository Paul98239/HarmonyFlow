// ============================================================
//  scheduler.test.mjs — src/midi/scheduler.js 的回歸測試（純 Node，無瀏覽器）
//
//  沒有測試框架，跟 test/browser/smoke-test.mjs 同一套風格：run()／assert() 是整個專案
//  唯一的測試慣例。假 synth 只實作 controllerChange／programChange／noteOn／noteOff，並替每個
//  事件蓋上當下的假時間；每 12ms 呼叫一次 tick()，跟 midiPlayer.js 的排程 tick 一致。
//  觸發（press／pressAt）直接呼叫 trigger(slot, 假時間)，不經過 tick——driver 的音要在這次呼叫內發聲。
//
//  模型（見 scheduler.js 檔頭）：被指派的聲部是 driver（每個起音要按一次），電腦輔助的聲部是 follower（不用按）。
//  每次按鍵啟動它負責的那一段 [T_k, T_{k+1})：follower 的音依估到的速度排好時刻；提早按時，上一段還沒輪到的 follower 音依
//  T_k 的垂直 tick 處理（還該響著的追音、整顆在身後的跳過；同 tick 的電腦音與你同刻）。時間數字都是照模型手算的，不是跑出來再抄回去；
//  容許誤差以一個排程 tick（12ms）為單位。
//
//  「note-on／note-off 成對」的意思是以「音」為單位：每顆音有一個起點與一個終點（原檔的終點可能是
//  Note Off，也可能是 velocity 0 的 Note On，parser 都配成同一顆音）；排程器送給合成器的 noteOn 與
//  noteOff 次數要相同、一一對應，而且絕不送 velocity 0 的 noteOn（合成器會把它當成 note-off）。
//
//  用法：node test/unit/scheduler.test.mjs
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseMidi, buildSegments } from '../../src/midi/midiParser.js';
import { Scheduler, DEFAULT_PORTS, portsNeeded } from '../../src/midi/scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANON_PATH = join(__dirname, '../../src/assets/canon-violin-cello.mid');
const TICK_MS = 12;

function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ═══════════════════════════════════════════
   測試工具：假合成器、假時鐘＋觸發、譜面產生器
   ═══════════════════════════════════════════ */

function makeFakeSynth(log, label, clock) {
  return {
    controllerChange: (ch, cc, val) => log.push({ t: 'cc', label, ch, cc, val, ms: clock.ms }),
    programChange: () => {},
    noteOn: (ch, note, vel) => log.push({ t: 'on', label, ch, note, vel, ms: clock.ms }),
    noteOff: (ch, note) => log.push({ t: 'off', label, ch, note, ms: clock.ms }),
  };
}

// press(slot)＝在目前的假時間觸發一次（不跑 tick，回傳有沒有放行）；pressAt(ms)＝先跑 tick 到 ms 之前，再在剛好 ms 觸發；
// gap(ms)＝兩個 tick 之間隔了很久（背景分頁被節流）。
function makeDriver(hp, clock) {
  const tick = () => { clock.ms += TICK_MS; hp.tick(clock.ms); };
  return {
    tick,
    runMs(ms) { const end = clock.ms + ms; while (clock.ms < end) tick(); },
    press(slot = 1) { return hp.trigger(slot, clock.ms); },
    pressAt(ms, slot = 1) { while (clock.ms + TICK_MS <= ms) tick(); clock.ms = ms; return hp.trigger(slot, ms); },
    gap(ms) { clock.ms += ms; hp.tick(clock.ms); },
    get nowMs() { return clock.ms; },
  };
}

function makeHp(score, assignments, { play = true } = {}) {
  const log = [], clock = { ms: 0 };
  const hp = new Scheduler();
  hp.setSynths(makeFakeSynth(log, 'assist', clock), makeFakeSynth(log, 'human', clock));
  hp.load(score, new Map(assignments));
  const d = makeDriver(hp, clock);
  if (play) hp.play();
  return { hp, log, d };
}

const onNotes = (log, label) => log.filter((e) => e.t === 'on' && (!label || e.label === label)).map((e) => e.note);
const eventMs = (log, t, note, label) => log.find((e) => e.t === t && e.note === note && (!label || e.label === label))?.ms;
const onMs = (log, note, label) => eventMs(log, 'on', note, label);
const offMs = (log, note, label) => eventMs(log, 'off', note, label);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const count = (log, t, note) => log.filter((e) => e.t === t && (note === undefined || e.note === note)).length;

// 手工譜共用的尾巴：4/4、一律 480 tpq、固定速度（拍長 beatSec 秒）。tick ↔ 秒是線性的，反函數也是。
function scoreTail(notes, parts, beatSec, durationTicks) {
  const tpq = 480;
  return {
    parts, notes, segments: buildSegments(notes),
    durationSeconds: (durationTicks / tpq) * beatSec, durationTicks, timeDivision: tpq,
    timeSignatures: [{ ticks: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }],
    midiTicksToSeconds: (t) => (t / tpq) * beatSec,
    secondsToMIDITicks: (s) => (s / beatSec) * tpq,
  };
}

// spec：partId → 這個聲部的音符（拍序號，或 { beat, dur 秒, note 音高 }）。4/4，預設 120 BPM（拍長 0.5s），
// 音符預設 25ms 短音；音高預設 40＋聲部序號×12＋這顆音在聲部裡的序號。beatSec 可改拍長（例如 1.2 ＝ 50 BPM）。
function buildBeatScore(spec, beatSec = 0.5) {
  const tpq = 480;
  const notes = [], parts = [];
  Object.entries(spec).forEach(([id, items], pi) => {
    parts.push({ id, trackIndex: pi, channel: pi, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } });
    items.forEach((it, ni) => {
      const { beat, dur = 0.025, note = 40 + pi * 12 + ni } = typeof it === 'number' ? { beat: it } : it;
      notes.push({
        partId: id, trackIndex: pi, channel: pi, program: 0, midiNote: note, velocity: 100,
        startTick: beat * tpq, endTick: beat * tpq + Math.round((dur / beatSec) * tpq),
        startSeconds: beat * beatSec, endSeconds: beat * beatSec + dur, durationSeconds: dur,
      });
    });
  });
  notes.sort((a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex);
  const totalBeats = Math.max(...notes.map((n) => n.startTick / tpq)) + 8;
  return scoreTail(notes, parts, beatSec, totalBeats * tpq);
}

// MuseScore 匯出相連音符的樣子：記譜長度 − 1 tick（0.5s 的拍少 1 tick），下一顆音在下一拍的拍首。
const ONE_TICK_SHORT = 0.5 * 479 / 480;

/* ═══════════════════════════════════════════
   不變量檢查用的假合成器（壓力測試與 canon 共用）
   排程器用 try/catch 包住每一次 synth 呼叫（音源掛掉不能拖垮排程），假 synth 裡丟的例外會被吞掉：
   違規只記下來，每次呼叫排程器之後再檢查。
   ═══════════════════════════════════════════ */
function makeInvariantRig(seed) {
  const state = {
    hp: null, silencing: false, inTick: false, inTrigger: false, triggerTicks: null, maxSimultaneous: 0, noteOns: 0,
    balance: new Map(), problems: [], triggerLog: [],
  };
  const check = (cond, msg) => { if (!cond) state.problems.push(`seed ${seed}：${msg}`); };
  state.check = check;
  state.flush = () => assert(!state.problems.length, state.problems[0]);
  const staffOf = (ch, label) => [...state.hp._staves.values()].find((x) => x.channel === ch && (label === 'human') === (x.kind === 'human'));
  state.fake = (label) => ({
    controllerChange() {}, programChange() {},
    noteOn: (ch, pitch, vel) => {
      const hp = state.hp;
      const staff = staffOf(ch, label);
      const sounded = [...hp._sounded];
      const note = sounded[sounded.length - 1];            // 排程器先把音記進 _sounded 再 noteOn
      state.noteOns++;
      check(vel >= 1, '送了 velocity 0 的 noteOn（合成器會把它當成 note-off）');
      check(note && note.midiNote === pitch, `發聲的音高 ${pitch} 跟 _sounded 最後一顆（${note?.midiNote}）不符`);
      if (staff.kind === 'human') {
        check(state.inTrigger, `driver 的音（${staff.id}）不是在 trigger() 裡發聲`);
      } else {
        check(hp._anchoredSlice >= hp._sliceOfTick(note.startTick), `follower 音（tick ${note.startTick}）在它那一段被按鍵啟動之前就發聲了`);
        // 不擠、不丟、不補放：每顆 follower 音都在它排好的時刻之後不超過一個排程 tick（12ms）就發聲——沒有被延後再一次放出
        // （按鍵呼叫裡放出的，只有同 tick 的音，與上個 tick 之後剛到期的殘餘音）。
        const entry = hp._pending.find((p) => p.note === note);
        if (entry) {
          check(hp._clockMs - entry.dueMs <= 12 + 1e-6, `follower 音（tick ${note.startTick}）比排好的時刻晚了 ${(hp._clockMs - entry.dueMs).toFixed(1)}ms 才發聲：被補放（擠在一起）`);
        } else {
          // 不在佇列裡的 follower 音只有一種：你早按時的追音——在 trigger() 裡、起音在你這個起音之前、結尾在它之後（T_k 還該響著）
          const pressTick = hp._driverSegs[hp._segIndex - 1]?.ticks;
          check(state.inTrigger && pressTick !== undefined && note.startTick < pressTick && note.endTick > pressTick,
            `follower 音（tick ${note.startTick}–${note.endTick}）不在排程佇列裡發聲，又不是你早按時的追音（按下的起音 tick ${pressTick}）：被補放（擠在一起）`);
        }
      }
      const k = `${label}/${ch}/${pitch}`;
      state.balance.set(k, (state.balance.get(k) ?? 0) + 1);
      state.maxSimultaneous = Math.max(state.maxSimultaneous, state.balance.get(k));
      if (state.inTrigger) state.triggerLog.push({ label, pitch });
    },
    noteOff: (ch, pitch) => {
      const hp = state.hp;
      const staff = staffOf(ch, label);
      const k = `${label}/${ch}/${pitch}`;
      state.balance.set(k, (state.balance.get(k) ?? 0) - 1);
      check(state.balance.get(k) >= 0, `${k} 沒有對應的 noteOn 就 noteOff`);
      const e = staff.sounding.get(pitch)?.find((x) => x.holdIdx === null);   // 先進先出只排沒有 hold 的音
      // 收音只有三個理由：到期（照 MIDI 音符長度）、driver 的音在下一次按鍵時 endTick ≤ 新錨點、暫停／重播清場。
      if (!state.silencing && e) {
        const due = e.offMs <= hp._clockMs + 1e-6;
        const byPress = staff.kind === 'human' && state.inTrigger && e.endTick <= state.triggerTicks;
        check(due || byPress, `${k} 提早收音（offMs ${e.offMs}、時鐘 ${hp._clockMs}）`);
      }
    },
  });
  return state;
}

/* ═══════════════════════════════════════════
   只有「我的聲部」要按：按鍵啟動它負責的那一段
   ═══════════════════════════════════════════ */

run('按一下放行 driver 的下一個 segment，同 tick 的電腦音同刻發聲；其餘電腦音自己依速度放，不用按', () => {
  // p0（指派）在拍 0、2、4；a1（電腦輔助）每拍一顆。音高：p0 40～42、a1 52～56。
  const { log, d } = makeHp(buildBeatScore({ p0: [0, 2, 4], a1: [0, 1, 2, 3, 4] }), [['p0', 1]]);
  d.tick(); d.runMs(100);
  const t0 = d.nowMs;
  assert(d.press() === true, '第一下應該放行');
  assert(onMs(log, 40, 'human') === t0 && onMs(log, 52, 'assist') === t0, `你的 40 與同 tick 的電腦音 52 要在按下的那一刻同刻發聲，實際 ${onMs(log, 40)}／${onMs(log, 52)}（按下 ${t0}）`);
  d.runMs(1100);
  const t1 = d.nowMs;
  assert(near(onMs(log, 53, 'assist') - t0, 500, TICK_MS), `拍 1 的電腦音 53 沒有人按，按下後 500ms（速度 1×）自己發聲，實際 ${onMs(log, 53) - t0}ms`);
  assert(onMs(log, 41) === undefined && onMs(log, 54) === undefined, '拍 2 是你的下一個起音：還沒按，你的 41 與同 tick 的電腦音 54 都不會越過去');
  assert(d.press() === true, '第二下應該放行');
  assert(onMs(log, 41, 'human') === t1 && onMs(log, 54, 'assist') === t1, '第二下：你的 41 與電腦音 54 同刻');
  const rate = 1.0 / ((t1 - t0) / 1000);                     // 兩次按鍵：樂譜 1.0s、真實 t1−t0
  d.runMs(1500);
  assert(near(onMs(log, 55, 'assist') - t1, 500 / rate, TICK_MS), `拍 3 的電腦音 55 照估到的速度（${rate.toFixed(3)}×）在 ${(500 / rate).toFixed(0)}ms 後自己發聲，實際 ${onMs(log, 55) - t1}ms`);
  d.runMs(500);
  assert(d.press() === true && onMs(log, 42, 'human') !== undefined && onMs(log, 56, 'assist') === onMs(log, 42, 'human'), '第三下：42 與 56 同刻');
  assert(d.press() === false, 'driver 的 segment 都放行完了，再按沒有反應');
});

run('前奏照原速播、停在你的入場點：第一次按之前電腦聲部自己播，剛好落在你入場那個 tick 的電腦音要等你按', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [4, 5], a1: [0, 1, 2, 3, 4, 5] }), [['p0', 1]]); // 你從拍 4 才入場
  d.tick();
  const base = d.nowMs;
  d.runMs(3000);                                              // 完全不按
  for (let b = 0; b < 4; b++) assert(near(onMs(log, 52 + b, 'assist') - base, b * 500, TICK_MS), `前奏第 ${b} 拍的電腦音應在 ${b * 500}ms 自己發聲，實際 ${onMs(log, 52 + b) - base}`);
  assert(onMs(log, 56) === undefined && onNotes(log, 'human').length === 0, '拍 4（你的入場點）的電腦音 56 要等你按那一下');
  assert(near(hp.getPositionTicks(), 1920, 1e-6), `播放頭停在你的入場點（tick 1920），實際 ${hp.getPositionTicks()}`);
  const t = d.nowMs;
  assert(d.press() === true && onMs(log, 40, 'human') === t && onMs(log, 56, 'assist') === t, '按下：你的 40 與電腦音 56 同刻');
});

run('前奏鎖：前奏還沒播到你的入場點，按鍵不放行、不跳過前奏；前奏播完那一刻自動放行預按的第一個起音（預按只記一次）', () => {
  // 卡農形狀：電腦聲部 a1 從拍 0 起每拍一顆（前奏拍 0~3＝2000ms），你的聲部 p0 從拍 4 才入場
  const { log, d } = makeHp(buildBeatScore({ p0: [4, 5, 6], a1: [0, 1, 2, 3, 4, 5, 6] }), [['p0', 1]]);
  d.tick();
  const base = d.nowMs;
  d.runMs(500);
  assert(d.press() === false, '前奏中按鍵不放行');
  assert(d.pressAt(base + 1200) === false && d.pressAt(base + 1700) === false, '前奏中不管按幾下都不放行（預按只是記一個旗標，不是計數）');
  assert(onNotes(log, 'human').length === 0, `前奏中你的聲部不發聲，實際 ${onNotes(log, 'human')}`);
  d.runMs(2200);                                              // 前奏播完（base+2000）之後再多走一點
  for (let b = 0; b < 4; b++) {
    assert(count(log, 'on', 52 + b) === 1, `前奏第 ${b} 拍的電腦音 ${52 + b} 要恰好發聲一次（不丟、不重複），實際 ${count(log, 'on', 52 + b)}`);
    assert(near(onMs(log, 52 + b, 'assist') - base, b * 500, TICK_MS), `前奏第 ${b} 拍的電腦音照原速在 ${b * 500}ms 發聲，實際 ${onMs(log, 52 + b) - base}ms（按鍵不能把它挪動）`);
  }
  assert(onMs(log, 40, 'human') !== undefined, '預按過：前奏播完，入場音 40 自動放行');
  assert(near(onMs(log, 40, 'human') - base, 2000, TICK_MS), `入場音在前奏結束那一刻（2000ms）發聲，實際 ${onMs(log, 40, 'human') - base}ms`);
  assert(onMs(log, 56, 'assist') === onMs(log, 40, 'human'), '入場點的電腦音 56 與你的 40 同刻');
  assert(onMs(log, 41, 'human') === undefined, '預按只算一次：你的第二個起音 41 要等你再按');
  d.runMs(600);
  assert(d.press() === true && onMs(log, 41, 'human') === d.nowMs, '入場之後的按鍵照常放行、0ms');
});

run('量測：tick 放出的電腦音記下遲到量（時鐘 − 排好的時刻）；按鍵呼叫內同刻放出的不算；重設清掉', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 2, 4], a1: [0, 1, 2, 3, 4] }), [['p0', 1]]);
  d.tick();
  d.press();                                                  // 拍 0 的電腦音在這次呼叫內同刻發聲，不經過 tick
  assert(hp.lateStats().count === 0, `按鍵呼叫內放出的電腦音不算遲到，實際 ${JSON.stringify(hp.lateStats())}`);
  d.runMs(480);                                               // 拍 1 的電腦音（按下後 500ms）還沒到
  d.gap(hp._pending[0].dueMs - hp._clockMs + 50);             // 下一個 tick 剛好晚了 50ms：就像主執行緒被卡住
  let s = hp.lateStats();
  assert(s.count === 1 && Math.abs(s.max - 50) < 0.11 && s.over30 === 1, `拍 1 的電腦音比排好的時刻晚 50ms 才被 tick 放出，實際 ${JSON.stringify(s)}`);
  d.runMs(520);
  d.press();
  d.runMs(600);                                               // 拍 3 的電腦音正常 12ms 的 tick 放出：遲到小於一個 tick
  s = hp.lateStats();
  assert(s.count === 2 && s.p50 < TICK_MS + 0.5 && s.over30 === 1, `正常 tick 的遲到小於 12ms、個數 2，實際 ${JSON.stringify(s)}`);
  hp.stop();
  assert(hp.lateStats().count === 0, '重設（stop）之後清空，重新累計');
});

run('前奏鎖：沒有預按就不自動放行；預按後暫停再播放，預按作廢', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [4, 5], a1: [0, 1, 2, 3, 4, 5] }), [['p0', 1]]);
  d.tick();
  d.runMs(3000);
  assert(onNotes(log, 'human').length === 0, '完全沒按：入場點到了也不自動放行，等你按');
  const b = makeHp(buildBeatScore({ p0: [4, 5], a1: [0, 1, 2, 3, 4, 5] }), [['p0', 1]]);
  b.d.tick(); b.d.runMs(500);
  assert(b.d.press() === false, '前奏中預按');
  b.hp.pause(); b.hp.play();
  b.d.tick(); b.d.runMs(3000);
  assert(onNotes(b.log, 'human').length === 0, `暫停再播放後預按作廢，入場音不該自動放行，實際 ${onNotes(b.log, 'human')}`);
});

run('沒有電腦聲部、你的聲部很晚才入場：什麼都不播、播放頭停在入場點', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [2, 4] }), [['p0', 1]]);
  d.runMs(10000);
  assert(onNotes(log).length === 0, `不該有任何音，實際 ${onNotes(log)}`);
  assert(near(hp.getPositionTicks(), 960, 1e-6) && !hp.isFinished(), `進度停在入場點（tick 960）、不算播完，實際 ${hp.getPositionTicks()}`);
});

run('提早按（垂直切片）：上一段還沒輪到、整顆在你這個起音之前結束的電腦音跳過（不發聲、不補放、不擠），跟你同 tick 的電腦音與你同刻', () => {
  // p0 在拍 0、1；a1 在拍 0、0.25、0.5、0.75、1：前四個屬於 p0 第一個起音負責的那一段（predicted 500ms）
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 1], a1: [0, 0.25, 0.5, 0.75, 1] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  assert(d.press() === true, '第一下');
  assert(d.pressAt(t0 + 320) === true, '第二下提早 180ms（預估 500ms、實際 320ms；去抖窗口是 300ms，所以接受）');
  const t1 = t0 + 320;
  d.runMs(1000);
  // 52（拍 0，跟你第一下同 tick）、53（拍 0.25 ＝125ms）、54（拍 0.5 ＝250ms）在第二下之前都響了；55（拍 0.75，原排在 375ms）還沒響，
  // 第二下按下的是拍 1（tick 480），55 只有 25ms 長（結尾 tick 384）早已結束：整顆在你身後，跳過
  [52, 53, 54].forEach((n, i) => assert(near(onMs(log, n, 'assist') - t0, [0, 125, 250][i], TICK_MS), `電腦音 ${n} 照排定時刻發聲，實際 ${onMs(log, n, 'assist') - t0}ms`));
  assert(count(log, 'on', 55) === 0 && count(log, 'off', 55) === 0, '55 整顆在你身後：不發聲（不在按下的那一刻擠出來、也不事後補放）');
  assert(onMs(log, 41, 'human') === t1 && onMs(log, 56, 'assist') === t1, `你的 41 與同 tick 的電腦音 56 同刻 0ms，實際 ${onMs(log, 41, 'human') - t0}／${onMs(log, 56, 'assist') - t0}`);
  const stats = hp.chaseStats();
  assert(stats.presses === 1 && stats.chased === 0 && stats.skipped === 1, `chaseStats：一次早按、跳過 1 顆，實際 ${JSON.stringify(stats)}`);
  assert(hp.isFinished(), '跳過的音算已處理：全部放完、收完之後算播完');
});

run('提早按（垂直切片）：T_k 還該響著的電腦音追音——在按下的那一刻與你同刻發聲，長度是檔案裡 T_k 到結尾的剩餘長度 ÷ 速度', () => {
  // a1：60（拍 0.5，短）、61（拍 0.75、長 0.3s＝結尾在拍 1.35，橫跨你第二下的起音）、62（拍 1，跟你第二下同 tick）、63（拍 1.5）。第二下提早到 300ms
  const notes = [{ beat: 0.5, dur: 0.05, note: 60 }, { beat: 0.75, dur: 0.3, note: 61 }, { beat: 1, dur: 0.05, note: 62 }, { beat: 1.5, dur: 0.05, note: 63 }];
  const { hp, log, d } = makeHp(buildBeatScore({ me: [0, 1, 2], a1: notes }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 300);                                        // 速度 0.5÷0.3＝1.667×；61 原本排在 t0+375，還沒響
  const t1 = t0 + 300;
  d.runMs(800);
  assert([60, 61, 62, 63].every((n) => count(log, 'on', n) === 1), `四個電腦音都恰好發聲一次，實際 ${[60, 61, 62, 63].map((n) => count(log, 'on', n))}`);
  assert(onMs(log, 41, 'human') === t1 && onMs(log, 61, 'assist') === t1 && onMs(log, 62, 'assist') === t1, `你的 41、追音 61、同 tick 的 62 全在按下的那一刻（0ms），實際 ${[onMs(log, 41, 'human'), onMs(log, 61, 'assist'), onMs(log, 62, 'assist')].map((m) => m - t0)}`);
  // 61 的結尾在拍 1.35，T_k 是拍 1：剩下 0.35 拍＝0.175s ÷ 1.667 ＝ 105ms
  assert(near(offMs(log, 61, 'assist') - t1, 105, TICK_MS), `61 追音後響完剩餘長度（0.175s ÷ 1.667＝105ms），實際 ${offMs(log, 61, 'assist') - t1}`);
  assert(near(onMs(log, 60, 'assist') - t0, 250, TICK_MS), '60 在第二下之前就照排定時刻響了');
  assert(near(onMs(log, 63, 'assist') - t1, 150, TICK_MS), `63 這一段從按下的那一刻起照新速度排：0.25s ÷ 1.667＝150ms，實際 ${onMs(log, 63, 'assist') - t1}`);
  const stats = hp.chaseStats();
  assert(stats.presses === 1 && stats.chased === 1 && stats.skipped === 0, `chaseStats：一次早按、追音 1 顆，實際 ${JSON.stringify(stats)}`);
});

run('提早按（垂直切片）：沒有殘餘的電腦音（準時按）時行為不變——跟你同 tick 的電腦音跟你同刻，chaseStats 都是 0', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ me: [0, 1, 2], a1: [0, 0.5, 1, 1.5] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 500);                                        // 準時：拍 0.5 的電腦音早就響完了
  assert(onMs(log, 41, 'human') === t0 + 500 && onMs(log, 54, 'assist') === t0 + 500, `你的 41 與同 tick 的電腦音 54 同刻，實際 ${onMs(log, 41, 'human') - t0}／${onMs(log, 54, 'assist') - t0}`);
  assert(isDeepStrictEqual(hp.chaseStats(), { presses: 0, chased: 0, skipped: 0 }), `準時按沒有追音也沒有跳過，實際 ${JSON.stringify(hp.chaseStats())}`);
});

run('提早按（垂直切片）：連續早按（密集的十六分音符伴奏）——每顆音發聲或跳過恰好一次，同 tick 的電腦音每一下都與你同刻、不倒序', () => {
  // 每 300ms 一下（預估 500ms 起、之後估速跟上），電腦每個十六分音符一顆；第一下之後速度還沒學到，第二下就是早按
  const cpu = Array.from({ length: 32 }, (_, i) => ({ beat: i * 0.25, dur: 0.05, note: 40 + i }));   // 音高各不相同，用音高認出是哪一顆
  const { hp, log, d } = makeHp(buildBeatScore({ me: [0, 1, 2, 3, 4, 5, 6, 7], a1: cpu }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  for (let k = 1; k <= 7; k++) d.pressAt(t0 + 300 * k);
  d.runMs(1500);
  const ons = log.filter((e) => e.t === 'on' && e.label === 'assist');
  const stats = hp.chaseStats();
  assert(stats.skipped > 0, `前提：這個情境真的有早按跳過，實際 ${JSON.stringify(stats)}`);
  assert(ons.length + stats.skipped === 32 && hp._sounded.size + hp._skipped.size === 8 + 32, `32 顆電腦音：發聲 ${ons.length} ＋ 跳過 ${stats.skipped}，每顆恰好處理一次`);
  for (let k = 0; k <= 7; k++) {
    const sameTick = ons.find((e) => e.note === 40 + 4 * k);   // 第 k+1 下按的是拍 k，同一拍的電腦音是第 4k 顆
    assert(sameTick && sameTick.ms === t0 + 300 * k, `第 ${k + 1} 下：同 tick 的電腦音與你同刻（0ms），實際 ${sameTick ? sameTick.ms - t0 - 300 * k : '沒發聲'}`);
  }
  assert(ons.every((e, i) => i === 0 || e.note > ons[i - 1].note), '電腦音依樂譜順序發聲（音高就是樂譜序號），不倒序');
});

run('提早按（垂直切片）：已經到期、只是排程 tick 還沒來得及放的電腦音照常放（不當成「還沒輪到」而跳過）', () => {
  // 電腦的 60 在拍 0.9375（tick 450，排在 468.75ms，只有 25ms 長、結尾 tick 474 早於你第二下的起音 tick 480）；第二下按在 474ms：
  // 排程 tick 在 468 跑過、下一個 tick 在 480 才來，60 在兩個 tick 之間到期（468.75 ≤ 474），按下時它已經到期，要照常放，不能被當成早按的殘餘而跳過
  const { hp, log, d } = makeHp(buildBeatScore({ me: [0, 1, 2, 3], cpu: [{ beat: 0.9375, dur: 0.025, note: 60 }] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  assert(d.pressAt(t0 + 474) === true, '第二下（預估 500ms、實際 474ms，去抖窗口 300ms，接受）');
  assert(count(log, 'on', 60) === 1 && hp.chaseStats().skipped === 0, `60 已到期：照常發聲一次、不算跳過，實際 on ${count(log, 'on', 60)}／${JSON.stringify(hp.chaseStats())}`);
});

run('你的音在下一次按鍵時依 endTick 先收：同一位演奏者的另一個聲部在這個起音有音、這個聲部休止（尾巴收尾管不到，靠 endTick）', () => {
  // p0 的 40 在拍 0、長 0.4s（結尾 tick 384，之後休止；離拍 1 的起音 96 tick，超過 hold 容差，不算相連）；p1 在拍 0、1 有音，兩個聲部都給演奏者 1。
  // 第二下提早到 320ms：40 的排好收音時刻是 400ms，但這一下起音 tick 480 已經過了它的結尾，要在按下的那一刻收。
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0.4, note: 40 }, 2], p1: [0, 1] }), [['p0', 1], ['p1', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  assert(d.pressAt(t0 + 320) === true, '第二下提早');
  assert(offMs(log, 40, 'human') === t0 + 320, `40 在第二下按下的那一刻收，實際 ${offMs(log, 40, 'human') - t0}`);
});

run('尾巴收尾：你按得比預估早，同譜表還在響的電腦舊音在新音起音處收，不比檔案多疊（檔案裡有空隙就收在新音發聲那一刻）', () => {
  // a1 的 70 在拍 0.25、長 0.3s（檔案裡 0.425s 結束，離拍 1 的 71 還有 75ms 空隙）；第二下提早到 320ms，71 在那一刻發聲
  const { log, d } = makeHp(buildBeatScore({ p0: [0, 1, 2], a1: [{ beat: 0.25, dur: 0.3, note: 70 }, { beat: 1, dur: 0.1, note: 71 }] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 320);
  d.runMs(400);
  assert(onMs(log, 70, 'assist') !== undefined && onMs(log, 71, 'assist') === t0 + 320, '70、71 都發聲（不丟音），71 在第二下那一刻');
  assert(offMs(log, 70, 'assist') <= onMs(log, 71, 'assist'), `70 在 71 發聲時就收（沒有疊到 71），實際 off ${offMs(log, 70, 'assist') - t0}、71 on ${onMs(log, 71, 'assist') - t0}`);
});

run('尾巴收尾：檔案裡本來就有的重疊要留著——舊音的收音是「新音起音 ＋ 檔案重疊量 ÷ 速度」，只提早、不延長', () => {
  // 70 長 0.5s（0.625s 結束），71 在 0.5s 起音：檔案裡重疊 125ms。第二下提早到 320ms（速度 1.5625×）：重疊量 125ms ÷ 1.5625＝80ms
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 1, 2], a1: [{ beat: 0.25, dur: 0.5, note: 70 }, { beat: 1, dur: 0.1, note: 71 }] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 320);
  d.runMs(500);
  assert(near(hp.playbackRate, 1.5625, 1e-9), `前提：速度 1.5625，實際 ${hp.playbackRate}`);
  assert(near(offMs(log, 70, 'assist') - t0, 320 + 125 / 1.5625, TICK_MS), `70 在新音後 80ms 收（320＋125÷1.5625），實際 ${offMs(log, 70, 'assist') - t0}`);
});

run('尾巴收尾對你的聲部同樣適用：你的舊音在你按下一個起音時，收音不晚於「新音 ＋ 檔案重疊量 ÷ 速度」', () => {
  // p0 的 60 長 0.7s（檔案裡跟拍 1 的 61 重疊 200ms）；第二下提早到 320ms（1.5625×）→ 重疊量 200ms ÷ 1.5625＝128ms，收在 448ms（原本會響到 448ms 之後）
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0.7, note: 60 }, { beat: 1, dur: 0.1, note: 61 }, 2] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 320);
  d.runMs(600);
  assert(near(offMs(log, 60, 'human') - t0, 320 + 200 / 1.5625, TICK_MS), `60 在 448ms 左右收，實際 ${offMs(log, 60, 'human') - t0}`);
});

run('尾巴收尾：同音高的舊音要在新音 noteOn 之前先收（先收再放），新音不會被連帶關掉', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [0, 1, 2], a1: [{ beat: 0.25, dur: 0.3, note: 70 }, { beat: 1, dur: 0.1, note: 70 }] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 320);
  d.runMs(500);
  const seq = log.filter((e) => e.note === 70 && (e.t === 'on' || e.t === 'off')).map((e) => e.t).join();
  assert(seq === 'on,off,on,off', `應為 on,off,on,off，實際 ${seq}`);
});

// ── hold：結尾對齊你某個起音的音（你的與電腦的一樣）不在原長收，等你按到那個起音才收；其餘的音照原長收，不依速度換算。譜是 120 BPM（拍長 0.5s）──
run('hold：結尾接著你下一個起音的音（含 MuseScore 的「少 1 tick」），你晚按時一直響到你按下去，你的與電腦的一樣', () => {
  // 你的 40、電腦的 60 起訖相同（拍 0 到拍 1 少 1 tick），電腦的 62 剛好到拍 1（tick 480）：都對齊你在拍 1 的起音
  const { log, d } = makeHp(buildBeatScore({
    me: [{ beat: 0, dur: ONE_TICK_SHORT, note: 40 }, { beat: 1, dur: 0.4, note: 41 }],
    cpu: [{ beat: 0, dur: ONE_TICK_SHORT, note: 60 }, { beat: 0, dur: 0.5, note: 62 }],
  }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(850);                                               // 原長 500ms 早就過了
  assert(count(log, 'off', 40) === 0 && count(log, 'off', 60) === 0 && count(log, 'off', 62) === 0, '還沒按下一個起音：三顆都 hold 著，不收');
  assert(d.pressAt(t0 + 900) === true, '第二下放行');
  [[40, 'human'], [60, 'assist'], [62, 'assist']].forEach(([n, label]) => assert(offMs(log, n, label) === t0 + 900, `${n} 在你按下去的那一刻收，實際 ${offMs(log, n, label) - t0}`));
});

run('hold：同一個 tick 你的音短、電腦音長——短音照原長收，長音只在它對齊的那個起音才收，不被中間的按鍵切掉', () => {
  // 你的 40 只有 0.2s（結尾 tick 192，不對齊任何起音）；電腦的 60 從拍 0 到拍 2（結尾 tick 960＝你在拍 2 的起音）
  const { log, d } = makeHp(buildBeatScore({
    me: [{ beat: 0, dur: 0.2, note: 40 }, { beat: 1, dur: 0.1, note: 41 }, { beat: 2, dur: 0.1, note: 42 }],
    cpu: [{ beat: 0, dur: 1.0, note: 60 }],
  }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(500);
  assert(near(offMs(log, 40, 'human') - t0, 200, TICK_MS), `你的短音 40 在原長 200ms 收（不被拉長），實際 ${offMs(log, 40, 'human') - t0}`);
  d.pressAt(t0 + 900);                                        // 拍 1：電腦的長音結尾在拍 2，不該被這一下切掉
  d.runMs(700);                                               // 1600ms：原長 1000ms 早就過了
  assert(count(log, 'off', 60) === 0, '60 的結尾對齊拍 2：只按了拍 1，它還要 hold 著');
  d.pressAt(t0 + 1800);
  assert(offMs(log, 60, 'assist') === t0 + 1800, `按到拍 2 的那一刻收，實際 ${offMs(log, 60, 'assist') - t0}`);
});

run('hold：你按得比預估早，結尾對齊起音的音在你按下那個起音的那一刻收（以你的聲部為準，不響到原長）', () => {
  // 電腦的 60 拍 0～拍 2（結尾對齊你在拍 2 的起音）。你快：360ms 按拍 1、700ms 按拍 2（檔案裡拍 2 在 1000ms）
  const { log, d } = makeHp(buildBeatScore({ me: [0, 1, 2], cpu: [{ beat: 0, dur: 1.0, note: 60 }] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 360);                                        // 預測 500ms，早按
  assert(count(log, 'off', 60) === 0, '拍 1 按下去時 60 還在它的音值內（結尾在拍 2）：繼續 loop，不收');
  d.pressAt(t0 + 700);
  assert(offMs(log, 60, 'assist') === t0 + 700, `按到拍 2 的那一刻收（不等原長），實際 ${offMs(log, 60, 'assist') - t0}`);
});

run('hold：結尾對齊的起音已經按過了（早按時）——整顆在你身後就跳過，不發聲、不會永遠 hold；T_k 還該響著的追音不 hold 到已經按過的起音', () => {
  // 電腦的 60 在拍 0.75（原排在 375ms 發聲）、結尾對齊拍 1；第二下在 320ms 就按了拍 1（早按）：60 整顆在你身後，跳過
  const a = makeHp(buildBeatScore({ me: [0, 1, 2, 3], cpu: [{ beat: 0.75, dur: 0.125, note: 60 }] }), [['me', 1]]);
  a.d.tick();
  const t0 = a.d.nowMs;
  a.d.press();
  a.d.pressAt(t0 + 320);
  a.d.runMs(900);                                             // 之後完全不按
  assert(count(a.log, 'on', 60) === 0 && count(a.log, 'off', 60) === 0, `60 結尾對齊你已經按過的起音：不發聲、不留 hold，實際 on ${count(a.log, 'on', 60)}／off ${count(a.log, 'off', 60)}`);
  assert(a.hp.chaseStats().skipped === 1, `跳過 1 顆，實際 ${JSON.stringify(a.hp.chaseStats())}`);
  // 61 在拍 0.75、結尾在拍 1.25（橫跨拍 1，結尾離拍 2 很遠）：追音，剩餘 0.25 拍＝0.125s ÷ 1.5625＝80ms 後收，不等你按拍 2
  const b = makeHp(buildBeatScore({ me: [0, 1, 2, 3], cpu: [{ beat: 0.75, dur: 0.25, note: 61 }] }), [['me', 1]]);
  b.d.tick();
  const s0 = b.d.nowMs;
  b.d.press();
  b.d.pressAt(s0 + 320);
  b.d.runMs(900);
  assert(onMs(b.log, 61, 'assist') === s0 + 320 && near(offMs(b.log, 61, 'assist') - s0 - 320, 80, TICK_MS), `61 追音在 320ms 發聲、響 80ms 就收，實際 on ${onMs(b.log, 61, 'assist') - s0}／off ${offMs(b.log, 61, 'assist') - s0}`);
});

run('hold：前奏的最後一個電腦音結尾接著你的入場點，你沒按就一直 hold 著，按下去才收', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [4, 5], a1: [0, 1, 2, { beat: 3, dur: ONE_TICK_SHORT, note: 55 }, 4, 5] }), [['p0', 1]]);
  d.tick();
  d.runMs(3000);                                              // 入場點在 2000ms，完全不按
  assert(count(log, 'on', 55) === 1 && count(log, 'off', 55) === 0, '55 的結尾對齊你的入場起音：等你按，不收');
  assert(count(log, 'off', 52) === 1, '前奏裡其他不對齊的音照原長收');
  const t = d.nowMs;
  assert(d.press() === true && offMs(log, 55, 'assist') === t, '按下入場音的那一刻收掉');
});

run('hold：hold 著的音不擋住同音高、排在它後面且已到期的音（先進先出只排沒有 hold 的音，_dueIndex）', () => {
  // 垂直切片之後，一般按鍵不會再讓 hold 著的舊音排在較晚發聲的同音高音前面（上一段的殘餘當場追音或跳過），所以直接測佇列規則：
  // 佇列 [B（hold 著，收音時刻無限大）, A（已到期）]——A 到期就要收，不能等到 B 被放行；只有 hold 著的音時不收任何一顆
  const { hp } = makeHp(buildBeatScore({ me: [0, 1, 2], cpu: [{ beat: 0.9, dur: 0.05, note: 70 }] }), [['me', 1]]);
  const B = { holdIdx: 2, offMs: Infinity }, A = { holdIdx: null, offMs: 500 }, C = { holdIdx: null, offMs: 900 };
  assert(hp._dueIndex([B, A], 600) === 1, 'A 已到期：從 hold 著的 B 後面挑出 A');
  assert(hp._dueIndex([B, A], 400) === -1, 'A 還沒到期：不收');
  assert(hp._dueIndex([B], 1e9) === -1, '只有 hold 著的音：永遠不收（要等你按）');
  assert(hp._dueIndex([A, C], 600) === 0 && hp._dueIndex([C, A], 600) === -1, '沒有 hold 時先進先出：只看最前面那顆沒有 hold 的音');
});

run('音長依你的速度等比例縮放：你按得比檔案快或慢，電腦音的起音與長度都跟著你的速度（整份譜用你的 BPM 演奏）', () => {
  // 快：兩次按鍵隔 320ms（1.5625×）。電腦音 53 在拍 1.5、長 0.2s（結尾不對齊起音）：起音在按下後 0.25÷1.5625＝160ms，長度 0.2÷1.5625＝128ms
  const fast = makeHp(buildBeatScore({ p0: [0, 1, 2], a1: [0, { beat: 1.5, dur: 0.2 }] }), [['p0', 1]]);
  fast.d.tick();
  const f0 = fast.d.nowMs;
  fast.d.press();
  fast.d.pressAt(f0 + 320);
  fast.d.runMs(500);
  assert(near(fast.hp.playbackRate, 1.5625, 1e-9), `速度 1.5625，實際 ${fast.hp.playbackRate}`);
  assert(near(onMs(fast.log, 53, 'assist') - (f0 + 320), 160, TICK_MS), `起音跟著你的速度（160ms），實際 ${onMs(fast.log, 53) - (f0 + 320)}`);
  assert(near(offMs(fast.log, 53, 'assist') - onMs(fast.log, 53, 'assist'), 128, TICK_MS), `長度 200÷1.5625＝128ms，實際 ${offMs(fast.log, 53) - onMs(fast.log, 53)}`);
  // 慢：兩次按鍵隔 1000ms（0.5×）。電腦音 53 起音在按下後 0.25÷0.5＝500ms，長度 0.2÷0.5＝400ms；你的音 41 長 0.2s 也是 400ms
  const slow = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0.2 }, { beat: 1, dur: 0.2 }, 2], a1: [0, { beat: 1.5, dur: 0.2 }] }), [['p0', 1]]);
  slow.d.tick();
  const s0 = slow.d.nowMs;
  slow.d.press();
  slow.d.pressAt(s0 + 1000);
  slow.d.runMs(900);
  assert(near(slow.hp.playbackRate, 0.5, 1e-9), `速度 0.5，實際 ${slow.hp.playbackRate}`);
  assert(near(onMs(slow.log, 53, 'assist') - (s0 + 1000), 500, TICK_MS), `起音跟著你的速度（500ms），實際 ${onMs(slow.log, 53) - (s0 + 1000)}`);
  assert(near(offMs(slow.log, 53, 'assist') - onMs(slow.log, 53, 'assist'), 400, TICK_MS), `長度 200÷0.5＝400ms，實際 ${offMs(slow.log, 53) - onMs(slow.log, 53)}`);
  assert(near(offMs(slow.log, 41, 'human') - (s0 + 1000), 400, TICK_MS), `你的音 41 也是 400ms，實際 ${offMs(slow.log, 41, 'human') - (s0 + 1000)}`);
});

run('hold：跨過多個起音的長音，一路 hold 到它對齊的那個起音，中間的按鍵與你彈得慢都不影響', () => {
  // 電腦的 60 是整音符（拍 0～4，結尾對齊你在拍 4 的起音）；你每 900ms 一下
  const { log, d } = makeHp(buildBeatScore({ me: [0, 1, 2, 3, 4], cpu: [{ beat: 0, dur: 2.0, note: 60 }] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 900);
  d.pressAt(t0 + 1800);
  d.runMs(300);                                               // 2100ms：原長 2000ms 已過
  assert(count(log, 'off', 60) === 0, '2100ms 時還在 hold');
  d.pressAt(t0 + 2700);
  d.runMs(800);
  assert(count(log, 'off', 60) === 0, '3500ms 時還在 hold（拍 4 還沒按）');
  d.pressAt(t0 + 3600);
  assert(offMs(log, 60, 'assist') === t0 + 3600, `按到拍 4 的那一刻收，實際 ${offMs(log, 60, 'assist') - t0}`);
});

run('hold：橫跨起音、結尾不對齊的音，等你按到它橫跨的那個起音，再響完檔案裡剩下的長度 ÷ 你的速度（你晚按就跟著晚，不在原長就停）', () => {
  // 電腦的 60 從拍 0 到 0.75s（tick 720），橫跨拍 1（tick 480）；原長在 750ms 結束，但你第二下晚到 900ms（速度 0.5/0.9＝0.5556×）
  const { hp, log, d } = makeHp(buildBeatScore({ me: [0, 1, 2], cpu: [{ beat: 0, dur: 0.75, note: 60 }] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(850);
  assert(count(log, 'off', 60) === 0, '原長（750ms）過了，但拍 1 還沒按：檔案裡 60 此刻還在響，不能先停');
  d.pressAt(t0 + 900);
  const tail = 250 / hp.playbackRate;                                // 檔案裡拍 1 到結尾 0.25s，依你的速度換算＝450ms
  assert(near(tail, 450, 0.5), `前提：剩餘長度 ÷ 速度＝450ms，實際 ${tail}`);
  d.runMs(600);
  assert(near(offMs(log, 60, 'assist') - t0, 900 + tail, TICK_MS), `按下拍 1 之後再響完剩餘長度（250ms ÷ 速度＝450ms），實際 ${offMs(log, 60, 'assist') - t0}`);
});

run('hold：橫跨起音的音，你早按時，在「結尾之前最後一個起音」後只再響剩餘長度 ÷ 速度（以你的聲部為準，不響到原長）', () => {
  // 電腦的 60 從拍 0 到 1.75s（tick 1680）：橫跨拍 1、2、3，結尾之前最後一個起音是拍 3（tick 1440）。你每 300ms 按一下（1.667×）
  const { hp, log, d } = makeHp(buildBeatScore({ me: [0, 1, 2, 3, 4, 5], cpu: [{ beat: 0, dur: 1.75, note: 60 }] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 300); d.pressAt(t0 + 600);
  assert(count(log, 'off', 60) === 0, '拍 1、2 都還沒到結尾之前最後一個起音（拍 3）：繼續 loop');
  d.pressAt(t0 + 900);                                              // 拍 3
  assert(near(hp.playbackRate, 1.5 / 0.9, 1e-9), `前提：速度 1.667，實際 ${hp.playbackRate}`);
  assert(count(log, 'off', 60) === 0, '拍 3 剛按下去，還要響剩餘 250ms ÷ 1.667＝150ms');
  d.runMs(300);
  assert(near(offMs(log, 60, 'assist') - t0, 900 + 150, TICK_MS), `60 在拍 3 之後 150ms 收（1050ms，不是原長的 1050ms 之後），實際 ${offMs(log, 60, 'assist') - t0}`);
});

run('hold：橫跨多個起音的音，剩餘長度從「結尾之前最後一個起音」起算，後面的按鍵不影響', () => {
  // 同上的 60（結尾之前最後一個起音是拍 3），你每 900ms 一下（0.5556×）：剩餘 250ms ÷ 0.5556＝450ms
  const { hp, log, d } = makeHp(buildBeatScore({ me: [0, 1, 2, 3, 4, 5], cpu: [{ beat: 0, dur: 1.75, note: 60 }] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 900); d.pressAt(t0 + 1800);
  d.runMs(900);                                                    // 2700ms：拍 3 還沒按
  assert(count(log, 'off', 60) === 0, '拍 3 還沒按：一路等');
  d.pressAt(t0 + 2700);
  const tail = 250 / hp.playbackRate;
  assert(near(tail, 450, 0.5), `前提：剩餘 ÷ 速度＝450ms，實際 ${tail}`);
  d.runMs(300);
  assert(count(log, 'off', 60) === 0, '拍 3 按下去 300ms 後還在響（剩餘 450ms）');
  d.runMs(300);
  assert(count(log, 'off', 60) === 1 && near(offMs(log, 60, 'assist') - t0, 2700 + tail, TICK_MS), `拍 3 按下去 450ms（剩餘 ÷ 速度）後收，實際 ${offMs(log, 60, 'assist') - t0}`);
  d.pressAt(t0 + 3600);
  assert(count(log, 'off', 60) === 1, '之後的按鍵不再動它');
});

run('hold 容差：匯出器統一縮短一點點的相連音也算接著下一個起音；斷奏、離起音太遠的音照原長收；容差上限是十六分音符', () => {
  // 你的起音在拍 0、1、4。電腦的 60 拍 0～454（比拍 1 早 26 tick，約 5.4%）→ hold；62 拍 0～240（斷奏，空隙一半）→ 不 hold。
  // 66、68 從拍 1 起，結尾比拍 4（tick 1920）早 100／130 tick：容差上限＝十六分音符 120 tick → 66 hold、68 不 hold
  const mk = (beat, endTick, note) => ({ beat, dur: ((endTick - beat * 480) / 480) * 0.5, note });
  const { log, d } = makeHp(buildBeatScore({
    me: [0, 1, 4],
    cpu: [mk(0, 454, 60), mk(0, 240, 62), mk(1, 1820, 66), mk(1, 1790, 68)],
  }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(450);
  assert(near(offMs(log, 62, 'assist') - t0, 250, TICK_MS), `斷奏的 62 在原長（250ms）收，實際 ${offMs(log, 62, 'assist') - t0}`);
  assert(count(log, 'off', 60) === 0, '60 比拍 1 早 26 tick（間隔的 5.4%）：算接著拍 1，原長（約 473ms）過了也要等你按');
  d.pressAt(t0 + 500);
  assert(offMs(log, 60, 'assist') === t0 + 500, '拍 1 按下去的那一刻收 60');
  d.runMs(1500);                                                   // 拍 1 起算 1500ms：68 的原長（約 1365ms）已過
  assert(near(offMs(log, 68, 'assist') - (t0 + 500), 1365, TICK_MS), `68 比拍 4 早 130 tick（超過十六分音符）：照原長（約 1365ms）收，實際 ${offMs(log, 68, 'assist') - (t0 + 500)}`);
  assert(count(log, 'off', 66) === 0, '66 比拍 4 早 100 tick（在十六分音符之內）：原長（約 1396ms）過了也要等你按');
  d.pressAt(d.nowMs + 1000);
  assert(count(log, 'off', 66) === 1, '按下拍 4 之後 66 收');
});

run('hold 容差：沒有 tick per quarter 的檔案（SMPTE，timeDivision＝null）用固定秒數當上限，相連音一樣 hold', () => {
  const smpte = { ...buildBeatScore({ me: [0, 1, 2], cpu: [{ beat: 0, dur: (454 / 480) * 0.5, note: 60 }] }), timeDivision: null };
  const { log, d } = makeHp(smpte, [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(800);
  assert(count(log, 'off', 60) === 0, '比下一個起音早 26 tick 的相連音：等你按');
  d.pressAt(t0 + 900);
  assert(offMs(log, 60, 'assist') === t0 + 900, '按下去的那一刻收');
});

run('hold：零長度的音、離下一個起音還很遠的短音不會被誤判成相連而 hold', () => {
  // 電腦的 60 是零長度（拍 0.5，tick 240）；62 是 10 tick 長、結尾離拍 1 還有 230 tick
  const { log, d } = makeHp(buildBeatScore({ me: [0, 1, 2], cpu: [{ beat: 0.5, dur: 0, note: 60 }, { beat: 0.5, dur: (10 / 480) * 0.5, note: 62 }] }), [['me', 1]]);
  d.tick();
  d.press();
  d.runMs(700);
  assert(count(log, 'on', 60) === 1 && count(log, 'off', 60) === 1, '零長度的音發聲後立刻收');
  assert(count(log, 'on', 62) === 1 && count(log, 'off', 62) === 1, '短音照原長收');
});

run('hold：同譜表的新音發聲時，檔案裡沒有重疊的 hold 音（舊音已結束、新音在起音前一點點發聲）在新音那一刻收，不會糊到你下一次按鍵', () => {
  // 電腦的 70 從拍 0.25 到 tick 456（比你在拍 1 的起音早 24 tick，在容差內＝要 hold）；同譜表的 71 在 tick 468 發聲：檔案裡 70 已經結束
  const { log, d } = makeHp(buildBeatScore({ me: [0, 1, 2], cpu: [{ beat: 0.25, dur: 0.35, note: 70 }, { beat: 0.975, dur: 0.01, note: 71 }] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(800);                                               // 還沒按拍 1
  assert(near(offMs(log, 70, 'assist') - t0, 487.5, TICK_MS), `70 在 71 發聲（487.5ms）那一刻收，不 hold 到你按，實際 ${offMs(log, 70, 'assist') - t0}`);
});

run('hold：同一行譜的多聲部——檔案裡真的重疊、音高不同的 hold 長音保留 loop，不被新音修剪；你按下它的結尾起音那一刻才收', () => {
  // 電腦的 70 從拍 0.25 到拍 1（對齊你的起音）；同譜表的 71 在拍 0.5 發聲：檔案裡 70 在 71 之後還響 0.25s（樂譜本意的重疊，不是你早按造成的）
  const { log, d } = makeHp(buildBeatScore({ me: [0, 1, 2], cpu: [{ beat: 0.25, dur: 0.375, note: 70 }, { beat: 0.5, dur: 0.1, note: 71 }] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(800);                                               // 還沒按拍 1
  assert(count(log, 'on', 71) === 1 && count(log, 'off', 70) === 0, `71 發聲後 70 仍在 loop，實際 off ${count(log, 'off', 70)}`);
  d.pressAt(t0 + 900);
  assert(offMs(log, 70, 'assist') === t0 + 900, `按下拍 1 的那一刻收，實際 ${offMs(log, 70, 'assist') - t0}`);
});

run('hold 的音遇到暫停：全部收掉，續播後不會留下卡音', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ me: [{ beat: 0, dur: ONE_TICK_SHORT, note: 40 }, 1] }), [['me', 1]]);
  d.tick(); d.press(); d.runMs(800);
  assert(count(log, 'off', 40) === 0, '暫停前 40 在 hold');
  hp.pause();
  assert(count(log, 'off', 40) === 1, '暫停收掉 hold 的音');
  hp.play(); d.tick(); d.runMs(2000);
  assert(count(log, 'off', 40) === 1, '續播後不再有第二個 noteOff');
});

run('按鍵記錄：每次按鍵嘗試都記（含被去抖擋掉、前奏預按），沒有資格的不記；重設清空；回傳的是複本', () => {
  const { hp, d } = makeHp(buildBeatScore({ me: [4, 5, 6], cpu: [0, 1, 2, 3] }), [['me', 1]]);   // cpu 有前奏（拍 0～3），你的入場點在拍 4
  d.tick();
  d.press();                                                 // 前奏中：不放行、記成預按
  assert(hp.pressLog().length === 1 && hp.pressLog()[0].released === false && hp.pressLog()[0].slot === 1, `前奏預按要記（released＝false），實際 ${JSON.stringify(hp.pressLog())}`);
  hp.trigger(2, d.nowMs);                                    // 槽位 2 沒有指派聲部：不算
  assert(hp.pressLog().length === 1, '沒有資格的槽位不記');
  d.runMs(2200);                                             // 前奏播到入場點，預按自動放行第一個起音（tick 放行，不是按鍵，不記）
  assert(hp.pressLog().length === 1, '預按在 tick 裡自動放行的那一下不重複記');
  const t1 = d.nowMs;
  d.press();                                                 // 入場後立刻再按：離上一次放行太近 → 被去抖擋掉
  d.pressAt(t1 + 600);                                       // 正常的一下
  const log = hp.pressLog();
  assert(log.length === 3 && log[1].released === false && log[2].released === true, `擋掉的記 false、放行的記 true，實際 ${JSON.stringify(log)}`);
  assert(near(log[2].clockMs - log[1].clockMs, 600, 1), `clockMs 是排程器時鐘（兩次相差 600），實際 ${log[2].clockMs - log[1].clockMs}`);
  log.length = 0;
  assert(hp.pressLog().length === 3, '改回傳的陣列不影響排程器裡的記錄（複本）');
  hp.stop();
  assert(hp.pressLog().length === 0, 'stop() 之後清空');
});

run('你的音在下一次按鍵時，endTick ≤ 新起音的先收：按得比預估早，也不等排好的收音時刻（先收再放）', () => {
  // 40 長 0.45s（結尾在 tick 432）；第一次按鍵時速度還是 1×，排好的收音時刻在 450ms 後。
  // 第二下提早到 320ms：這時 40 已經過了它的結尾 tick，要在這一下先關掉，而不是掛到 450ms。
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0.45 }, 1] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 320);
  assert(offMs(log, 40, 'human') === t0 + 320, `40 應在第二下的那一刻收掉（${t0 + 320}），實際 ${offMs(log, 40)}`);
  assert(onMs(log, 41, 'human') === t0 + 320, '41 在同一刻發聲');
});

run('慢按：電腦聲部放完這一段就停，不越過你的下一個起音；你停手太久這次間隔不拿來估速', () => {
  // 這首歌的典型起音間隔 g ＝ 2 秒，速度區間下緣 ＝ g ÷ 30 秒 ＝ 0.0667；兩個起音相隔 2 樂譜秒，隔超過 30 秒（隱含速度 < 0.0667）才算停手，所以停 40 秒
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 4], a1: [0, 1, 2, 3, 4, 5, 6, 7] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(40000);
  [0, 1, 2, 3].forEach((b) => assert(near(onMs(log, 52 + b, 'assist') - t0, b * 500, TICK_MS), `第 ${b} 拍的電腦音照時刻發聲`));
  assert(onMs(log, 56) === undefined && onMs(log, 41) === undefined, '拍 4 是你的下一個起音，電腦音 56 與你的 41 都要等你按');
  assert(near(hp.getPositionTicks(), 1920, 1e-6), `播放頭停在下一個起音（tick 1920），實際 ${hp.getPositionTicks()}`);
  const t1 = d.nowMs;
  assert(d.press() === true, '之後照常放行');
  assert(hp.playbackRate === 1, `停手超過閒置門檻之後的間隔不拿來估速：速度維持 1，實際 ${hp.playbackRate}`);
  d.runMs(600);
  assert(near(onMs(log, 57, 'assist') - t1, 500, TICK_MS), '速度維持 1×：拍 5 的電腦音 57 在 500ms 後發聲');
});

run('速度還沒學到時，你很慢（比預測慢很多）不是停手：這次間隔照常拿來估速（不然慢速演奏者永遠學不到速度）', () => {
  // 預測 500ms、實際 1500ms：停格 1000ms 超過 800ms，但沒超過預測的 10 倍（5000ms）
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  assert(d.pressAt(t0 + 1500) === true, '第二下');
  assert(near(hp.playbackRate, 1 / 3, 1e-9), `速度要學到 1/3，實際 ${hp.playbackRate}`);
});

run('速度還沒學到時，慢到速度下限（0.1×）以內都學得到：每拍 4 秒（慢 8×）第二下就學到 0.125、之後電腦音跟著你的慢速排', () => {
  // 以前的門檻是預測間隔的 3 倍：慢超過 4× 的人每一下都被當成停手，速度永遠停在 1×（原譜 BPM），電腦音在每一格開頭連續出完
  const { hp, log, d } = makeHp(buildBeatScore({ me: [0, 1, 2, 3, 4], cpu: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 4000);                                       // 預測 500ms、實際 4000ms：停格 3500ms < 5000ms
  assert(near(hp.playbackRate, 0.125, 1e-9), `第二下就學到 0.125，實際 ${hp.playbackRate}`);
  d.pressAt(t0 + 8000);
  d.pressAt(t0 + 12000);
  assert(near(hp.playbackRate, 0.125, 1e-9), `之後維持 0.125（歷史沒有被清掉），實際 ${hp.playbackRate}`);
  const t3 = t0 + 12000;
  d.runMs(5000);
  // 第四下（拍 3）之後：電腦音在拍 3.5 ＝ 0.25s ÷ 0.125 ＝ 2000ms 後發聲（不是 500ms 後一口氣出完）
  assert(near(onMs(log, 59, 'assist') - t3, 2000, TICK_MS), `拍 3.5 的電腦音（59）${(onMs(log, 59, 'assist') - t3)}ms 後發聲（應約 2000ms）`);
});

run('連按之後轉成極慢（每下約 10 秒）：連續兩下一致的長空檔是你很慢、不是停手，速度要學到 g ÷ 10 秒而不是鎖在連按時的快速', () => {
  // 拍長 150ms 的譜（g＝0.15 秒，區間 [0.005, 2.5]），連按 6 下（每 150ms）學到約 1×；接著每下停 10 秒（隱含速度 0.015）。
  // 第一次長空檔（速度已學到）先不信（驚訝）、速度維持；第二下的隱含速度跟它一致才接受（變速）：不能一直當停手而鎖在連按時的快速
  const { hp, d } = makeHp(buildBeatScore({ p0: Array.from({ length: 20 }, (_, i) => i) }, 0.15), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  for (let k = 1; k <= 5; k++) assert(d.pressAt(t0 + 150 * k) === true, `連按第 ${k + 1} 下`);
  assert(near(hp.playbackRate, 1, 0.05), `連按後學到約 1×，實際 ${hp.playbackRate}`);
  const t5 = t0 + 750;
  d.pressAt(t5 + 10000);
  assert(near(hp.playbackRate, 1, 0.05), `第一次長空檔先不信：速度維持，實際 ${hp.playbackRate}`);
  d.pressAt(t5 + 20000);
  assert(near(hp.playbackRate, 0.015, 1e-9), `第二下一致：你很慢，速度學到 0.15 ÷ 10 ＝ 0.015，實際 ${hp.playbackRate}`);
  d.pressAt(t5 + 30000);
  assert(near(hp.playbackRate, 0.015, 1e-9), `之後維持（歷史沒有再被清掉），實際 ${hp.playbackRate}`);
});

run('速度還沒學到時，空檔超過 30 秒對應的長度才算停手：這次間隔不拿來估速；30 秒以內都是你很慢', () => {
  // g＝0.5 秒，區間下緣 ＝ 0.5 ÷ 30 ＝ 0.0167：隔 25 秒（隱含 0.02）是很慢、隔 40 秒（隱含 0.0125）是停手
  const a = makeHp(buildBeatScore({ p0: [0, 1, 2, 3] }), [['p0', 1]]);
  a.d.tick();
  const t0 = a.d.nowMs;
  a.d.press();
  assert(a.d.pressAt(t0 + 25000) === true, '第二下');
  assert(near(a.hp.playbackRate, 0.02, 1e-9), `隔 25 秒：學到 0.02，實際 ${a.hp.playbackRate}`);
  const b = makeHp(buildBeatScore({ p0: [0, 1, 2, 3] }), [['p0', 1]]);
  b.d.tick();
  const s0 = b.d.nowMs;
  b.d.press();
  assert(b.d.pressAt(s0 + 40000) === true, '第二下');
  assert(b.hp.playbackRate === 1, `隔 40 秒：停手，速度維持 1，實際 ${b.hp.playbackRate}`);
});

run('每首歌的速度區間依你的聲部起音間隔算：換指派（reassign）後重算，新 MIDI 不必手調', () => {
  // me 每 0.5 秒一個起音（g＝0.5）、slow 每 2 秒一個（g＝2）；區間 ＝ [g ÷ 30, g ÷ 0.06]
  const { hp } = makeHp(buildBeatScore({ me: Array.from({ length: 30 }, (_, i) => i), slow: Array.from({ length: 8 }, (_, i) => i * 4) }), [['me', 1]]);
  assert(near(hp._rateBounds.lo, 0.5 / 30, 1e-9) && near(hp._rateBounds.hi, 0.5 / 0.06, 1e-9), `me：[0.0167, 8.33]，實際 ${JSON.stringify(hp._rateBounds)}`);
  assert(hp.rateBounds().lo === hp._rateBounds.lo && hp.rateBounds() !== hp._rateBounds, 'rateBounds() 回傳複本');
  hp.reassign(new Map([['slow', 1]]));
  assert(near(hp._rateBounds.lo, 2 / 30, 1e-9) && near(hp._rateBounds.hi, 2 / 0.06, 1e-9), `改指派 slow 之後重算：[0.0667, 33.3]，實際 ${JSON.stringify(hp._rateBounds)}`);
});

run('極快：連按每 100ms（每 0.5 拍秒的譜 ＝ 5×，超過舊上限 4×）也學得到，不被夾在 4×', () => {
  const { hp, d } = makeHp(buildBeatScore({ me: Array.from({ length: 40 }, (_, i) => i) }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  for (let k = 1; k <= 30; k++) d.pressAt(t0 + 100 * k);
  assert(near(hp.playbackRate, 5, 0.5), `連按每 100ms 的速度倍率約 5，實際 ${hp.playbackRate}`);
});

run('極快的上緣：連按每 55ms（隱含 9.09×，超過這首歌的區間上緣 8.33×）速度夾在區間上緣，不超過', () => {
  const { hp, d } = makeHp(buildBeatScore({ me: Array.from({ length: 60 }, (_, i) => i) }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  for (let k = 1; k <= 40; k++) d.pressAt(t0 + 55 * k);
  assert(near(hp.rateBounds().hi, 0.5 / 0.06, 1e-9), `區間上緣 8.33，實際 ${hp.rateBounds().hi}`);
  assert(near(hp.playbackRate, hp.rateBounds().hi, 1e-6), `速度夾在區間上緣 8.33，實際 ${hp.playbackRate}`);
});

run('變速：你真的變慢 4×——第一下先不信（速度維持），第二下一致才接受，之後電腦音跟著新速度', () => {
  const { hp, d } = makeHp(buildBeatScore({ me: Array.from({ length: 30 }, (_, i) => i) }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  for (let k = 1; k <= 6; k++) d.pressAt(t0 + 500 * k);
  assert(near(hp.playbackRate, 1, 0.05), `學到約 1×，實際 ${hp.playbackRate}`);
  d.pressAt(t0 + 3000 + 2000);                                // 第一個 2 秒的間隔：驚訝（隱含 0.25 比 1 差 4 倍），先不信
  assert(near(hp.playbackRate, 1, 0.05), `第一下先不信：速度維持，實際 ${hp.playbackRate}`);
  d.pressAt(t0 + 3000 + 4000);                                // 第二個 2 秒的間隔：一致，接受
  assert(near(hp.playbackRate, 0.25, 0.01), `第二下一致：接受變速，速度 0.25，實際 ${hp.playbackRate}`);
});

run('停手／失誤：只有一個長空檔、之後回到原本速度——速度不被拖慢（驚訝的那一下不拿來估速）', () => {
  const { hp, d } = makeHp(buildBeatScore({ me: Array.from({ length: 30 }, (_, i) => i) }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  for (let k = 1; k <= 6; k++) d.pressAt(t0 + 500 * k);
  d.pressAt(t0 + 3000 + 6000);                                // 停 6 秒
  assert(near(hp.playbackRate, 1, 0.05), `停手那一下：速度維持，實際 ${hp.playbackRate}`);
  for (let k = 1; k <= 4; k++) d.pressAt(t0 + 9000 + 500 * k); // 回到原速
  assert(near(hp.playbackRate, 1, 0.1), `回到原速之後仍是 1×（空檔沒有混進估速），實際 ${hp.playbackRate}`);
});

run('音長上限不短於檔案本身的長度：整首自動播放（1×）檔案裡 12 秒的長音照 12 秒收，不被 8 秒上限切短', () => {
  const { log, d } = makeHp(buildBeatScore({ a: [{ beat: 0, dur: 12, note: 60 }] }), []);
  d.tick();
  d.runMs(14000);
  assert(near(offMs(log, 60, 'assist') - onMs(log, 60, 'assist'), 12000, TICK_MS), `12 秒的長音照 12 秒收，實際 ${offMs(log, 60, 'assist') - onMs(log, 60, 'assist')}ms`);
});

run('極慢的音長上限 8 秒：速度 0.02× 時 0.2 秒的段內音響 8 秒（不是 10 秒）；起音位置仍照完整速度排開', () => {
  // 隔 25 秒（隱含 0.02）學到 0.02；電腦的 70 在拍 1.1（0.05s 後）、長 0.2s 的段內音（結尾離下一個起音很遠，不 hold）
  const { hp, log, d } = makeHp(buildBeatScore({ me: [0, 1, 2, 3], cpu: [{ beat: 1.1, dur: 0.2, note: 70 }] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 25000);
  assert(near(hp.playbackRate, 0.02, 1e-9), `速度 0.02，實際 ${hp.playbackRate}`);
  d.runMs(14000);
  assert(near(onMs(log, 70, 'assist') - (t0 + 25000), 2500, TICK_MS), `70 的起音照完整速度：（拍 1.1 − 拍 1）＝ 0.05 樂譜秒 ÷ 0.02 ＝ 2.5 秒，實際 ${onMs(log, 70, 'assist') - (t0 + 25000)}ms`);
  assert(near(offMs(log, 70, 'assist') - onMs(log, 70, 'assist'), 8000, TICK_MS), `音長 0.2s ÷ 0.02 ＝ 10 秒，上限 8 秒，實際 ${offMs(log, 70, 'assist') - onMs(log, 70, 'assist')}ms`);
});

run('速度學到之後（≥ 3 個間隔），停格超過 800ms 就算停手：這次間隔不拿來估速', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3, 4, 5] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  [500, 1000, 1500].forEach((ms) => assert(d.pressAt(t0 + ms) === true, `第 ${ms} 下`));   // 3 個間隔，速度 1×
  assert(d.pressAt(t0 + 3500) === true, '停 2 秒後再按');    // 預測 500ms，停格 1500ms > 800ms
  assert(hp.playbackRate === 1, `停手：歷史清空、速度維持 1（不被拖慢），實際 ${hp.playbackRate}`);
});

run('停格超過閒置門檻（800ms）：橫跨你下一個起音的長音不被閒置收音切掉，也不在原長就停，等你按下那個起音再響完剩下的長度', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 5 }, 1] }), [['p0', 1]]); // 長音 5s，下一個起音在 0.5s
  d.tick();
  d.press();
  d.runMs(2500);                                              // 0.5s 到達下一個起音停格，停格已 2s：早就超過 800ms
  assert(count(log, 'off', 40) === 0, '停格超過 800ms，長音還沒到它自己的結尾，不能被閒置收音切掉');
  d.runMs(3000);                                              // 5500ms：原長（5000ms）早就過了，但拍 1 還沒按，檔案裡這顆音此刻還在響
  assert(count(log, 'off', 40) === 0, '原長過了、你還沒按它橫跨的起音：繼續等');
  d.runMs(30000);                                             // 再等到 35.5 秒：空檔超過 30 秒＝停手（速度維持 1×），剩餘長度照 1× 算
  assert(count(log, 'off', 40) === 0, '空檔再久也沒有時間上限：一直 hold 到你按下去');
  const t1 = d.nowMs;
  d.press();
  assert(count(log, 'on', 41) === 1 && count(log, 'off', 40) === 0, '之後照常放行；長音在你按下那個起音後再響完剩下的 4500ms');
  d.runMs(4600);
  assert(count(log, 'off', 40) === 1 && near(offMs(log, 40) - t1, 4500, TICK_MS), `長音在按下後 4500ms 收，實際 ${offMs(log, 40) - t1}ms`);
});

run('停格超過閒置門檻（800ms）：電腦聲部橫跨你下一個起音的長音同樣不被切掉，等你按下去再響完剩下的長度 ÷ 速度', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 4], a1: [{ beat: 0, dur: 3 }] }), [['p0', 1]]); // 電腦的長音 3s，你的下一個起音在 2s
  d.tick();
  d.press();
  d.runMs(2900);                                              // 2s 起停格，停格 0.9s：超過門檻
  assert(count(log, 'on', 52) === 1 && count(log, 'off', 52) === 0, `電腦的長音還沒到結尾，不能被切掉，實際 off ${count(log, 'off', 52)} 個`);
  d.runMs(500);                                               // 3400ms：原長（3000ms）過了，你還沒按
  assert(count(log, 'off', 52) === 0, '原長過了、你還沒按它橫跨的起音：繼續等');
  const t1 = d.nowMs;
  d.press();
  const tail = 1000 / hp.playbackRate;                        // 檔案裡起音（2s）到結尾（3s）剩 1s，依你按出來的速度換算
  d.runMs(tail + 100);
  assert(near(offMs(log, 52, 'assist') - t1, tail, TICK_MS), `按下去之後再響完剩下的 1s ÷ 速度＝${tail.toFixed(0)}ms，實際 ${offMs(log, 52, 'assist') - t1}`);
});

run('最後一個 driver 起音之後的電腦音照節奏自己放完，尾音照時值收完才算播完；進度夾在總長以內', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0], a1: [0, 1, 2, 3] }), [['p0', 1]]);
  d.tick();
  assert(!hp.isFinished(), '還沒按，不算播完');
  d.press();
  assert(!hp.isFinished(), '放行完了但電腦音還沒放完，不算播完');
  d.runMs(6000);
  assert([52, 53, 54, 55].every((n) => onMs(log, n, 'assist') !== undefined), '之後的電腦音都自己放出來，不用再按');
  assert(hp.isFinished(), '全部放完、收完＝播完');
  assert(hp.getPositionTicks() === hp._score.durationTicks, `進度夾在總長（${hp._score.durationTicks} tick），實際 ${hp.getPositionTicks()}`);
});

/* ═══════════════════════════════════════════
   估速（最近 8 個間隔的頭尾比值）與去抖
   ═══════════════════════════════════════════ */

run('playbackRate：第一次按之前與第一次按都是 1；穩定的按鍵節奏估得出來；視窗只看最近 8 個間隔', () => {
  const beats = Array.from({ length: 20 }, (_, i) => i);      // 每拍一個 driver 起音，樂譜間隔 0.5s
  const { hp, d } = makeHp(buildBeatScore({ p0: beats }), [['p0', 1]]);
  d.tick();
  assert(hp.playbackRate === 1, '還沒按：1');
  const t0 = d.nowMs;
  assert(d.press() === true && hp.playbackRate === 1, '第一下沒有間隔可估，維持 1');
  for (let k = 1; k <= 9; k++) assert(d.pressAt(t0 + k * 400) === true, `第 ${k + 1} 下（每 400ms 一下）應該被接受`);
  assert(near(hp.playbackRate, 1.25, 1e-9), `每拍 0.5s 在 400ms 內按完＝1.25×，實際 ${hp.playbackRate}`);
  for (let k = 1; k <= 8; k++) assert(d.pressAt(t0 + 9 * 400 + k * 800) === true, `慢下來每 800ms 一下，第 ${k} 下應該被接受`);
  assert(near(hp.playbackRate, 0.625, 1e-9), `最近 8 個間隔都是 800ms（0.5s ÷ 0.8s）＝0.625×，更早的快節奏不再影響，實際 ${hp.playbackRate}`);
});

run('去抖：兩次按鍵太近就忽略第二次——不放行、不發聲、不更新估速；之後正常的按鍵照常放行', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  assert(d.press() === true, '第一下');
  const before = count(log, 'on');
  assert(d.pressAt(t0 + 30) === false && count(log, 'on') === before && hp._segIndex === 1, '30ms 後的第二下（手抖／重複觸發）被忽略：不發聲、segment 沒前進');
  assert(d.pressAt(t0 + 500) === true && hp._segIndex === 2, '500ms 後的按鍵照常放行（那次被忽略的按鍵不影響）');
  assert(hp.playbackRate === 1, `速度只用兩次有效按鍵（0.5s ÷ 0.5s）＝1，不受被忽略的按鍵影響，實際 ${hp.playbackRate}`);
  const n = count(log, 'on');
  assert(d.pressAt(t0 + 600) === false && count(log, 'on') === n, '剛放行完 100ms 內又按：忽略（窗口 ≈ 0.6 × 預估 500ms）');
});

run('去抖不會把「一開始就比檔案快」的人永遠擋住：只有第一個間隔的第二下被擋，之後都按得上，速度也學得起來', () => {
  const beats = Array.from({ length: 14 }, (_, i) => i);
  const { hp, d } = makeHp(buildBeatScore({ p0: beats }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  const results = [];
  for (let k = 0; k < 14; k++) results.push(d.pressAt(t0 + k * 250));  // 每 250ms 一下＝檔案速度的 2 倍
  assert(results.filter((r) => !r).length === 1 && results[1] === false, `只有第一個間隔的第二下（250ms 後）被擋，實際 ${results.map((r) => (r ? '✓' : '✗')).join('')}`);
  assert(near(hp.playbackRate, 2, 1e-9), `視窗內都是 250ms 的間隔＝2×，實際 ${hp.playbackRate}`);
});

run('沒有放行的情況：沒在播放、槽位沒有指派聲部、暫停中、整首自動播放、載入空樂譜，trigger() 都回傳 false 而且不發聲', () => {
  const score = buildBeatScore({ p0: [0, 2], a1: [0, 1] });
  const stopped = makeHp(score, [['p0', 1]], { play: false });
  assert(stopped.d.press() === false, '還沒 play()');
  const { hp, log, d } = makeHp(score, [['p0', 1]]);
  assert(d.press(2) === false, '槽位 2 沒有指派任何聲部，沒有資格推進');
  hp.pause();
  assert(d.press() === false, '暫停中');
  const auto = makeHp(score, []);
  assert(auto.d.press() === false, '沒有人被指派＝整首自動播放，不接受觸發');
  const empty = new Scheduler();
  empty.load(null, []);
  empty.play();
  assert(empty.trigger(1, 0) === false, '沒有樂譜');
  assert(onNotes(log).length === 0 && onNotes(stopped.log).length === 0, '這些情況都不該發聲');
});

/* ═══════════════════════════════════════════
   收音、零長度、先進先出
   ═══════════════════════════════════════════ */

run('音長依你的速度等比例縮放（速度 1× 時就是 MIDI 的音符長度）', () => {
  const dur = 0.4;                                            // 384 tick＝0.4s
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur }, { beat: 1, dur }, { beat: 2, dur }, { beat: 3, dur }] }), [['p0', 1]]);
  d.tick(); const t0 = d.nowMs;
  d.press();
  assert(offMs(log, 40) === undefined, '剛按下，第一顆還在響');
  d.runMs(500);
  assert(near(offMs(log, 40) - t0, 400, TICK_MS), `第一次按之後還沒有速度可估（1×）：音照 MIDI 長度（0.4s）在 400ms 後收，實際 ${offMs(log, 40) - t0}`);
  d.pressAt(t0 + 700);                                        // 第二下（比檔案慢：0.5s 的間隔花 700ms）
  d.pressAt(t0 + 1400);                                       // 第三下
  const t2 = t0 + 1400;
  d.runMs(800);
  const rate = 1.0 / ((t2 - t0) / 1000);                      // 兩個間隔共 1.0 樂譜秒、真實 1400ms
  assert(near(rate, 0.714, 0.001), '前提：估到的速度約 0.714×');
  assert(near(offMs(log, 42) - t2, 400 / rate, TICK_MS + 2), `第三顆音（0.4s）在速度 ${rate.toFixed(3)}× 下放長成 ${(400 / rate).toFixed(0)}ms 收，實際 ${offMs(log, 42) - t2}`);
});

run('同音高重疊（先進先出）：兩顆同音高的重疊音各自在自己的時刻收，不留卡音', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 1.0, note: 60 }, { beat: 1, dur: 1.0, note: 60 }] }), [['p0', 1]]);
  d.tick(); const t0 = d.nowMs;
  d.press(); d.pressAt(t0 + 500);                             // 準時按（速度 1×）
  d.runMs(2500);
  const offs = log.filter((e) => e.t === 'off' && e.note === 60).map((e) => e.ms);
  assert(count(log, 'on', 60) === 2 && offs.length === 2, `兩個 noteOn、兩個 noteOff，實際 ${count(log, 'on', 60)}／${offs.length}`);
  assert(near(offs[0] - t0, 1000, 30) && near(offs[1] - t0, 1500, 30), `先進先出：第一顆在樂譜 1.0s、第二顆在 1.5s 收，實際 ${offs.map((m) => m - t0)}`);
  assert(hp.isFinished(), '全部放行、收音之後算播完');
});

run('零長度的音（起點＝終點，軌尾收尾的音）：照樣發聲、收音，每個 noteOn 一個 noteOff', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0, note: 99 }] }), [['p0', 1]]);
  d.tick(); d.press();
  assert(count(log, 'on', 99) === 1 && count(log, 'off', 99) === 1, `一個 noteOn、一個 noteOff，實際 ${count(log, 'on', 99)}／${count(log, 'off', 99)}`);
  assert(offMs(log, 99) === onMs(log, 99), '零長度的音在同一次呼叫內收掉');
  assert(hp.isFinished(), '放行完而且沒有音在響＝播完');
});

run('相連音 hold：你的音結尾接著下一個起音（MuseScore 少 1 tick），你停手就一直響到你按下一個起音；按下時先收再放', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, { beat: 1, dur: 0.4 }] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(700);
  assert(count(log, 'off', 40) === 0, '原長（約 500ms）過了，下一個起音還沒按：40 hold 著');
  const t1 = d.nowMs;
  d.press();
  assert(count(log, 'off', 40) === 1 && offMs(log, 40) === t1 && onMs(log, 41) === t1, '下一個起音放行的那一刻：先收 40、再開 41');
  const iOff = log.findIndex((e) => e.t === 'off' && e.note === 40), iOn = log.findIndex((e) => e.t === 'on' && e.note === 41);
  assert(iOff < iOn, '先收再放');
});

run('相連音的後繼音就在同一段裡（不用等你按）：照自己的時刻關、再開', () => {
  // a0 的兩顆音在拍 0 與拍 0.5（相連），你的起音在拍 0 與拍 2：後繼音屬於同一段，自己會發聲
  const { log, d } = makeHp(buildBeatScore({ a0: [{ beat: 0, dur: 239 / 960 }, { beat: 0.5, dur: 0.1 }], p1: [0, 2] }), [['p1', 1]]);   // a0 第一顆 239 tick（比下一顆早 1 tick 結束）
  d.tick(); d.press();
  d.runMs(400);
  const iOff = log.findIndex((e) => e.t === 'off' && e.note === 40), iOn = log.findIndex((e) => e.t === 'on' && e.note === 41);
  assert(iOff !== -1 && iOn !== -1 && iOff < iOn, `後繼音自己發聲，舊音先收、再開新音，實際 off#${iOff} on#${iOn}`);
});

run('停格再久也不被閒置切掉：結尾接著下一個起音的長音一直 hold 到你按；結尾不對齊的長音照原長收', () => {
  // 40：0～5s−1tick（結尾對齊拍 10 的起音，你停手）；60 是電腦的 0～3s（結尾不對齊任何起音）
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 5 - 0.5 / 480 }, 10], a1: [{ beat: 0, dur: 3, note: 60 }] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(5500);                                              // 停格 5s，超過閒置門檻；40 的原長（約 5000ms）也早過了
  assert(count(log, 'off', 40) === 0, '40 的結尾對齊拍 10：沒按就 hold，停格再久也不收');
  assert(count(log, 'off', 60) === 1 && near(offMs(log, 60, 'assist') - t0, 3000, TICK_MS), `60 照原長（3000ms）收，實際 ${offMs(log, 60, 'assist') - t0}`);
  const t1 = d.nowMs;
  d.press();
  assert(offMs(log, 40, 'human') === t1 && onMs(log, 41, 'human') === t1, '按到拍 10 的那一刻先收 40、再開 41');
});

run('相連音遇到同音高重複：先關舊音再開新音，新音不會被連帶關掉', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT, note: 60 }, { beat: 1, dur: 0.4, note: 60 }] }), [['p0', 1]]);
  d.tick(); d.press(); d.runMs(600); d.press(); d.runMs(1000);
  const seq = log.filter((e) => e.note === 60 && (e.t === 'on' || e.t === 'off')).map((e) => e.t).join();
  assert(seq === 'on,off,on,off', `應為 on,off,on,off，實際 ${seq}`);
});

run('沒有 tick 換算的檔案（SMPTE division，timeDivision＝null）也能照常按：不丟例外', () => {
  const smpte = { ...buildBeatScore({ p0: [{ beat: 0, dur: 0.3 }, 1] }), timeDivision: null };
  const { log, d } = makeHp(smpte, [['p0', 1]]);
  d.tick(); d.press(); d.runMs(700);
  assert(count(log, 'off', 40) === 1, '照檔案收音（0.3s，結尾不對齊起音，不 hold）');
  d.press();
  assert(count(log, 'on', 41) === 1, '照常放行下一個 segment');
});

/* ═══════════════════════════════════════════
   時間步長上限、暫停
   ═══════════════════════════════════════════ */

run('每個 tick 的時間步長上限 100ms：分頁被節流後恢復，不會一次衝過一大段（手動、自動播放都一樣）', () => {
  const manual = makeHp(buildBeatScore({ p0: [0, 8] }), [['p0', 1]]);
  manual.d.tick(); manual.d.press(); manual.d.tick();
  manual.d.gap(5000);
  assert(manual.hp.getPositionTicks() < 120, `隔 5 秒才醒來，播放頭最多多走 0.1s（96 tick），實際 ${manual.hp.getPositionTicks()}`);
  const auto = makeHp(buildBeatScore({ a0: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), []);
  auto.d.tick();
  auto.d.gap(5000);
  assert(onNotes(auto.log).length === 1, `自動播放隔 5 秒才醒來，不會一次吐出一大段音，實際 ${onNotes(auto.log).length} 顆`);
});

run('暫停收掉所有還在響的音；時鐘不計暫停的時間，恢復後排好的電腦音照剩下的時間放，也不把暫停當成兩次按鍵的間隔', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 3 }, 1], a1: [{ beat: 0, dur: 3 }, 0.5, 1] }), [['p0', 1]]);
  d.tick(); d.press(); d.runMs(100);
  const posBefore = hp.getPositionTicks();
  hp.pause();
  assert(count(log, 'off', 40) === 1 && count(log, 'off', 52) === 1, '暫停對你的長音與電腦的長音各送一個 noteOff');
  assert(log.some((e) => e.t === 'cc' && e.cc === 123), '另外送 CC123 當保險');
  d.gap(5000);                                                // 暫停期間時間照樣過（tick 不處理）
  hp.play(); d.runMs(36);
  assert(count(log, 'off', 40) === 1 && count(log, 'off', 52) === 1, '恢復播放後不再重複收');
  assert(hp.getPositionTicks() >= posBefore && hp.getPositionTicks() < posBefore + 200, `播放頭從原處繼續（不是跳過暫停的 5 秒），實際 ${posBefore} → ${hp.getPositionTicks()}`);
  assert(onMs(log, 53, 'assist') === undefined, '拍 0.5 的電腦音（原本在按下後 250ms）還沒到時間');
  d.runMs(400);
  assert(count(log, 'on', 53) === 1, '暫停前排好的電腦音，恢復後照剩下的時間放出來（沒有丟）');
  d.press();
  assert(count(log, 'on', 41) === 1 && near(hp.playbackRate, 0.5 / ((100 + 36 + 400 + 0) / 1000), 0.06), `暫停那 5 秒不拿來估速（0.5s ÷ 約 0.54s），實際 ${hp.playbackRate}`);
});

/* ═══════════════════════════════════════════
   整首自動播放（沒有指派）：同一條路徑，沒有 driver 就沒有按鍵，電腦聲部整首自己放
   ═══════════════════════════════════════════ */

run('整首自動播放（沒有指派）：每顆音在樂譜時間發聲（誤差在兩個 tick 內），每個 noteOn 一個 noteOff，跑完算播完', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ a0: [0, 2, 4, 6], a1: [1, 3] }), []);
  d.tick();
  const base = d.nowMs;
  while (!hp.isFinished() && d.nowMs < 10000) d.tick();
  assert(hp.isFinished(), '應該自己播完');
  const want = [[40, 0], [52, 1], [41, 2], [53, 3], [42, 4], [43, 6]];
  for (const [note, beat] of want) {
    const ms = onMs(log, note);
    assert(ms !== undefined && ms - (base + beat * 500) >= 0 && ms - (base + beat * 500) <= 2 * TICK_MS, `音高 ${note} 應在樂譜拍 ${beat}（${base + beat * 500}ms）後 ${2 * TICK_MS}ms 內發聲，實際 ${ms}`);
  }
  assert(count(log, 'on') === 6 && count(log, 'off') === 6, `6 個 noteOn、6 個 noteOff，實際 ${count(log, 'on')}／${count(log, 'off')}`);
});

run('整首自動播放：每顆音照編碼收——舊音在檔案寫的結尾收，再開新音', () => {
  // 第一顆音比下一拍短 20 tick：照檔案在 tick 460 收。
  const { hp, log, d } = makeHp(buildBeatScore({ a0: [{ beat: 0, dur: 0.5 * 460 / 480 }, { beat: 1, dur: 0.4 }] }), []);
  while (!hp.isFinished() && d.nowMs < 5000) d.tick();
  const iOff = log.findIndex((e) => e.t === 'off' && e.note === 40), iOn = log.findIndex((e) => e.t === 'on' && e.note === 41);
  assert(iOff !== -1 && iOff < iOn, `先關舊音、再開新音，實際 off#${iOff}@${log[iOff]?.ms} on#${iOn}@${log[iOn]?.ms}`);
  const gap = log[iOn].ms - log[iOff].ms;
  assert(gap >= TICK_MS && gap <= 3 * TICK_MS, `不撐：舊音在 tick 460 收，比新音早約 20 tick（≈21ms），不是等到新音才收；實際相差 ${gap}ms`);
});

/* ═══════════════════════════════════════════
   canon 實際樂譜＋不變量：任何按鍵速度下，每顆音恰好一次、driver 在按下當下、follower 不擠、不丟
   ═══════════════════════════════════════════ */

const canonScore = parseMidi(readFileSync(CANON_PATH));
const canonCello = canonScore.parts.find((p) => p.name === '大提琴');
const canonViolin = canonScore.parts.find((p) => p.name === '小提琴');

// 用不變量假合成器跑一首：大提琴指派（driver）、小提琴電腦輔助（follower）。每個 driver segment 由 pressTimeOf(i) 決定想按的
// 時刻；被去抖擋掉的按鍵，每隔 40ms 再按一次（就像你發現沒聲音會再按）。
function playCanonWith(pressTimeOf) {
  const rig = makeInvariantRig('canon');
  const hp = rig.hp = new Scheduler();
  hp.setSynths(rig.fake('assist'), rig.fake('human'));
  hp.load(canonScore, new Map([[canonCello.id, 1]]));
  hp.play();
  let now = 12; hp.tick(now);
  const segs = hp._driverSegs;
  let blocked = 0, lastMs = now;
  for (let i = 0; i < segs.length; i++) {
    let want = Math.max(lastMs + 1, pressTimeOf(i, segs[i]));
    for (;;) {
      while (now + 12 <= want) { now += 12; rig.inTick = true; hp.tick(now); rig.inTick = false; rig.flush(); }
      now = want;
      rig.triggerTicks = segs[i].ticks; rig.inTrigger = true;
      const ok = hp.trigger(1, now);
      rig.inTrigger = false; rig.flush();
      if (ok) { lastMs = now; break; }
      blocked++; want = now + 40;
    }
  }
  while (!hp.isFinished() && now < lastMs + 120000) { now += 12; rig.inTick = true; hp.tick(now); rig.inTick = false; rig.flush(); }
  return { hp, rig, blocked, lastMs, segs };
}

const canonStyles = [
  { name: '準時（每個 driver segment 在樂譜時間按）', at: (i, seg) => 12 + canonScore.midiTicksToSeconds(seg.ticks) * 1000 },
  { name: '比原譜快 2 倍', at: (i, seg) => 12 + canonScore.midiTicksToSeconds(seg.ticks) * 500 },
  { name: '比原譜慢 2 倍（常常停手超過閒置門檻）', at: (i, seg) => 12 + canonScore.midiTicksToSeconds(seg.ticks) * 2000 },
  { name: '連珠炮（快 7 倍，很多按鍵被去抖擋掉再重按）', at: (i, seg) => 12 + canonScore.midiTicksToSeconds(seg.ticks) * 150 },
  { name: '慢 25％＋抖動', at: (i, seg) => 12 + canonScore.midiTicksToSeconds(seg.ticks) * 1250 + ((i * 7) % 5) * 10 },
];
for (const style of canonStyles) {
  run(`canon（大提琴指派、小提琴電腦輔助）${style.name}：每顆音恰好一次，driver 在按下當下發聲，follower 不擠、不丟、不在被啟動之前發聲`, () => {
    const { hp, rig, segs } = playCanonWith(style.at);
    rig.flush();
    assert(segs.length > 100, `前提：大提琴有足夠多的起音（實際 ${segs.length}）`);
    // 每顆音恰好一次：發聲，或你早按時整顆在你身後而跳過（_skipped，沒有發聲）——兩者合起來剛好是全部，而且沒有重疊
    assert(hp._sounded.size + hp._skipped.size === canonScore.notes.length && rig.noteOns === hp._sounded.size && [...hp._skipped].every((n) => !hp._sounded.has(n)),
      `每顆音恰好處理一次：樂譜 ${canonScore.notes.length} 顆、發聲 ${rig.noteOns}（記錄 ${hp._sounded.size}）＋跳過 ${hp._skipped.size}`);
    for (const [k, v] of rig.balance) assert(v === 0, `${k} 的 noteOn 與 noteOff 差了 ${v} 個`);
    assert(hp.isFinished(), '全部放行、收音之後算播完');
  });
}

run('前奏鎖：卡農實譜，指派小提琴（大提琴 0 秒起、小提琴 14.22 秒才入場）▶ 後馬上按，大提琴前奏完整播完、不被跳過', () => {
  const log = [], clock = { ms: 0 };
  const hp = new Scheduler();
  hp.setSynths(makeFakeSynth(log, 'assist', clock), makeFakeSynth(log, 'human', clock));
  hp.load(canonScore, new Map([[canonViolin.id, 1]]));
  hp.play();
  const d = makeDriver(hp, clock);
  d.tick();
  const base = d.nowMs;
  const entrySec = canonScore.midiTicksToSeconds(hp._driverSegs[0].ticks);
  const prelude = canonScore.notes.filter((n) => n.partId === canonCello.id && n.startTick < hp._driverSegs[0].ticks);
  assert(prelude.length >= 4 && entrySec > 10, `前提：大提琴前奏有足夠多的音（${prelude.length}）、小提琴很晚才入場（${entrySec.toFixed(2)}s）`);
  assert(d.press() === false, '▶ 後馬上按：不放行');
  d.runMs((entrySec - 2) * 1000);
  assert(d.press() === false && onNotes(log, 'human').length === 0, '入場前 2 秒再按一下：仍不放行');
  d.runMs(3000);
  const preludeOns = log.filter((e) => e.t === 'on' && e.label === 'assist' && e.ms < base + entrySec * 1000 - TICK_MS);
  assert(preludeOns.length >= prelude.length - 1, `大提琴前奏的 ${prelude.length} 顆音（扣掉剛好在入場 tick 的）都要發聲，實際 ${preludeOns.length}`);
  assert(onNotes(log, 'human').length > 0 && near(log.find((e) => e.label === 'human' && e.t === 'on').ms - base, entrySec * 1000, TICK_MS), '預按過：小提琴在入場點（14.22s）自動入場');
});

/* ═══════════════════════════════════════════
   重設／重播：stop() 與 restart() 共用同一個重設函式 _resetPlayback()
   ═══════════════════════════════════════════ */

// 排程器目前所有「會變」的狀態快照。刻意用「取全部欄位、只排除載入後不變的東西」而不是列舉欄位：
// 之後任何新增的狀態欄位忘了在 _resetPlayback() 重設，比對就會直接抓到。
function stateSnapshot(hp) {
  const state = {};
  for (const [k, v] of Object.entries(hp)) {
    if (['cfg', '_score', '_staves', '_driverSegs', '_driverTicks', '_followers', '_sliceFirst', 'unplacedStaffIds'].includes(k)) continue;
    if (typeof v === 'function' || (v && typeof v.noteOn === 'function')) continue; // 函式、合成器物件
    if (k === '_pending') { state[k] = v.map((p) => [p.dueMs, p.note.midiNote]); continue; } // 內含 staff／note 參照，只比時刻與音高
    if (k === '_sounded' || k === '_skipped') { state[k] = v.size; continue; }
    state[k] = v;
  }
  const staves = {};
  for (const [id, staff] of hp._staves) { const { notes, ...rest } = staff; staves[id] = rest; }
  return structuredClone({ state, staves });
}
function snapshotDiffs(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.state), ...Object.keys(b.state)])) {
    if (!isDeepStrictEqual(a.state[k], b.state[k])) out.push(k);
  }
  for (const id of new Set([...Object.keys(a.staves), ...Object.keys(b.staves)])) {
    for (const k of new Set([...Object.keys(a.staves[id] || {}), ...Object.keys(b.staves[id] || {})])) {
      if (!isDeepStrictEqual(a.staves[id]?.[k], b.staves[id]?.[k])) out.push(`${id}.${k}`);
    }
  }
  return out;
}

// p0 指派給演奏者 1（拍 0、2、4、6 各一顆短音，樂譜間隔 1 秒）、a1 不指派＝電腦輔助（每拍一顆短音）：
// 重設要同時覆蓋「driver」與「follower」兩條路徑。
const twoPartScore = () => buildBeatScore({ p0: [0, 2, 4, 6], a1: [0, 1, 1.75, 2, 3, 4, 5, 6, 7] });

run('重設把排程器退回「剛載入」的狀態：播放中／暫停／播完三種情況，stop() 與 restart() 結果都相同', () => {
  const scenarios = {
    播放中: (hp, d) => { d.tick(); d.press(); d.runMs(1000); d.press(); d.runMs(400); },
    早按: (hp, d) => { d.tick(); d.press(); d.runMs(650); d.press(); d.runMs(200); },     // 第二下提早（預估 1000ms、實際 650ms，在去抖窗口 600ms 之外）：拍 1.75 的電腦音（原排在 875ms）跳過，_skipped 與 _early 都有值
    暫停: (hp, d) => { d.tick(); d.press(); d.runMs(1000); d.press(); d.runMs(400); hp.pause(); },
    播完: (hp, d) => { d.tick(); for (let i = 0; i < 4; i++) { d.press(); d.runMs(1000); } d.runMs(8000); },
  };
  const resets = { 'stop()': (hp) => hp.stop(), 'restart()': (hp) => { hp.restart(); hp.pause(); } };
  for (const [sName, dirty] of Object.entries(scenarios)) {
    for (const [rName, reset] of Object.entries(resets)) {
      const { hp, d } = makeHp(twoPartScore(), [['p0', 1]], { play: false });
      const fresh = stateSnapshot(hp);
      hp.play();
      dirty(hp, d);
      const dirtied = snapshotDiffs(fresh, stateSnapshot(hp));
      for (const k of ['_segIndex', '_clockMs', '_anchoredSlice', '_history', '_lastAcceptClock', 'playbackRate']) {
        assert(dirtied.includes(k), `${sName}：前提不成立——${k} 根本沒被弄髒（只有 ${dirtied}），這個比對什麼都沒驗證`);
      }
      reset(hp);
      const diffs = snapshotDiffs(fresh, stateSnapshot(hp));
      assert(diffs.length === 0, `${sName}＋${rName}：重設後與剛載入不同的欄位：${diffs.join('、')}`);
    }
  }
});

run('restart()：整首自動播放跑完後重播，每顆音恰好再發聲一次', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ a0: [0, 2, 4, 6] }), []);
  const onCount = () => log.filter((e) => e.t === 'on').length;
  d.tick();
  while (!hp.isFinished() && d.nowMs < 10000) d.tick();
  assert(hp.isFinished(), '前提：第一輪應該播完');
  assert(onCount() === 4, `第一輪 4 顆音都要發聲，實際 ${onCount()}`);
  hp.restart();
  assert(hp.isPlaying() && !hp.isFinished(), 'restart() 之後應該在播放中、而且不是已播完');
  assert(hp.getPositionTicks() < 5, `restart() 之後進度應該回到開頭，實際 ${hp.getPositionTicks()}`);
  const before = onCount();
  d.tick();
  while (!hp.isFinished() && d.nowMs < 20000) d.tick();
  assert(hp.isFinished(), '重播後應該再次播完');
  assert(onCount() - before === 4, `重播後 4 顆音都要再發聲一次（不多不少），實際 ${onCount() - before}`);
});

run('restart() 之後要重新按才會放行 driver：segment 游標回到第一個，前奏重新播', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [2, 4, 6], a1: [0, 1, 2, 3, 4, 5, 6] }), [['p0', 1]]);
  d.tick(); d.runMs(1500); d.press(); d.runMs(1000); d.press();
  hp.restart();
  const from = log.length;
  d.tick(); d.runMs(1200);                                    // 重播後完全不按：前奏（拍 0、1）自己播、你的聲部不發聲
  assert(onNotes(log.slice(from), 'assist').join() === '52,53' && !log.slice(from).some((e) => e.t === 'on' && e.label === 'human'), `重播後前奏重新播（52、53），你的聲部不發聲，實際 ${onNotes(log.slice(from))}`);
  assert(!hp.isFinished(), '還沒有按到你的聲部，不算播完');
  d.runMs(1000);
  d.press();
  assert(log.slice(from).filter((e) => e.t === 'on' && e.note === 40).length === 1, '重播後第一次按應該是你的第一個起音（音高 40）');
});

run('命名：未指派＝電腦輔助的聲部（assistSynth／kind:assist），指派聲部走 humanSynth／kind:human', () => {
  const { hp } = makeHp(twoPartScore(), [['p0', 1]], { play: false });
  assert(hp.assistSynth && hp.humanSynth && hp.assistSynth !== hp.humanSynth, '兩個合成器都要設好，而且是不同的兩個');
  assert(hp._staves.get('p0').kind === 'human', `指派聲部的 kind 應該是 human，實際 ${hp._staves.get('p0').kind}`);
  assert(hp._staves.get('a1').kind === 'assist', `未指派聲部（電腦輔助）的 kind 應該是 assist，實際 ${hp._staves.get('a1').kind}`);
});

run('load(null) 清掉上一首的狀態：接著 play()／tick() 不丟例外', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 1, 2] }), [['p0', 1]]);
  d.tick(); d.press();
  hp.load(null, []);
  hp.play();
  d.runMs(200);
  assert(hp.isPlaying() && !hp.isFinished(), '沒有樂譜時排程器照常空轉，不算播完');
});

/* ═══════════════════════════════════════════
   staff 化：一個 part 底下有多個 staff（鋼琴兩行譜、弓弦的 pizzicato channel）、打擊 channel 分配、
   初始 CC、baseVolume。part.staves 是新資料形狀；沒有 staves 的 part 是舊形狀，視為單一 staff。
   ═══════════════════════════════════════════ */

// 假合成器：記下 program 與每個 CC，順序就是送出的順序（初始化要在第一個 noteOn 之前）。
function makeLoggingSynth(log, label, clock) {
  return {
    controllerChange: (ch, cc, val) => log.push({ t: 'cc', label, ch, cc, val, ms: clock.ms }),
    programChange: (ch, program) => log.push({ t: 'pc', label, ch, program, ms: clock.ms }),
    noteOn: (ch, note, vel) => log.push({ t: 'on', label, ch, note, vel, ms: clock.ms }),
    noteOff: (ch, note) => log.push({ t: 'off', label, ch, note, ms: clock.ms }),
  };
}
function makeStaffHp(score, assignments, { play = true } = {}) {
  const log = [], clock = { ms: 0 };
  const hp = new Scheduler();
  hp.setSynths(makeLoggingSynth(log, 'assist', clock), makeLoggingSynth(log, 'human', clock));
  hp.load(score, new Map(assignments));
  const d = makeDriver(hp, clock);
  if (play) hp.play();
  return { hp, log, d };
}

// spec：[{ id, staves: [{ id, program?, kit?（鼓組 program）, init?, bank?, notes: [拍序號…] }] }]。每個 staff 一條單音旋律。
function buildStaffScore(spec, beatSec = 0.5) {
  const tpq = 480, notes = [], parts = [];
  spec.forEach((p, pi) => {
    const staves = p.staves.map((v, vi) => {
      const staff = {
        id: v.id, partId: p.id, trackIndex: pi, channel: v.channel ?? pi * 4 + vi,
        program: v.program ?? v.kit ?? 0, bank: v.bank ?? { msb: v.kit !== undefined ? 120 : 121, lsb: 0 },
        percussionKit: v.kit !== undefined, init: v.init ?? null, noteCount: v.notes.length,
      };
      v.notes.forEach((beat, ni) => {
        notes.push({
          partId: p.id, staffId: v.id, trackIndex: pi, channel: staff.channel, midiNote: v.pitch ?? 40 + parts.length * 12 + vi * 6 + ni, velocity: 100,
          startTick: beat * tpq, endTick: beat * tpq + 12, startSeconds: beat * beatSec, endSeconds: beat * beatSec + 0.025, durationSeconds: 0.025,
        });
      });
      return staff;
    });
    parts.push({ id: p.id, name: p.id, noteCount: staves.reduce((s, v) => s + v.noteCount, 0), staves });
  });
  notes.sort((a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex);
  const totalBeats = Math.max(...notes.map((n) => n.startTick / tpq)) + 8;
  return scoreTail(notes, parts, beatSec, totalBeats * tpq);
}

run('staff 化：一個 part 兩個 staff（鋼琴兩行譜）各拿一個輸出 channel、都走真人軌、共用同一個指派槽位；音符依 staffId 分給各自的 staff；一次按鍵兩個譜表與同 tick 的電腦音一起發聲', () => {
  const score = buildStaffScore([
    { id: 'piano', staves: [{ id: 't1c0', notes: [0, 2], pitch: 72 }, { id: 't2c0', notes: [0, 2], pitch: 48 }] },
    { id: 'flute', staves: [{ id: 't3c1', notes: [0, 2], pitch: 80 }] },
  ]);
  const { hp, log, d } = makeStaffHp(score, [['piano', 1]]);
  assert(hp._staves.size === 3, `3 個 staff（鋼琴 2、長笛 1），實際 ${hp._staves.size}`);
  const upper = hp._staves.get('t1c0'), lower = hp._staves.get('t2c0'), flute = hp._staves.get('t3c1');
  assert(upper && lower && flute, `staff 要用 staffId 當 key，實際 ${[...hp._staves.keys()]}`);
  assert(upper.kind === 'human' && lower.kind === 'human' && flute.kind === 'assist', '鋼琴的兩個 staff 都走真人軌，長笛走電腦輔助');
  assert(upper.slot === 1 && lower.slot === 1 && upper.partId === 'piano' && lower.partId === 'piano', '兩個 staff 共用 part 的指派槽位、partId 保留');
  assert(upper.channel !== lower.channel, `兩個 staff 輸出 channel 不同，實際 ${upper.channel}／${lower.channel}`);
  assert(upper.notes.length === 2 && upper.notes.every((n) => n.midiNote === 72) && lower.notes.every((n) => n.midiNote === 48), '音符依 staffId 分組');
  d.tick(); d.press();
  const ons = log.filter((e) => e.t === 'on');
  assert(ons.map((e) => e.note).sort().join() === '48,72,80' && new Set(ons.map((e) => e.ms)).size === 1, `一次按鍵：兩個譜表與同 tick 的長笛同刻發聲，實際 ${ons.map((e) => `${e.note}@${e.ms}`)}`);
  const humanOn = ons.filter((e) => e.label === 'human');
  assert(humanOn.map((e) => e.note).sort().join() === '48,72' && new Set(humanOn.map((e) => e.ch)).size === 2, '鋼琴兩個音走真人合成器、在不同的輸出 channel');
});

run('staff 初始化：bank／program 之外，CC7／10／91／93 在該 channel 第一個 noteOn 之前送出；沒有 init 用 GM 預設 100／64／0／0', () => {
  const score = buildStaffScore([
    { id: 'a', staves: [{ id: 'a0', program: 73, init: { volume: 90, pan: 30, reverb: 20, chorus: 10 }, bank: { msb: 0, lsb: 4 }, notes: [0] }] },
    { id: 'b', staves: [{ id: 'b0', program: 40, notes: [0] }] },
  ]);
  const { hp, log, d } = makeStaffHp(score, []);
  d.runMs(100);
  const initOf = (staffId) => {
    const ch = hp._staves.get(staffId).channel;
    const before = log.slice(0, log.findIndex((e) => e.t === 'on' && e.ch === ch));
    const mine = before.filter((e) => e.ch === ch);
    return { pc: mine.find((e) => e.t === 'pc')?.program, cc: Object.fromEntries(mine.filter((e) => e.t === 'cc').map((e) => [e.cc, e.val])) };
  };
  const a = initOf('a0'), b = initOf('b0');
  assert(a.pc === 73 && a.cc[0] === 0 && a.cc[32] === 4 && a.cc[7] === 90 && a.cc[10] === 30 && a.cc[91] === 20 && a.cc[93] === 10,
    `a0 的初始化（program、bank、CC7／10／91／93）要在第一個 noteOn 之前送出，實際 ${JSON.stringify(a)}`);
  assert(b.pc === 40 && b.cc[7] === 100 && b.cc[10] === 64 && b.cc[91] === 0 && b.cc[93] === 0,
    `沒有 init 的 staff 明確送 GM 預設 100／64／0／0，實際 ${JSON.stringify(b)}`);
});

run('指派聲部的 CC7 只在載入時送一次（原音量），按鍵與重播都不再動它', () => {
  const score = buildStaffScore([
    { id: 'p0', staves: [{ id: 'p0v', init: { volume: 90, pan: 64, reverb: 0, chorus: 0 }, notes: [0, 1, 2, 3] }] },
    { id: 'a0', staves: [{ id: 'a0v', notes: [0, 1, 2, 3] }] },
  ]);
  const { hp, log, d } = makeStaffHp(score, [['p0', 1]]);
  const ch = hp._staves.get('p0v').channel;
  const cc7 = () => log.filter((e) => e.t === 'cc' && e.cc === 7 && e.ch === ch && e.label === 'human').map((e) => e.val);
  assert(cc7().join() === '90', `載入時送 init 的音量 90，實際 ${cc7()}`);
  d.tick(); d.press(); d.runMs(600); d.press();
  hp.restart();
  assert(cc7().join() === '90', `按鍵與重播都不該再送 CC7（沒有代打音量），實際 ${cc7()}`);
});

run('打擊 staff：依鼓組 program 分配到 9／25／41／57，同一個鼓組共用；第 5 種鼓組回報 unplaced；旋律 staff 不會落在打擊槽', () => {
  const kits = [0, 8, 16, 24, 32];
  const score = buildStaffScore([
    ...kits.map((kit, i) => ({ id: `k${i}`, staves: [{ id: `kit${i}`, kit, notes: [0] }] })),
    { id: 'k0b', staves: [{ id: 'kit0b', kit: 0, notes: [1] }] },                                       // 第二個標準鼓組：跟第一個共用 channel
    ...Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, staves: [{ id: `mel${i}`, program: i, notes: [0] }] })),
  ]);
  const { hp } = makeStaffHp(score, []);
  const ch = (id) => hp._staves.get(id)?.channel;
  assert([ch('kit0'), ch('kit1'), ch('kit2'), ch('kit3')].join() === '9,25,41,57', `前四種鼓組應依序在 9／25／41／57，實際 ${[ch('kit0'), ch('kit1'), ch('kit2'), ch('kit3')]}`);
  assert(ch('kit0b') === 9, `同一種鼓組共用 channel，實際 ${ch('kit0b')}`);
  assert(ch('kit4') === undefined && hp.unplacedStaffIds.join() === 'kit4', `第 5 種鼓組沒有打擊槽可用，應回報 unplaced，實際 ${hp.unplacedStaffIds}`);
  const melodic = [...hp._staves.values()].filter((v) => v.id.startsWith('mel')).map((v) => v.channel);
  assert(melodic.length === 20 && new Set(melodic).size === 20, `20 個旋律 staff 各一個 channel，實際 ${melodic}`);
  assert(melodic.every((c) => c % 16 !== 9), `旋律 staff 不能落在任何 port 的打擊槽（9／25／41／57），實際 ${melodic}`);
});

run('輸出 channel 用完：多出來的 staff 回報在 unplacedStaffIds（列 staff，不是 part）', () => {
  const score = buildStaffScore(Array.from({ length: 62 }, (_, i) => ({ id: `p${i}`, staves: [{ id: `v${i}`, notes: [0] }] })));
  const { hp } = makeStaffHp(score, [], { play: false });
  assert(hp._staves.size === 60 && hp.unplacedStaffIds.join() === 'v60,v61', `64 個 channel 扣掉 4 個打擊槽剩 60 個，實際 ${hp._staves.size} 個、unplaced ${hp.unplacedStaffIds}`);
});

run('排不進 channel 的 driver 的音不進 segment；整個 segment 都排不進就不收（一次按鍵不會只推進一個不會響的 segment）', () => {
  // 62 個旋律聲部都指派給演奏者 1：v60、v61 排不進 channel。把它們的音放在獨立的拍 5（只有它們）：這個 segment 應被丟掉。
  const spec = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, staves: [{ id: `v${i}`, notes: [0] }] }));
  spec.push({ id: 'p60', staves: [{ id: 'v60', notes: [5] }] }, { id: 'p61', staves: [{ id: 'v61', notes: [5] }] });
  const { hp, log } = makeStaffHp(buildStaffScore(spec), spec.map((p) => [p.id, 1]), { play: false });
  assert(hp.unplacedStaffIds.join() === 'v60,v61', `前提：v60、v61 排不進，實際 ${hp.unplacedStaffIds}`);
  assert(hp._driverSegs.length === 1 && hp._driverSegs[0].ticks === 0 && hp._driverSegs[0].items.length === 60, `只剩拍 0 那個 segment（60 顆音），實際 ${hp._driverSegs.map((s) => `${s.ticks}:${s.items.length}`)}`);
  assert(onNotes(log).length === 0, '載入不發聲');
});

run('portsNeeded：旋律 staff 每個 port 15 個、每種鼓組佔一個 port 的打擊槽，指派與未指派兩個池子各自算，不低於預設 4 個 port', () => {
  const melodic = (n, prefix = 'p') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, staves: [{ id: `${prefix}v${i}`, notes: [0] }] }));
  const kits = (n) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, staves: [{ id: `kit${i}`, kit: i * 8, notes: [0] }] }));
  assert(DEFAULT_PORTS === 4, `預設 port 數是 4（開機補的），實際 ${DEFAULT_PORTS}`);
  assert(portsNeeded(buildStaffScore(melodic(60)), []) === 4, '60 個旋律 staff 剛好 4 個 port');
  assert(portsNeeded(buildStaffScore(melodic(61)), []) === 5, '61 個旋律 staff 要 5 個 port');
  assert(portsNeeded(buildStaffScore(melodic(150)), []) === 10, '150 個旋律 staff 要 10 個 port');
  assert(portsNeeded(buildStaffScore([...kits(6), ...melodic(3)]), []) === 6, '6 種鼓組要 6 個 port（每個 port 只有一個打擊槽）');
  const two = buildStaffScore(melodic(40));
  assert(portsNeeded(two, new Map(two.parts.slice(0, 20).map((p) => [p.id, 1]))) === 4, '20 個指派＋20 個未指派分在兩個合成器，各用不到 4 個 port');
  assert(portsNeeded(null, []) === 4 && portsNeeded(buildStaffScore(melodic(1)), []) === 4, '沒有樂譜或很簡單的樂譜也是預設 4 個 port');
});

run('port 數變多之後（setPortCount）：62 個旋律 staff 全部分得到輸出 channel，最多用到第 5 個 port，都不落在打擊槽', () => {
  const log = [], clock = { ms: 0 };
  const hp = new Scheduler();
  hp.setSynths(makeFakeSynth(log, 'assist', clock), makeFakeSynth(log, 'human', clock));
  const score = buildStaffScore(Array.from({ length: 62 }, (_, i) => ({ id: `p${i}`, staves: [{ id: `v${i}`, notes: [0] }] })));
  hp.setPortCount(portsNeeded(score, []));
  hp.load(score, new Map());
  const channels = [...hp._staves.values()].map((v) => v.channel);
  assert(hp._staves.size === 62 && hp.unplacedStaffIds.length === 0, `5 個 port 放得下 62 個旋律 staff，實際 ${hp._staves.size} 個、unplaced ${hp.unplacedStaffIds}`);
  assert(new Set(channels).size === 62 && Math.max(...channels) < 80 && Math.max(...channels) >= 64, `channel 各不相同、用到第 5 個 port（64～79），實際最大 ${Math.max(...channels)}`);
  assert(channels.every((c) => c % 16 !== 9), '旋律 staff 不落在任何 port 的打擊槽');
});

run('舊資料形狀（part 沒有 staves，手工譜）：視為單一 staff，id 沿用 part.id，行為照舊', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [0, 2], a1: [1] }), [['p0', 1]], { play: false });
  const v = hp._staves.get('p0');
  assert(v && v.partId === 'p0' && v.kind === 'human' && v.slot === 1, `舊形狀的 part 就是一個 staff（id＝part.id），實際 ${JSON.stringify([...hp._staves.keys()])}`);
  assert(hp._staves.get('a1').kind === 'assist', '未指派的舊形狀 part 照常是電腦輔助');
});

/* ═══════════════════════════════════════════
   整體不變量壓力測試：固定種子的隨機譜＋隨機按鍵、停手、暫停、重播
   ═══════════════════════════════════════════ */

// 每個聲部是一條單音旋律：音長取 MuseScore 風格的「記譜長度 − 1 tick」（相連音間隙 1 tick），偶爾插入休止、
// 偶爾有長音、偶爾疊一顆同音高的重疊音（檔案裡是先進先出配對），讓相連音、休止、長音、同音高重疊都會被壓到。
// exotic：每顆音的結尾隨機取「少 1 tick（MuseScore 相連音）／縮短 5.4%（統一縮短的匯出器）／斷奏一半／零長度／超出下一顆 60 tick
// 的重疊／跨兩個記譜長度的延音／多 1 tick」之一，壓 hold 的容差與橫跨音的收音。
function buildRandomScore(rand, nParts, exotic = false) {
  const tpq = 480;
  const beatSec = 0.25 + rand() * 1.2;                 // 50~240 BPM
  const totalTicks = (40 + Math.floor(rand() * 40)) * tpq;
  const parts = [], notes = [];
  for (let pi = 0; pi < nParts; pi++) {
    const id = `p${pi}`;
    parts.push({ id, trackIndex: pi, channel: pi, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } });
    const mk = (note, startTick, endTick) => ({
      partId: id, trackIndex: pi, channel: pi, program: 0, midiNote: note, velocity: 90,
      startTick, endTick, startSeconds: (startTick / tpq) * beatSec, endSeconds: (endTick / tpq) * beatSec,
      durationSeconds: ((endTick - startTick) / tpq) * beatSec,
    });
    let t = 0, idx = 0;
    while (t < totalTicks) {
      const notated = [120, 240, 480, 960, 1920][Math.floor(rand() * 5)];
      if (rand() < 0.15) t += [240, 480, 960][Math.floor(rand() * 3)];
      const pitch = 40 + pi * 12 + (idx++ % 12);
      const len = exotic
        ? [notated - 1, Math.round(notated * 0.946), notated >> 1, 0, notated + 60, notated * 2 - 1, notated + 1][Math.floor(rand() * 7)]
        : notated - 1;
      notes.push(mk(pitch, t, t + len));
      if (rand() < 0.1) notes.push(mk(pitch, t + (notated >> 1), t + notated - 1 + (notated >> 1)));
      t += notated;
    }
  }
  notes.sort((a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex);
  const durationTicks = Math.max(...notes.map((n) => n.endTick));   // 跟 parser 一樣：譜面長度＝最晚的音符結尾
  return scoreTail(notes, parts, beatSec, durationTicks);
}

const mulberry32 = (seed) => {
  let s = seed;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};

const stressInvariants = (exotic) => {
  for (const seed of [11, 22, 33, 44]) {
    const rand = mulberry32(seed);
    const score = buildRandomScore(rand, 5 + Math.floor(rand() * 2), exotic);
    const beatSec = score.midiTicksToSeconds(480);
    const assignments = [['p0', 1], ['p1', 1], ['p2', 2], ['p3', 3]];   // p4（、p5）是電腦輔助
    const rig = makeInvariantRig(seed);
    const hp = rig.hp = new Scheduler();
    hp.setSynths(rig.fake('assist'), rig.fake('human'));
    hp.load(score, new Map(assignments));
    hp.play();
    const pPress = 12 / (beatSec * 1000 * 0.5);          // 平均約 0.5 拍按一次
    // 一開始全體先不按 3.8 秒（前奏自己播、停在入場點），之後隨機全體停手 1.2~3 秒（壓到停格）；偶爾手抖連按（壓到去抖）。
    let now = 0, prevPos = 0, accepted = 0, ignored = 0, idleSeen = 0, quietUntil = 320, burstUntil = -1;
    for (let i = 0; i < 5000; i++) {
      now += 12;
      if (i >= quietUntil && rand() < 0.002) quietUntil = i + 100 + Math.floor(rand() * 150);
      if (i >= quietUntil && rand() < 0.003) burstUntil = i + 3;
      for (const slot of [1, 2, 3]) {
        if (slot === 3 && i > 1250) continue;           // 演奏者 3 在 15 秒後離開
        const wants = i >= quietUntil && (rand() < pPress || (i < burstUntil && rand() < 0.5));
        if (!wants) continue;
        const next = hp._driverSegs[hp._segIndex];
        const before = hp._segIndex;
        rig.triggerTicks = next?.ticks ?? null; rig.inTrigger = true;
        const ok = hp.trigger(slot, now);
        rig.inTrigger = false;
        rig.flush();
        rig.check(hp._segIndex === before + (ok ? 1 : 0), `trigger 回傳 ${ok}，segment 游標卻從 ${before} 變成 ${hp._segIndex}（一次觸發只能放行一個 segment）`);
        if (ok) accepted++; else if (next) ignored++;
      }
      if (rand() < 0.0008) { rig.silencing = true; hp.pause(); rig.silencing = false; for (let k = 0; k < 150; k++) { now += 12; hp.tick(now); } hp.play(); }
      if (rand() < 0.0003) { rig.silencing = true; hp.restart(); rig.silencing = false; prevPos = 0; }
      rig.inTick = true; hp.tick(now); rig.inTick = false;
      rig.flush();

      const pos = hp.getPositionTicks();
      assert(pos >= prevPos - 1e-9, `seed ${seed}：進度倒退了（${prevPos} → ${pos}）`);
      prevPos = pos;
      const next = hp._driverSegs[hp._segIndex];
      assert(!next || pos <= next.ticks + 1e-6, `seed ${seed}：播放頭 ${pos} 越過你的下一個起音（tick ${next?.ticks}）`);
      // 沒有任何音會被撐住：這個 tick 結束時，每個音高佇列的最前面那一顆（同音高先進先出，後面的音要等前面的收掉）都該還沒到自己的結尾（停格再久也一樣）
      const overdue = [...hp._staves.values()].reduce((a, v) => a + [...v.sounding.values()].reduce((b, q) => b + (q.length && q[0].offMs <= hp._clockMs - 1e-6 ? 1 : 0), 0), 0);
      assert(overdue === 0, `seed ${seed}：有 ${overdue} 個音過了自己的結尾還在響`);
      if (hp._stallMsAt(hp._clockMs) > 800 + 1e-9) idleSeen++;
    }
    assert(accepted > 50, `seed ${seed}：前提：60 秒內應該真的放行很多個 segment（實際 ${accepted} 次）`);
    assert(ignored > 0, `seed ${seed}：前提：這個壓力測試應該真的壓到去抖（有按鍵被忽略）`);
    assert(idleSeen > 0, `seed ${seed}：前提：這個壓力測試應該真的壓到停格超過閒置門檻`);
    assert(rig.maxSimultaneous >= 2, `seed ${seed}：前提：這個壓力測試應該真的壓到同音高重疊`);
    rig.silencing = true; hp.pause(); rig.silencing = false;    // 收掉還在響的音之後，每個 noteOn 都剛好有一個 noteOff
    rig.flush();
    for (const [k, v] of rig.balance) assert(v === 0, `seed ${seed}：${k} 的 noteOn 與 noteOff 差了 ${v} 個`);
  }
};
run('固定種子的整體不變量壓力測試：隨機譜、3 位演奏者、隨機停手／暫停／重播／手抖，各 60 秒', () => stressInvariants(false));
run('固定種子的整體不變量壓力測試（各種音長：相連／縮短／斷奏／零長度／重疊／延音）：hold 與橫跨音收音下仍然每個 noteOn 一個 noteOff、沒有音過期還在響', () => stressInvariants(true));

run('固定種子的自動播放壓力測試：隨機譜整首自動播放，每顆音恰好發聲一次、在樂譜時間（一個 tick 步長內）、每個 noteOn 一個 noteOff', () => {
  for (const seed of [11, 22, 33, 44]) {
    const rand = mulberry32(seed);
    const score = buildRandomScore(rand, 4 + Math.floor(rand() * 3));
    const stepMs = 12 + 1e-6;                                  // 一個排程 tick 的長度：自動播放（1×）下起音最多晚這麼久
    const rig = makeInvariantRig(seed);
    const hp = rig.hp = new Scheduler();
    const assistSynth = rig.fake('assist');
    const origOn = assistSynth.noteOn;
    const onTimes = [];
    assistSynth.noteOn = (ch, note, vel) => { origOn(ch, note, vel); const s = [...hp._sounded]; onTimes.push({ note: s[s.length - 1], clock: hp._clockMs }); };
    hp.setSynths(assistSynth, rig.fake('human'));
    hp.load(score, new Map());
    hp.play();
    let now = 0, guard = 0;
    while (!hp.isFinished() && guard++ < 20000) { now += 12; rig.inTick = true; hp.tick(now); rig.inTick = false; rig.flush(); }
    assert(hp.isFinished(), `seed ${seed}：自動播放應該自己播完`);
    assert(hp._sounded.size === score.notes.length, `seed ${seed}：每顆音恰好發聲一次：樂譜 ${score.notes.length} 顆、實際 ${hp._sounded.size}`);
    for (const { note, clock } of onTimes) {
      const due = score.midiTicksToSeconds(note.startTick) * 1000;
      assert(clock - due >= -1e-6 && clock - due <= stepMs, `seed ${seed}：音高 ${note.midiNote} 的起音應在樂譜時間 ${due.toFixed(1)}ms 後一個 tick 內發聲，實際 ${clock.toFixed(1)}ms`);
    }
    for (const [k, v] of rig.balance) assert(v === 0, `seed ${seed}：${k} 的 noteOn 與 noteOff 差了 ${v} 個`);
  }
});

/* ═══════════════════════════════════════════
   lookahead：電腦音提早（LOOKAHEAD_MS）帶時間戳送進合成器，由音訊執行緒準時發聲；你的音永遠不帶時間戳
   ═══════════════════════════════════════════ */

const AUDIO0 = 100; // 假的 AudioContext 時間原點（秒）

// 記下第四個參數（eventOptions）的假合成器：time＝時間戳（秒，undefined＝沒帶）、ms＝呼叫當下的假時間。
function makeTimedSynth(log, label, clock) {
  return {
    controllerChange: () => {}, programChange: () => {},
    noteOn: (ch, note, vel, opts) => log.push({ t: 'on', label, ch, note, ms: clock.ms, time: opts?.time }),
    noteOff: (ch, note, opts) => log.push({ t: 'off', label, ch, note, ms: clock.ms, time: opts?.time }),
  };
}

// 每個 tick 把「假的 AudioContext 時間」一起交給排程器（跟假時間同步前進）；withAudio＝false 時跟舊的呼叫方式一樣只給 nowMs。
function makeAudioHp(score, assignments, { withAudio = true } = {}) {
  const log = [], clock = { ms: 0 };
  const hp = new Scheduler();
  hp.setSynths(makeTimedSynth(log, 'assist', clock), makeTimedSynth(log, 'human', clock));
  hp.load(score, new Map(assignments));
  hp.play();
  const d = {
    tick() { clock.ms += TICK_MS; withAudio ? hp.tick(clock.ms, clock.ms / 1000 + AUDIO0) : hp.tick(clock.ms); },
    runMs(ms) { const end = clock.ms + ms; while (clock.ms < end) d.tick(); },
    press(slot = 1) { return hp.trigger(slot, clock.ms); },
    get nowMs() { return clock.ms; },
  };
  return { hp, log, d, clock };
}

run('lookahead：電腦音在到期之前（50ms 內）就帶時間戳送出，時間戳＝預定發聲的 AudioContext 時間；你的音與按鍵當下同刻的電腦音不帶時間戳', () => {
  const { log, d } = makeAudioHp(buildBeatScore({ p0: [0, 2, 4], a1: [0, 1, 2, 3, 4] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  assert(d.press() === true, '第一下');
  d.runMs(700);
  const on = log.find((e) => e.t === 'on' && e.note === 53);              // 拍 1 的電腦音：按下後 500ms 到期
  assert(on, '拍 1 的電腦音 53 要發聲');
  assert(Math.abs(on.time - ((t0 + 500) / 1000 + AUDIO0)) < 1e-6, `時間戳要等於預定發聲的 AudioContext 時間 ${(t0 + 500) / 1000 + AUDIO0}，實際 ${on.time}`);
  assert(on.ms >= t0 + 450 - 1e-6 && on.ms < t0 + 500, `在到期前 50ms 內的那個 tick 送出（${t0 + 450}~${t0 + 500}），實際 ${on.ms}`);
  const off = log.find((e) => e.t === 'off' && e.note === 53);
  assert(off && off.time !== undefined && Math.abs(off.time - on.time - 0.025) < 1e-6, `收音也帶時間戳：發聲後 25ms（音長），實際 ${off?.time - on.time}`);
  assert(off.ms < (off.time - AUDIO0) * 1000, `收音也是提早送出（呼叫時刻 ${off.ms} 早於預定 ${(off.time - AUDIO0) * 1000}）`);
  const mine = log.find((e) => e.t === 'on' && e.label === 'human'), sameTick = log.find((e) => e.t === 'on' && e.note === 52);
  assert(mine.time === undefined && sameTick.time === undefined && sameTick.ms === t0, '你的音與按鍵當下同刻的電腦音（52）都不帶時間戳，在按鍵呼叫內立即發聲');
  assert(log.filter((e) => e.label === 'human').every((e) => e.time === undefined), '真人合成器的所有呼叫都不帶時間戳');
  const mineOff = log.find((e) => e.t === 'off' && e.label === 'human');
  assert(mineOff && mineOff.ms >= t0 + 25 - 1e-6, `你的音照舊在時鐘到了才收（按下後 25ms），不因為 lookahead 提早收，實際 ${mineOff?.ms - t0}ms`);
});

run('lookahead：前奏預按在 tick 裡自動放行的你的第一個起音，也不帶時間戳（你的聲部永遠立即發聲）', () => {
  const { log, d } = makeAudioHp(buildBeatScore({ p0: [4, 5], a1: [0, 1, 2, 3, 4, 5] }), [['p0', 1]]);
  d.tick();
  d.runMs(500);
  assert(d.press() === false, '前奏中預按');
  d.runMs(2000);
  const mine = log.filter((e) => e.t === 'on' && e.label === 'human');
  assert(mine.length === 1 && mine[0].time === undefined, `前奏播完自動放行入場音 40，不帶時間戳，實際 ${JSON.stringify(mine)}`);
});

run('lookahead：沒有交 AudioContext 時間（audioNow 缺席）就不提早、不帶時間戳，行為跟以前一樣', () => {
  const { log, d } = makeAudioHp(buildBeatScore({ p0: [0, 2, 4], a1: [0, 1, 2, 3, 4] }), [['p0', 1]], { withAudio: false });
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.runMs(700);
  const on = log.find((e) => e.t === 'on' && e.note === 53);
  assert(on.time === undefined && on.ms >= t0 + 500 - 1e-6, `沒有 audioNow：到期之後才發聲、不帶時間戳，實際 ${JSON.stringify(on)}`);
});

run('lookahead：暫停時已經送出、還沒響的電腦音，另外送一個帶時間戳的收音（不然 noteOff 先到、之後那顆 noteOn 就卡住）', () => {
  // 拍 1 的 53 長 200ms：noteOn 已送出（時間戳在未來），收音時刻（發聲後 200ms）還在 lookahead 範圍外、沒送
  const { hp, log, d } = makeAudioHp(buildBeatScore({ p0: [0, 2, 4], a1: [0, { beat: 1, dur: 0.2 }, 2, 3, 4] }), [['p0', 1]]);
  d.tick();
  d.press();
  d.runMs(470);                                                           // 拍 1 的電腦音（按下後 500ms）已送出、還沒到期
  const on = log.find((e) => e.t === 'on' && e.note === 53);
  assert(on && on.time > d.nowMs / 1000 + AUDIO0, `前提：53 已經送出、時間戳在未來，實際 ${JSON.stringify(on)}`);
  hp.pause();
  const offs = log.filter((e) => e.t === 'off' && e.note === 53);
  assert(offs.length === 1 && offs[0].time !== undefined && Math.abs(offs[0].time - (on.time + 0.001)) < 1e-9, `暫停要送一個帶時間戳（發聲後 1ms）的收音，實際 ${JSON.stringify(offs)}`);
  assert(!log.some((e) => e.t === 'off' && e.note === 53 && e.time === undefined), '不能送立刻處理的 noteOff（會比那顆 noteOn 早到）');
});

run('lookahead：相連音（後繼音在你還沒按的那一段）的收音也照自己的結尾提早帶時間戳送出，不等你按下去', () => {
  // a1 在拍 1 的 60 比拍 2 的 61 早結束（結尾不對齊起音，照原長收）；拍 2 是你的下一個起音（p0），61 在還沒啟動的段裡
  const { log, d } = makeAudioHp(buildBeatScore({ p0: [0, 2], a1: [{ beat: 1, dur: 0.4, note: 60 }, { beat: 2, dur: 0.025, note: 61 }] }), [['p0', 1]]);
  d.tick();
  d.press();
  d.runMs(1100);                                                          // 60 的收音時刻（約 898ms，結尾不對齊起音所以不 hold）早已落在 lookahead 範圍內，你還沒按第二下
  const off60 = log.find((e) => e.t === 'off' && e.note === 60);
  assert(off60 && off60.time !== undefined, `60 在自己的結尾收，而且帶時間戳（lookahead），實際 ${JSON.stringify(log.filter((e) => e.note === 60))}`);
  assert(!log.some((e) => e.t === 'on' && e.note === 61), '你還沒按，61 不會發聲');
});

// 依 worklet 的規則重播事件：時間戳在未來才排進佇列、已過就在送出的當下立刻處理，同一刻依送出順序。
// 每個 (合成器, channel, 音高) 的 noteOn／noteOff 配對：noteOff 不能比 noteOn 早處理（會讓後來那顆 noteOn 永遠卡住）。
run('lookahead 壓力測試：隨機譜、不規則的 tick 間隔（含停頓）、隨機按鍵／暫停／重播，依 worklet 規則重播事件後沒有搶先的 noteOff、結束時沒有卡音', () => {
  for (const seed of [5, 17, 29, 41]) {
    const rand = mulberry32(seed);
    const score = buildRandomScore(rand, 5);
    const events = [];
    let seq = 0, now = 0;
    const audio = () => now / 1000 + AUDIO0;
    const rec = (label) => ({
      controllerChange: () => {}, programChange: () => {},
      noteOn: (ch, note, vel, o) => events.push({ key: `${label}/${ch}/${note}`, d: +1, at: Math.max(audio(), o?.time ?? -Infinity), seq: seq++ }),
      noteOff: (ch, note, o) => events.push({ key: `${label}/${ch}/${note}`, d: -1, at: Math.max(audio(), o?.time ?? -Infinity), seq: seq++ }),
    });
    const hp = new Scheduler();
    hp.setSynths(rec('assist'), rec('human'));
    hp.load(score, new Map([['p0', 1], ['p1', 1]]));
    hp.play();
    let committedAhead = 0;
    for (let i = 0; i < 4000; i++) {
      now += rand() < 0.03 ? 40 + Math.floor(rand() * 60) : 5 + Math.floor(rand() * 15);   // 偶爾主執行緒停頓 40~100ms
      if (rand() < 0.05) hp.trigger(1, now);
      if (rand() < 0.0015) { hp.pause(); now += 30 + Math.floor(rand() * 200); hp.play(); }
      if (rand() < 0.0008) hp.restart();
      const before = events.length;
      hp.tick(now, audio());
      committedAhead += events.slice(before).filter((e) => e.at > audio() + 1e-9).length;
    }
    hp.pause();
    assert(committedAhead > 100, `seed ${seed}：前提：要真的有很多事件是提早（時間戳在未來）送出的，實際 ${committedAhead}`);
    const running = new Map();
    for (const e of events.sort((a, b) => a.at - b.at || a.seq - b.seq)) {
      const n = (running.get(e.key) || 0) + e.d;
      assert(n >= 0, `seed ${seed}：${e.key} 的 noteOff 在對應的 noteOn 之前被處理（會讓後來那顆 noteOn 卡住）`);
      running.set(e.key, n);
    }
    for (const [k, v] of running) assert(v === 0, `seed ${seed}：${k} 結束時還有 ${v} 顆音沒收（卡音）`);
  }
});

/* ═══════════════════════════════════════════
   指派單位：part 或 staff；槽位可以是字串（'kb'＝PC 鍵盤手）
   ═══════════════════════════════════════════ */

run('staff 級指派：指派 staff id 只有那個譜表走真人軌，同一個 part 的另一個譜表與其他 part 走電腦輔助；staff 的指派優先於 part 的', () => {
  const score = buildStaffScore([{ id: 'piano', staves: [{ id: 't1c0', notes: [0, 2], pitch: 72 }, { id: 't2c0', notes: [0, 2], pitch: 48 }] }]);
  const { hp, log, d } = makeStaffHp(score, [['t1c0', 1]]);
  assert(hp._staves.get('t1c0').kind === 'human' && hp._staves.get('t1c0').slot === 1, '上行譜（t1c0）走真人軌');
  assert(hp._staves.get('t2c0').kind === 'assist', '下行譜沒被指派，走電腦輔助');
  assert(hp._driverSegs.length === 2 && hp._driverSegs.every((g) => g.items.length === 1), 'driver segment 只含上行譜的音');
  d.tick(); d.press();
  assert(onMs(log, 72, 'human') === d.nowMs && onMs(log, 48, 'assist') === d.nowMs, '一次按鍵：上行譜（你的）與同 tick 的下行譜（電腦的）同刻發聲');
  const both = makeStaffHp(score, [['piano', 2], ['t1c0', 1]]);
  assert(both.hp._staves.get('t1c0').slot === 1 && both.hp._staves.get('t2c0').slot === 2, 'staff 的指派優先於 part 的');
  assert(portsNeeded(score, [['t1c0', 1]]) >= DEFAULT_PORTS, 'portsNeeded 也認 staff 級指派');
});

run("槽位可以是字串：'kb'（PC 鍵盤手）有資格觸發，其他槽位沒有", () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 1, 2], a1: [0, 1, 2] }), [['p0', 'kb']]);
  d.tick();
  assert(hp.trigger(1, d.nowMs) === false, '槽位 1 沒有指派聲部，不放行');
  assert(hp.trigger('kb', d.nowMs) === true && onMs(log, 40, 'human') === d.nowMs, "'kb' 放行，你的 40 與電腦的 52 同刻發聲");
});

/* ═══════════════════════════════════════════
   熱切換指派（reassign）：從目前位置接續，不從頭
   ═══════════════════════════════════════════ */

run('reassign：整首自動播放播到一半改成指派聲部——已經過的音不重播、不補放，停在你的下一個起音等你按', () => {
  const score = buildBeatScore({ p0: [0, 1, 2, 3, 4, 5], a1: [0, 1, 2, 3, 4, 5] });
  const { hp, log, d } = makeHp(score, []);
  d.tick(); d.runMs(1200);                                    // 播到拍 2.4（tick 1152）：拍 0、1、2 的音已響過
  const before = count(log, 'on');
  assert(before === 6, `前提：已經響了拍 0～2 的 6 顆音，實際 ${before}`);
  hp.reassign(new Map([['p0', 1]]));
  d.runMs(2000);
  assert(count(log, 'on') === before, `改指派後沒按，已經過的音不重播、拍 3 以後的音要等你按，實際又多了 ${count(log, 'on') - before} 顆`);
  assert(near(hp.getPositionTicks(), 1440, 1e-6), `播放頭停在你的下一個起音（拍 3＝tick 1440），實際 ${hp.getPositionTicks()}`);
  const t = d.nowMs;
  assert(d.press() === true, '之後照常放行');
  assert(onMs(log, 43, 'human') === t && onMs(log, 55, 'assist') === t, '拍 3 的你的 43 與電腦的 55 同刻發聲');
});

run('reassign：指派聲部播到一半改成整首自動播放——從目前位置往下播完，每顆音恰好響一次', () => {
  const score = buildBeatScore({ p0: [0, 1, 2, 3, 4], a1: [0, 1, 2, 3, 4] });
  const { hp, log, d } = makeHp(score, [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press(); d.pressAt(t0 + 500); d.pressAt(t0 + 1000);       // 按到拍 2
  d.runMs(200);
  hp.reassign(new Map());
  d.runMs(5000);
  for (const n of [40, 41, 42, 43, 44, 52, 53, 54, 55, 56]) assert(count(log, 'on', n) === 1, `音 ${n} 恰好響一次，實際 ${count(log, 'on', n)}`);
  assert(hp.isFinished() && hp._assignedSlots.size === 0, '改成自動播放後播完');
  assert(log.filter((e) => e.t === 'on' && e.note >= 43 && e.note <= 44).every((e) => e.label === 'assist'), '改指派之後 p0 的音走電腦輔助軌');
});

run('reassign：前奏鎖在改指派之後仍有效（改成指派入場晚的聲部，播放頭還在前奏裡）', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [4, 5], a1: [0, 1, 2, 3, 4, 5] }), []);
  d.tick(); d.runMs(300);
  hp.reassign(new Map([['p0', 1]]));
  assert(hp._hasPrelude === true, '改指派後重算前奏');
  assert(d.press() === false, '前奏還沒播到你的入場點，按鍵不放行（只記預按）');
  d.runMs(2000);
  assert(onMs(log, 40, 'human') !== undefined, '預按過：播到入場點自動放行你的第一個起音');
  assert(count(log, 'on', 52) === 1 && count(log, 'on', 55) === 1, '前奏的電腦音沒有因為改指派重播或丟掉');
});

run('reassign：debounce／速度歷史清掉但速度保留；改指派之後第一下按鍵不丟例外也不被擋', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3, 4], a1: [0, 1, 2, 3, 4] }), [['p0', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press(); d.pressAt(t0 + 400); d.pressAt(t0 + 800);
  const rate = hp.playbackRate;
  hp.reassign(new Map([['a1', 1]]));
  assert(hp.playbackRate === rate, '速度估計保留');
  d.runMs(100);
  assert(d.press() === true, '改指派後的第一下放行');
});

run('reassign：播完之前改完，isFinished 正確（已過的音算已發聲，剩下的要全響完且收完）', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 1, 2], a1: [0, 1, 2, 3, 4] }), [['p0', 1]]);
  d.tick(); d.press(); d.runMs(100);
  hp.reassign(new Map([['a1', 1]]));
  assert(!hp.isFinished(), '改完還沒按完，不算播完');
  for (let k = 0; k < 6; k++) { d.runMs(700); d.press(); }
  d.runMs(3000);
  assert(hp.isFinished(), '按完全部 driver 起音、剩下的都響完收完＝播完');
});

run('reassign：剛按下一個起音就改指派，那個 tick 的音已經響過，不會再放一次', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3], a1: [0, 1, 2, 3] }), [['p0', 1]]);
  d.tick(); d.runMs(100);
  d.press();                                                  // 拍 0 的 40 與 52 響了
  hp.reassign(new Map());                                     // 播放頭還在拍 0 上（沒有 tick 隔開）
  d.runMs(4000);
  for (const n of [40, 41, 42, 43, 52, 53, 54, 55]) assert(count(log, 'on', n) === 1, `音 ${n} 恰好響一次，實際 ${count(log, 'on', n)}`);
});

run('reassign：你早按後（電腦音已跳過／追音）改指派，跳過的音不補放、追音不重複，播得完且 isFinished 正確', () => {
  // 電腦的 60 在拍 0.9（原排在 450ms，短音）、61 在拍 0.8（長音，橫跨拍 1）；第二下提早到 320ms：60 跳過、61 追音。接著改成整首自動播放
  const { hp, log, d } = makeHp(buildBeatScore({ me: [0, 1, 2, 3], cpu: [{ beat: 0.8, dur: 0.3, note: 61 }, { beat: 0.9, dur: 0.05, note: 60 }] }), [['me', 1]]);
  d.tick();
  const t0 = d.nowMs;
  d.press();
  d.pressAt(t0 + 320);
  assert(hp.chaseStats().chased === 1 && hp.chaseStats().skipped === 1, `前提：61 追音、60 跳過，實際 ${JSON.stringify(hp.chaseStats())}`);
  hp.reassign(new Map());
  d.runMs(4000);
  assert(count(log, 'on', 60) === 0, `跳過的 60 不補放，實際 ${count(log, 'on', 60)} 次`);
  assert(count(log, 'on', 61) === 1, `追音 61 不重複，實際 ${count(log, 'on', 61)} 次`);
  assert(hp.isFinished(), '改指派後播完：isFinished 為 true');
});

run('reassign：沒有樂譜（load(null)）不丟例外', () => {
  const hp = new Scheduler();
  hp.load(null, []);
  hp.reassign(new Map([['x', 1]]));
});

run('reassign 壓力測試：canon 實譜，在隨機時刻改指派（自動播放 ↔ 小提琴 ↔ 大提琴 ↔ 兩個都指派），每顆音最多響一次、最後播得完', () => {
  const score = canonScore;
  const [violin, cello] = [score.parts.find((p) => p.name === '小提琴').id, score.parts.find((p) => p.name === '大提琴').id];
  const options = [[], [[violin, 'kb']], [[cello, 'kb']], [[violin, 'kb'], [cello, 'kb']]];
  for (const seed of [3, 8, 21, 40]) {
    let r = seed;
    const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
    const { hp, log, d } = makeHp(score, options[Math.floor(rnd() * 4)]);
    d.tick();
    let guard = 0;
    for (let k = 0; k < 4; k++) {
      // 隨機走一段：有 driver 就隨機按幾下（被去抖擋掉就算了），沒有就讓它自己播
      const end = d.nowMs + 1000 + rnd() * 9000;
      while (d.nowMs < end && guard++ < 100000) {
        d.runMs(60 + rnd() * 400);
        if (hp._assignedSlots.size && rnd() < 0.7) hp.trigger('kb', d.nowMs);
      }
      hp.reassign(new Map(options[Math.floor(rnd() * 4)]));
    }
    // 收尾：有 driver 就一直按到放行完，等所有音響完
    for (let k = 0; k < 5000 && !hp.isFinished(); k++) {
      d.runMs(150);
      if (hp._assignedSlots.size) hp.trigger('kb', d.nowMs);
    }
    assert(hp.isFinished(), `seed ${seed}：改指派之後最後要播得完`);
    assert(count(log, 'on') <= score.notes.length, `seed ${seed}：noteOn 共 ${count(log, 'on')} 次，不能超過音符數 ${score.notes.length}（有音重複響）`);
    assert(count(log, 'on') === count(log, 'off'), `seed ${seed}：每個 noteOn 一個 noteOff，實際 ${count(log, 'on')}／${count(log, 'off')}`);
  }
});

console.log('\n全部測試跑完。');
