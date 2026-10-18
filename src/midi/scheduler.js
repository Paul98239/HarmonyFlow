// scheduler.js — 排程器：你按一下放行你的聲部（driver）的下一個起音，電腦聲部（follower）依你的速度排好時刻跟著走；單位是 MIDI tick。
// 規格與假設見 docs/design-spec.md 的 N1～N12。
// 你的音一律在 trigger() 呼叫內立即 noteOn，不經 tick、不帶時間戳（唯一例外：前奏預按，N8）；排程器時鐘（_clockMs）只在 tick()／trigger()／lift() 前進，暫停時不走。
// keyup 模式：輸入事件帶 key（鍵盤的 event.code）時，你的音按下 noteOn、放開（lift()）noteOff，不做 hold；不帶 key 的（手勢、槽位觸發）行為完全不變（N10）。
// 沒有任何 driver（沒有指派，或指派的聲部都沒有音符）＝整首自動播放：只有第 0 段，從開頭照原速放完（同一條程式路徑）。
// 每個 driver 群組（performancePlan.js）在這裡有一份執行期狀態（makeGroupState()）；現在永遠一個群組，播放頭、hold 判定、對外的 playbackRate 看第一個群組。
// 預報入口 setForecaster()：每個 tick 問預報器「你會在什麼時刻按下一個起音」，收到有效預報就段中換錨、重排還沒送出的電腦音（_applyForecast）；預設沒有預報器，行為完全不變（N2）。
// 所有合成器呼叫都經過 voices.js。

import { summarizeMs, TempoFollower, minPressIntervalSec } from './tempo.js';
import { OutputRouter, portsFor, VoiceLedger, scaledMs, EPS_MS } from './voices.js';
import { buildPlan, staffPools, sliceOfTick, switchesKit, stateEvents } from './performancePlan.js';
import { ChannelStateTracker, chaseEventsAt, DRUM_CHANNEL } from './midiParser.js';

// 演奏的對外事件：排程器在 trigger()／tick()／暫停等呼叫裡先把事件排隊，呼叫結束、合成器的呼叫都送出之後才發給訂閱者（flush），訂閱者的工作不會擋在你的音前面；訂閱者丟的例外被隔離，不影響演奏。
// 統計（遲到、早按處理、按鍵記錄）是標準訂閱者。事件種類與 payload 見 docs/design-spec.md「程式內部細節」。

// 量測／記錄各留最近一批（超過丟最舊的），避免長時間播放無限成長；事件記錄每顆音一筆，一首最密的歌整首約一萬多筆
const LATE_SAMPLES_MAX = 5000;
const PRESS_LOG_MAX = 20000;
const EVENT_LOG_MAX = 100000;
// 滿了一次丟最舊的八分之一而不是每筆 shift()：大陣列的 shift() 是 O(n)（10 萬筆實測每筆約 0.3ms），攤銷後每筆 O(1)。
function pushCapped(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - (max - (max >> 3)));
}

// 每次按鍵都會走過排隊與派送（trigger() 的執行時間直接加在按下到出聲上），所以這裡刻意寫得省：沒有人訂閱的種類不排隊、
// 佇列裡種類與 payload 交錯放（不另建 [種類, payload] 小陣列）、派送用索引迴圈（不建迭代器）。
export class PerformanceEvents {
  constructor() {
    this._subscribers = new Map();   // 事件種類 → 回呼陣列（訂閱、取消時換成新的陣列：正在派送的那一輪照舊陣列跑完，新的訂閱下一個事件才生效）
    this._queue = [];                // 排隊中、還沒發的事件：種類, payload, 種類, payload…
  }

  /** 訂閱一種事件，回傳取消訂閱的函式。同一個回呼重複訂閱只算一次。 */
  on(type, fn) {
    const subs = this._subscribers.get(type) || [];
    if (!subs.includes(fn)) this._subscribers.set(type, [...subs, fn]);
    return () => this._subscribers.set(type, (this._subscribers.get(type) || []).filter((f) => f !== fn));
  }

  /** 這種事件現在有沒有人訂閱：內容要另外組、又很頻繁的種類（control）先問，沒有人訂閱就連內容都不組。 */
  has(type) {
    const subs = this._subscribers.get(type);
    return subs !== undefined && subs.length > 0;
  }

  // 排一個事件。排隊當下沒有人訂閱的種類直接略過（演奏時只有統計訂閱 noteOn／press／chase，其餘的不排隊也不派送）。
  queue(type, payload) {
    const subs = this._subscribers.get(type);
    if (subs !== undefined && subs.length > 0) this._queue.push(type, payload);
  }

  // 把排隊的事件依序發出。先把佇列換掉再發：訂閱者裡如果又呼叫了排程器（又排了事件），那些事件下一次 flush 才發，不會亂序。
  flush() {
    if (!this._queue.length) return;
    const pending = this._queue;
    this._queue = [];
    for (let i = 0; i < pending.length; i += 2) {
      const type = pending[i], payload = pending[i + 1], subs = this._subscribers.get(type);
      for (let k = 0; k < subs.length; k++) {
        try { subs[k](payload); } catch (err) { console.error(`演奏事件「${type}」的訂閱者出錯（已略過，不影響演奏）：`, err); }
      }
    }
  }
}

/** 標準訂閱者：tick() 放出的電腦音比排好的時刻晚了多少（見 scheduler.js 的 lateStats()）。 */
export function lateStatsSubscriber(events) {
  const sub = { samples: [], stats() { return summarizeMs(this.samples); }, reset() { this.samples = []; } };
  events.on('noteOn', (e) => {
    // 只記 tick() 放出的電腦音：按鍵呼叫內同刻放出的音（時鐘就是按下的那一刻）沒有「等 tick」這回事，記進去只會把統計稀釋成 0；
    // 組裡到點放出的你的音不是電腦音。
    if (e.fromTick && e.kind === 'assist') {
      pushCapped(sub.samples, e.lateMs, LATE_SAMPLES_MAX);
    }
  });
  return sub;
}

/** 標準訂閱者：你早按時的追音、跳過與取消不了的組內音（見 scheduler.js 的 chaseStats()）。 */
export function chaseStatsSubscriber(events) {
  const zero = () => ({ presses: 0, chased: 0, skipped: 0, inFlight: 0 });
  const sub = { counts: zero(), stats() { return { ...this.counts }; }, reset() { this.counts = zero(); } };
  events.on('chase', (e) => {
    sub.counts.presses++;
    sub.counts.chased += e.chased.length;
    sub.counts.skipped += e.skipped.length;
    sub.counts.inFlight += e.inFlight;
  });
  return sub;
}

/** 標準訂閱者：每次按鍵嘗試與每次放開的記錄（見 scheduler.js 的 pressLog()、liftLog()）。 */
export function pressLogSubscriber(events) {
  const sub = {
    entries: [], lifts: [],
    log() { return this.entries.map((p) => ({ ...p })); },
    liftLog() { return this.lifts.map((p) => ({ ...p })); },
    reset() { this.entries = []; this.lifts = []; },
  };
  events.on('press', (e) => {
    pushCapped(sub.entries, { slot: e.slot, clockMs: e.clockMs, released: e.result === 'released', source: e.source, key: e.key, eventTimeMs: e.eventTimeMs, receivedMs: e.receivedMs }, PRESS_LOG_MAX);
  });
  events.on('lift', (e) => {
    pushCapped(sub.lifts, { slot: e.slot, key: e.key, clockMs: e.clockMs, closed: e.closed, eventTimeMs: e.eventTimeMs, receivedMs: e.receivedMs }, PRESS_LOG_MAX);
  });
  return sub;
}

/**
 * 錄音用的事件記錄（enableEventLog() 才掛）：錨點與換錨（速度）、放行、每顆音實際發聲的時刻、早按處理，存成可轉 JSON 的小物件，音符用 id（「軌序號:軌內序號」，同一版 parser 解析同一個檔一定相同）。
 * 實際發聲時刻（排程器時鐘）：帶時間戳的電腦音在時間戳發聲（時間戳已經過去就在送出的當下），其餘在送出的當下。
 */
export function eventLogSubscriber(events) {
  const sub = { entries: [], log() { return this.entries.map((e) => ({ ...e })); }, reset() { this.entries = []; } };
  const push = (entry) => pushCapped(sub.entries, entry, EVENT_LOG_MAX);
  const ids = (notes) => notes.map((n) => n.id ?? null);
  events.on('anchor', (e) => push({ type: 'anchor', group: e.group, slice: e.slice, clockMs: e.clockMs, scoreSec: e.scoreSec, rate: e.rate }));
  events.on('reanchor', (e) => push({ type: 'reanchor', group: e.group, slice: e.slice, clockMs: e.clockMs, scoreSec: e.scoreSec, rate: e.rate }));
  events.on('release', (e) => push({ type: 'release', group: e.group, index: e.index, ticks: e.ticks, clockMs: e.clockMs }));
  events.on('group', (e) => push({ type: 'group', group: e.group, index: e.index, merged: e.merged.map((m) => m.index), clockMs: e.clockMs }));
  events.on('autoRelease', (e) => push({ type: 'autoRelease', group: e.group, index: e.index, ticks: e.ticks, dueMs: e.dueMs, clockMs: e.clockMs }));
  events.on('noteOn', (e) => push({ type: 'noteOn', noteId: e.noteId, staffId: e.staffId, kind: e.kind, atMs: e.timed ? Math.max(e.dueMs, e.clockMs) : e.clockMs }));
  events.on('chase', (e) => push({ type: 'chase', group: e.group, ticks: e.ticks, chased: ids(e.chased), skipped: ids(e.skipped) }));
  return sub;
}

// channel 的單一來源在 voices.js；synth.js 從這裡 import（對外的匯出不變）。
export { CHANNELS_PER_PORT, DEFAULT_PORTS } from './voices.js';

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  drumChannel: DRUM_CHANNEL,
  // 預報的到達時刻跟目前預計的差不到這麼多（毫秒）就不換錨：預報器每個 tick 都會更新，免得每個 tick 都重排。應用層數字，不是規格
  forecastMinChangeMs: 10,
});

// 控制器事件 ev 在檔案裡是不是比這顆音的 note on 早：先比 tick，同一個 tick 再比軌序、軌內序（parser 的 byFileOrder，官方 timeline 的順序）；合併佇列用它決定同一個 tick 的控制器插在哪裡。
const fileBefore = (ev, note) => ev.ticks < note.startTick
  || (ev.ticks === note.startTick && (ev.trackIndex < note.trackIndex || (ev.trackIndex === note.trackIndex && ev.eventIndex < note.eventIndex)));

// 兩個依 dueMs 排好的佇列合成一個（穩定：同一個時刻 a 的在前——自動放行排在同一刻的控制器前面，先收再放）
function mergeByDue(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) out.push(j >= b.length || (i < a.length && a[i].dueMs <= b[j].dueMs) ? a[i++] : b[j++]);
  return out;
}

// 鍵盤的演奏者槽位。肢體動作的槽位是數字 1~4（演奏者 ID），鍵盤用字串，兩者不衝突，日後可以並存。
// 單一來源：midiPlayer.js 列在指派下拉的「PC 鍵盤手」、main.js 交給 keyboard.js 的觸發槽位都用它。
export const KEYBOARD_SLOT = 'kb';

// keyup 模式的發聲方式（傳給 _sound／發聲帳本的 mode）：{ key } ＝等這個鍵放開才收；LIFTED ＝ keyup 模式但不等鍵（前奏預按在入場前已放開、組裡被併入的音），照 scaledMs(檔案音長, 速度) 收、不 hold。null ＝ 非 keyup 模式（有 hold）。
const LIFTED = Object.freeze({ key: null });
const keyupOf = (key) => (key != null ? { key } : null);

// 應用層常數（不是規格）：
// 每個 tick 的時間步長上限：分頁被瀏覽器節流（背景分頁的計時器可能隔好幾秒才醒來）後恢復時，時鐘最多只前進這麼多，
// 不會一次把空窗期的音全部放出來或收掉。
const MAX_TICK_DT_MS = 100;
// lookahead：tick() 把「這麼久以內就要發聲／收音」的電腦音提早帶時間戳（eventOptions.time，AudioContext 時間）送進合成器，由 worklet 依取樣時鐘準時放，主執行緒被影像算繪卡住幾十毫秒也不會晚。
// 取捨：worklet 沒有取消已送出事件的辦法（spessasynth_core 的 eventQueue 只有 push／shift），所以這段內的音「一定會響」。50ms 是蓋過實機量到的主執行緒停頓（攝影機開著，最大約 40ms）的最小值；只用在電腦輔助聲部（N9）。
const LOOKAHEAD_MS = 50;

// 這首歌至少需要幾個 port 的 channel（不低於 DEFAULT_PORTS）：旋律 staff 每個 port 15 個、打擊 staff 每種鼓組 program 佔一個 port 的打擊槽，指派與未指派兩個池子（兩個合成器）各自算、取較大的（voices.js 的 portsFor()）。assignments 同 load()。
export function portsNeeded(score, assignments) {
  const { assigned, assist } = staffPools(score, assignments);
  return portsFor([assigned, assist].map((specs) => ({
    melodic: specs.filter((s) => !s.percussionKit).length,
    kits: new Set(specs.filter((s) => s.percussionKit).map((s) => s.program)),
  })));
}

// driver 群組的執行期狀態，每個群組一份：計畫（plan：performancePlan.js 的群組，載入後不變）、速度追蹤 tempo，以及播放狀態（_resetPlayback() 要全部重設）。
// tempo：改指派時沿用舊的（速度估計保留，見 reassign()），沒給就新建（1×）；速度區間一律換成這個群組的計畫算的。
function makeGroupState(index, plan, tempo = new TempoFollower()) {
  tempo.setBounds(plan.rateBounds);
  return {
    index,                 // 群組編號（對外事件的 group）
    plan,
    tempo,                 // 速度估計 playbackRate、停手／變速判斷、去抖（見 tempo.js）
    cursor: 0,             // 下一個還沒放行的 driver segment（按下的組頭、或組裡等著自動放行的起音）
    groupEnd: 0,           // 下一個要你按的 driver segment：還在進行的一組之後的那個（沒有組在進行時＝cursor）
    lastHead: null,        // 你上一次實際按下的起音（組頭）：估速與去抖的「上一下」
    anchor: null,          // 目前這一段的錨點 { slice, clockMs, scoreSec, rate }
    anchoredSlice: -1,     // 已經被啟動的最大段（第 0 段＝前奏，第 k+1 段由第 k 次按鍵啟動）
    // 排好時刻、還沒送出的 follower 音、被併入組裡的你的音（own）與送電腦合成器的控制器（同一個佇列）：音 { dueMs, offMs, staff, note, own }、
    // 控制器 { dueMs, ev, targets }、SysEx { dueMs, ev, sysex }，依 dueMs 排序，同一個時刻照檔案順序（見 _anchorSlice）
    pending: [],
    // 排好時刻、還沒做的「你那邊」的項目：送你的合成器的控制器 { dueMs, ev, targets } 與組裡起音的自動放行 { dueMs, ticks, autoRelease }，
    // 時鐘到了才做（不提早），依 dueMs 排序
    humanPending: [],
    ownSent: [],           // 被併入組裡、已經提早帶時間戳送出的你的音的預定時刻（你提早按下一組時統計取消不了的有幾顆）
    preludeCredit: false,  // 前奏鎖期間有人預按過（布林）：播放頭到入場點時自動放行第一個起音
    preludeSource: null,   // 預按那一下的輸入來源（自動放行時判斷分組用）
    preludeKey: null,      // 預按那一下帶的鍵（keyup 模式；沒帶 key 就是 null）
    preludeLifted: false,  // 預按的鍵在前奏結束前已經放開（入場音就照檔案長度收，不等鍵）
    stalled: false,        // 播放頭停在你的下一個起音（stall 事件只在狀態改變時發）
  };
}

export class Scheduler {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this._router = new OutputRouter(this.cfg.drumChannel);   // 兩個合成器、輸出 channel、初始音色、lookahead 時間戳：所有合成器呼叫都經過它
    this.events = new PerformanceEvents();   // 對外事件（統計、視覺化、測試工具訂閱）：trigger()／tick()／暫停等呼叫結束、合成器的呼叫都送出之後才發
    this._ledger = new VoiceLedger(this._router, this.events);   // 發聲帳本：正在響的音、hold、尾巴收尾、先進先出收音（見 voices.js）
    this._score = null;
    this._plan = buildPlan(null);   // 載入後不變的計畫（staff、driver 群組、總音數、hold 容差上限；見 performancePlan.js）
    this._groups = this._plan.groups.map((p, i) => makeGroupState(i, p));   // 每個 driver 群組的執行期狀態（現在永遠一個）
    this._forecasters = [];    // 群組編號 → 預報器（setForecaster()；預設沒有）。是設定不是播放狀態：載入、改指派、重設都不拿掉
    // 播放狀態（_resetPlayback() 要全部重設）
    this._playing = false;
    this._clockMs = 0;         // 排程器時鐘（只在 tick／trigger 前進，暫停不走）
    this._lastTickMs = null;   // null＝下一次 tick() 的 dt 是 0
    this._lateStats = lateStatsSubscriber(this.events);     // 量測：tick() 放出的電腦音比排好的時刻晚了幾毫秒（見 lateStats()）
    this._chaseStats = chaseStatsSubscriber(this.events);   // 量測：早按時的追音與跳過（見 chaseStats()）
    this._pressLog = pressLogSubscriber(this.events);       // 量測：每次按鍵嘗試（含被去抖擋掉、前奏預按），給 pressLog() 匯出、離線重放用
    this._eventLog = null;     // 錄音用的事件記錄（enableEventLog() 才建：預設不記，不增加每次按鍵的派送成本）
    this._finishSent = false;  // finish 事件已經發過
    this._sounded = new Set(); // 已經發過聲的音（每顆音恰好一次）
    this._skipped = new Set(); // 早按時整顆在你身後而跳過的電腦音（沒有發聲；跟 _sounded 合起來才是「處理過」，見 isFinished）
    this._laneTrackers = new Map();   // 早按時補控制器狀態用：輸入 channel → { tracker: 已經套用到哪裡的 ChannelStateTracker, pos }，只往後套用
  }

  setSynths(assistSynth, humanSynth) {
    this._router.setSynths(assistSynth, humanSynth);
  }

  setPortCount(ports) {
    this._router.setPortCount(ports);
  }

  /**
   * 掛上（或拿掉，傳 null）一個 driver 群組的預報器。排程器每個 tick 呼叫 forecaster.forecast(view)（view 見 _forecastView()），
   * 回傳 { atMs（預估你按下一個起音的排程器時鐘時刻）, uncertaintyMs?, source } 或 null（不預報）。預設沒有預報器：行為完全不變。
   */
  setForecaster(groupIndex, forecaster) {
    this._forecasters[groupIndex] = forecaster || undefined;
  }

  get assistSynth() { return this._router.assistSynth; }   // 電腦輔助聲部（follower）的合成器
  get humanSynth() { return this._router.humanSynth; }     // 被指派聲部（driver）的合成器
  get ports() { return this._router.ports; }               // 合成器目前有幾個 port（每個 16 個 channel）
  get playbackRate() { return this._groups[0].tempo.playbackRate; }  // 你現在的速度（樂譜秒 ÷ 真實秒，第一個群組的），命名同官方 Sequencer
  get unplacedStaffIds() { return this._plan.unplaced; }   // 輸出 channel 排不進去（旋律 staff 超過 60 個、鼓組超過 4 種）的 staff，這一輪不出聲

  _secOf(tick) {
    return this._score.midiTicksToSeconds(tick);
  }

  /**
   * 載入這首歌：建立 staff、套初始音色，把全曲的音分成 driver segment 與 follower。
   * @param {import('./midiParser.js').ParsedMidi} score  parseMidi() 的結果（不會被修改）
   * @param {Map<string,number>|[string,number][]} assignments  partId → 演奏者槽位
   */
  load(score, assignments) {
    this.stop();
    this._score = score || null;
    this._plan = buildPlan(this._score, assignments, this._router);   // 沒有樂譜時是空的計畫：tick() 空轉
    this._router.resetIfSysexSent();   // 上一首送過整體參數的 SysEx（主音量、殘響…）：兩個合成器整個重設
    this._router.clearShadow();   // 換歌（synth.js 清場過）：不知道合成器每個 channel 現在的狀態，下面全部重新建立
    this._sendInitialState();
    this._groups = this._plan.groups.map((p, i) => makeGroupState(i, p));
    this._bindLedger();
  }

  // 合成器退回這首歌在界線 boundary（tick）之前的狀態：界線之前的整體參數 SysEx → 每個輸出 channel 重設控制器（CC121 與中途改過的送回預設，voices.js 的 resetChannel()）→ 初始音色 →
  // 每條控制器軌在界線之前的狀態（chase，只送跟 shadow 不同的）。載入與重播是 tick 0 的狀態（界線 1），改指派是播放頭的位置。都在任何 noteOn 之前。
  _sendInitialState(boundary = 1) {
    for (const ev of this._plan.globalSysex) if (ev.ticks < boundary) this._router.sendSysex(ev.data);
    const staves = [...this._plan.staves.values()];
    for (const staff of staves) this._router.resetChannel(staff);
    for (const staff of staves) this._router.applyInitialPatch(staff);
    for (const lane of this._plan.lanes.values()) this._sendLaneState(lane, chaseEventsAt(lane.events, boundary));
  }

  // 把一條控制器軌的狀態（chase 序列）送到它的每個輸出 channel：只送跟 shadow 不同的值（voices.js 的 sendStateDiff）；tick 0 的
  // bank／program 不送（初始音色的事）、會讓打擊與旋律互換的 bank select 不送（見 performancePlan.js）。
  _sendLaneState(lane, chase) {
    const events = stateEvents(chase);
    for (const staff of lane.targets) this._router.sendStateDiff(staff, events.filter((ev) => !switchesKit(staff, ev)));
  }

  // 發聲帳本綁定這一輪的譜表與計畫。hold 看第一個群組的 driver 起音（現在只有一個群組；多群組時每顆音跟哪個群組 hold 是多人分工規則的一部分）
  _bindLedger() {
    this._ledger.bind({ staves: this._plan.staves, driverTicks: this._groups[0].plan.driverTicks, holdCapTicks: this._plan.holdCapTicks, secOf: (tick) => this._secOf(tick) });
  }

  /**
   * 播放到一半改指派（或整首自動播放 ↔ 有人演奏）：從目前的播放位置接續，不從頭。
   * 做法：量舊計畫的播放頭算出「界線 boundary」→ 收掉還在響的音 → 依新指派重建 staff 與計畫（同 load()）→ 起音在界線之前的音算已經過了（不重播、不補放，isFinished 才算得對）
   * → driver 游標指到第一個 >= 界線的起音 → 以現在的時鐘為界線重新錨定這一段（速度沿用）。
   * 界線：舊計畫停格在你的下一個起音上（播放頭已走到它、還沒按）→ 那個起音的 tick（它的音還沒響）；否則是播放頭所在的 tick（含）——剛按下一個起音、播放頭還在它上面時，那個 tick 的音已經響過，不能再放一次。
   * 控制器：舊的輸出 channel 先重設（踏板放開、彎音歸中央，在收音之前；channel 可能換給別的譜表用），新的輸出 channel 送初始音色與界線之前的狀態（_sendInitialState）；暫停中再依新狀態放開踏板與彎音，續播恢復。
   * 去抖與估速歷史清掉（舊間隔對不上新的 driver 序列），速度估計保留；前奏鎖依新計畫重算。播放／暫停狀態不變。切換瞬間還在響的音會被收掉、不重播；
   * lookahead 已提早送出、還沒響的電腦音取消不了，起音在界線之後的話新計畫會再放一次（最多 LOOKAHEAD_MS 內的短暫重複）。多個群組時新舊群組怎麼對應是多人分工規則的一部分。
   * @param {Map<string,number|string>|[string,number|string][]} assignments  同 load()
   */
  reassign(assignments) {
    if (!this._score) return;
    const score = this._score;
    const rate = this.playbackRate;
    const pos = this.getPositionTicks();
    const old = this._groups[0];
    const next = old.plan.driverSegs[old.cursor];
    // 播放頭是浮點數（秒 ↔ tick 換算有誤差）：比大小都留一個微小量，起音 tick 是整數
    const boundary = next && pos >= next.ticks - 1e-6 ? next.ticks : pos + 1e-6;
    for (const staff of this._plan.staves.values()) this._router.resetChannel(staff);
    this.silence();
    this._plan = buildPlan(score, assignments, this._router);
    // 新的分配從頭建立（同 load()）：synth.js 補 port 時會整個重設合成器，shadow 已經對不上
    this._router.clearShadow();
    this._sendInitialState(boundary);
    if (!this._playing) for (const staff of this._plan.staves.values()) this._router.releaseForPause(staff);
    this._laneTrackers.clear();
    // 群組狀態依新計畫重建（游標、錨點、佇列、前奏預按、停格都是新的），速度追蹤沿用舊群組的（速度估計保留）
    this._groups = this._plan.groups.map((p, i) => makeGroupState(i, p, this._groups[i]?.tempo));
    this._bindLedger();
    const g = this._groups[0];

    // 起音在界線之前的音都算已經過了（不重播、不補放）。舊佇列裡沒有需要保留的電腦音：tick／trigger 之後佇列裡的音都排在時鐘之後，
    // 起音一定在播放頭之後（界線之後）；你早按時沒輪到的音當場就追音或跳過了（見 _chaseOrSkip），不會留在佇列裡。
    this._sounded.clear();
    for (const staff of this._plan.staves.values()) {
      for (const note of staff.notes) if (note.startTick < boundary) this._sounded.add(note);
    }
    g.cursor = g.plan.driverTicks.findIndex((t) => t >= boundary);   // 第一個 >= 界線的 driver 起音；都在前面就是放完了
    if (g.cursor === -1) g.cursor = g.plan.driverTicks.length;
    g.groupEnd = g.cursor;   // 界線之後還沒發聲的組內起音依新的計畫當成一般起音
    this._skipped.clear();                                           // 界線之前的音都已重新記成處理過（上面的 _sounded）
    this._finishSent = false;
    g.tempo.forgetHistory();
    this._lastTickMs = null;
    // 這一段的編號＝已經放行的 driver 起音數；第 0 段（前奏）一律 1× 起算
    this._anchorSlice(g, g.cursor, this._clockMs, this._secOf(Math.max(0, boundary)), g.cursor === 0 ? 1 : rate, boundary);
    this.events.flush();
  }

  play() {
    this._playing = true;
    // 第一個 tick 的 dt 是 0；暫停的時間不會算進時鐘（時鐘只在 tick() 前進），所以不用重設任何排好的時刻。
    this._lastTickMs = null;
    for (const staff of this._plan.staves.values()) this._router.restoreAfterPause(staff);   // 暫停時放開的踏板、彎音恢復原狀
  }

  // 暫停：收掉還在響的音，時鐘、錨點與排好的 follower 音與控制器都保留（下次從原處繼續）。收音之前先放開踩著的延音踏板、彎音歸中央（MIDI 1.0：踏板踩著時 Note Off 與 All Notes Off 要等踏板放開才生效），續播再恢復。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    for (const g of this._groups) { g.preludeCredit = false; g.preludeKey = null; g.preludeLifted = false; } // 預按作廢：續播後要重新按
    for (const staff of this._plan.staves.values()) this._router.releaseForPause(staff);
    this.silence();
  }

  silence() {
    this._ledger.noteOffAll(this._clockMs);
    for (const staff of this._plan.staves.values()) this._router.allNotesOff(staff); // CC123 All Notes Off 當保險
    this.events.flush();
  }

  // 停止／換歌前的清場：收音＋整個播放狀態退回剛載入的樣子。
  stop() {
    this.pause();
    this._resetPlayback();
  }

  // 從頭重播：收音、退回剛載入的樣子，再接著播放（跟 stop() 共用 _resetPlayback()）；合成器的控制器也退回 tick 0 的狀態（同 load()）。
  restart() {
    this.pause();
    this._resetPlayback();
    this._router.resetIfSysexSent();   // 送過整體參數的 SysEx：兩個合成器整個重設（channel 的 CC121 管不到整體參數）
    this._sendInitialState();
    this.play();
  }

  // 把播放狀態整個退回「剛 load() 完」的樣子（stop() 與 restart() 共用）。新增狀態欄位都要在這裡重設。呼叫端負責先收音（pause()）與決定要不要接著播放。
  _resetPlayback() {
    for (const g of this._groups) {
      g.cursor = 0;
      g.groupEnd = 0;
      g.lastHead = null;
      g.anchor = null;
      g.anchoredSlice = -1;
      g.pending = [];
      g.humanPending = [];
      g.ownSent = [];
      g.preludeCredit = false;
      g.preludeSource = null;
      g.preludeKey = null;
      g.preludeLifted = false;
      g.stalled = false;
      g.tempo.reset();
    }
    this._laneTrackers.clear();
    this._router.forgetPauseSaves();   // 暫停時放開的踏板不再恢復（重播會整個重送 tick 0 的狀態）
    this._clockMs = 0;
    this._lastTickMs = null;
    this._lateStats.reset();
    this._chaseStats.reset();
    this._pressLog.reset();
    this._eventLog?.reset();
    this._finishSent = false;
    this._sounded.clear();
    this._skipped.clear();
  }

  isPlaying() { return this._playing; }

  /**
   * 唯讀快照（複本）：測試、工具與之後的視覺化用，取代直接讀私有欄位。陣列與物件都是新的；note 是樂譜裡的同一個物件（唯讀，不複製）。
   * groups 現在永遠一個；最上層的 playbackRate／rateBounds／followers／sliceFirst 是第一個群組的。
   */
  inspect() {
    const withStaffId = ({ staff, note }) => ({ staffId: staff.id, note });
    const first = this._groups[0].plan;
    return {
      loaded: !!this._score,
      playing: this._playing,
      clockMs: this._clockMs,
      playbackRate: this.playbackRate,
      rateBounds: this.rateBounds(),
      totalNotes: this._plan.totalNotes,
      holdCapTicks: this._plan.holdCapTicks,
      sounded: new Set(this._sounded),
      skipped: new Set(this._skipped),
      unplacedStaffIds: [...this._plan.unplaced],
      followers: first.followers.map(withStaffId),
      sliceFirst: [...first.sliceFirst],
      groups: this._groups.map((g) => ({
        slots: [...g.plan.slots],
        segments: g.plan.driverSegs.map((s) => ({ ticks: s.ticks, items: s.items.map(withStaffId) })),
        cursor: g.cursor,
        hasPrelude: g.plan.hasPrelude,
        preludeCredit: g.preludeCredit,
        anchor: g.anchor && { ...g.anchor },
        anchoredSlice: g.anchoredSlice,
        stallMs: this._stallMsAt(g, this._clockMs),
        // 還沒發聲的音：電腦音與組裡你的音（own）
        pending: g.pending.filter((p) => p.note).map((p) => ({ dueMs: p.dueMs, offMs: p.offMs, staffId: p.staff.id, note: p.note, own: p.own })),
        // 還沒送出的控制器（送電腦合成器的在前、送你的合成器的在後，各自依 dueMs）
        pendingControls: [...g.pending.filter((p) => !p.note), ...g.humanPending.filter((c) => c.ev)].map((c) => ({
          dueMs: c.dueMs, id: c.ev.id, ticks: c.ev.ticks, type: c.ev.type, staffIds: (c.targets ?? []).map((s) => s.id),   // SysEx 沒有目標譜表（兩個合成器都送）
        })),
        groupEnd: g.groupEnd,
        lastHead: g.lastHead,
        // 組裡還沒到的自動放行
        pendingAutoReleases: g.humanPending.filter((c) => c.autoRelease !== undefined).map((c) => ({ dueMs: c.dueMs, index: c.autoRelease, ticks: c.ticks })),
        playbackRate: g.tempo.playbackRate,
        rateBounds: { ...g.tempo.bounds },
        tempo: g.tempo.snapshot(),
      })),
      staves: [...this._plan.staves.values()].map((s) => ({
        id: s.id, partId: s.partId, slot: s.slot, kind: s.kind, channel: s.channel, program: s.program, bank: s.bank && { ...s.bank },
        init: s.init && { ...s.init }, percussionKit: s.percussionKit, baseVolume: s.baseVolume, notes: [...s.notes],
        // 正在響的音攤平成一筆一顆（同音高重疊時依先進先出的順序）
        sounding: [...s.sounding].flatMap(([pitch, queue]) => queue.map((e) => ({
          pitch, endTick: e.endTick, offMs: e.offMs, holdIdx: e.holdIdx, waitKey: e.waitKey ?? null, tailSec: e.tailSec, capped: e.capped, onTime: e.onTime, note: e.note,
        }))),
      })),
    };
  }

  /** 這個 tick 屬於第幾段（第一個 driver 起音之前＝第 0 段；第一個群組的）。唯讀查詢。呼叫的 sliceOfTick(...) 是 performancePlan.js 匯出的同名函式，類別方法名稱不會變成可直接呼叫的變數名。 */
  sliceOfTick(tick) { return sliceOfTick(this._groups[0].plan.driverTicks, tick); }

  /** 以目前的 driver 游標判斷這顆音要不要 hold（見 voices.js 的 holdOf()）。唯讀查詢。 */
  holdOf(note) { return this._ledger.holdOf(note, this._groups[0].cursor); }

  // 播完：所有音（你的與電腦的）都發過聲而且沒有還在響的音。有指派聲部但還沒按到，driver 的音沒發過，不算播完。
  isFinished() {
    if (!this._score) return false;
    if (this._sounded.size + this._skipped.size < this._plan.totalNotes) return false;   // 早按跳過的音也算處理過（沒有發聲）
    return this._ledger.isSilent();   // 沒有還在響的音
  }

  /**
   * 播放頭目前在第幾個 tick（跟 note 的 startTick／endTick 同一個座標系）：從這一段的錨點起，依速度往前走，最多走到你的
   * 下一個起音（停格等你）。看第一個群組（現在只有一個）。唯讀、無副作用。
   * @returns {number} tick（可為小數），夾在 [0, score.durationTicks]；沒有樂譜、沒有 staff、還沒開始播時 0
   */
  getPositionTicks() {
    const g = this._groups[0];
    const a = g.anchor;
    if (!this._score || this._plan.staves.size === 0 || !a) return 0;
    let sec = a.scoreSec + (Math.max(0, this._clockMs - a.clockMs) * a.rate) / 1000;
    const next = g.plan.driverSegs[g.cursor];
    if (next) sec = Math.min(sec, this._secOf(next.ticks));
    const ticks = this._score.secondsToMIDITicks(sec);
    const total = this._score.durationTicks;
    return total > 0 ? Math.min(ticks, total) : ticks;
  }

  // 排程器時鐘在 nowMs 這一刻的值：上一個 tick 的時鐘，加上之後經過的真實時間（跟 tick() 一樣有步長上限）。
  _clockAt(nowMs) {
    if (this._lastTickMs == null) return this._clockMs;
    return this._clockMs + Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));
  }

  // 群組 g 的播放頭停在你的下一個起音已經多久（毫秒）：這一段依錨點速度預計走完的時刻之後的時間；沒有下一個起音（最後一段、
  // 整首自動播放）就不會停格。
  _stallMsAt(g, clockMs) {
    const reach = this._reachClockMs(g);
    return reach === null ? 0 : Math.max(0, clockMs - reach);
  }

  // 群組 g 的播放頭依這一段的錨點速度走到你的下一個起音（預設：下一個還沒放行的；index 可以指定）的時鐘時刻；沒有錨點或沒有那個起音
  // （最後一段、整首自動播放）回 null。
  _reachClockMs(g, index = g.cursor) {
    const a = g.anchor;
    const next = g.plan.driverSegs[index];
    if (!a || !next) return null;
    return a.clockMs + ((this._secOf(next.ticks) - a.scoreSec) * 1000) / a.rate;
  }

  // 第 0 段（前奏）在第一次需要時（第一個 tick 或第一次按鍵）用目前時鐘、1× 起算。
  _ensureAnchored(g) {
    if (g.anchoredSlice < 0) this._anchorSlice(g, 0, this._clockMs, 0, 1);
  }

  // 啟動群組 g 的第 slice 段：記下錨點，把這一段的 follower 音各自排好發聲時刻（錨點時刻 ＋ 樂譜秒差 ÷ 速度）與收音時刻（發聲時刻 ＋ 音符時值 ÷ 速度；結尾對齊或橫跨你某個起音的音在發聲時另外標 hold，見 _sound），成為依 dueMs 排序的佇列。
  // 上一段沒放完的 follower 音在你按下時已追音或跳過（_chaseOrSkip）。這一段的控制器用同一條換算排時刻：送電腦合成器的插進同一個佇列——同一個 tick 插在檔案裡比它晚的第一個音之前（踏板換踩、program change 在音之前；音符之間的順序不變），送你的合成器的進 humanPending。
  // fromTick：熱切換指派從中間接續時，這一段裡 startTick 在它之前的音（與控制器）已經過了（控制器的狀態已用 chase 送），不排進佇列，不然會一次補放。
  // 近距起音分組（lastSlice > slice）：組頭 j 啟動第 j＋1 段到第 lastSlice 段（組裡每個起音之間的段，到下一個組頭為止），用同一個錨點；組裡被併入的起音的音像電腦音一樣排時刻（own：走你的合成器、帶 lookahead 時間戳，同 tick 排在電腦音前面），
  // 另外每個起音排一個自動放行（_autoRelease），跟送你的合成器的控制器依時刻排在一起。
  _anchorSlice(g, slice, clockMs, scoreSec, rate, fromTick = -Infinity, lastSlice = slice, ownMode = null) {
    g.anchor = { slice, clockMs, scoreSec, rate };
    this.events.queue('anchor', { group: g.index, slice, clockMs, scoreSec, rate });
    g.anchoredSlice = lastSlice;
    const { followers, sliceFirst, controls, controlFirst, driverSegs } = g.plan;
    const from = sliceFirst[slice], to = sliceFirst[lastSlice + 1];
    const cTo = controlFirst[lastSlice + 1];
    const dueOf = (tick) => clockMs + ((this._secOf(tick) - scoreSec) * 1000) / rate;
    const fresh = [], human = [], own = [], autos = [];
    for (let s = slice; s < lastSlice; s++) {
      own.push(...driverSegs[s].items);
      autos.push({ dueMs: dueOf(driverSegs[s].ticks), ticks: driverSegs[s].ticks, autoRelease: s });
    }
    let k = controlFirst[slice];
    const takeControl = () => {
      const { ev, human: h, assist: a, sysex } = controls[k++];
      if (ev.ticks < fromTick) return;
      const dueMs = dueOf(ev.ticks);
      if (sysex) { fresh.push({ dueMs, ev, sysex }); return; }   // 整體參數：兩個合成器同一個時間，跟電腦音一起排
      if (a.length) fresh.push({ dueMs, ev, targets: a });
      if (h.length) human.push({ dueMs, ev, targets: h });
    };
    // 電腦音與組裡你的音依起音排（同一個 tick 你的先）；控制器插在檔案裡比它晚的第一個音之前
    for (let i = from, o = 0; i < to || o < own.length; ) {
      const isOwn = o < own.length && (i >= to || own[o].note.startTick <= followers[i].note.startTick);
      const { staff, note } = isOwn ? own[o++] : followers[i++];
      while (k < cTo && fileBefore(controls[k].ev, note)) takeControl();
      if (note.startTick < fromTick) continue;
      const startSec = this._secOf(note.startTick);
      const dueMs = clockMs + ((startSec - scoreSec) * 1000) / rate;
      fresh.push({ dueMs, offMs: dueMs + scaledMs(this._secOf(note.endTick) - startSec, rate), staff, note, own: isOwn, mode: isOwn ? ownMode : null });   // 起音與音長都依你的速度等比例縮放（整份譜用你的 BPM 演奏）
    }
    while (k < cTo) takeControl();
    // 啟動新的一段時佇列一定是空的（上一段的電腦音與控制器在你按下時已經放完、追音或跳過）；依樂譜順序，dueMs 單調不減
    g.pending = fresh;
    g.humanPending = autos.length ? mergeByDue(autos, human) : human;
  }

  /**
   * 觸發一次：放行這個槽位所屬群組的下一個 driver segment，裡面的音在這次呼叫內立刻 noteOn，同時啟動它負責的那一段 follower。
   * trigger(輸入事件)（鍵盤 keyboard.js、揮手 gestureTrigger.js）與 trigger(槽位, 時刻)（測試）走同一條路徑；發聲與錨點用程式收到的時刻，事件發生的時刻（eventTimeMs）只記在按鍵事件與按鍵記錄裡。
   * @param {number|string|{ slot: number|string, source: string|null, eventTimeMs: number|null, receivedMs: number }} input
   *   演奏者槽位（要有指派聲部才有資格），或輸入事件：source＝來源（'keyboard'…）、eventTimeMs＝事件發生的時刻（鍵盤的
   *   event.timeStamp，跟 performance.now() 同一個時間原點）、receivedMs＝程式收到的時刻（performance.now()）
   * @param {number} [nowMs]  performance.now()（傳槽位時用；輸入事件用它自己的 receivedMs）
   * @returns {boolean} 有沒有放行（沒在播放、槽位沒有指派聲部、整首自動播放中、segment 都放行完了、被去抖忽略都回 false）
   */
  trigger(input, nowMs) {
    // 槽位的寫法補成輸入事件的形狀：沒有來源與事件發生的時刻（記 null）
    const ev = typeof input === 'object' && input !== null ? input : { slot: input, source: null, eventTimeMs: null, receivedMs: nowMs };
    try { return this._trigger(ev); }
    finally { this.events.flush(); }   // 對外事件在這次呼叫的合成器呼叫都送出之後才發
  }

  _trigger(ev) {
    const g = this._groups.find((x) => x.plan.slots.has(ev.slot));   // 這個槽位所屬的群組（現在只有一個）；找不到＝沒有資格觸發
    if (!this._playing || !g || g.groupEnd >= g.plan.driverSegs.length) return false;
    this._ensureAnchored(g);
    const clock = this._clockAt(ev.receivedMs);
    const j = g.groupEnd, seg = g.plan.driverSegs[j];   // 這一下要放行的起音：還在進行的一組之後的那個
    const scoreSec = this._secOf(seg.ticks);

    // 前奏鎖：別的聲部在你的第一個起音之前有音（卡農：大提琴先進、你控制後進的小提琴），前奏還沒播到入場點時按鍵不放行——放行會讓第 1 段用「現在」重新對時，前奏剩下的音就被跳過。
    // 這一下只記成「預按」（布林，按幾下都一樣），播放頭走到入場點的那一刻由 tick() 自動放行第一個起音；不動估速、去抖與錨點。
    if (j === 0 && g.plan.hasPrelude && clock < this._reachClockMs(g) - EPS_MS) {
      this._pressEvent(g, ev, clock, 'prelude');
      g.preludeCredit = true;
      g.preludeSource = ev.source ?? null;
      g.preludeKey = ev.key ?? null;
      g.preludeLifted = false;
      return false;
    }

    // 去抖（tempo.js 的 attempt()）：這一步依目前速度預估的真實長度，從你上一次按下的起音（組頭）算起（第一下沒有上一個，去抖不會用到）
    const head = g.lastHead === null ? null : this._secOf(g.plan.driverSegs[g.lastHead].ticks);
    const blocked = g.tempo.attempt(clock, head === null ? 0 : ((scoreSec - head) * 1000) / g.tempo.playbackRate);
    this._pressEvent(g, ev, clock, blocked ? 'blocked' : 'released');   // 放行必定接著 _release()
    if (blocked) return false;

    // 接受：把按下的時刻納入時鐘（tick 之間的那一小段）
    this._clockMs = clock;
    this._lastTickMs = ev.receivedMs;
    const inFlight = this._takeInFlight(g, clock);
    this._flushAutoReleases(g, clock);   // 提早按下一組：這一組還沒到的自動放行先依序做完（hold 與收音的狀態才一致）
    this._release(g, clock, ev.source ?? null, inFlight, keyupOf(ev.key));
    return true;
  }

  /**
   * 放開一個鍵（keyup 模式，鍵盤 keyup／視窗失焦補送）：登記這個鍵的你的音收在放開的時鐘時刻；組內被併入的音不受影響（照檔案走）。
   * 前奏預按的鍵在入場前放開，入場音就不等鍵。沒帶 key、沒有資格的槽位、這個鍵沒有登記的音（被去抖擋掉、已被下一次按下收掉、暫停收掉）都不做事。
   * @param {{ slot: number|string, key: string, source?: string|null, eventTimeMs?: number|null, receivedMs: number }} input  keyboard.js 的放開事件
   * @returns {boolean} 有沒有收到音
   */
  lift(input) {
    try { return this._lift(input); }
    finally { this.events.flush(); }
  }

  _lift(ev) {
    const g = this._groups.find((x) => x.plan.slots.has(ev.slot));
    if (ev.key == null || !g) return false;
    if (g.preludeCredit && g.preludeKey === ev.key) g.preludeLifted = true;
    let clock = this._clockMs;
    if (this._playing) {   // 暫停中時鐘不走（暫停已經收掉所有音，這裡也沒有東西可收）
      clock = this._clockAt(ev.receivedMs);
      this._clockMs = clock;
      this._lastTickMs = ev.receivedMs;
    }
    const closed = this._ledger.releaseKey(ev.key, clock);
    this._ledger.closeDue(clock);
    this.events.queue('lift', { group: g.index, slot: ev.slot, key: ev.key, clockMs: clock, closed, eventTimeMs: ev.eventTimeMs ?? null, receivedMs: ev.receivedMs ?? null });
    return closed > 0;
  }

  // 放行群組 g 的下一個 driver segment（按鍵 trigger() 與前奏結束時的預按放行共用），時刻 clock（排程器時鐘）；它是一組的組頭。
  // source＝這一下的輸入來源（分組的門檻，見 _groupEnd）；inFlight＝上一組已經提早送出、取消不了的你的音（統計用，見 _chaseOrSkip）。
  // keyup＝keyup 模式的發聲方式（keyupOf()／LIFTED，null＝非 keyup 模式）：組頭等鍵放開，組裡被併入的音照檔案長度，都不 hold。
  _release(g, clock, source = null, inFlight = 0, keyup = null) {
    const j = g.cursor, seg = g.plan.driverSegs[j];
    const scoreSec = this._secOf(seg.ticks);
    if (g.stalled) { g.stalled = false; this.events.queue('stall', { group: g.index, state: 'end', clockMs: clock }); }
    // 估速（停手與變速的判斷見 tempo.js）：間隔從你上一次按下的起音（組頭）算起
    g.tempo.accept(j, scoreSec, g.lastHead === null ? null : this._secOf(g.plan.driverSegs[g.lastHead].ticks), clock);
    const rate = g.tempo.playbackRate;                              // 這一下估完的速度
    const end = this._groupEnd(g, j, rate, source);                 // 按不及的近距起音併進這一組：[j＋1, end) 到點自動放行
    // 已經到期、tick 還沒來得及放的電腦音（與控制器）要在游標前進之前放：結尾對齊這個起音的才會 hold，下面的 releaseHeld 才收得到它；也要在追音之前，同譜表的新音才截得到它們
    this._emitPending(g);
    g.lastHead = j;
    g.cursor = j + 1;
    g.groupEnd = end;
    this.events.queue('release', { group: g.index, index: j, ticks: seg.ticks, clockMs: clock });
    if (end > j + 1) {
      const merged = g.plan.driverSegs.slice(j + 1, end).map((s, i) => ({ index: j + 1 + i, ticks: s.ticks }));
      this.events.queue('group', { group: g.index, index: j, ticks: seg.ticks, merged, clockMs: clock });
    }

    this._ledger.closeByTick(seg.ticks, this._clockMs);             // driver 的音 endTick ≤ 這個起音的，先收
    this._ledger.releaseHeld(j, clock, rate);                       // 結尾對齊這個起音（或更早的起音）而 hold 著的音：你的音與電腦音都在你按下的這一刻收（錨點就是按下的時刻）
    this._ledger.closeDue(this._clockMs);
    this._emitHumanPending(g, this._clockMs);
    // 早按：上一段還沒輪到的電腦音落在你這個起音的「垂直 tick」之前，不能再照原時刻放（會跟你不同步、甚至倒序）。改跳到 T_k 的垂直狀態：還該響著的追音、整顆在身後的跳過，控制器改送 T_k 之前的狀態（_chaseOrSkip）。錨點因此永遠是按下的時刻。
    this._chaseOrSkip(g, seg.ticks, scoreSec, clock, inFlight);
    this._anchorSlice(g, j + 1, clock, scoreSec, rate, -Infinity, end, keyup && LIFTED);   // 這一段（含組裡起音之間的段）的錨點、電腦音、組裡的音與控制器（佇列此時是空的）
    this._emitHumanPending(g, clock);                               // 你起音那個 tick 上、送你的合成器的控制器（program change 等）在你的音之前
    for (const { staff, note } of seg.items) this._sound(g, staff, note, clock + scaledMs(this._secOf(note.endTick) - scoreSec, rate), clock, false, false, keyup);
    this._emitPending(g);                                           // 同 tick 的 follower 音與控制器（dueMs ＝ 這一刻）跟你的音同刻
    this._emitHumanPending(g, this._clockMs);
    this._ledger.closeDue(this._clockMs);                           // 零長度的音
  }

  // 近距起音分組：從組頭 j 往後串，相鄰兩個起音的樂譜間隔依目前速度換成真實時間，比這個輸入來源的最短間隔還短（按不及；鍵盤 0.06 秒，tempo.js 的 minPressIntervalSec）就併進來，一直串到不按不及為止（沒有長度上限）。
  // 彈得慢間隔被拉開、併的就少，彈得快併的就多。回傳這一組的結束（不含）。
  _groupEnd(g, j, rate, source) {
    const segs = g.plan.driverSegs, minSec = minPressIntervalSec(source);
    let m = j + 1;
    while (m < segs.length && (this._secOf(segs[m].ticks) - this._secOf(segs[m - 1].ticks)) / rate < minSec) m++;
    return m;
  }

  // 組裡被併入的起音 s 到了它排定的時刻 atMs：做兩件跟「按下它」一樣的事——收掉你的聲部裡 endTick ≤ 它的音、放行 hold 著等它
  // （或更早起音）的音（收在 atMs ＋ 剩餘長度 ÷ 速度）。不動估速與去抖：它們只看你實際的按鍵。
  _autoRelease(g, s, atMs) {
    const ticks = g.plan.driverSegs[s].ticks;
    g.cursor = s + 1;
    this._ledger.closeByTick(ticks, this._clockMs);
    this._ledger.releaseHeld(s, atMs, g.tempo.playbackRate);
    this.events.queue('autoRelease', { group: g.index, index: s, ticks, dueMs: atMs, clockMs: this._clockMs });
  }

  // 你提早按下一組時，這一組還沒到的自動放行依序在按下的這一刻做完（之後的放行與垂直切片才對得上 hold 與收音的狀態）。
  _flushAutoReleases(g, clock) {
    if (g.cursor >= g.groupEnd) return;
    const rest = [];
    for (const item of g.humanPending) {
      if (item.autoRelease !== undefined) this._autoRelease(g, item.autoRelease, clock);
      else rest.push(item);
    }
    g.humanPending = rest;
  }

  // 你按下時，組裡已經提早帶時間戳送出、還沒到時刻的你的音有幾顆（取消不了，會在按下之後 ≤ LOOKAHEAD_MS 響；統計用），並清空記錄
  _takeInFlight(g, clock) {
    let n = 0;
    for (const dueMs of g.ownSent) if (dueMs > clock + EPS_MS) n++;
    g.ownSent = [];
    return n;
  }

  // 早按時的垂直切片（N2；Antescofo 的 @tight＋@local、DAW 的 Chase Events）：你按下 driver 起音 T_k（ticks）時，佇列裡還沒輪到、起音在 T_k 之前的電腦音，endTick > T_k 的追音（現在發聲，長度＝檔案裡 T_k 到結尾的剩餘長度 ÷ 速度，hold 照舊，見 _sound），
  // endTick ≤ T_k 的整顆在你身後，跳過（記進 _skipped，isFinished 才算得對）。佇列依 dueMs 排序，同 tick 的音排在一起，所以追音順序就是樂譜順序。
  // 還沒送出的控制器不逐一重播：先把控制器軌帶到 T_k 之前的狀態（_chaseLane，在追音之前），還沒送出的整體參數 SysEx 依序馬上送（N12）。組裡被併入、還沒送出的你的音（own）同理；已經提早送出的取消不了（inFlight，記在 chase 事件裡）。
  _chaseOrSkip(g, ticks, scoreSec, clock, inFlight = 0) {
    const left = g.pending, leftHuman = g.humanPending;
    if (!left.length && !leftHuman.length && !inFlight) return;
    g.pending = [];
    g.humanPending = [];
    let lanes = null;   // 有還沒送出的控制器的輸入 channel
    const notes = [];
    for (const p of left) {
      if (p.note) notes.push(p);
      else if (p.sysex) this._router.sendSysex(p.ev.data);
      else (lanes ??= new Set()).add(p.ev.channel);
    }
    for (const c of leftHuman) if (c.ev) (lanes ??= new Set()).add(c.ev.channel);   // 自動放行已經在按下時做完了（_flushAutoReleases）
    if (lanes) for (const channel of lanes) this._chaseLane(channel, ticks);
    if (!notes.length && !inFlight) return;
    const chased = [], skipped = [];
    for (const p of notes) {
      if (p.note.endTick > ticks) {
        chased.push(p.note);
        this._sound(g, p.staff, p.note, clock + scaledMs(this._secOf(p.note.endTick) - scoreSec, g.tempo.playbackRate), clock, false, false, p.mode);
      } else {
        skipped.push(p.note);
        this._skipped.add(p.note);
      }
    }
    this.events.queue('chase', { group: g.index, ticks, chased, skipped, inFlight });
  }

  // 把一條控制器軌（輸入 channel）的輸出 channel 帶到 tick 之前的狀態：漸進的 ChannelStateTracker 往後套用到 tick（不重算整條；
  // 播放中 tick 只會往後），再送它的 chase 序列，只送跟 shadow 不同的值（_sendLaneState）。
  _chaseLane(channel, ticks) {
    const lane = this._plan.lanes.get(channel);
    if (!lane) return;
    let t = this._laneTrackers.get(channel);
    if (!t) this._laneTrackers.set(channel, (t = { tracker: new ChannelStateTracker(), pos: 0 }));
    const { events } = lane;
    while (t.pos < events.length && events[t.pos].ticks < ticks) t.tracker.apply(events[t.pos++]);
    this._sendLaneState(lane, t.tracker.chase());
  }

  // 讓一顆音發聲：記進 _sounded（每顆音恰好一次），交給發聲帳本 noteOn 並登記（hold、尾巴收尾、先進先出見 voices.js 的 sound()；hold 看群組 g 的游標、音長看 g 的速度）。
  // dueMs＝預定發聲的時鐘時刻（你的音就是按下的那一刻）；fromTick＝由 tick() 放出（遲到統計只算這種）；timed＝你的合成器也照 lookahead 帶時間戳（組裡被併入的音）。
  // mode＝keyup 模式的發聲方式（keyupOf()／LIFTED，undefined／null＝非 keyup 模式）。
  _sound(g, staff, note, offMs, dueMs, fromTick = false, timed = false, mode = null) {
    this._sounded.add(note);
    this._ledger.sound(staff, note, offMs, dueMs, { cursor: g.cursor, rate: g.tempo.playbackRate, fromTick, clockMs: this._clockMs, timed, mode: mode ?? null });
  }

  // 群組 g 排好時刻已到的 follower 音、組裡你的音與送電腦合成器的控制器依序送出（佇列已依 dueMs 排序）。fromTick＝由 tick() 呼叫
  // （遲到統計只算這種，見 _sound）。組裡你的音照 lookahead 帶時間戳（主執行緒卡住也不會擠在一起），提早送出的記下來（_takeInFlight）。
  _emitPending(g, limitMs = this._clockMs, fromTick = false) {
    let n = 0;
    while (n < g.pending.length && g.pending[n].dueMs <= limitMs + EPS_MS) {
      const p = g.pending[n++];
      if (p.note) {
        this._sound(g, p.staff, p.note, p.offMs, p.dueMs, fromTick, p.own, p.mode);
        if (p.own && p.dueMs > this._clockMs + EPS_MS) g.ownSent.push(p.dueMs);
      } else if (p.sysex) this._router.sendSysex(p.ev.data, this._router.stampTime(p.dueMs));
      else this._sendControl(p);
    }
    if (n) g.pending.splice(0, n);
  }

  // 群組 g「你那邊」時刻已到（≤ limitMs）的項目依序做：送你的合成器的控制器、組裡起音的自動放行。不提早（沒有 lookahead）：limitMs
  // 一律是時鐘。
  _emitHumanPending(g, limitMs) {
    let n = 0;
    while (n < g.humanPending.length && g.humanPending[n].dueMs <= limitMs + EPS_MS) {
      const item = g.humanPending[n++];
      if (item.autoRelease !== undefined) this._autoRelease(g, item.autoRelease, item.dueMs);
      else this._sendControl(item);
    }
    if (n) g.humanPending.splice(0, n);
  }

  // 送出一個控制器到它的每個輸出 channel：tick() 裡送電腦合成器的帶 lookahead 時間戳（stamp；你的合成器、按鍵呼叫裡的都立刻處理）。
  _sendControl({ dueMs, ev, targets }) {
    for (const staff of targets) this._router.sendChannelEvent(staff, ev, this._router.stamp(staff, dueMs));
    if (this.events.has('control')) {
      this.events.queue('control', { id: ev.id, ticks: ev.ticks, type: ev.type, outputs: targets.map((s) => ({ kind: s.kind, channel: s.channel })), dueMs, clockMs: this._clockMs });
    }
  }

  /**
   * 量測：tick() 放出的電腦音比排好的時刻晚了多少（排程器時鐘 − dueMs，毫秒）的統計：tick 間隔（12ms 計時器被主執行緒的影像算繪／姿勢推論延後）造成的遲到，不含 AudioWorklet 的一個 render quantum（約 2.7ms）與瀏覽器輸出延遲。重設（stop／restart／換歌）時清空。
   */
  lateStats() { return this._lateStats.stats(); }

  /**
   * 量測：你早按時（按下那一刻上一段還有電腦音或組內音沒輪到）的處理結果：presses＝有這種情況的按鍵數、chased＝追音（T_k 還該響著、
   * 按下時補發）的顆數、skipped＝跳過（整顆在你身後）的顆數、inFlight＝組裡已經提早送出、取消不了的你的音的顆數。重設（stop／restart／
   * 換歌）時清空。
   */
  chaseStats() { return this._chaseStats.stats(); }

  /** 量測：這首歌目前的速度區間 { lo, hi }（第一個群組的，rateBoundsFor 依你的聲部起音間隔算出的複本）。 */
  rateBounds() { return { ...this._groups[0].tempo.bounds }; }

  // 按鍵嘗試的事件（按鍵記錄 pressLog() 是它的訂閱者）。result：'released' 放行、'blocked' 被去抖擋掉、'prelude' 前奏中的預按。
  // ev 是輸入事件（見 trigger()）：來源與事件發生的時刻原樣記下（用槽位觸發時是 null）。
  _pressEvent(g, ev, clockMs, result) {
    this.events.queue('press', { group: g.index, slot: ev.slot, source: ev.source ?? null, key: ev.key ?? null, result, clockMs, eventTimeMs: ev.eventTimeMs ?? null, receivedMs: ev.receivedMs ?? null });
  }

  /** 量測：這一輪每次按鍵嘗試的記錄（複本）。clockMs 是排程器時鐘（暫停不走）；重設（stop／restart／換歌）時清空。 */
  pressLog() { return this._pressLog.log(); }

  /** 量測：這一輪每次放開的記錄（keyup 模式；複本）：槽位、鍵、排程器時鐘、收了幾顆音與兩個時刻。重設時清空。 */
  liftLog() { return this._pressLog.liftLog(); }

  /** 開啟錄音用的事件記錄（錨點、換錨、放行、每顆音實際發聲的時刻、早按處理；見 scheduler.js 的 eventLogSubscriber）。 */
  enableEventLog() {
    if (!this._eventLog) this._eventLog = eventLogSubscriber(this.events);
  }

  /** 這一輪的事件記錄（複本；沒開就是空陣列）。重設（stop／restart／換歌）時清空。 */
  eventLog() { return this._eventLog ? this._eventLog.log() : []; }

  /**
   * 由 midiPlayer.js 的排程 tick（~12ms）每次呼叫：推進時鐘、放出到時間的 follower 音、收掉到期的音。
   * driver 的起音永遠不在這裡放出，只來自 trigger()。
   * @param {number} nowMs  performance.now()
   * @param {number} [audioNow]  AudioContext 的目前時間（秒）。有給就啟用 lookahead：LOOKAHEAD_MS 以內要發聲／收音的電腦音
   *        提早帶時間戳送出；沒給（AudioContext 還沒就緒）就照到期時刻才發聲、不帶時間戳。
   */
  tick(nowMs, audioNow) {
    if (!this._playing || !this._score) return; // 沒有樂譜（load(null)）時空轉
    for (const g of this._groups) this._ensureAnchored(g);
    const dt = this._lastTickMs == null ? 0 : Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));
    this._lastTickMs = nowMs;
    this._clockMs += dt;
    const timed = Number.isFinite(audioNow);
    this._router.setAudioBase(timed ? { audio: audioNow, clock: this._clockMs } : null);  // 只在這個 tick 內有效：按鍵、暫停的呼叫一律立刻處理
    try {
      this._askForecasters();   // 先換錨再收音發聲：這個 tick 放出的電腦音就照新的速度
      this._tickBody(timed ? this._clockMs + LOOKAHEAD_MS : this._clockMs);
      this._queueStateEvents();
    } finally {
      this._router.setAudioBase(null);
      this.events.flush();   // 對外事件在這個 tick 的合成器呼叫都送出之後才發
    }
  }

  // 狀態改變的事件，只在改變的那一刻發一次：各群組的播放頭停在你的下一個起音（停格開始；你按下去時 _release() 發「結束」）、
  // 所有音都發過聲而且收完（播完，整首一次）。
  _queueStateEvents() {
    for (const g of this._groups) {
      const reach = this._reachClockMs(g);
      if (!g.stalled && reach !== null && this._clockMs >= reach - EPS_MS) {
        g.stalled = true;
        this.events.queue('stall', { group: g.index, state: 'start', clockMs: reach });
      }
    }
    if (!this._finishSent && this.isFinished()) {
      this._finishSent = true;
      this.events.queue('finish', { clockMs: this._clockMs });
    }
  }

  // 問每個有掛預報器的群組（沒有預報器的群組什麼都不做）
  _askForecasters() {
    for (const g of this._groups) {
      const f = this._forecasters[g.index];
      if (f) this._applyForecast(g, f.forecast(this._forecastView(g)));
    }
  }

  // 給預報器看的唯讀資料：游標（下一個要你按的起音：還在進行的一組之後的那個）、時鐘、目前的錨點（可能已經換過錨）、這一段起點
  // （你上一次按的起音；改指派之後還沒按過就是前一個起音）與下一個要按的起音的樂譜秒（前奏時起點是 null、最後一段時下一個起音是
  // null）、速度追蹤目前的速度與區間。
  _forecastView(g) {
    const segs = g.plan.driverSegs, next = g.groupEnd, from = g.lastHead ?? next - 1;
    return {
      group: g.index, cursor: next, clockMs: this._clockMs, anchor: g.anchor && { ...g.anchor },
      segmentStartSec: from >= 0 ? this._secOf(segs[from].ticks) : null,
      nextOnsetSec: next < segs.length ? this._secOf(segs[next].ticks) : null,
      rate: g.tempo.playbackRate, rateBounds: { ...g.tempo.bounds },
    };
  }

  // 段中換錨（N2「預報入口」）：預報說你會在 f.atMs 按下一個起音，條件符合時以（現在, 此刻的樂譜位置 p, r′）為新錨點，把佇列裡還沒送出、樂譜位置在 p 之後的電腦音與控制器照 r′ 重排時刻；同 tick 的、lookahead 已送出的、已經在響的、p 之前已過期的都碰不到。
  // 近距起音分組進行中時，「下一個起音」是下一個要你按的組頭（組裡的起音到點自動放行，一起依新速度重排）。
  _applyForecast(g, f) {
    if (!f) return;
    const now = this._clockMs, j = g.groupEnd, next = g.plan.driverSegs[j], a = g.anchor;
    const reach = this._reachClockMs(g, j);
    const applied = j >= 1 && !!next && !!a && reach !== null && now < reach && f.atMs > now
      && Math.abs(f.atMs - reach) >= this.cfg.forecastMinChangeMs;
    this.events.queue('forecast', { group: g.index, index: j, clockMs: now, atMs: f.atMs, uncertaintyMs: f.uncertaintyMs ?? null, source: f.source ?? null, applied });
    if (!applied) return;
    const p = a.scoreSec + ((now - a.clockMs) * a.rate) / 1000;   // 此刻的樂譜位置（還沒走到下一個起音：now < reach）
    const { lo, hi } = g.tempo.bounds;
    const rate = Math.min(hi, Math.max(lo, ((this._secOf(next.ticks) - p) * 1000) / (f.atMs - now)));
    g.anchor = { slice: a.slice, clockMs: now, scoreSec: p, rate };
    let retimed = 0;
    // 控制器、組裡你的音與自動放行（兩個佇列都是）跟電腦音一起重排，時刻的換算相同
    for (const q of [...g.pending, ...g.humanPending]) {
      const startSec = this._secOf(q.note ? q.note.startTick : q.ev ? q.ev.ticks : q.ticks);
      if (startSec <= p) continue;                                    // 已經過期、只是還沒放出：照原時刻（馬上）放
      q.dueMs = now + ((startSec - p) * 1000) / rate;
      if (!q.note) continue;
      q.offMs = q.dueMs + scaledMs(this._secOf(q.note.endTick) - startSec, rate);
      retimed++;
    }
    this.events.queue('reanchor', { group: g.index, slice: a.slice, clockMs: now, scoreSec: p, rate, retimed });
  }

  _tickBody(horizonMs) {
    this._ledger.closeDue(this._clockMs, horizonMs);     // 先收再放：到期的舊音在同一個 tick 要發聲的新音之前關掉（同音高的相連音才不會被連帶關掉）
    for (const g of this._groups) this._emitPending(g, horizonMs, true);
    for (const g of this._groups) this._emitHumanPending(g, this._clockMs);    // 送你的合成器的控制器、組裡起音的自動放行：不提早
    this._ledger.closeDue(this._clockMs, horizonMs);     // 剛發聲就到期的短音
    // 前奏鎖期間有人預按過：播放頭到了入場點就放行第一個起音。放行時刻取「剛好到達」的那一刻（不是這個 tick 的時鐘），第 1 段的錨點因此接在前奏的 1× 時間軸上；落在這一刻到現在之間的電腦音由 _release() 裡的 _emitPending() 補放。
    for (const g of this._groups) {
      if (!g.preludeCredit || g.cursor !== 0) continue;
      const reach = this._reachClockMs(g);
      if (reach !== null && this._clockMs >= reach - EPS_MS) {
        // keyup 模式的預按：入場時鍵還按著就等 keyup，入場前已放開就照檔案長度收
        const keyup = g.preludeKey != null ? (g.preludeLifted ? LIFTED : keyupOf(g.preludeKey)) : null;
        g.preludeCredit = false; g.preludeKey = null; g.preludeLifted = false;
        this._release(g, reach, g.preludeSource, 0, keyup);
      }
    }
  }
}
