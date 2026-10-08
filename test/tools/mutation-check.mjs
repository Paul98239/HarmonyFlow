// ============================================================
//  mutation-check.mjs — 變異檢查：故意把排程器弄壞，看指定的測試會不會變紅（手動執行，不進 CI，純 Node）
//
//  做法：把 src／測試複製到暫存資料夾，在複製出來的原始檔（預設 scheduler.js，也可以用 target 指定別的檔）
//  套用一個「一行的破壞」，跑測試，檢查「指定的那幾個測試」有沒有失敗。不會動到工作目錄裡的任何檔案。沒有任何
//  指定測試變紅＝這個行為沒有被保護。suites 可以含 'smoke'：用同一支瀏覽器測試（test/browser/smoke-test.mjs）
//  跑被破壞的複本（HF_ROOT），每個要一分多鐘，所以只放確實要靠瀏覽器才抓得到的破壞。
//  破壞用的字串必須在原始碼裡剛好出現一次；原始碼改了找不到就會直接報錯，提醒更新這張表。
//
//  用法：node test/tools/mutation-check.mjs [--only=關鍵字] [--skip-smoke | --only-smoke]
// ============================================================

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = 'src/midi/scheduler.js'; // 沒有指定 target 的變異破壞這個檔
const PRESS = 'src/midi/pressTiming.js', PREVIEW = 'src/midi/previewPlayer.js', PLAYER = 'src/midi/midiPlayer.js', SYNTH = 'src/midi/synth.js', PARSER = 'src/midi/midiParser.js', KEYBOARD = 'src/keyboard.js';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const SKIP_SMOKE = process.argv.includes('--skip-smoke'); // 只跑單元測試抓得到的變異（快）
const ONLY_SMOKE = process.argv.includes('--only-smoke'); // 只跑要靠瀏覽器測試抓的變異（慢）

// edits：[原始碼裡的那一行（或片段）, 換成什麼]。expect：應該變紅的測試名稱關鍵字（任何一個變紅就算抓到）；
// suites：要跑哪些測試檔（預設只跑排程器的單元測試）；target：破壞哪個檔（預設排程器）。
const MUTATIONS = [
  // ── 排程器：driver／follower、按鍵啟動它負責的那一段、去抖、收音 ──
  { name: 'FIFO 改回以音高為鍵（同音高的新音蓋掉舊音）', edits: [['queue.push({ endTick: note.endTick, offMs: holdIdx === null ? offMs : Infinity, origOffMs: offMs, holdIdx, note, onTime: opts?.time, capped: false });', 'queue.length = 0; queue.push({ endTick: note.endTick, offMs: holdIdx === null ? offMs : Infinity, origOffMs: offMs, holdIdx, note, onTime: opts?.time, capped: false });']],
    expect: ['同音高重疊（先進先出）', '壓力測試'], suites: ['scheduler', 'oracle'] },
  { name: '一次按鍵放行兩個 driver segment', edits: [['this._segIndex = j + 1;', 'this._segIndex = j + 2;']],
    expect: ['按一下放行 driver 的下一個 segment'] },
  { name: 'parser：相同 startTick 的音不併成同一個 segment', target: PARSER, suites: ['midi-parser', 'scheduler'], edits: [['if (last && last.ticks === note.startTick) last.notes.push(note);', 'if (false) last.notes.push(note);']],
    expect: ['segments：相同 startTick', '按一下放行 driver 的下一個 segment'] },
  { name: '同 tick 的電腦音晚一個排程 tick 才發聲（跟你的音沒有對齊）', edits: [['* 1000, clock);\n    this._emitPending();', '* 1000, clock);\n    void 0;']],
    expect: ['按一下放行 driver 的下一個 segment', 'L3 同步', 'L2 完美演奏者'], suites: ['scheduler', 'oracle'] },
  { name: '沒在播放也放行（trigger 不檢查 playing）', edits: [['if (!this._playing || !this._assignedSlots.has(slot) ||', 'if (!this._assignedSlots.has(slot) ||']],
    expect: ['沒有放行的情況'] },
  { name: '沒有指派聲部的槽位也能放行（不檢查資格）', edits: [['if (!this._playing || !this._assignedSlots.has(slot) ||', 'if (!this._playing ||']],
    expect: ['沒有放行的情況'] },
  { name: '前奏不自己播（tick 不先啟動第 0 段）', edits: [['    this._ensureAnchored();\n    const dt =', '    const dt =']],
    expect: ['前奏照原速播'] },
  { name: '前奏鎖拿掉（前奏還沒播完，按鍵就放行第一個起音、跳過前奏）', edits: [['if (j === 0 && this._hasPrelude && clock < this._reachClockMs() - EPS_MS) {', 'if (false) {']],
    expect: ['前奏鎖：前奏還沒播到', '前奏鎖：卡農實譜'] },
  { name: '前奏中的按鍵不記預按（播完不會自動入場）', edits: [['      this._preludeCredit = true;\n      return false;', '      return false;']],
    expect: ['前奏鎖：前奏還沒播到', '前奏鎖：卡農實譜'] },
  { name: '前奏播到入場點不自動放行預按的第一個起音', edits: [['if (reach !== null && this._clockMs >= reach - EPS_MS) { this._preludeCredit = false; this._release(reach); }', 'void reach;']],
    expect: ['前奏鎖：前奏還沒播到', '前奏鎖：卡農實譜'] },
  { name: '遲到量連按鍵呼叫內同刻放出的音也記（統計被稀釋成 0）', edits: [['      if (fromTick) {', '      if (true) {']],
    expect: ['量測：tick 放出的電腦音'] },
  { name: 'lookahead：你的音也帶時間戳', edits: [["if (staff.kind === 'human' || !this._audioBase || ms === undefined) return undefined;", 'if (!this._audioBase || ms === undefined) return undefined;']],
    expect: ['lookahead：電腦音在到期之前'] },
  { name: 'lookahead：你的音也提早收（用 lookahead 的上限）', edits: [["const limit = staff.kind === 'human' ? this._clockMs : limitMs;", 'const limit = limitMs;']],
    expect: ['lookahead：電腦音在到期之前'] },
  { name: 'lookahead：暫停時沒有替已送出、還沒響的音排收音（立刻處理的 noteOff 比 noteOn 早到）', edits: [['try { synth?.noteOff(staff.channel, pitch, this._offOpts(staff, entry)); } catch (err) {}', 'try { synth?.noteOff(staff.channel, pitch); } catch (err) {}']],
    expect: ['lookahead：暫停時已經送出', 'lookahead 壓力測試'] },
  { name: 'lookahead：收音沒有排在 noteOn 之後（沒有 onTime 下限）', edits: [['return { time: Math.max(stamp?.time ?? -Infinity, entry.onTime + 0.001) };', 'return stamp;']],
    expect: ['lookahead：暫停時已經送出', 'lookahead 壓力測試'] },
  { name: 'lookahead：audioNow 缺席也提早送出（不看 Number.isFinite）', edits: [['const timed = Number.isFinite(audioNow);', 'const timed = true;']],
    expect: ['lookahead：沒有交 AudioContext 時間'] },
  { name: '暫停不清掉預按', edits: [['this._preludeCredit = false; // 預按作廢：續播後要重新按', 'void 0;']],
    expect: ['預按後暫停再播放'] },
  { name: '電腦音的發聲時刻不依 playbackRate 換算（起音沒有跟著你的速度）', edits: [['const dueMs = clockMs + ((startSec - scoreSec) * 1000) / rate;', 'const dueMs = clockMs + ((startSec - scoreSec) * 1000);']],
    expect: ['音長不依速度換算'] },
  { name: '電腦音的長度又依 playbackRate 換算（音長隨你的速度伸縮）', edits: [['offMs: dueMs + (this._secOf(note.endTick) - startSec) * 1000,', 'offMs: dueMs + ((this._secOf(note.endTick) - startSec) * 1000) / rate,']],
    expect: ['音長不依速度換算'] },
  { name: '你的音長度又依 playbackRate 換算（音長隨你的速度伸縮）', edits: [['clock + (this._secOf(note.endTick) - scoreSec) * 1000, clock);', 'clock + ((this._secOf(note.endTick) - scoreSec) * 1000) / this.playbackRate, clock);']],
    expect: ['音長就是 MIDI 的音符長度', '音長不依速度換算'] },
  { name: '新的一段啟動時丟掉上一段沒放完的電腦音（提早按就丟音）', edits: [['    this._pending = merged;', '    this._pending = fresh;']],
    expect: ['提早按：上一段沒放完的電腦音', '壓力測試'] },
  { name: '新的一段的電腦音直接接在佇列後面（不依 dueMs 合併排序）', edits: [['    this._pending = merged;', '    this._pending = old.concat(fresh);']],
    expect: ['提早按：上一段沒放完的電腦音', '壓力測試'] },
  { name: '每一段的第一個電腦音位置只設一次（跳過沒有電腦音的段）', edits: [['      while (s <= slice) this._sliceFirst[s++] = i;', '      if (s <= slice) this._sliceFirst[s++] = i;']],
    expect: ['按一下放行 driver 的下一個 segment', '壓力測試'] },
  { name: '播放頭可以越過你的下一個起音（拿掉停格上限）', edits: [['    if (next) sec = Math.min(sec, this._secOf(next.ticks));', '    void next;']],
    expect: ['慢按：電腦聲部放完這一段就停', '前奏照原速播'] },
  { name: '去抖拿掉（太近的按鍵也放行）', edits: [['blocked = clock - this._lastAcceptClock < debounceWindowMs(expectedMs, this._lastAttemptIntervalMs);', 'blocked = false;']],
    expect: ['去抖：兩次按鍵太近就忽略第二次'] },
  { name: '去抖的「上一次按鍵間隔」不算被忽略的按鍵（一開始就比檔案快的人永遠被擋）', edits: [['    if (this._lastAttemptClock != null) this._lastAttemptIntervalMs = clock - this._lastAttemptClock;\n    this._lastAttemptClock = clock;\n    this._logPress(slot, clock, !blocked);   // 被擋掉記 false，放行記 true（放行必定接著 _release()）\n    if (blocked) return false;', '    this._logPress(slot, clock, !blocked);   // 被擋掉記 false，放行記 true（放行必定接著 _release()）\n    if (blocked) return false;\n    if (this._lastAttemptClock != null) this._lastAttemptIntervalMs = clock - this._lastAttemptClock;\n    this._lastAttemptClock = clock;']],
    expect: ['去抖不會把「一開始就比檔案快」的人永遠擋住'] },
  { name: 'playbackRate 不估速（永遠 1×）', edits: [['this.playbackRate = estimatePlaybackRate(this._history, this.playbackRate);', 'this.playbackRate = 1;']],
    expect: ['playbackRate：第一次按之前', '音長不依速度換算', '提早按'] },
  { name: '停手超過閒置門檻之後的間隔也拿來估速', edits: [['    if (this._isIdleBreak(clock)) this._history = [];', '    void 0;']],
    expect: ['慢按：電腦聲部放完這一段就停'] },
  { name: '放行 segment 時先開後收（拿掉開始前的收音）', edits: [['this._closeByTick(seg.ticks);', 'void 0;']],
    expect: ['你的音在下一次按鍵時依 endTick 先收'] },
  { name: '零長度的音不在同一次呼叫內收（拿掉放行後的收音）', edits: [['跟你的音同刻\n    this._closeDue();', '跟你的音同刻\n    void 0;']],
    expect: ['零長度的音'] },
  { name: '停格太久又把所有還在響的音全部收掉（切掉有固定長度的長音）', edits: [['this._closeDue(horizonMs);     // 剛發聲就到期的短音', 'this._closeDue(horizonMs);     // 剛發聲就到期的短音\n    if (this._stallMsAt(this._clockMs) > IDLE_MS) this._noteOffAll();']],
    expect: ['停格超過閒置門檻（800ms）', '停格再久也不改音長', '壓力測試'] },
  { name: '停手判斷速度沒學到時也只用 800ms（慢速演奏者學不到速度）', edits: [['return learned || this._stallMsAt(clock) > IDLE_UNLEARNED_FACTOR * predictedMs;', 'return true;']],
    expect: ['速度還沒學到時，你很慢'] },
  { name: '停手判斷速度學到之後也用預測間隔的 3 倍（停手辨認不出來，歷史被停手的空檔拖慢）', edits: [['return learned || this._stallMsAt(clock) > IDLE_UNLEARNED_FACTOR * predictedMs;', 'return this._stallMsAt(clock) > IDLE_UNLEARNED_FACTOR * predictedMs;']],
    expect: ['速度學到之後（≥ 3 個間隔）'] },
  { name: '拿掉尾巴收尾（同譜表新音發聲時舊音照原排程收，疊音比檔案多）', edits: [['if (capMs < entry.offMs - EPS_MS) { entry.offMs = capMs; entry.capped = true; entry.holdIdx = null; }', 'if (false) { entry.offMs = capMs; entry.capped = true; entry.holdIdx = null; }']],
    expect: ['尾巴收尾：你按得比預估早', '尾巴收尾：檔案裡本來就有的重疊', '尾巴收尾對你的聲部同樣適用', '尾巴收尾：同音高', 'hold：同譜表的新音發聲時'] },
  // ── hold（loop 等你按下一個起音）──
  { name: '拿掉 hold（結尾對齊起音的音也照原長收）', edits: [['return a[lo] - note.endTick <= HOLD_GAP_TICKS && a[lo] > note.startTick ? lo : null;', 'return null;']],
    expect: ['hold：結尾接著你下一個起音', 'hold：同一個 tick', 'hold：前奏', 'hold：跨過多個起音', '相連音 hold'] },
  { name: 'hold：對齊容差拿掉（MuseScore 少 1 tick 的相連音不 hold）', edits: [['const HOLD_GAP_TICKS = 2;', 'const HOLD_GAP_TICKS = 0;']],
    expect: ['hold：結尾接著你下一個起音', '相連音 hold'] },
  { name: 'hold：已經放行的起音也 hold（早按之後才發聲的音永遠不收）', edits: [['if (lo >= a.length || lo < this._segIndex) return null;', 'if (lo >= a.length) return null;']],
    expect: ['hold：結尾對齊的起音已經按過了'] },
  { name: 'hold：放行起音時不釋放 hold 的音', edits: [['this._releaseHeld(j, clock);', 'void 0;']],
    expect: ['hold：結尾接著你下一個起音', 'hold：同一個 tick', 'hold：前奏', '相連音 hold'] },
  { name: 'hold：釋放時直接用按下的時刻（早按會切斷還沒走完原長的音）', edits: [['entry.offMs = Math.max(entry.origOffMs, clock);', 'entry.offMs = clock;']],
    expect: ['hold：你按得比預估早'] },
  { name: 'hold：hold 著的音擋住同音高後面已到期的音（先進先出看佇列最前面）', edits: [['const i = queue.findIndex((e) => e.holdIdx === null);', 'const i = 0;']],
    expect: ['hold：hold 著的音不擋住同音高'] },
  { name: 'hold：被同譜表新音截短之後仍 hold（放行時又蓋掉截短的收音時刻）', edits: [['entry.offMs = capMs; entry.capped = true; entry.holdIdx = null; }', 'entry.offMs = capMs; entry.capped = true; }']],
    expect: ['hold：同譜表的新音發聲時'] },
  { name: '按鍵記錄不記被去抖擋掉的嘗試', edits: [['this._logPress(slot, clock, !blocked);', 'if (!blocked) this._logPress(slot, clock, true);']],
    expect: ['按鍵記錄：每次按鍵嘗試都記'] },
  { name: '拿掉每個 tick 的 dt 上限', edits: [['const dt = this._lastTickMs == null ? 0 : Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));', 'const dt = this._lastTickMs == null ? 0 : Math.max(0, nowMs - this._lastTickMs);']],
    expect: ['每個 tick 的時間步長上限'] },
  { name: '重設不清 driver segment 游標（重播從上次的位置接著放行）', edits: [['    this._segIndex = 0;\n    this._clockMs = 0;', '    this._clockMs = 0;']],
    expect: ['重設把排程器退回', 'restart() 之後要重新按才會放行 driver'] },
  { name: '重設不清錨點與排好的電腦音', edits: [['    this._anchor = null;\n    this._anchoredSlice = -1;\n    this._pending = [];', '    this._anchor = null;']],
    expect: ['重設把排程器退回'] },
  { name: '重設不清去抖狀態', edits: [['    this._sounded.clear();\n    this._history = [];\n    this._lastAcceptClock = null;', '    this._sounded.clear();\n    this._history = [];']],
    expect: ['重設把排程器退回'] },
  { name: '收音時不送 noteOff（暫停與停格釋放只清紀錄）', edits: [['for (const entry of queue) {\n          try { synth?.noteOff(staff.channel, pitch, this._offOpts(staff, entry)); }', 'for (const entry of []) {\n          try { synth?.noteOff(staff.channel, pitch, this._offOpts(staff, entry)); }']],
    expect: ['暫停收掉所有還在響的音', '壓力測試'] },
  { name: '進度不夾在總長以內', edits: [['return total > 0 ? Math.min(ticks, total) : ticks;', 'return ticks;']],
    expect: ['最後一個 driver 起音之後的電腦音照節奏自己放完'] },
  { name: '還有音在響也算播完', edits: [['      if (staff.sounding.size > 0) return false;\n', '']],
    expect: ['最後一個 driver 起音之後的電腦音照節奏自己放完', '整首自動播放（沒有指派）'] },
  { name: '還有音沒發過聲也算播完', edits: [['    if (this._sounded.size < this._totalNotes) return false;\n', '']],
    expect: ['最後一個 driver 起音之後的電腦音照節奏自己放完', '整首自動播放（沒有指派）', '前奏照原速播'] },
  { name: '排不進 channel 的 driver 的音也留在 segment 裡（整個 segment 都排不進也收）', edits: [['if (items.length) { this._driverSegs.push({ ticks: seg.ticks, items }); this._driverTicks.push(seg.ticks); }', '{ this._driverSegs.push({ ticks: seg.ticks, items }); this._driverTicks.push(seg.ticks); }']],
    expect: ['排不進 channel 的 driver 的音不進 segment'] },
  { name: '所有音一律送 velocity 0 的 noteOn', edits: [['try { this._synthOf(staff)?.noteOn(staff.channel, note.midiNote, note.velocity, opts); } catch (err) {}', 'try { this._synthOf(staff)?.noteOn(staff.channel, note.midiNote, 0, opts); } catch (err) {}']],
    expect: ['不送 velocity 0 的 noteOn', 'L2 完美演奏者', '壓力測試'], suites: ['scheduler', 'oracle'] },
  { name: 'portsNeeded 永遠只回預設 port 數（歌曲需要更多也不補）', edits: [['return Math.max(DEFAULT_PORTS, ...pools.map', 'return DEFAULT_PORTS || Math.max(DEFAULT_PORTS, ...pools.map']],
    expect: ['portsNeeded：', 'port 數變多之後'] },
  // ── 指派單位與熱切換（reassign）──
  { name: 'staff 級指派：只認 part 的指派（指派 staff id 沒有作用）', edits: [['const slotOfSpec = (assignments, spec) => assignments.get(spec.id) ?? assignments.get(spec.partId);', 'const slotOfSpec = (assignments, spec) => assignments.get(spec.partId);']],
    expect: ['staff 級指派'] },
  { name: 'reassign：起音在界線之前的音不算已發聲（isFinished 永遠等不到）', edits: [['for (const note of staff.notes) if (note.startTick < boundary && !keptNotes.has(note)) this._sounded.add(note);', 'for (const note of staff.notes) void note;']],
    expect: ['reassign：整首自動播放播到一半', 'reassign：播完之前改完', 'reassign 壓力測試'] },
  { name: 'reassign：這一段裡播放頭之前的電腦音也排進佇列（一次補放）', edits: [['if (note.startTick < fromTick) continue;', 'void 0;']],
    expect: ['reassign：整首自動播放播到一半', 'reassign 壓力測試'] },
  { name: 'reassign：不收掉還在響的音', edits: [['    this.silence();\n    this._staves = new Map();', '    this._staves = new Map();']],
    expect: ['reassign 壓力測試'] },
  { name: 'reassign：driver 游標從頭開始（改指派等於從頭按）', edits: [['this._segIndex = this._driverTicks.findIndex((t) => t >= boundary);', 'this._segIndex = 0;']],
    expect: ['reassign：整首自動播放播到一半', 'reassign 壓力測試'] },
  { name: 'reassign：剛按下起音、播放頭還在它上面時，把那個 tick 當成還沒響（重複放一次）', edits: [['pos >= next.ticks - 1e-6 ? next.ticks : pos + 1e-6;', 'pos >= next.ticks - 1e-6 ? next.ticks : pos - 1e-6;']],
    expect: ['reassign：剛按下一個起音就改指派', 'reassign 壓力測試'] },
  { name: 'reassign：不保留舊計畫還沒發聲的電腦音（早按留下的音被丟掉）', edits: [["if (staff && staff.kind === 'assist' && p.note.startTick < boundary) kept.push({ ...p, staff });", 'void staff;']],
    expect: ['reassign：你早按時留下'] },
  { name: 'reassign：不清去抖歷史（舊的間隔對不上新的 driver 序列）', edits: [['    this._history = [];\n    this._lastAcceptClock = null;\n    this._lastAttemptClock = null;\n    this._lastAttemptIntervalMs = Infinity;\n    this._lastTickMs = null;', '    this._lastTickMs = null;']],
    expect: ['reassign：debounce', 'reassign 壓力測試'] },
  // ── 按鍵節奏：估速與去抖（pressTiming.js，單元測試）──
  { name: '估速：視窗不限 8 個間隔（用全部歷史）', target: PRESS, suites: ['press-timing', 'scheduler'], edits: [['const first = history[Math.max(0, history.length - 1 - RATE_WINDOW_INTERVALS)];', 'const first = history[0];']],
    expect: ['視窗只看最近 8 個間隔'] },
  { name: '估速：改成只看最近一個間隔（手抖被放大）', target: PRESS, suites: ['press-timing'], edits: [['const first = history[Math.max(0, history.length - 1 - RATE_WINDOW_INTERVALS)];', 'const first = history[history.length - 2];']],
    expect: ['視窗內的手抖互相抵銷', '視窗只看最近 8 個間隔'] },
  { name: '估速：不夾速度範圍', target: PRESS, suites: ['press-timing'], edits: [['return clamp((last.scoreSec - first.scoreSec) / realSec, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);', 'return (last.scoreSec - first.scoreSec) / realSec;']],
    expect: ['夾在 [0.25, 4]'] },
  { name: '去抖：窗口不取「上一次按鍵間隔」較小者', target: PRESS, suites: ['press-timing'], edits: [['const base = Math.min(expectedStepMs, lastAttemptIntervalMs);', 'const base = expectedStepMs;']],
    expect: ['取「預估長度」與「你上一次的按鍵間隔」較小者'] },
  { name: '去抖：下限拿掉', target: PRESS, suites: ['press-timing'], edits: [['return clamp(DEBOUNCE_FRACTION * base, DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS);', 'return clamp(DEBOUNCE_FRACTION * base, 0, DEBOUNCE_MAX_MS);']],
    expect: ['下限 50ms、上限 500ms'] },
  { name: '去抖：上限拿掉', target: PRESS, suites: ['press-timing'], edits: [['return clamp(DEBOUNCE_FRACTION * base, DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS);', 'return clamp(DEBOUNCE_FRACTION * base, DEBOUNCE_MIN_MS, Infinity);']],
    expect: ['下限 50ms、上限 500ms'] },
  { name: 'pressLoad：同一個秒數重複算', target: PRESS, suites: ['press-timing'], edits: [['const t = [...new Set(secs)].sort((a, b) => a - b);', 'const t = [...secs].sort((a, b) => a - b);']],
    expect: ['pressLoad：同一個秒數'] },
  // ── parser：容器容錯、多樂器軌拆分、警告彙整（只改怎麼讀，不改音符資料）──
  { name: 'parser：不認 RMID 外包裝', target: PARSER, suites: ['midi-parser'], edits: [["if (bytes.length >= 12 && tag(0) === 'RIFF') {", "if (false) {"]],
    expect: ['RMID 外包裝'] },
  { name: 'parser：RIFF 但不是 RMID 也當成 MIDI 讀', target: PARSER, suites: ['midi-parser'], edits: [["if (tag(8) !== 'RMID') throw", "if (false) throw"]],
    expect: ['RIFF 但不是 RMID'] },
  { name: 'parser：檔頭前的雜訊不略過', target: PARSER, suites: ['midi-parser'], edits: [["if (bytes.length < 4 || tag(0) === 'MThd') return bytes;", 'return bytes;']],
    expect: ['檔頭前有雜訊'] },
  { name: 'parser：雜訊搜尋沒有 4KB 上限', target: PARSER, suites: ['midi-parser'], edits: [['const last = Math.min(SMF_SEARCH_LIMIT, bytes.length - 4);', 'const last = bytes.length - 4;']],
    expect: ['檔頭前有雜訊'] },
  { name: 'parser：tick 過大不警告', target: PARSER, suites: ['midi-parser'], edits: [['if (maxTick > MAX_PLAUSIBLE_TICK) {', 'if (false) {']],
    expect: ['tick 超過 1e7'] },
  { name: 'parser：多樂器的軌不拆（拿掉依樂器類別拆 part）', target: PARSER, suites: ['midi-parser'], edits: [['if (byClass.size <= 1) { out.push(group); continue; }', 'if (true) { out.push(group); continue; }']],
    expect: ['format 0 同一條軌混多種樂器'] },
  { name: 'parser：樂器類別改成逐 program 區分（MuseScore 的演奏法 channel 被誤拆）', target: PARSER, suites: ['midi-parser'], edits: [["return isDrum ? '打擊' : `family ${program >> 3}`;", "return isDrum ? '打擊' : `family ${program}`;"]],
    expect: ['MuseScore 的演奏法 channel'] },
  { name: 'parser：樂器類別不優先看首軌的初始化（下行譜自己的 Program Change 造成誤拆）', target: PARSER, suites: ['midi-parser'], edits: [['  const fromFirst = group.first.initByChannel.get(channel);', '  const fromFirst = undefined;']],
    expect: ['下行譜自己送了不同的 Program Change'] },
  { name: 'parser：打擊與旋律不分（拿掉打擊類別）', target: PARSER, suites: ['midi-parser'], edits: [['const isDrum = msb === 120 || (msb === undefined && absChannel % 16 === DRUM_CHANNEL);', 'const isDrum = false;']],
    expect: ['format 0 同一條軌混多種樂器'] },
  { name: 'parser：對不上 MuseScore 模式的孤立 note off 逐個警告（不彙整）', target: PARSER, suites: ['midi-parser'], edits: [['      if (entry) entry.count++;\n      else unexplained.set(channel, { count: 1, ticks, pitch });', '      warn(`track ${track.index} 的 channel ${channel}：沒有對應的 note on 的 note off`);']],
    expect: ['對不上 MuseScore 模式的孤立 note off'] },
  { name: 'parser：孤立 note off 一律警告（不認 MuseScore 補送的模式）', target: PARSER, suites: ['midi-parser'], edits: [['      if ((onChannelsAt.get(ticks * 128 + pitch) ?? 0) & ~(1 << channel)) continue;\n', '']],
    expect: ['MuseScore 補送的 note off'] },
  { name: 'parser：孤立 note off 配對時同一個 channel 的 note on 也算', target: PARSER, suites: ['midi-parser'], edits: [['(onChannelsAt.get(ticks * 128 + pitch) ?? 0) & ~(1 << channel)', '(onChannelsAt.get(ticks * 128 + pitch) ?? 0)']],
    expect: ['孤立 note off 只認「別的 channel」'] },
  { name: 'parser：孤立 note off 配對時不看音高（只看 tick）', target: PARSER, suites: ['midi-parser'], edits: [['const at = ev.ticks * 128 + ev.data1;', 'const at = ev.ticks * 128;'], ['onChannelsAt.get(ticks * 128 + pitch)', 'onChannelsAt.get(ticks * 128)']],
    expect: ['對不上 MuseScore 模式的孤立 note off'] },
  { name: 'parser：與第一軌完全相同的速度／拍號也警告', target: PARSER, suites: ['midi-parser'], edits: [['|| onFirst.has(key(ev))) continue;', ') continue;']],
    expect: ['速度／拍號出現在非第一軌'] },
  { name: 'parser：非第一軌的速度／拍號依種類不彙整（次數不累計）', target: PARSER, suites: ['midi-parser'], edits: [['if (f) f.count++; else found.set', 'if (false) f.count++; else found.set']],
    expect: ['速度／拍號出現在非第一軌'] },
  // ── parser：tick ↔ 秒的反函數、program 查詢、segments ──
  { name: 'parser：secondsToMIDITicks 忘了加區段的起始 tick', target: PARSER, suites: ['midi-parser', 'oracle'], edits: [['return seg.ticks + ((seconds - seg.seconds) * 1e6 * tpq) / seg.microsecondsPerQuarter;', 'return ((seconds - seg.seconds) * 1e6 * tpq) / seg.microsecondsPerQuarter;']],
    expect: ['互為反函數', 'L1 反函數'] },
  { name: 'parser：program 的全曲查詢只用軌內 channel（不同 port 的同號 channel 互相汙染）', target: PARSER, suites: ['midi-parser'], edits: [
    ['      const key = absChannel(track.index, ev.channel);', '      const key = ev.channel;'],
    ['      const global = globalLookup(absChannel(currentTrack, channel), ticks);', '      const global = globalLookup(channel, ticks);']],
    expect: ['沒有初始化區塊的 staff 查 program'] },
  // ── parser：聲部切分（part／staff）與跟官方對齊（單元測試＋差異測試）──
  { name: 'parser：同 tick 的速度衝突改回先出現者生效', target: PARSER, suites: ['midi-parser', 'oracle'], edits: [['        last.microsecondsPerQuarter = ev.microsecondsPerQuarter;\n        last.bpm = ev.bpm;\n', '']],
    expect: ['同 tick 的速度衝突'] },
  { name: 'parser：同 tick 的拍號／調號改回先出現者生效', target: PARSER, suites: ['midi-parser', 'oracle'], edits: [['if (last && last.ticks === ev.ticks) { out[out.length - 1] = decorate(ev); continue; }', 'if (last && last.ticks === ev.ticks) continue;']],
    expect: ['同 tick 的拍號與調號衝突'] },
  { name: 'parser：音符 channel 不加 port 偏移', target: PARSER, suites: ['midi-parser', 'oracle'], edits: [['    offsets.set(t.index, offsetOfPort.get(port));', '    offsets.set(t.index, 0);']],
    expect: ['port 絕對 channel', '打擊樂器在 port 1'] },
  { name: 'parser：port 偏移用 port 的數值而不是出現順序', target: PARSER, suites: ['midi-parser'], edits: [['    if (!offsetOfPort.has(port)) offsetOfPort.set(port, offsetOfPort.size * 16);', '    if (!offsetOfPort.has(port)) offsetOfPort.set(port, port * 16);']],
    expect: ['port 絕對 channel'] },
  { name: 'parser：沒指定 port 的軌用 0 而不是最小的已指定 port', target: PARSER, suites: ['midi-parser'], edits: [['  const defaultPort = given.length ? Math.min(...given) : 0;', '  const defaultPort = 0;']],
    expect: ['port 絕對 channel'] },
  { name: 'parser：有初始化區塊的 track 也能併入上一組（拿掉 hasInit 條件）', target: PARSER, suites: ['midi-parser'], edits: [['    const canMerge = cur && !s.hasInit\n', '    const canMerge = cur\n']],
    expect: ['兩台鋼琴同名'] },
  { name: 'parser：軌名不同也併入上一組（拿掉軌名條件）', target: PARSER, suites: ['midi-parser'], edits: [['      && (!s.track.name || !cur.first.track.name || s.track.name === cur.first.track.name)\n', '']],
    expect: ['舊檔（沒有初始化區塊'] },
  { name: 'parser：用了別的 channel 也併入上一組（拿掉 channel 子集條件）', target: PARSER, suites: ['midi-parser'], edits: [['      && [...s.noteChannels].every((ch) => cur.knownChannels.has(ch));', ';']],
    expect: ['用的是這組沒有的 channel'] },
  { name: 'parser：單獨的 Program Change 也算初始化區塊（下行譜變成新樂器）', target: PARSER, suites: ['midi-parser'], edits: [["    if (ev.type === 'programChange') {\n      init.program = ev.data1;\n", "    if (ev.type === 'programChange') {\n      init.program = ev.data1;\n      hasInit = true;\n"]],
    expect: ['〈蝸牛與黃鸝鳥〉的結構'] },
  { name: 'parser：下行譜不沿用首軌的初始化', target: PARSER, suites: ['midi-parser'], edits: [['      const fromInit = group.first.initByChannel.get(channel) || null;', '      const fromInit = summary.initByChannel.get(channel) || null;']],
    expect: ['鋼琴兩行譜'] },
  { name: 'parser：有初始化區塊的 staff 不用 tick 0 的 program', target: PARSER, suites: ['midi-parser'], edits: [['      const program = fromInit?.program ?? st.program;', '      const program = st.program;']],
    expect: ['就算在第一顆音之前出現也被忽略'] },
  { name: 'parser：bank 預設不分打擊 channel（一律 121）', target: PARSER, suites: ['midi-parser'], edits: [['      const defaultMsb = vk.channel % 16 === DRUM_CHANNEL ? 120 : 121;', '      const defaultMsb = 121;']],
    expect: ['沒有初始化區塊的 staff', '打擊樂器在 port 1'] },
  { name: 'parser：同音高重疊不警告', target: PARSER, suites: ['midi-parser'], edits: [['      if (st.overlaps) {', '      if (false) {']],
    expect: ['同一個 staff 內同音高重疊'] },
  { name: 'parser：同名 part 不加序號', target: PARSER, suites: ['midi-parser'], edits: [['    if (sameBase(i) === 1) { part.name = bases[i]; return; }', '    if (true) { part.name = bases[i]; return; }']],
    expect: ['兩個小提琴 Part'] },
  { name: 'parser：part 名稱取第一個 staff（不是音符最多的）', target: PARSER, suites: ['midi-parser'], edits: [['    const main = [...part.staves].sort((a, b) => b.noteCount - a.noteCount || a.channel - b.channel)[0];', '    const main = part.staves[0];']],
    expect: ['part 名稱取音符最多的 staff'] },
  // ── 可播放性（嚴格假合成器：初始狀態先於 noteOn、打擊槽、值域、成對、沒有卡音）──
  { name: '可播放性：初始化不送 program（noteOn 之前缺 program）', suites: ['playability'], edits: [['      synth.programChange(channel, staff.program || 0);\n', '']],
    expect: ['整首自動播放可以播放'] },
  { name: '可播放性：打擊 staff 配到旋律 channel', suites: ['playability'], edits: [['    if (s.percussionKit) {\n      if (!kitChannel.has', '    if (false) {\n      if (!kitChannel.has']],
    expect: ['輸出 channel 配置', '整首自動播放可以播放'] },
  { name: '可播放性：收音時不送 noteOff（曲末卡音，嚴格合成器也要抓到）', suites: ['playability'], edits: [['for (const entry of queue) {\n          try { synth?.noteOff(staff.channel, pitch, this._offOpts(staff, entry)); }', 'for (const entry of []) {\n          try { synth?.noteOff(staff.channel, pitch, this._offOpts(staff, entry)); }'], ['try { synth?.noteOff(staff.channel, pitch, this._offOpts(staff, queue[i], queue[i].offMs)); } catch (err) {}\n          queue.splice(i, 1);', 'queue.splice(i, 1);']],
    expect: ['整首自動播放可以播放', '兩位演奏者'] },
  // ── staff 化（排程器以 staff 為單位）──
  { name: 'staff 化：同一個 part 的 staff 用 partId 當 key（互相覆蓋）', edits: [['staves.set(spec.id, makeStaff(spec, slotOfSpec(assignments, spec), notesByStaff.get(spec.id) || [], \'human\', channel));', 'staves.set(spec.partId, makeStaff(spec, slotOfSpec(assignments, spec), notesByStaff.get(spec.id) || [], \'human\', channel));']],
    expect: ['staff 化：一個 part 兩個 staff'] },
  { name: 'staff 化：音符不依 staffId 分組（全按 partId）', edits: [['const staffKeyOf = (note) => note.staffId ?? note.partId;', 'const staffKeyOf = (note) => note.partId;']],
    expect: ['staff 化：一個 part 兩個 staff'] },
  { name: 'staff 化：不同鼓組全擠在第一個打擊槽', edits: [['kitChannel.set(s.program, drumChannels[kitChannel.size]);', 'kitChannel.set(s.program, drumChannels[0]);']],
    expect: ['打擊 staff：依鼓組 program 分配'] },
  { name: 'staff 化：旋律 staff 可以落在打擊槽', edits: [['if (ch % CHANNELS_PER_PORT !== drumChannel) out.push(ch);', 'out.push(ch);']],
    expect: ['打擊 staff：依鼓組 program 分配'] },
  { name: 'staff 化：輸出 channel 用完的 staff 不回報', edits: [['    else unplaced.push(s.id);\n  }\n  return { byStaffId, unplaced };', '  }\n  return { byStaffId, unplaced };']],
    expect: ['輸出 channel 用完'] },
  { name: 'staff 化：初始化不送 CC10／91／93', edits: [['      synth.controllerChange(channel, 10, init?.pan ?? GM_DEFAULT_PAN);\n      synth.controllerChange(channel, 91, init?.reverb ?? GM_DEFAULT_REVERB);\n      synth.controllerChange(channel, 93, init?.chorus ?? GM_DEFAULT_CHORUS);\n', '']],
    expect: ['staff 初始化'] },
  { name: 'staff 化：初始化不送 CC7（原音量）', edits: [['      synth.controllerChange(channel, 7, staff.baseVolume);\n', '']],
    expect: ['staff 初始化', 'baseVolume'] },
  // ── 試聽：PreviewPlayer（單元測試）──
  { name: '試聽不關掉官方的循環播放（loopCount 留著預設）', target: PREVIEW, suites: ['preview-player'], edits: [['seq.loopCount = 0; // 官方預設循環播放（-1），試聽播完就該停', '/* 變異：沒有關循環 */']],
    expect: ['loopCount 明確設成 0'] },
  { name: '試聽不比對 songChange 的檔名（舊載入的事件也算數）', target: PREVIEW, suites: ['preview-player'], edits: [['(song) => { if (song?.fileName === name) settle(); }', '() => { settle(); }']],
    expect: ['別次載入晚到的 songChange', '載入中又 start()'] },
  { name: '試聽載入沒有逾時（長度 0 的 MIDI 會永遠卡住）', target: PREVIEW, suites: ['preview-player'], edits: [["timer = setTimeout(() => settle(fail('timeout', '官方播放器沒有回應')), this._timeoutMs);", '/* 變異：沒有逾時 */']],
    expect: ['逾時'] },
  { name: '停止試聽不中斷還在等的載入', target: PREVIEW, suites: ['preview-player'], edits: [["this._abort?.(fail('aborted', '試聽被中斷'));", '/* 變異：不中斷 */']],
    expect: ['載入中 stop()', '載入中又 start()'] },
  { name: '載入結束後不移除官方事件的監聽（累積）', target: PREVIEW, suites: ['preview-player'], edits: [["seq.eventHandler.removeEvent('songChange', EVENT_ID);", '/* 變異：不移除 */']],
    expect: ['監聽都已移除'] },
  { name: '播完後續播不從頭（直接 play）', target: PREVIEW, suites: ['preview-player'], edits: [['if (this._seq.isFinished) this.restart();\n    else this._seq.play();', 'this._seq.play();']],
    expect: ['播完（官方 isFinished）之後 resume()'] },
  { name: '暫停不呼叫官方的 pause（試聽停不下來）', target: PREVIEW, suites: ['preview-player'], edits: [['pause() { if (this._active) this._seq.pause(); }', 'pause() { /* 變異：不暫停 */ }']],
    expect: ['pause()／resume() 交給官方'] },
  { name: '解析失敗不丟錯（當成載入成功）', target: PREVIEW, suites: ['preview-player'], edits: [["(err) => settle(fail('parse', err?.message || '官方解析器拒絕這首 MIDI'))", '() => settle()']],
    expect: ['官方解析器拒絕（midiError）'] },
  { name: '開始新的試聽前不先結束上一次', target: PREVIEW, suites: ['preview-player'], edits: [['this.stop(); // 上一次試聽（包含還在等的載入）先結束', '/* 變異：不先 stop */']],
    expect: ['載入中又 start()'] },
  // ── 鍵盤觸發（瀏覽器測試）──
  { name: '鍵盤：不擋瀏覽器預設行為（下拉被字母鍵 type-ahead 跳選項）', target: KEYBOARD, suites: ['smoke'], edits: [['    e.preventDefault();\n', '']],
    expect: ['焦點在下拉：type-ahead 被擋掉'] },
  { name: '鍵盤：按住不放的自動重複也算觸發', target: KEYBOARD, suites: ['smoke'], edits: [['if (e.repeat) return;', 'if (false) return;']],
    expect: ['按住不放的自動重複只算一次'] },
  { name: '鍵盤：在搜尋欄打字也觸發', target: KEYBOARD, suites: ['smoke'], edits: [['if (isTyping(document.activeElement)) return;', 'if (false) return;']],
    expect: ['焦點在搜尋欄'] },
  { name: '指派：播放中改指派不即時處理（要等下次 ▶ 重新載入）', target: PLAYER, suites: ['smoke'], edits: [['  reassignInPlace();\n  updateHumanGate(); // 指派全清時', '  updateHumanGate(); // 指派全清時']],
    expect: ['播放中把大提琴改成'] },
  { name: '指派：下拉沒有 PC 鍵盤手', target: PLAYER, suites: ['smoke'], edits: [["select.append(new Option('無', ''), new Option('PC 鍵盤手', KEYBOARD_SLOT));", "select.append(new Option('無', ''));"]],
    expect: ['單聲部的歌也列出指派下拉'] },
  { name: '指派：單聲部的歌不顯示分譜區塊', target: PLAYER, suites: ['smoke'], edits: [['scorePartSection.hidden = player.parts.length === 0;', 'scorePartSection.hidden = player.parts.length <= 1;']],
    expect: ['單聲部的歌也列出指派下拉'] },
  // ── 試聽：播放列與引擎接線（瀏覽器測試，每個一分多鐘）──
  { name: '換來源時不把播放列切回演奏（試聽 mode 殘留）', target: PLAYER, suites: ['smoke'], edits: [["playerStore.set({ mode: 'perform', transport: 'idle', notice: null, started: false, finished: false, previewDuration: 0 });", "playerStore.set({ transport: 'idle', notice: null, started: false, finished: false, previewDuration: 0 });"]],
    expect: ['換歌', '按鈕狀態'] },
  { name: '試聽播完 uiTick 不偵測（永遠停在「播放中」）', target: PLAYER, suites: ['smoke'], edits: [['!playerStore.state.finished && synth.isPreviewFinished()', 'false']],
    expect: ['試聽播完'] },
  { name: '演奏播放中 ♪ 也能按', target: PLAYER, suites: ['smoke'], edits: [['preview: inPreview, // 演奏播放中 ♪ 灰；試聽播放中 ♪ 是「結束試聽」，可按', 'preview: true,']],
    expect: ['演奏播放中 ♪ 是灰的', '64 種狀態組合'] },
  { name: '♪ 的 action 不對狀態表（灰的時候被呼叫也照做）', target: PLAYER, suites: ['smoke'], edits: [["'preview': whenAllowed('preview', () => (playerStore.state.mode === 'preview' ? leavePreview() : enterPreview())),", "'preview': () => (playerStore.state.mode === 'preview' ? leavePreview() : enterPreview()),"]],
    expect: ['64 種狀態組合'] },
  { name: '清場不停掉試聽（換歌／離開試聽之後官方還在播）', target: SYNTH, suites: ['smoke'], edits: [['  previewPlayer?.stop();\n  isSongLoaded = false;', '  isSongLoaded = false;']],
    expect: ['離開試聽：官方 Sequencer 已停', '換歌'] },
  { name: '離開試聽不清場（只切畫面）', target: PLAYER, suites: ['smoke'], edits: [['function leavePreview() {\n  synth.flushPreviousSong();\n', 'function leavePreview() {\n']],
    expect: ['離開試聽：官方 Sequencer 已停'] },
  { name: '進入試聽不結束演奏（排程器繼續跑）', target: SYNTH, suites: ['smoke'], edits: [["  if (!SequencerClass) throw engineError('音源引擎缺少 Sequencer');\n  flushPreviousSong();\n", "  if (!SequencerClass) throw engineError('音源引擎缺少 Sequencer');\n"]],
    expect: ['進入試聽＝演奏進度歸零'] },
  { name: 'worklet 回讀：初始化的 CC7 沒送到 worklet（只剩 program）', suites: ['smoke'], edits: [['      synth.controllerChange(channel, 7, staff.baseVolume);\n', '']],
    expect: ['worklet 在'] },
  { name: 'lookahead：audioNow 的時鐘差了一個時間原點（時間戳在遙遠的未來，worklet 永遠不處理）', target: SYNTH, suites: ['smoke'], edits: [["audioCtx?.state === 'running' ? audioCtx.currentTime : undefined;", "audioCtx?.state === 'running' ? audioCtx.currentTime + 1000 : undefined;"]],
    expect: ['的 noteOn 在 worklet 端都發聲了'] },
  { name: '歌曲需要更多 port 時不補 channel（load 不呼叫 ensurePorts）', target: SYNTH, suites: ['smoke'], edits: [['  ensurePorts(portsNeeded(score, assignments));', '  void portsNeeded;']],
    expect: ['62 個旋律 staff'] },
  { name: '開機補完 channel 後不重設合成器（channel 16 以上預設是打擊）', target: SYNTH, suites: ['smoke'], edits: [['        s.reset();\n      }', '      }']],
    expect: ['開機後'] },
  { name: '試聽失敗時畫面沒有提示', target: PLAYER, suites: ['smoke'], edits: [["      notice: PREVIEW_NOTICE[err.kind] ?? `試聽失敗：${source.name}`,\n", '']],
    expect: ['試聽錯誤路徑'] },
  { name: '__stats()：固定音訊段把渲染區塊算成整個（不是平均半個）', target: 'src/main.js', suites: ['smoke'], edits: [['(audio.渲染區塊ms ?? 0) / 2', '(audio.渲染區塊ms ?? 0)']],
    expect: ['估計的固定音訊段'] },
  { name: '__stats()：音訊輸出延遲不併進估計（只算內部延遲）', target: 'src/main.js', suites: ['smoke'], edits: [[' + (audio.輸出延遲ms ?? 0)) * 10) / 10', ') * 10) / 10']],
    expect: ['估計的固定音訊段'] },
];

// 瀏覽器測試：用真實 repo 的 test/browser/smoke-test.mjs 跑 dir 這份被破壞的複本（HF_ROOT）。變紅的判斷＝它印出的
// 「✗」行（check／expectTransport 的失敗項）；腳本中途丟錯（例如等不到某個狀態逾時）就以「出錯於<最後一個步驟>」當名稱。
function runSmoke(dir) {
  const r = spawnSync(process.execPath, ['--no-warnings', 'test/browser/smoke-test.mjs', '--duration', '300'], { cwd: ROOT, env: { ...process.env, HF_ROOT: dir }, encoding: 'utf8', timeout: 420000 });
  const failed = [];
  let lastStep = '';
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('▶ ')) lastStep = line.slice(2).trim();
    const m = line.match(/^ {2}✗ (.+)$/);
    if (m) failed.push(m[1]);
  }
  // 腳本中途丟錯（例如等不到某個狀態逾時）：就算前面已經有別的「✗」行也要算，否則會被別的失敗遮住
  if (/測試腳本本身出錯/.test(`${r.stdout}${r.stderr}`)) failed.push(`（smoke 測試出錯於「${lastStep}」）`);
  else if (r.status !== 0 && !failed.length) failed.push(`（smoke 測試沒通過，但沒有印出失敗項，最後的步驟「${lastStep}」）`);
  if (r.error || r.status === null) failed.push(`（smoke 沒有正常結束：${r.error?.message || r.signal}）`);
  return failed;
}

function runSuite(dir, suite) {
  if (suite === 'smoke') return runSmoke(dir);
  const r = spawnSync(process.execPath, ['--no-warnings', `test/unit/${suite}.test.mjs`], { cwd: dir, encoding: 'utf8', timeout: 180000 });
  const failed = [];
  let current = '';
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('=== ')) current = line.replace(/^=== (\[已知差異\] )?/, '').replace(/ ===\s*$/, '');
    else if (line.startsWith('❌')) failed.push(current);
  }
  if (r.error || r.status === null) failed.push(`（${suite} 沒有正常結束：${r.error?.message || r.signal}）`);
  return failed;
}

const tmp = mkdtempSync(join(tmpdir(), 'hf-mutation-'));
try {
  mkdirSync(join(tmp, 'test'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });   // 連音色庫與姿勢模型一起複製：瀏覽器測試要用
  cpSync(join(ROOT, 'index.html'), join(tmp, 'index.html'));
  cpSync(join(ROOT, 'test/unit'), join(tmp, 'test/unit'), { recursive: true });
  for (const pkg of ['spessasynth_core', 'stb-vorbis']) cpSync(join(ROOT, 'node_modules', pkg), join(tmp, 'node_modules', pkg), { recursive: true });   // oracle 測試要用 spessasynth_core；複製而不是連結，rmSync 才不會碰到真的 node_modules
  // 換行統一成 LF：不管 checkout 時是 CRLF 還是 LF，多行的破壞字串都對得上
  const originals = new Map();
  const originalOf = (target) => {
    if (!originals.has(target)) originals.set(target, readFileSync(join(ROOT, target), 'utf8').replace(/\r\n/g, '\n'));
    return originals.get(target);
  };
  let bad = 0;
  for (const m of MUTATIONS.filter((x) => x.name.includes(ONLY) && !(SKIP_SMOKE && x.suites?.includes('smoke')) && !(ONLY_SMOKE && !x.suites?.includes('smoke')))) {
    const target = m.target || TARGET;
    let mutated = originalOf(target);
    for (const [find, replace] of m.edits) {
      const count = mutated.split(find).length - 1;
      if (count !== 1) { console.error(`✗ ${m.name}：要破壞的字串在原始碼裡出現 ${count} 次（要剛好 1 次），請更新這張表：\n  ${find}`); process.exit(2); }
      mutated = mutated.replace(find, () => replace);
    }
    writeFileSync(join(tmp, target), mutated);
    const failed = (m.suites || ['scheduler']).flatMap((suite) => runSuite(tmp, suite));
    writeFileSync(join(tmp, target), originalOf(target)); // 還原，下一個變異從乾淨的複本開始
    const caught = m.expect.filter((k) => failed.some((f) => f.includes(k)));
    if (!caught.length) bad++;
    console.log(`${caught.length ? '✓' : '✗'} ${m.name}\n    指定的測試變紅：${caught.length ? caught.join('、') : '沒有！'}；全部變紅的測試 ${failed.length} 個${failed.length ? `：${failed.slice(0, 4).map((f) => f.slice(0, 40)).join('、')}${failed.length > 4 ? '…' : ''}` : ''}`);
  }
  console.log(bad ? `\n有 ${bad} 個變異沒有被指定的測試抓到` : '\n每個變異都被指定的測試抓到');
  process.exitCode = bad ? 1 : 0;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
