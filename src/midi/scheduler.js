// scheduler.js — 排程器：每位演奏者按一下放行他的聲部（driver）的下一個起音；伴奏（follower）跟著帶頭的人的速度排好時刻；單位是 MIDI tick。
// 規格與假設見 docs/design-spec.md 的 N1～N12。
// 你的音一律在 trigger() 呼叫內立即 noteOn，不經 tick、不帶時間戳（例外：被鎖成預按的那一下——前奏鎖 N8、休止符鎖、揮手超前鎖——到點由 tick() 放出）；排程器時鐘（_clockMs）只在 tick()／trigger()／lift() 前進，暫停時不走。
// keyup 模式：輸入事件帶 key（鍵盤的 event.code）時，你的音按下 noteOn、放開（lift()）noteOff，不做 hold；不帶 key 的（手勢、槽位觸發）行為完全不變（N10）。
// 沒有任何 driver（沒有指派，或指派的聲部都沒有音符）＝整首自動播放：只有第 0 段，從開頭照原速放完（同一條程式路徑）。
// 每位演奏者（performancePlan.js 的 performers）在這裡有一份執行期狀態（makePerformerState()），去抖、估速、游標各自一份；伴奏一份合奏狀態（makeEnsemble()），
// 只在帶頭的人觸發時重新對時（合奏位置、hold 判定、對外的 playbackRate 看帶頭的人）。
// 預報入口 setForecaster()：每個 tick 問預報器「你會在什麼時刻按下一個起音」，收到有效預報就段中換錨、重排還沒送出的電腦音（_applyForecast）；預設沒有預報器，行為完全不變（N2）。
// 所有合成器呼叫都經過 voices.js。

import { summarizeMs, TempoFollower, minPressIntervalSec, maxGroupSpanSec } from './tempo.js';
import { OutputRouter, portsFor, VoiceLedger, scaledMs, EPS_MS } from './voices.js';
import { buildPlan, staffPools, sliceOfTick, switchesKit, stateEvents, emptyPerformerPlan, slotOrder } from './performancePlan.js';
import { ChannelStateTracker, chaseEventsAt, DRUM_CHANNEL } from './midiParser.js';
import { ENSEMBLE, threshold, beatMs, isActive, Roster, pickLeader, classifyOffset, stage1GraceMs, shouldSubstitute, extendSteadyRun, isSteadyRun } from './ensemble.js';

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
    pushCapped(sub.entries, { slot: e.slot, clockMs: e.clockMs, released: e.result === 'released', result: e.result, jumped: e.jumped, source: e.source, key: e.key, eventTimeMs: e.eventTimeMs, receivedMs: e.receivedMs }, PRESS_LOG_MAX);
  });
  events.on('lift', (e) => {
    pushCapped(sub.lifts, { slot: e.slot, key: e.key, clockMs: e.clockMs, closed: e.closed, eventTimeMs: e.eventTimeMs, receivedMs: e.receivedMs }, PRESS_LOG_MAX);
  });
  return sub;
}

/**
 * 錄音用的事件記錄（enableEventLog() 才掛）：錨點與換錨（速度）、放行、每顆音實際發聲與收音的時刻、早按處理，存成可轉 JSON 的小物件，音符用 id（「軌序號:軌內序號」，同一版 parser 解析同一個檔一定相同）。
 * 實際發聲時刻（排程器時鐘）：帶時間戳的電腦音在時間戳發聲（時間戳已經過去就在送出的當下），其餘在送出的當下；收音時刻同理（沒有排定時刻的收音，例如 hold 著的音被暫停收掉，記送出的當下）。
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
  events.on('noteOff', (e) => push({ type: 'noteOff', noteId: e.noteId, staffId: e.staffId, kind: e.kind, atMs: e.timed && Number.isFinite(e.offMs) ? Math.max(e.offMs, e.clockMs) : e.clockMs }));
  events.on('chase', (e) => push({ type: 'chase', group: e.group, ticks: e.ticks, chased: ids(e.chased), skipped: ids(e.skipped) }));
  events.on('leader', (e) => push({ type: 'leader', from: e.from, to: e.to, reason: e.reason, clockMs: e.clockMs }));
  events.on('performer', (e) => push({ type: 'performer', slot: e.slot, from: e.from, to: e.to, reason: e.reason, clockMs: e.clockMs }));
  events.on('presence', (e) => push({ type: 'presence', slots: e.slots, clockMs: e.clockMs, receivedMs: e.receivedMs }));
  return sub;
}

// channel 的單一來源在 voices.js；synth.js 從這裡 import（對外的匯出不變）。
export { CHANNELS_PER_PORT, DEFAULT_PORTS } from './voices.js';

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  drumChannel: DRUM_CHANNEL,
  // 預報的到達時刻跟目前預計的差不到這麼多（毫秒）就不換錨：預報器每個 tick 都會更新，免得每個 tick 都重排。應用層數字，不是規格
  forecastMinChangeMs: 10,
  stage2K: ENSEMBLE.STAGE2_K,   // 第二段防呆：錯過幾下才代打（ensemble.js 的 shouldSubstitute；可以傳別的值試）
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

// 依 tick 遞增的陣列裡第一個 ≥ x 的位置（二分搜尋 lower bound）；x 可以是 ±Infinity
function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// 第一個 > x 的位置（upper bound）
function upperBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

// 佇列項目在樂譜上的位置：音看起音、控制器看 ev、組內自動放行看它的起音
const itemTick = (it) => (it.note ? it.note.startTick : it.ev ? it.ev.ticks : it.ticks);
// 幾個佇列攤平成建批次時的順序（seq）：早按時的追音與跳過照這個順序處理，跟以前單一佇列的順序相同
const bySeq = (...queues) => queues.flat().sort((x, y) => x.seq - y.seq);

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
export const LOOKAHEAD_MS = 50;   // main.js 的 __latency() 拿它當排程 tick 間隔的門檻

// 這首歌至少需要幾個 port 的 channel（不低於 DEFAULT_PORTS）：旋律 staff 每個 port 15 個、打擊 staff 每種鼓組 program 佔一個 port 的打擊槽，指派與未指派兩個池子（兩個合成器）各自算、取較大的（voices.js 的 portsFor()）。assignments 同 load()。
export function portsNeeded(score, assignments) {
  const { assigned, assist } = staffPools(score, assignments);
  return portsFor([assigned, assist].map((specs) => ({
    melodic: specs.filter((s) => !s.percussionKit).length,
    kits: new Set(specs.filter((s) => s.percussionKit).map((s) => s.program)),
  })));
}

// 演奏者的執行期狀態，每人一份：計畫（plan：performancePlan.js 的 performers，載入後不變）、速度追蹤 tempo，以及播放狀態（_resetPlayback() 要全部重設）。
// tempo：改指派時同一槽位沿用舊的（速度估計保留，見 reassign()），沒給就新建（1×）；速度區間一律換成他的計畫算的。
function makePerformerState(index, plan, tempo = new TempoFollower()) {
  tempo.setBounds(plan.rateBounds);
  return {
    index,                 // 演奏者序號（對外事件的 group；依指派下拉順序）
    slot: plan.slot,       // 槽位（'kb'、1~4；整首自動播放的空計畫是 null）
    plan,
    tempo,                 // 速度估計 playbackRate、停手／變速判斷、去抖（見 tempo.js）
    cursor: 0,             // 下一個還沒放行的起音（按下的組頭、或組裡等著自動放行的起音）
    groupEnd: 0,           // 下一個要他按的起音：還在進行的一組之後的那個（沒有組在進行時＝cursor）
    lastHead: null,        // 他上一次實際按下的起音（組頭）：估速與去抖的「上一下」
    anchor: null,          // 他自己這一段的錨點 { slice, clockMs, scoreSec, rate }；null＝還沒開始（他的控制器跟著合奏走）
    anchoredSlice: -1,     // 已經被啟動的最大段（第 0 段＝前奏，第 k+1 段由第 k 次按鍵啟動）
    // 排好時刻、還沒送出的組裡被併入的音（own，帶 lookahead 時間戳走他的合成器）：{ dueMs, offMs, staff, note, own, mode, owner, seq }，依 dueMs 排序
    timed: [],
    // 排好時刻、還沒做的「他那邊」的項目：送他的合成器的控制器 { dueMs, ev, targets, seq } 與組裡起音的自動放行 { dueMs, ticks, autoRelease, owner, seq }，
    // 時鐘到了才做（不提早），依 dueMs 排序
    clock: [],
    ownSent: [],           // 被併入組裡、已經提早帶時間戳送出的他的音的預定時刻（他提早按下一組時統計取消不了的有幾顆）
    // 預按（布林，鎖住期間按幾下都只算一下）：{ kind, key, lifted, source }。kind：'prelude'＝前奏鎖（合奏走到他的入場點時放出第一個起音）、
    // 'rest'＝休止符鎖（合奏走到他休止後的起音時放出）、'ahead'＝揮手超前鎖（合奏走到只差 1/2 拍時放出）；key＝那一下帶的鍵（keyup 模式）、lifted＝放出前鍵已經放開（照檔案長度收、不等鍵）、source＝輸入來源（分組用）
    credit: null,
    zone: 'sync',          // 他上一下的區間（ensemble.js 的 classifyOffset）
    xMs: null,             // 他上一下的相對時間 x（ms，正＝超前）
    offRun: { sign: 0, count: 0 },   // 連續幾下同方向偏離或脫隊（sign：+1 超前、-1 落後）
    stalled: false,        // 他的播放頭停在他的下一個起音（stall 事件只在狀態改變時發）
    // 'ok'｜'trouble'（帶頭時出狀況，或代打剛交還：恢復正常才能再帶頭，見 _trackRecovery）｜'substitute'（第二段防呆：電腦代打中）。彈完不另存狀態，看游標
    status: 'ok',
    statusReason: null,    // 狀態最近一次改變的原因（performer 事件的 reason）
    recoverCount: 0,       // 多數決出狀況之後連續幾下同步（ENSEMBLE.RECOVER_PERSIST 下恢復正常）
    steady: null,          // 停住、代打回來之後穩定的一串（ensemble.js 的 extendSteadyRun）
    lastTriggerMs: -Infinity,   // 他上一次觸發（含被去抖擋掉、預按）的動作時刻（排程器時鐘）：判斷「正在彈」
    lastSource: null,      // 他上一次觸發的輸入來源（算錯過幾下時照它分組）
    absentSinceMs: null,   // 揮手的人從什麼時候開始不在鏡頭裡（排程器時鐘；在場或鍵盤是 null，見 setPresence()）
    missStartMs: null,     // 從沒觸發過的人：合奏開始走過他的起音的時鐘（第二段防呆「離上一下多久」從這裡算）
    restEndMs: null,       // 他第一個錯過的那一下前面是長休止時，合奏走到那一下的時鐘（第二段防呆不算他的休止，見 _restEndMs）
    lastAutoMs: null,      // 他上一個起音被自動放行的時鐘（代打交還時比哪個起音最近）
  };
}

// 合奏（伴奏）的執行期狀態：帶頭的人、合奏錨點（anchor 跟帶頭的人觸發時的錨點是同一個物件）、合奏走到過的最遠位置
// （floorTick：合奏位置不倒退，換人或帶頭的人落後時用）、佇列（timed：伴奏的音、送電腦合成器的控制器、整體參數 SysEx；clock：還沒開始彈的演奏者的控制器，時鐘到了才送）。
const makeEnsemble = () => ({ leader: null, anchor: null, floorTick: -Infinity, timed: [], clock: [] });

export class Scheduler {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this._router = new OutputRouter(this.cfg.drumChannel);   // 兩個合成器、輸出 channel、初始音色、lookahead 時間戳：所有合成器呼叫都經過它
    this.events = new PerformanceEvents();   // 對外事件（統計、視覺化、測試工具訂閱）：trigger()／tick()／暫停等呼叫結束、合成器的呼叫都送出之後才發
    this._ledger = new VoiceLedger(this._router, this.events);   // 發聲帳本：正在響的音、hold、尾巴收尾、先進先出收音（見 voices.js）
    this._score = null;
    this._plan = buildPlan(null);   // 載入後不變的計畫（staff、每位演奏者、伴奏、總音數、hold 容差上限；見 performancePlan.js）
    this._setPerformers();          // 每位演奏者的執行期狀態（_performers、依槽位查的 _bySlot）
    this._ensemble = makeEnsemble();
    this._roster = new Roster();   // 名單：誰先開始演奏（ensemble.js）
    this._seq = 0;             // 佇列項目的建批次順序（合併各佇列送出時，同一刻照這個順序）
    this._resumeClockMs = 0;   // 最近一次 play() 的時鐘：動作時刻換成時鐘時不早於它（跨過暫停的不算）
    this._forecasters = [];    // 演奏者序號 → 預報器（setForecaster()；預設沒有）。是設定不是播放狀態：載入、改指派、重設都不拿掉
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
   * 掛上（或拿掉，傳 null）一位演奏者（序號 index，依指派下拉順序）的預報器。排程器每個 tick 呼叫 forecaster.forecast(view)（view 見 _forecastView()），
   * 回傳 { atMs（預估他按下一個起音的排程器時鐘時刻）, uncertaintyMs?, source } 或 null（不預報）。預設沒有預報器：行為完全不變。
   */
  setForecaster(index, forecaster) {
    this._forecasters[index] = forecaster || undefined;
  }

  get assistSynth() { return this._router.assistSynth; }   // 電腦輔助聲部（follower）的合成器
  get humanSynth() { return this._router.humanSynth; }     // 被指派聲部（driver）的合成器
  get ports() { return this._router.ports; }               // 合成器目前有幾個 port（每個 16 個 channel）
  get playbackRate() { return this._holdOwner().tempo.playbackRate; }  // 合奏現在的速度（樂譜秒 ÷ 真實秒，帶頭的人的），命名同官方 Sequencer
  get unplacedStaffIds() { return this._plan.unplaced; }   // 輸出 channel 排不進去（旋律 staff 超過 60 個、鼓組超過 4 種）的 staff，這一輪不出聲

  _secOf(tick) {
    return this._score.midiTicksToSeconds(tick);
  }

  // 依這一輪的計畫建每位演奏者的狀態。沒有任何演奏者（整首自動播放）時放一份空計畫，伴奏照樣由它的第 0 段放完。
  // oldBySlot／fallbackRate：改指派時同一槽位沿用舊的速度追蹤與上一次觸發的時刻，新出現的槽位從合奏目前的速度起算。
  _setPerformers(oldBySlot = new Map(), fallbackRate) {
    const plans = this._plan.performers.length ? this._plan.performers : [emptyPerformerPlan()];
    this._performers = plans.map((plan, i) => {
      const old = oldBySlot.get(plan.slot);
      let tempo = old?.tempo;
      if (!tempo) {
        tempo = new TempoFollower();
        if (fallbackRate !== undefined) tempo.playbackRate = fallbackRate;
      }
      const p = makePerformerState(i, plan, tempo);
      if (old) { p.lastTriggerMs = old.lastTriggerMs; p.absentSinceMs = old.absentSinceMs; }
      return p;
    });
    this._bySlot = new Map(this._performers.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
  }

  // 合奏跟誰走：帶頭的人（leader，預設是現任）；沒有人帶頭時是下一個起音最早的演奏者（同一刻照指派下拉順序），單人時就是他。
  _holdOwner(leader = this._ensemble.leader) {
    if (leader) return leader;
    let best = this._performers[0], bestTick = Infinity;
    for (const p of this._performers) {
      const t = p.plan.driverSegs[p.cursor]?.ticks ?? Infinity;
      if (t < bestTick) { best = p; bestTick = t; }
    }
    return best;
  }

  // 合奏停在哪個起音等（帶頭的人的下一個起音；整首自動播放時沒有）。leader 同 _holdOwner()
  _ensembleNextTick(leader = this._ensemble.leader) {
    const o = this._holdOwner(leader);
    return o.plan.driverSegs[o.cursor]?.ticks;
  }

  // 合奏這次對時排到哪個 tick（不含）：帶頭的人下一個要按的起音。他一下放一組時是組尾，不是組裡下一個自動放行的起音——組裡的起音到點只推進游標，不會再排伴奏與代打
  _ensembleHorizonTick() {
    const o = this._holdOwner();
    return o.plan.driverTicks[o.groupEnd] ?? Infinity;
  }

  /**
   * 載入這首歌：建立 staff、套初始音色，把全曲的音分給每位演奏者與伴奏。
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
    this._setPerformers();
    this._ensemble = makeEnsemble();
    this._roster.clear();
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

  // 發聲帳本綁定這一輪的譜表與 hold 容差（hold 等哪一串起音在每次發聲時傳，見 _sound）
  _bindLedger() {
    this._ledger.bind({ staves: this._plan.staves, holdCapTicks: this._plan.holdCapTicks, secOf: (tick) => this._secOf(tick) });
  }

  /**
   * 播放到一半改指派（或整首自動播放 ↔ 有人演奏）：從目前的合奏位置接續，不從頭。
   * 做法：量合奏位置算出「界線 boundary」→ 收掉還在響的音 → 依新指派重建 staff 與計畫（同 load()）→ 起音在界線之前的音算已經過了（不重播、不補放，isFinished 才算得對）
   * → 每位演奏者的游標指到第一個 >= 界線的起音 → 以現在的時鐘為界線重新錨定合奏（速度沿用）。
   * 界線：合奏停格在帶頭的人的下一個起音上（播放頭已走到它、還沒按）→ 那個起音的 tick（它的音還沒響）；否則是播放頭所在的 tick（含）——剛按下一個起音、播放頭還在它上面時，那個 tick 的音已經響過，不能再放一次。
   * 控制器：舊的輸出 channel 先重設（踏板放開、彎音歸中央，在收音之前；channel 可能換給別的譜表用），新的輸出 channel 送初始音色與界線之前的狀態（_sendInitialState）；暫停中再依新狀態放開踏板與彎音，續播恢復。
   * 去抖與估速歷史清掉（舊間隔對不上新的起音序列），同一槽位的速度估計保留、新的槽位從合奏的速度起算；帶頭的人的槽位還在就繼續帶頭；前奏鎖依新計畫重算。播放／暫停狀態不變。切換瞬間還在響的音會被收掉、不重播；
   * lookahead 已提早送出、還沒響的電腦音取消不了，起音在界線之後的話新計畫會再放一次（最多 LOOKAHEAD_MS 內的短暫重複）。
   * @param {Map<string,number|string>|[string,number|string][]} assignments  同 load()
   */
  reassign(assignments) {
    if (!this._score) return;
    const score = this._score;
    const rate = this.playbackRate;
    const pos = this.getPositionTicks();
    const next = this._ensembleNextTick();
    // 播放頭是浮點數（秒 ↔ tick 換算有誤差）：比大小都留一個微小量，起音 tick 是整數
    const boundary = next !== undefined && pos >= next - 1e-6 ? next : pos + 1e-6;
    for (const staff of this._plan.staves.values()) this._router.resetChannel(staff);
    this.silence();
    this._plan = buildPlan(score, assignments, this._router);
    // 新的分配從頭建立（同 load()）：synth.js 補 port 時會整個重設合成器，shadow 已經對不上
    this._router.clearShadow();
    this._sendInitialState(boundary);
    if (!this._playing) for (const staff of this._plan.staves.values()) this._router.releaseForPause(staff);
    this._laneTrackers.clear();
    const leaderSlot = this._ensemble.leader?.slot;
    this._setPerformers(this._bySlot, rate);
    this._ensemble = makeEnsemble();
    this._ensemble.leader = this._bySlot.get(leaderSlot) ?? null;
    for (const slot of this._roster.slots()) if (!this._bySlot.has(slot)) this._roster.remove(slot);   // 被拿掉指派、超出人數的人移出名單
    this._bindLedger();

    // 起音在界線之前的音都算已經過了（不重播、不補放）。舊佇列裡沒有需要保留的電腦音：tick／trigger 之後佇列裡的音都排在時鐘之後，
    // 起音一定在播放頭之後（界線之後）；早按時沒輪到的音當場就追音或跳過了（見 _chaseOrSkip），不會留在佇列裡。
    this._sounded.clear();
    for (const staff of this._plan.staves.values()) {
      for (const note of staff.notes) if (note.startTick < boundary) this._sounded.add(note);
    }
    for (const p of this._performers) {
      p.cursor = lowerBound(p.plan.driverTicks, boundary);   // 第一個 >= 界線的起音；都在前面就是放完了
      p.groupEnd = p.cursor;   // 界線之後還沒發聲的組內起音依新的計畫當成一般起音
      p.tempo.forgetHistory();
    }
    this._skipped.clear();                                           // 界線之前的音都已重新記成處理過（上面的 _sounded）
    this._finishSent = false;
    this._lastTickMs = null;
    // 合奏這一段的編號＝帶頭的人已經放行的起音數；第 0 段（前奏）一律 1× 起算
    const o = this._holdOwner();
    this._anchorSlice(o, o.cursor, this._clockMs, this._secOf(Math.max(0, boundary)), o.cursor === 0 ? 1 : rate, boundary, o.cursor, null, true);
    if (leaderSlot !== undefined && !this._ensemble.leader) this._updateLeader(this._clockMs, 'removed');   // 帶頭的人被拿掉：交給名單上下一位
    this.events.flush();
  }

  play() {
    this._playing = true;
    // 第一個 tick 的 dt 是 0；暫停的時間不會算進時鐘（時鐘只在 tick() 前進），所以不用重設任何排好的時刻。
    this._lastTickMs = null;
    this._resumeClockMs = this._clockMs;
    for (const staff of this._plan.staves.values()) this._router.restoreAfterPause(staff);   // 暫停時放開的踏板、彎音恢復原狀
  }

  // 暫停：收掉還在響的音，時鐘、錨點與排好的音與控制器都保留（下次從原處繼續）。收音之前先放開踩著的延音踏板、彎音歸中央（MIDI 1.0：踏板踩著時 Note Off 與 All Notes Off 要等踏板放開才生效），續播再恢復。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    for (const p of this._performers) p.credit = null;   // 預按作廢：續播後要重新按
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
    for (const p of this._performers) {
      p.cursor = 0;
      p.groupEnd = 0;
      p.lastHead = null;
      p.anchor = null;
      p.anchoredSlice = -1;
      p.timed = [];
      p.clock = [];
      p.ownSent = [];
      p.credit = null;
      p.zone = 'sync';
      p.xMs = null;
      p.offRun = { sign: 0, count: 0 };
      p.stalled = false;
      p.status = 'ok';
      p.statusReason = null;
      p.recoverCount = 0;
      p.steady = null;
      p.lastTriggerMs = -Infinity;
      p.lastSource = null;
      p.absentSinceMs = null;
      p.missStartMs = null;
      p.restEndMs = null;
      p.lastAutoMs = null;
      p.tempo.reset();
    }
    this._ensemble = makeEnsemble();
    this._roster.clear();
    this._seq = 0;
    this._resumeClockMs = 0;
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
   * groups 每位演奏者一筆（依指派下拉順序；整首自動播放時是一筆空的）；ensemble 是合奏；最上層的 playbackRate／rateBounds 是合奏（帶頭的人）的。
   * performers 是給子專案 2～4 的合奏狀態（規格「合奏」的對外狀態），每位演奏者一筆：來源、名次（不在名單是 -1）、是不是帶頭的人、狀態、區間與相對時間 x（拍與 ms）、
   * 速度、游標、錯過幾下（數到 stage2K）、離他上一下多久（沒觸發過是 Infinity）。
   */
  inspect() {
    const withStaffId = ({ staff, note }) => ({ staffId: staff.id, note });
    const noteOf = (p) => ({ dueMs: p.dueMs, offMs: p.offMs, staffId: p.staff.id, note: p.note, own: p.own });
    const controlOf = (c) => ({
      dueMs: c.dueMs, id: c.ev.id, ticks: c.ev.ticks, type: c.ev.type, staffIds: (c.targets ?? []).map((s) => s.id),   // SysEx 沒有目標譜表（兩個合成器都送）
    });
    const E = this._ensemble, roster = this._roster.slots(), beat = this._score ? this._beatMsNow() : null;
    return {
      loaded: !!this._score,
      performers: this._performers.filter((p) => p.slot !== null).map((p) => ({
        slot: p.slot, source: p.lastSource, rosterIndex: roster.indexOf(p.slot), isLeader: p === E.leader, status: p.status,
        zone: p.zone, xMs: p.xMs, xBeats: p.xMs === null ? null : p.xMs / beat, rate: p.tempo.playbackRate, cursor: p.cursor,
        missed: this._score ? this._missedCount(p) : 0, sinceLastMs: this._clockMs - p.lastTriggerMs,
      })),
      playing: this._playing,
      clockMs: this._clockMs,
      playbackRate: this.playbackRate,
      rateBounds: this.rateBounds(),
      totalNotes: this._plan.totalNotes,
      holdCapTicks: this._plan.holdCapTicks,
      sounded: new Set(this._sounded),
      skipped: new Set(this._skipped),
      unplacedStaffIds: [...this._plan.unplaced],
      followers: this._plan.accompaniment.followers.map(withStaffId),
      ensemble: {
        leaderSlot: E.leader?.slot ?? null,
        roster: this._roster.slots(),
        anchor: E.anchor && { ...E.anchor },
        positionTicks: this.getPositionTicks(),
        rate: this.playbackRate,
        // 還沒發聲的伴奏音；還沒送出的伴奏控制器與還沒開始彈的人的控制器
        pending: E.timed.filter((p) => p.note).map(noteOf),
        pendingControls: [...E.timed.filter((p) => !p.note), ...E.clock].map(controlOf),
      },
      groups: this._performers.map((p) => ({
        slot: p.slot,
        slots: p.slot === null ? [] : [p.slot],
        status: p.status,
        provisional: this._roster.isProvisional(p.slot),
        segments: p.plan.driverSegs.map((s) => ({ ticks: s.ticks, items: s.items.map(withStaffId) })),
        cursor: p.cursor,
        hasPrelude: p.plan.hasPrelude,
        preludeCredit: p.credit?.kind === 'prelude',
        credit: p.credit && { ...p.credit },
        zone: p.zone,
        xMs: p.xMs,
        anchor: p.anchor && { ...p.anchor },
        anchoredSlice: p.anchoredSlice,
        stallMs: this._stallMsAt(p, this._clockMs),
        pending: p.timed.filter((x) => x.note).map(noteOf),   // 組裡還沒發聲的他的音
        pendingControls: p.clock.filter((c) => c.ev).map(controlOf),
        groupEnd: p.groupEnd,
        lastHead: p.lastHead,
        // 組裡還沒到的自動放行
        pendingAutoReleases: p.clock.filter((c) => c.autoRelease !== undefined).map((c) => ({ dueMs: c.dueMs, index: c.autoRelease, ticks: c.ticks })),
        playbackRate: p.tempo.playbackRate,
        rateBounds: { ...p.tempo.bounds },
        tempo: p.tempo.snapshot(),
      })),
      staves: [...this._plan.staves.values()].map((s) => ({
        id: s.id, partId: s.partId, slot: s.slot, kind: s.kind, channel: s.channel, program: s.program, bank: s.bank && { ...s.bank },
        init: s.init && { ...s.init }, percussionKit: s.percussionKit, baseVolume: s.baseVolume, notes: [...s.notes],
        // 正在響的音攤平成一筆一顆（同音高重疊時依先進先出的順序）
        sounding: [...s.sounding].flatMap(([pitch, queue]) => queue.map((e) => ({
          pitch, endTick: e.endTick, offMs: e.offMs, holdTick: e.holdTick, holdScope: e.holdScope, waitKey: e.waitKey ?? null, tailSec: e.tailSec, capped: e.capped, onTime: e.onTime, note: e.note,
        }))),
      })),
    };
  }

  /** 這個 tick 屬於合奏的第幾段（帶頭的人的第一個起音之前＝第 0 段）。唯讀查詢。呼叫的 sliceOfTick(...) 是 performancePlan.js 匯出的同名函式，類別方法名稱不會變成可直接呼叫的變數名。 */
  sliceOfTick(tick) { return sliceOfTick(this._holdOwner().plan.driverTicks, tick); }

  /** 以帶頭的人的游標判斷這顆伴奏音要不要 hold（見 voices.js 的 holdOf()）。唯讀查詢。 */
  holdOf(note) {
    const o = this._holdOwner();
    return this._ledger.holdOf(note, o.plan.driverTicks, o.cursor);
  }

  // 播完：所有音（你的與電腦的）都發過聲而且沒有還在響的音。有指派聲部但還沒按到，driver 的音沒發過，不算播完。
  isFinished() {
    if (!this._score) return false;
    if (this._sounded.size + this._skipped.size < this._plan.totalNotes) return false;   // 早按跳過的音也算處理過（沒有發聲）
    return this._ledger.isSilent();   // 沒有還在響的音
  }

  /**
   * 合奏位置目前在第幾個 tick（跟 note 的 startTick／endTick 同一個座標系）：從合奏錨點起，依速度往前走，最多走到帶頭的人的
   * 下一個起音（停格等他）。唯讀、無副作用。
   * @returns {number} tick（可為小數），夾在 [0, score.durationTicks]；沒有樂譜、沒有 staff、還沒開始播時 0
   */
  getPositionTicks() { return this._positionAt(this._clockMs); }

  // 合奏位置在時鐘 clockMs 的值（getPositionTicks() 是現在的時鐘；換帶頭的人時用觸發那一刻的時鐘，還沒納入排程器時鐘）
  _positionAt(clockMs) {
    const E = this._ensemble, a = E.anchor;
    if (!this._score || this._plan.staves.size === 0 || !a) return 0;
    let sec = a.scoreSec + (Math.max(0, clockMs - a.clockMs) * a.rate) / 1000;
    const next = this._ensembleNextTick();
    if (next !== undefined) sec = Math.min(sec, this._secOf(next));
    if (E.floorTick > -Infinity) sec = Math.max(sec, this._secOf(E.floorTick));   // 不倒退：帶頭的人落在合奏後面時，合奏停在原處等他走過來
    const ticks = this._score.secondsToMIDITicks(sec);
    const total = this._score.durationTicks;
    return total > 0 ? Math.min(ticks, total) : ticks;
  }

  // 排程器時鐘在 nowMs 這一刻的值：上一個 tick 的時鐘，加上之後經過的真實時間（跟 tick() 一樣有步長上限）。
  _clockAt(nowMs) {
    if (this._lastTickMs == null) return this._clockMs;
    return this._clockMs + Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));
  }

  // 演奏者 p 的播放頭停在他的下一個起音已經多久（毫秒）：這一段依錨點速度預計走完的時刻之後的時間；沒有下一個起音（最後一段、
  // 整首自動播放）就不會停格。
  _stallMsAt(p, clockMs) {
    const reach = this._reachClockMs(p);
    return reach === null ? 0 : Math.max(0, clockMs - reach);
  }

  // 演奏者 p 的播放頭走到他的下一個起音（預設：下一個還沒放行的；index 可以指定）的時鐘時刻。還沒開始彈的人跟著合奏的錨點走，
  // 合奏會先停在帶頭的人的下一個起音，所以他的起音在那之後就還到不了（null）；沒有錨點或沒有那個起音（最後一段、整首自動播放）也回 null。
  _reachClockMs(p, index = p.cursor) {
    const a = p.anchor ?? this._ensemble.anchor;
    const next = p.plan.driverSegs[index];
    if (!a || !next) return null;
    if (!p.anchor && next.ticks > (this._ensembleNextTick() ?? Infinity)) return null;
    return a.clockMs + ((this._secOf(next.ticks) - a.scoreSec) * 1000) / a.rate;
  }

  // 合奏的第 0 段（前奏）在第一次需要時（第一個 tick 或第一次按鍵）用目前時鐘、1× 起算，跟著「下一個起音最早的演奏者」排到他的入場點。
  _ensureEnsembleAnchored() {
    if (this._ensemble.anchor) return;
    this._anchorSlice(this._holdOwner(), 0, this._clockMs, 0, 1, -Infinity, 0, null, true);
  }

  // 動作時刻（鍵盤的 event.timeStamp、揮手最低點那張畫面的拍下時刻）換成排程器時鐘：收到時的時鐘減掉「收到 − 動作」；不早於最近一次續播
  //（跨過暫停的不算）。沒有動作時刻就用收到的時鐘。
  _motionClock(ev, clock) {
    if (!Number.isFinite(ev.eventTimeMs) || !Number.isFinite(ev.receivedMs)) return clock;
    return Math.max(this._resumeClockMs, clock - (ev.receivedMs - ev.eventTimeMs));
  }

  // 合奏位置上一拍（四分音符）的真實 ms（ensemble.js 的 beatMs，用合奏的速度）
  _beatMsNow() { return beatMs(this._score, this.getPositionTicks(), this.playbackRate); }

  // 兩個 tick 之間幾拍（SMPTE 沒有四分音符，用 ENSEMBLE.SMPTE_BEAT_SEC）
  _beatsBetween(a, b) {
    return this._score.timeDivision ? (b - a) / this._score.timeDivision : (this._secOf(b) - this._secOf(a)) / ENSEMBLE.SMPTE_BEAT_SEC;
  }

  // 演奏者 p 的第 index 個起音（預設下一個）前面那段休止 [開始, 結束]（rests 依開始排序、互不重疊，結束也遞增）；前面不是休止（長音、相連）回 null。
  _restBefore(p, index = p.cursor) {
    const next = p.plan.driverTicks[index], rests = p.plan.rests;
    if (next === undefined || !rests.length) return null;
    let lo = 0, hi = rests.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rests[mid][1] < next) lo = mid + 1; else hi = mid; }
    return rests[lo]?.[1] === next ? rests[lo] : null;
  }

  // 合奏位置落在他下一個起音前面的那段休止裡（不管還剩幾拍），而且那段休止夠長、可能讓帶頭的人交棒（≥ ENSEMBLE.REST_HANDOVER_BEATS 拍；斷奏的短空檔不算）
  _inRest(p) {
    const r = this._restBefore(p);
    if (!r) return false;
    const e = this.getPositionTicks();
    return e >= r[0] && e < r[1] && this._beatsBetween(r[0], r[1]) >= ENSEMBLE.REST_HANDOVER_BEATS;
  }

  // 他在休止中：合奏位置落在他下一個起音前面的那段休止裡，而且離休止結束還有 ENSEMBLE.REST_HANDOVER_BEATS 拍以上。
  // 看的是他的下一個起音，所以他已經按了進場音（游標過了休止）就不算；長音不是休止（rests 只收真的空檔）。
  _isResting(p) {
    const r = this._restBefore(p);
    if (!r) return false;
    const e = this.getPositionTicks();
    return e >= r[0] && this._beatsBetween(e, r[1]) >= ENSEMBLE.REST_HANDOVER_BEATS;
  }

  // 可以帶頭：狀態正常、聲部還沒彈完、不在休止中；現任的帶頭的人不必另外證明「正在彈」（合奏本來就停著等他），其他人要正在彈（ensemble.js 的 isActive）。
  // 不是現任的人，合奏位置在他的休止裡就不能帶頭，除非他正在觸發（entering）他的進場音：交還在他觸發進場音（或休止符鎖放出）時（規格「合奏」）——
  // 只看「休止還剩幾拍」的話，交棒時合奏往前跳一點、剩不到 1 拍，他馬上又被當成回來，在同一個門檻上來回跳。
  // 「還在等自己的下一個起音」只算彈長音的人：下一個起音前面是休止的人要真的觸發了才算回來。
  // 揮手確認前，只有在還沒有任何人確認時才能（暫時）帶頭（規格「合奏」的名單）；已經暫時帶頭的人留到確認或逾時。status＝要求的狀態（候補的第一順位是 'trouble'，見 _updateLeader）。
  _isCandidate(p, current, clock, entering = null, status = 'ok') {
    if (!p || p.status !== status || p.cursor >= p.plan.driverSegs.length || this._isResting(p)) return false;
    if (p === current) return true;
    if (this._provisionalBlocked(p)) return false;
    if (p !== entering && this._inRest(p)) return false;
    const reach = p.anchor && !this._restBefore(p) ? this._reachClockMs(p) : null;
    return isActive({ sinceLastMs: clock - p.lastTriggerMs, beatMs: this._beatMsNow(), resting: false, waiting: reach !== null && clock < reach });
  }

  // 揮手還沒確認、而名單上已經有人確認：不能帶頭（規格「合奏」的名單）
  _provisionalBlocked(p) { return this._roster.isProvisional(p.slot) && this._roster.hasConfirmed(); }

  // 候補的第二順位（_updateLeader）：在自己夠長的休止裡（合奏照他的速度走到他的進場音就停）；被代打、彈完的不算
  _isRestingStandIn(p) {
    return p.status !== 'substitute' && p.cursor < p.plan.driverSegs.length && this._inRest(p) && !this._provisionalBlocked(p);
  }

  // 第一次觸發排進名單（揮手的人先記成暫時的）；之後揮手的人在窗口內再觸發就確認。同時開始的窗口與確認窗口見 ENSEMBLE。
  _admit(p, ev, motion) {
    const R = this._roster, beat = this._beatMsNow();
    if (R.has(p.slot)) {
      if (R.isProvisional(p.slot) && motion - R.firstMotionMs(p.slot) <= threshold(ENSEMBLE.GESTURE_CONFIRM_BEATS, ENSEMBLE.GESTURE_CONFIRM_MIN_MS, beat)) R.confirm(p.slot);
      return;
    }
    R.admit(p.slot, { motionMs: motion, order: slotOrder(p.slot), tieMs: threshold(ENSEMBLE.TIE_BEATS, ENSEMBLE.TIE_MIN_MS, beat), provisional: ev.source === 'gesture' });
  }

  // 每個 tick：揮手的人逾時沒確認就移出名單；帶頭的人出狀況就換人（第一段防呆）；然後重新挑帶頭的人（休止交棒、彈完、回來交還）。
  _rosterTick() {
    const R = this._roster, clock = this._clockMs;
    for (const slot of R.slots()) {
      if (!R.isProvisional(slot) || clock - R.firstMotionMs(slot) <= threshold(ENSEMBLE.GESTURE_CONFIRM_BEATS, ENSEMBLE.GESTURE_CONFIRM_MIN_MS, this._beatMsNow())) continue;
      R.remove(slot);
      if (this._ensemble.leader?.slot === slot) this._updateLeader(clock, 'unconfirmed', true);
    }
    this._checkLeaderTrouble(clock);
    this._checkSubstitutes(clock);
    this._updateLeader(clock);
  }

  // 第二段防呆（規格「合奏」）：不是帶頭的人錯過太多下就由電腦代打（ensemble.js 的 shouldSubstitute）。有預按的人算已經觸發了；合奏停著等帶頭的人時
  // 不會走過任何人的起音，錯過的下數不會增加。從沒觸發過的人「離上一下多久」從合奏開始走過他的起音算。
  _checkSubstitutes(clock) {
    let beat = null;
    for (const p of this._performers) {
      if (p.slot === null || p === this._ensemble.leader || p.status === 'substitute' || p.credit) continue;
      const missed = this._missedCount(p);
      if (!missed) { p.missStartMs = null; p.restEndMs = null; continue; }
      if (p.missStartMs === null) { p.missStartMs = clock; p.restEndMs = this._restEndMs(p); }
      beat ??= this._beatMsNow();
      // 離他上一下多久：從沒觸發過的人從開始錯過算；不算他自己的休止（使用者 2026-10-22 定：休止中本來就不用按，長休止後晚一點進場不能算離開）
      const since = clock - Math.max(p.lastTriggerMs > -Infinity ? p.lastTriggerMs : p.missStartMs, p.restEndMs ?? -Infinity);
      const absentMs = p.absentSinceMs === null ? 0 : clock - p.absentSinceMs;
      if (!shouldSubstitute({ missed, sinceLastMs: since, beatMs: beat, absentMs, k: this.cfg.stage2K })) continue;
      this._setStatus(p, 'substitute', 'stage2', clock);
      p.lastAutoMs = null;   // 上一次代打留下的不算
      this._substituteFrom(p, this.getPositionTicks(), clock);
    }
  }

  // 他第一個錯過的那一下前面是夠長的休止（ENSEMBLE.IDLE_REST_BEATS）時，合奏走到那個起音的時鐘時刻；不是就 null。剛開始錯過時算：合奏錨點還是最近的，往回推得準
  //（_ensembleReachMs 會夾在錨點之後，錨點每一下都換，用它會一直往後推）。
  _restEndMs(p) {
    const r = this._restBefore(p, p.groupEnd);
    if (!r || this._beatsBetween(r[0], r[1]) < ENSEMBLE.IDLE_REST_BEATS) return null;
    const a = this._ensemble.anchor;
    return a.clockMs + ((this._secOf(r[1]) - a.scoreSec) * 1000) / a.rate;
  }

  // 他錯過了幾下（規格「合奏」）：從他下一個要按的起音起，依他的來源與速度併成的「一下」（同近距分組），起音已經落在合奏位置往前
  // ENSEMBLE.MISSED_BEHIND_BEATS 拍以前的個數；數到 stage2K 就夠了。
  _missedCount(p) {
    const lim = this._ticksBefore(this.getPositionTicks(), ENSEMBLE.MISSED_BEHIND_BEATS), ticks = p.plan.driverTicks, cap = this.cfg.stage2K;
    let n = 0;
    for (let j = p.groupEnd; n < cap && j < ticks.length && ticks[j] <= lim; j = this._groupEnd(p, j, p.tempo.playbackRate, p.lastSource)) n++;
    return n;
  }

  // 代打（規格「合奏」）：演奏者 q 從合奏位置 T 起由電腦照合奏錨點替他放（進入代打、合奏重新對時時都呼叫）。排好但還沒做的：T 之前的自動放行在這一刻做，
  // T 之前起音的音照垂直切片（還該響著的追音、整顆在身後的跳過）；從 T 起到合奏停的位置之前，他的起音照合奏錨點排：音帶 lookahead 時間戳走真人軌（同組裡被併入的音）、
  // 每個起音一個自動放行（到點收音、放行 hold）、控制器跟著合奏時間軸。他的速度改成合奏的速度（音長與 hold 的收尾照合奏）。
  _substituteFrom(q, T, clock) {
    const a = this._ensemble.anchor, rate = a.rate, tSec = this._secOf(T), ticks = q.plan.driverTicks, segs = q.plan.driverSegs;
    for (const it of q.clock) if (it.autoRelease !== undefined && it.ticks < T) this._autoRelease(q, it.autoRelease, clock);
    const kT = lowerBound(ticks, T);
    const pending = new Map();   // 還沒響的他的音（排好的、以及游標到 T 之間沒排過的段）
    for (const it of q.timed) if (it.note.startTick < T) pending.set(it.note, it);
    for (let s = q.cursor; s < kT; s++) for (const it of segs[s].items) pending.set(it.note, it);
    q.timed = [];
    q.clock = [];
    q.cursor = q.groupEnd = Math.max(q.cursor, kT);
    q.credit = null;
    q.tempo.playbackRate = rate;
    // 他已經在響的音：結尾在 T 之前的收掉；hold 著等 T 以前起音的，改成照樂譜剩下的長度收
    this._ledger.closeByTick(T, this._clockMs, q.slot);
    this._ledger.retimeHeld(q.slot, (t) => t < T, (t, tailSec) => clock + scaledMs(Math.max(0, this._secOf(t) + tailSec - tSec), rate));
    this._ledger.closeDue(this._clockMs);
    for (const [channel, lane] of this._plan.lanes) if (lane.targets.some((s) => s.slot === q.slot && s.kind === 'human')) this._chaseLane(channel, T);
    const chased = [], skipped = [];
    for (const { staff, note } of pending.values()) {
      if (this._sounded.has(note)) continue;
      if (note.endTick > T) {
        chased.push(note);
        this._sound(staff, note, clock + scaledMs(this._secOf(note.endTick) - tSec, rate), clock);
      } else {
        skipped.push(note);
        this._skipped.add(note);
      }
    }
    if (chased.length || skipped.length) this.events.queue('chase', { group: q.index, slot: q.slot, ticks: T, chased, skipped, inFlight: 0 });
    const hi = this._ensembleHorizonTick(), end = lowerBound(ticks, hi);
    const dueOf = (tick) => a.clockMs + ((this._secOf(tick) - a.scoreSec) * 1000) / rate;
    if (chased.length && q.cursor > 0) q.lastAutoMs = dueOf(ticks[q.cursor - 1]);   // 補上的追音也算電腦替他放了那一下（交還時比哪一下最近，用它在合奏時間軸上的時刻）
    const autos = [], controls = [];
    for (let s = q.cursor; s < end; s++) {
      autos.push({ dueMs: dueOf(ticks[s]), ticks: ticks[s], autoRelease: s, owner: q });
      for (const { staff, note } of segs[s].items) {
        const dueMs = dueOf(note.startTick);
        q.timed.push({ dueMs, offMs: dueMs + scaledMs(this._secOf(note.endTick) - this._secOf(note.startTick), rate), staff, note, own: true, mode: null, owner: q, seq: ++this._seq });
      }
    }
    for (let m = lowerBound(q.plan.controlTicks, T), mTo = lowerBound(q.plan.controlTicks, hi); m < mTo; m++) {
      const c = q.plan.controls[m];
      controls.push({ dueMs: dueOf(c.ev.ticks), ev: c.ev, targets: c.targets });
    }
    q.clock = mergeByDue(autos, controls);
    for (const it of q.clock) it.seq = ++this._seq;
    q.groupEnd = end;
    q.anchor = { slice: q.cursor, clockMs: a.clockMs, scoreSec: a.scoreSec, rate };
  }

  // 代打中的人再觸發（規格「合奏」的代打與交還）：對到時間上最近的起音（比起音在合奏時間軸上的時刻）。最近的是電腦已經替他放的那一下（自動放行、進入代打時補的追音、lookahead 已經送出的都算）→ 接手不重彈
  //（keyup 模式改成等這個鍵放開；揮手照原本的收音；那顆音已經結束就沒有聲音——改放下一個起音會多推一格），這一下照一般觸發進估速，回傳 false；
  // 最近的是還沒放的下一個 → 回傳 null，由 _trigger 照一般觸發處理（含 x 與鎖）。之後電腦不再替他排；名次不變，狀態先標成 trouble：恢復正常（_trackRecovery）才能重新帶頭（規格「合奏」）。
  _takeOver(p, ev, clock, motion) {
    this._emitTimed(clock);   // 到期的先放、自動放行先做：游標與「已經放了」才對
    this._emitClock(clock);
    const ticks = p.plan.driverTicks, segs = p.plan.driverSegs, a = this._ensemble.anchor;
    const dueOf = (k) => a.clockMs + ((this._secOf(ticks[k]) - a.scoreSec) * 1000) / a.rate;
    let sent = p.cursor;   // lookahead 已經帶時間戳送出、自動放行還沒到的起音也算電腦放了（取消不了，一定會響）
    while (sent < segs.length && segs[sent].items.every(({ note }) => this._sounded.has(note))) sent++;
    const last = sent - 1, lastMs = last >= p.cursor ? dueOf(last) : p.lastAutoMs;
    const nextMs = sent < ticks.length ? dueOf(sent) : Infinity;
    for (const it of p.clock) if (it.autoRelease !== undefined && it.autoRelease < sent) this._autoRelease(p, it.autoRelease, it.dueMs);
    const take = last >= 0 && lastMs !== null && Math.abs(motion - lastMs) <= Math.abs(nextMs - motion);
    p.timed = [];
    p.clock = p.clock.filter((c) => c.autoRelease === undefined);   // 他的控制器照舊；起音與音不再由電腦放
    p.groupEnd = p.cursor;
    this._setStatus(p, 'trouble', take ? 'takeover' : 'returned', clock);
    if (!take) return null;
    const k = p.cursor;
    this._clockMs = clock;
    this._lastTickMs = ev.receivedMs;
    if (ev.key != null) this._ledger.takeOver(p.slot, ticks[k - 1], ev.key);
    p.tempo.forgetHistory();
    p.tempo.accept(k - 1, this._secOf(ticks[k - 1]), null, motion);
    p.lastHead = k - 1;
    this._anchorSlice(p, k, p.lastAutoMs, this._secOf(ticks[k - 1]), p.tempo.playbackRate, this.getPositionTicks(), k, null, false);   // 他這一段的錨點：電腦放出 k−1 的那一刻；控制器從合奏位置起排
    this._pressEvent(p, ev, clock, 'takeover');
    return false;
  }

  // 重新挑帶頭的人：名單上第一位可以帶頭的（_isCandidate）；現任出狀況時，正常的人也不能自己已經停住（_stallWhy）：還算正在彈、卻已過了自己寬限的人，交過去同一刻就停住，
  // 帶頭會卡在他身上直到他不算正在彈（規格「合奏」的兩段防呆）。帶頭的人休止中時，只交給在他的進場音之前有要按的起音的人（規格「合奏」：彈長音跨過他整段休止的人
  // 不用伴奏往前走，合奏照他的速度走到進場音等他）。沒有正常的人可以接、而現任出狀況又停住（或已經不在名單上）時，交給名單上第一位還在的人：出狀況但還在彈、
  // 沒有停住的，其次在自己休止裡的（使用者 2026-10-22 定；不然其他人的觸發都被休止符鎖、超前鎖吞掉，整首卡住），原帶頭的人交給第二段防呆。換候補在他剛出狀況的那一刻（呼叫端給了 reason）；
  // 之後每個 tick 重新檢查時，出狀況的現任（含候補自己又停住）要已經不算正在彈（離上一下超過 ENSEMBLE.ACTIVE_BEATS 拍、或不在鏡頭裡）才換，不然候補一停頓就換下一位。
  // 都沒有就維持現狀（合奏停著等），除非現任已經不在名單上（force）。reason 沒給時依現任的狀況推（出狀況的原因、彈完、休止、名單更前面的人回來）。entering＝正在觸發的人（見 _isCandidate）。
  _updateLeader(clock, reason = null, force = false, entering = null) {
    const E = this._ensemble, cur = E.leader, slots = this._roster.slots(), at = (s) => this._bySlot.get(s);
    const entry = cur?.status === 'ok' && this._isResting(cur) ? cur.plan.driverTicks[cur.cursor] : null;
    const ok = (p) => this._isCandidate(p, cur, clock, entering) && (cur?.status !== 'trouble' || p === cur || !this._stallWhy(p, clock))
      && (entry === null || (p.plan.driverTicks[p.groupEnd] ?? Infinity) < entry);
    let slot = pickLeader(slots, (s) => ok(at(s)));
    const stall = cur?.status === 'trouble' ? this._stallWhy(cur, clock) : null;
    const gone = stall && (reason !== null || stall === 'absent' || clock - cur.lastTriggerMs > threshold(ENSEMBLE.ACTIVE_BEATS, ENSEMBLE.ACTIVE_MIN_MS, this._beatMsNow()));
    if (slot === null && (!cur || gone)) {
      slot = pickLeader(slots, (s) => at(s) !== cur && this._isCandidate(at(s), null, clock, entering, 'trouble') && !this._stallWhy(at(s), clock))
        ?? pickLeader(slots, (s) => at(s) !== cur && this._isRestingStandIn(at(s)));
    }
    const next = slot === null ? null : at(slot);
    if (next === cur || (next === null && !force)) return;
    const why = reason ?? (!cur ? 'first' : cur.status === 'trouble' ? cur.statusReason
      : cur.cursor >= cur.plan.driverSegs.length ? 'done' : this._isResting(cur) ? 'rest' : 'return');
    this._switchLeader(next, clock, why);
  }

  // 換帶頭的人。合奏原本就在等他（第一位帶頭的人就是前奏在等的那位，單人永遠是這樣）時什麼都不用動；否則合奏在這一刻重新對時：
  // 新帶頭者自己推算的位置（他的錨點往前推，最多到他的下一個起音）超過合奏位置就跳過去（垂直切片），沒超過就停在原處等他（不倒退）。
  _switchLeader(next, clock, reason) {
    const E = this._ensemble, cur = E.leader;
    this.events.queue('leader', { from: cur?.slot ?? null, to: next?.slot ?? null, reason, clockMs: clock });
    if (!E.anchor || (!cur && this._ensembleNextTick(next) === this._ensembleNextTick())) { E.leader = next; return; }
    // 已經到期、tick 還沒來得及放的照常先放（暫停中改指派時不放），再量合奏位置（照舊的帶頭者算）
    if (this._playing) { this._emitTimed(clock); this._emitClock(clock); }
    const ePos = this._positionAt(clock);
    E.leader = next;
    let target = ePos;
    if (next?.anchor) {
      const a = next.anchor, nt = next.plan.driverSegs[next.cursor]?.ticks;
      let sec = a.scoreSec + ((clock - a.clockMs) * a.rate) / 1000;
      if (nt !== undefined) sec = Math.min(sec, this._secOf(nt));
      target = Math.max(target, this._score.secondsToMIDITicks(sec));
    }
    this._jumpEnsemble(target, clock, this._holdOwner().tempo.playbackRate);
  }

  // 合奏在時鐘 clock 跳到 toTick、以速度 rate 重新對時（換帶頭的人時）：還沒送出的伴奏佇列作廢；合奏走過的最遠位置到 toTick 之間還沒響的伴奏音照垂直切片處理
  // （還該響著的追音、整顆在身後的跳過），控制器軌帶到 toTick 之前的狀態、這段的整體參數 SysEx 馬上送；伴奏 hold 著的音：新帶頭者還沒按到的起音照舊等，
  // 其餘（等的起音在 toTick 之前、或新帶頭者在那個 tick 沒有起音）改成依新錨點、合奏走到它的結尾時收；再從 toTick 起依新帶頭者排伴奏。
  _jumpEnsemble(toTick, clock, rate) {
    const E = this._ensemble, A = this._plan.accompaniment, from = E.floorTick;
    E.timed = [];
    E.clock = [];
    const chased = [], skipped = [];
    if (toTick > from) {
      for (let i = lowerBound(A.followerTicks, from), iTo = lowerBound(A.followerTicks, toTick); i < iTo; i++) {
        const { staff, note } = A.followers[i];
        if (this._sounded.has(note) || this._skipped.has(note)) continue;
        if (note.endTick > toTick) {
          chased.push(note);
          this._sound(staff, note, clock + scaledMs(this._secOf(note.endTick) - this._secOf(toTick), rate), clock);
        } else {
          skipped.push(note);
          this._skipped.add(note);
        }
      }
      // 只追有伴奏譜表的控制器軌：只屬於演奏者的軌，開始了的照他自己的錨點送，還沒開始的第一次放行時補（追蹤器每個 channel 一份、只能往後，追到合奏位置會讓落後的人提早收到）
      for (const [channel, lane] of this._plan.lanes) {
        if (lane.targets.some((s) => s.kind !== 'human') && lane.events.some((ev) => ev.ticks >= from && ev.ticks < toTick)) this._chaseLane(channel, toTick);
      }
      for (const ev of this._plan.globalSysex) if (ev.ticks >= from && ev.ticks < toTick) this._router.sendSysex(ev.data);
    }
    const owner = this._holdOwner();
    const scoreSec = this._secOf(toTick);
    const dueOf = (tick) => clock + ((this._secOf(tick) - scoreSec) * 1000) / rate;
    const onsets = new Set(owner.plan.driverTicks.slice(owner.cursor));
    this._ledger.retimeHeld('ensemble', (tick) => tick < toTick || !onsets.has(tick), (tick, tailSec) => dueOf(tick) + scaledMs(tailSec, rate));
    const hi = Math.max(toTick, this._ensembleHorizonTick());
    const anchor = { slice: owner.cursor, clockMs: clock, scoreSec, rate };
    E.anchor = anchor;
    E.floorTick = Math.max(E.floorTick, toTick);
    this.events.queue('anchor', { group: owner.index, slot: owner.slot, slice: owner.cursor, clockMs: clock, scoreSec, rate });
    const { fresh, others } = this._ensembleBatch(null, toTick, hi, anchor, toTick, [], null);
    for (const it of fresh) { it.seq = ++this._seq; E.timed.push(it); }
    for (const it of others) { it.seq = ++this._seq; E.clock.push(it); }
    if (chased.length || skipped.length) this.events.queue('chase', { group: owner.index, slot: owner.slot, ticks: toTick, chased, skipped, inFlight: 0 });
    this._resyncSubstitutes(toTick, clock);
  }

  // 合奏時間軸在 [lo, hi) 的項目，照錨點 anchor 排時刻：伴奏的音依起音排，own（帶頭的人組裡被併入的音）交錯在裡面、同一個 tick 排在伴奏前面；
  // 送電腦合成器的控制器與整體參數 SysEx 插在檔案裡比它晚的第一個音之前（踏板換踩、program change 在音之前；音符之間的順序不變）。
  // others＝還沒開始彈（沒有自己的錨點）的其他演奏者的控制器，跟著合奏走到他們各自的下一個起音為止。fromTick 之前的不排（改指派從中間接續時）；
  // 合奏走過的最遠位置（floorTick）之前的也不排（帶頭的人落在合奏後面時，那段合奏已經走過），own 不受這條限制；已經發聲的伴奏音不再排
  //（換帶頭跳位置時，lookahead 已經提早送出、起音在跳點之後的音）。
  _ensembleBatch(p, lo, hi, anchor, fromTick, own, ownMode) {
    const { clockMs, scoreSec, rate } = anchor;
    const dueOf = (tick) => clockMs + ((this._secOf(tick) - scoreSec) * 1000) / rate;
    const A = this._plan.accompaniment, fresh = [];
    const from = Math.max(fromTick, this._ensemble.floorTick);
    let i = lowerBound(A.followerTicks, lo), k = lowerBound(A.controlTicks, lo);
    const iTo = lowerBound(A.followerTicks, hi), kTo = lowerBound(A.controlTicks, hi);
    const take = () => {
      const c = A.controls[k++];
      if (c.ev.ticks < from) return;
      const dueMs = dueOf(c.ev.ticks);
      fresh.push(c.sysex ? { dueMs, ev: c.ev, sysex: true } : { dueMs, ev: c.ev, targets: c.targets });
    };
    for (let o = 0; i < iTo || o < own.length; ) {
      const isOwn = o < own.length && (i >= iTo || own[o].note.startTick <= A.followers[i].note.startTick);
      const { staff, note } = isOwn ? own[o++] : A.followers[i++];
      while (k < kTo && fileBefore(A.controls[k].ev, note)) take();
      if (note.startTick < (isOwn ? fromTick : from) || (!isOwn && this._sounded.has(note))) continue;
      const startSec = this._secOf(note.startTick);
      const dueMs = clockMs + ((startSec - scoreSec) * 1000) / rate;
      fresh.push({ dueMs, offMs: dueMs + scaledMs(this._secOf(note.endTick) - startSec, rate), staff, note, own: isOwn, mode: isOwn ? ownMode : null, owner: isOwn ? p : null });   // 起音與音長都依速度等比例縮放
    }
    while (k < kTo) take();
    const others = [];
    for (const q of this._performers) {
      if (q === p || q.anchor !== null || q.slot === null) continue;
      const qEnd = Math.min(hi, q.plan.driverSegs[q.cursor]?.ticks ?? Infinity);
      const t = q.plan.controlTicks;
      for (let m = lowerBound(t, lo), mTo = lowerBound(t, qEnd); m < mTo; m++) {
        const c = q.plan.controls[m];
        if (c.ev.ticks < from) continue;
        others.push({ dueMs: dueOf(c.ev.ticks), ev: c.ev, targets: c.targets });
      }
    }
    others.sort((x, y) => x.dueMs - y.dueMs);
    return { fresh, others };
  }

  // 啟動演奏者 p 的第 slice 段：記下錨點，把這一段他組裡被併入的音、送他的合成器的控制器與組裡起音的自動放行排好時刻（錨點時刻 ＋ 樂譜秒差 ÷ 速度）。
  // withEnsemble（他帶頭，或合奏的前奏／改指派）：同一個錨點也是合奏的錨點，伴奏的音與控制器一起排（_ensembleBatch）；結尾對齊或橫跨起音的音在發聲時另外標 hold，見 _sound。
  // 上一段沒放完的音在他按下時已追音或跳過（_chaseOrSkip），所以啟動新的一段時這些佇列一定是空的。
  // fromTick：熱切換指派從中間接續時，這一段裡 startTick 在它之前的音（與控制器）已經過了（控制器的狀態已用 chase 送），不排進佇列，不然會一次補放。
  // 近距起音分組（lastSlice > slice）：組頭 j 啟動第 j＋1 段到第 lastSlice 段（組裡每個起音之間的段，到下一個組頭為止），用同一個錨點；組裡被併入的起音的音像電腦音一樣排時刻（own：走他的合成器、帶 lookahead 時間戳，同 tick 排在電腦音前面），
  // 另外每個起音排一個自動放行（_autoRelease），跟送他的合成器的控制器依時刻排在一起。
  _anchorSlice(p, slice, clockMs, scoreSec, rate, fromTick = -Infinity, lastSlice = slice, ownMode = null, withEnsemble = false) {
    const anchor = { slice, clockMs, scoreSec, rate };
    p.anchor = anchor;
    this.events.queue('anchor', { group: p.index, slot: p.slot, slice, clockMs, scoreSec, rate });
    p.anchoredSlice = lastSlice;
    const { driverSegs, driverTicks, controls, controlTicks } = p.plan;
    const lo = slice === 0 ? -Infinity : driverTicks[slice - 1];
    const hi = lastSlice < driverTicks.length ? driverTicks[lastSlice] : Infinity;
    const dueOf = (tick) => clockMs + ((this._secOf(tick) - scoreSec) * 1000) / rate;
    const own = [], autos = [], human = [];
    for (let s = slice; s < lastSlice; s++) {
      own.push(...driverSegs[s].items);
      autos.push({ dueMs: dueOf(driverSegs[s].ticks), ticks: driverSegs[s].ticks, autoRelease: s, owner: p });
    }
    for (let k = lowerBound(controlTicks, lo), kTo = lowerBound(controlTicks, hi); k < kTo; k++) {
      const c = controls[k];
      if (c.ev.ticks >= fromTick) human.push({ dueMs: dueOf(c.ev.ticks), ev: c.ev, targets: c.targets });
    }
    let fresh;
    if (withEnsemble) {
      const E = this._ensemble;
      E.anchor = anchor;
      E.floorTick = Math.max(E.floorTick, lo);
      const batch = this._ensembleBatch(p, lo, hi, anchor, fromTick, own, ownMode);
      fresh = batch.fresh;
      E.timed = [];
      E.clock = batch.others;
      for (const it of E.clock) it.seq = ++this._seq;
    } else {
      fresh = [];
      for (const { staff, note } of own) {
        if (note.startTick < fromTick) continue;
        const startSec = this._secOf(note.startTick);
        const dueMs = clockMs + ((startSec - scoreSec) * 1000) / rate;
        fresh.push({ dueMs, offMs: dueMs + scaledMs(this._secOf(note.endTick) - startSec, rate), staff, note, own: true, mode: ownMode, owner: p });
      }
    }
    p.timed = [];
    for (const it of fresh) { it.seq = ++this._seq; (it.own ? p.timed : this._ensemble.timed).push(it); }
    p.clock = autos.length ? mergeByDue(autos, human) : human;
    for (const it of p.clock) it.seq = ++this._seq;
    if (withEnsemble) this._resyncSubstitutes(Math.max(lo, fromTick), clockMs);   // 代打的人跟著合奏的新錨點重排
  }

  // 合奏重新對時（帶頭的人觸發、換帶頭跳位置）之後，代打中的人從合奏的新起點 fromTick 重排（_substituteFrom）
  _resyncSubstitutes(fromTick, clock) {
    for (const q of this._performers) if (q.status === 'substitute') this._substituteFrom(q, fromTick, clock);
  }

  /**
   * 觸發一次：放行這個槽位的演奏者的下一個起音，裡面的音在這次呼叫內立刻 noteOn；他帶頭時同時啟動伴奏負責的那一段。
   * trigger(輸入事件)（鍵盤 keyboard.js、揮手 gestureTrigger.js）與 trigger(槽位, 時刻)（測試）走同一條路徑；發聲與錨點用程式收到的時刻，
   * 估速、去抖、名單先後、相對時間 x、錯過與「離上一下多久」用動作時刻（eventTimeMs 換成排程器時鐘，見 _motionClock；沒有就是收到的時刻）。
   * @param {number|string|{ slot: number|string, source: string|null, eventTimeMs: number|null, receivedMs: number }} input
   *   演奏者槽位（要有指派聲部才有資格），或輸入事件：source＝來源（'keyboard'…）、eventTimeMs＝動作時刻（鍵盤的 event.timeStamp、
   *   揮手最低點那張畫面的拍下時刻，跟 performance.now() 同一個時間原點）、receivedMs＝程式收到的時刻（performance.now()）
   * @param {number} [nowMs]  performance.now()（傳槽位時用；輸入事件用它自己的 receivedMs）
   * @returns {boolean} 有沒有放行（沒在播放、槽位沒有指派聲部、整首自動播放中、他的起音都放行完了、被去抖忽略、被鎖成預按、代打交還時接手都回 false）
   */
  trigger(input, nowMs) {
    // 槽位的寫法補成輸入事件的形狀：沒有來源與事件發生的時刻（記 null）
    const ev = typeof input === 'object' && input !== null ? input : { slot: input, source: null, eventTimeMs: null, receivedMs: nowMs };
    try { return this._trigger(ev); }
    finally { this.events.flush(); }   // 對外事件在這次呼叫的合成器呼叫都送出之後才發
  }

  _trigger(ev) {
    const p = this._bySlot.get(ev.slot);   // 這個槽位的演奏者；找不到＝沒有資格觸發
    if (!this._playing || !p || (p.status !== 'substitute' && p.groupEnd >= p.plan.driverSegs.length)) return false;
    this._ensureEnsembleAnchored();
    const clock = this._clockAt(ev.receivedMs);
    const R = this._roster, motion = this._motionClock(ev, clock), isNew = !R.has(p.slot), cur = this._ensemble.leader;
    p.lastTriggerMs = motion;
    p.lastSource = ev.source ?? null;
    this._admit(p, ev, motion);
    // 還沒有人帶頭：他先成為帶頭的人，這一下照帶頭的人處理（前奏、N2 早按）。已經有人帶頭：這一下先照不是帶頭的人處理（x、跳、鎖），再看要不要換人——
    // 先換的話，落後的人這一下會以帶頭的人的身分放他落後的起音，合奏停在原處等他、不會跳到合奏位置（規格「合奏」）
    if (!cur) this._updateLeader(clock, null, false, p);
    const released = this._triggerBody(p, ev, clock, motion);
    // 新加入的人因為同時開始排到現任前面：換人的原因是 tie。這一下也可能是他最後一個起音（彈完交棒）
    const tie = isNew && cur && R.slots().indexOf(p.slot) < R.slots().indexOf(cur.slot);
    this._updateLeader(clock, tie ? 'tie' : null, false, p);
    return released;
  }

  _triggerBody(p, ev, clock, motion) {
    if (p.status === 'substitute') {
      const taken = this._takeOver(p, ev, clock, motion);
      if (taken !== null) return taken;
      if (p.groupEnd >= p.plan.driverSegs.length) return false;
    }
    let j = p.groupEnd;   // 這一下要放行的起音：還在進行的一組之後的那個

    // 前奏鎖：他的第一個起音之前別的聲部有音（卡農：大提琴先進、你控制後進的小提琴），合奏還沒走到他的入場點時按鍵不放行——放行會讓他的第 1 段用「現在」重新對時，前奏剩下的音就被跳過。
    // 這一下只記成「預按」（布林，按幾下都一樣），合奏走到入場點的那一刻由 tick() 自動放行第一個起音；不動估速、去抖與錨點。合奏還到不了他的入場點（停在別人的起音上）也算還沒到。
    if (j === 0 && p.plan.hasPrelude) {
      const reach = this._reachClockMs(p);
      if (reach === null || clock < reach - EPS_MS) {
        this._pressEvent(p, ev, clock, 'prelude');
        p.credit = { kind: 'prelude', key: ev.key ?? null, lifted: false, source: ev.source ?? null };
        return false;
      }
    }
    // 休止符鎖（N8；帶頭的人、單人也一樣）：這個起音前面有 ≥ ENSEMBLE.REST_LOCK_BEATS 拍的休止，動作那一刻合奏位置離起音還有 REST_LOCK_BEATS 拍以上
    // （合奏可以還在休止前最後一個音裡）→ 記成預按，合奏走到這個起音時放出。收到時合奏已經走到起音（揮手確認晚到、休止已經結束）就照常放行。
    if (this._restLocked(p, j, motion, clock)) return this._restCredit(p, ev, clock);
    // 超前鎖住期間再觸發：只算一下（照樣記進按鍵記錄）
    if (p.credit?.kind === 'ahead') { this._pressEvent(p, ev, clock, 'ahead'); return false; }

    // 去抖（tempo.js 的 attempt()）：這一步依目前速度預估的真實長度，從他上一次按下的起音（組頭）算起（第一下沒有上一個，去抖不會用到）。
    // 去抖與估速都用動作時刻：程式收到的時刻多了輸入與確認的延遲（揮手確認要等手回升），不是他的節奏
    const head = p.lastHead === null ? null : this._secOf(p.plan.driverSegs[p.lastHead].ticks);
    const blocked = p.tempo.attempt(motion, head === null ? 0 : ((this._secOf(p.plan.driverTicks[j]) - head) * 1000) / p.tempo.playbackRate);
    if (blocked) { this._pressEvent(p, ev, clock, 'blocked'); return false; }

    // 相對時間 x 與區間（規格「合奏」）：落後太多就跳到合奏位置；揮手超前太多就鎖到只超前 1/2 拍
    const before = { zone: p.zone, offRun: p.offRun };
    let act = this._classify(p, j, motion, ev.source), jumped = false;
    if (act === 'jump') {
      jumped = true;
      this._clockMs = clock;
      this._lastTickMs = ev.receivedMs;
      const chased = this._jumpBehind(p, ev, clock, motion);
      // 合奏位置上沒有他的音在響：游標已經移到下一個起音，這一下當成提早觸發它（照休止符鎖，區間重新判斷；規格「合奏」）
      j = p.groupEnd;
      if (chased || j >= p.plan.driverSegs.length) {
        this._trackRecovery(p, clock, motion, this._positionAt(motion), true);
        this._pressEvent(p, ev, clock, 'released', true);
        return true;
      }
      p.zone = before.zone;
      p.offRun = before.offRun;
      if (this._restLocked(p, j, motion, clock)) return this._restCredit(p, ev, clock, true);
      act = this._classify(p, j, motion, ev.source);
    }
    this._trackRecovery(p, clock, motion, p.plan.driverTicks[j], jumped);
    if (act === 'lock') {
      p.tempo.accept(j, this._secOf(p.plan.driverTicks[j]), head, motion);   // 鎖住的這一下照樣進估速與去抖（放出時不再算一次）
      p.lastHead = j;
      p.credit = { kind: 'ahead', key: ev.key ?? null, lifted: false, source: ev.source ?? null };
      this._pressEvent(p, ev, clock, 'ahead', jumped);
      return false;
    }
    this._pressEvent(p, ev, clock, 'released', jumped);   // 放行必定接著 _release()

    // 接受：把按下的時刻納入時鐘（tick 之間的那一小段）
    this._clockMs = clock;
    this._lastTickMs = ev.receivedMs;
    const inFlight = this._takeInFlight(p, clock);
    this._flushAutoReleases(p, clock);   // 提早按下一組：這一組還沒到的自動放行先依序做完（hold 與收音的狀態才一致）
    this._release(p, clock, ev.source ?? null, inFlight, keyupOf(ev.key), false, motion);
    return true;
  }

  // 這一下記成休止符鎖的預按（合奏走到他的下一個起音時由 tick() 放出）；jumped＝落後跳之後落在休止裡
  _restCredit(p, ev, clock, jumped = false) {
    this._pressEvent(p, ev, clock, 'rest', jumped);
    p.credit = { kind: 'rest', key: ev.key ?? null, lifted: false, source: ev.source ?? null };
    return false;
  }

  // 休止符鎖的條件（見 _trigger）：第 j 個起音前面有 ≥ ENSEMBLE.REST_LOCK_BEATS 拍的休止，動作時刻 motion 的合奏位置離起音 ≥ REST_LOCK_BEATS 拍
  // （可以還在休止前最後一個音裡），收到時（clock）合奏還沒走到起音
  _restLocked(p, j, motion, clock) {
    const r = this._restBefore(p, j);
    if (!r || this._beatsBetween(r[0], r[1]) < ENSEMBLE.REST_LOCK_BEATS) return false;
    const e = this._positionAt(motion);
    return this._beatsBetween(e, r[1]) >= ENSEMBLE.REST_LOCK_BEATS && this._positionAt(clock) < r[1] - 1e-6;
  }

  // 這一下（放第 j 個起音）的相對時間 x 與區間（規格「合奏」）：x＝起音的樂譜位置 − 他動作時刻的合奏位置，用合奏的速度換成 ms。
  // 回傳要不要特別處理（只對不是帶頭的人）：'jump'＝落後，偏離同方向連續 ENSEMBLE.OFF_PERSIST 下或脫隊；'lock'＝揮手超前，條件同；null＝照常（鍵盤超前一律照常）。
  // 連續的計數處理過也不重數（最近兩下都偏離就算；多數決也看它，見 _majorityOff）。
  _classify(p, j, motion, source) {
    const x = ((this._secOf(p.plan.driverTicks[j]) - this._secOf(this._positionAt(motion))) * 1000) / this.playbackRate;
    const zone = classifyOffset(x, this._beatMsNow(), p.zone);
    p.xMs = x;
    p.zone = zone;
    if (p === this._ensemble.leader || (zone !== 'off' && zone !== 'lost')) { p.offRun = { sign: 0, count: 0 }; return null; }
    const sign = Math.sign(x);
    p.offRun = { sign, count: p.offRun.sign === sign ? p.offRun.count + 1 : 1 };
    if (zone === 'off' && p.offRun.count < ENSEMBLE.OFF_PERSIST) return null;
    return sign < 0 ? 'jump' : source === 'gesture' ? 'lock' : null;
  }

  // 出狀況的人恢復正常，之後依名次拿回帶頭（_updateLeader）。多數決出狀況的：連續 ENSEMBLE.RECOVER_PERSIST 下 |x| < RECOVER_BEATS 拍（下限同稍快／稍慢的 SLIGHT_MIN_MS）；
  // 停住、代打回來的：看他自己穩不穩（ensemble.js 的 extendSteadyRun／isSteadyRun），不要求跟現任同步——現任可能就是比較慢的那位。
  // tick＝這一下放到的樂譜位置，jumped＝落後跳（這一串從這一下重新起算）。被去抖擋掉、預按、接手的那幾下不會進來，不算也不打斷。
  _trackRecovery(p, clock, motion, tick, jumped) {
    if (p.status !== 'trouble') return;
    if (p.statusReason === 'majority') {
      const synced = Math.abs(p.xMs) < threshold(ENSEMBLE.RECOVER_BEATS, ENSEMBLE.SLIGHT_MIN_MS, this._beatMsNow());
      p.recoverCount = synced ? p.recoverCount + 1 : 0;
      if (p.recoverCount >= ENSEMBLE.RECOVER_PERSIST) this._setStatus(p, 'ok', 'recovered', clock);
      return;
    }
    p.steady = extendSteadyRun(p.steady, motion, this._secOf(tick), jumped);
    if (isSteadyRun(p.steady, beatMs(this._score, tick, p.tempo.playbackRate))) this._setStatus(p, 'ok', 'recovered', clock);
  }

  // 改演奏者的狀態，發 performer 事件
  _setStatus(p, status, reason, clock) {
    if (p.status === status) return;
    this.events.queue('performer', { slot: p.slot, from: p.status, to: status, reason, clockMs: clock });
    p.status = status;
    p.statusReason = reason;
    p.recoverCount = 0;
    p.steady = null;
  }

  // 第一段防呆（規格「合奏」）：帶頭的人出狀況就標成 trouble，交給名單上下一位正常而且正在彈的人（沒有人可接時見 _updateLeader 的候補）。
  // 停住（_stallWhy）或 'majority'＝三人以上時其他正在彈的人過半同方向偏離、各連續 ENSEMBLE.MAJORITY_PERSIST 下。有預按的人算已經觸發了。
  _checkLeaderTrouble(clock) {
    const L = this._ensemble.leader;
    if (!L || L.status !== 'ok' || L.credit || L.groupEnd >= L.plan.driverSegs.length) return;
    const why = this._stallWhy(L, clock) ?? (this._majorityOff(L, clock) ? 'majority' : null);
    if (!why) return;
    this._setStatus(L, 'trouble', why, clock);
    this._updateLeader(clock, why);
  }

  // 演奏者 p 停住了嗎：他的播放頭走到他下一個要按的起音之後，'overdue'＝過了寬限還沒觸發；'absent'＝他已經連續 ENSEMBLE.ABSENT_STAGE1_MS 不在鏡頭裡（不等寬限）；
  // 沒停住回 null。有預按、彈完的人不算停住。第一段防呆與找候補（_updateLeader：只有停住的現任才換給候補，候補自己也不能停住，不然兩個出狀況的人會每個 tick 互換）共用。
  _stallWhy(p, clock) {
    if (p.credit || p.groupEnd >= p.plan.driverSegs.length) return null;
    const reach = this._reachClockMs(p, p.groupEnd);
    if (reach === null || clock < reach - EPS_MS) return null;
    if (p.absentSinceMs !== null && clock - p.absentSinceMs >= ENSEMBLE.ABSENT_STAGE1_MS) return 'absent';
    return clock >= reach + stage1GraceMs(this._stepMs(p)) ? 'overdue' : null;
  }

  // 演奏者 p 這一步（上一個組頭到下一個要他按的起音）依他的速度預估的真實長度（ms）；還沒按過就從前一個起音算，第一個起音是 0
  _stepMs(p) {
    const j = p.groupEnd, from = p.lastHead ?? j - 1;
    return from < 0 ? 0 : ((this._secOf(p.plan.driverTicks[j]) - this._secOf(p.plan.driverTicks[from])) * 1000) / p.tempo.playbackRate;
  }

  // 多數決：名單上除了帶頭的人 L 以外正在彈的人至少兩位（合計三人以上），而且過半同方向偏離、各連續 ENSEMBLE.MAJORITY_PERSIST 下
  _majorityOff(L, clock) {
    const others = this._roster.slots().map((s) => this._bySlot.get(s)).filter((q) => q !== L && this._isCandidate(q, null, clock));
    if (others.length < 2) return false;
    return [1, -1].some((sign) => others.filter((q) => q.offRun.sign === sign && q.offRun.count >= ENSEMBLE.MAJORITY_PERSIST).length > others.length / 2);
  }

  /**
   * 在場名單：這一幀在鏡頭裡的揮手槽位（vision.js 的 presentSlots；main.js 經 midiPlayer.js 的 setPresentSlots() 交過來）。記下每個數字槽位從什麼時候開始不在場
   *（排程器時鐘），第一段防呆用；鍵盤永遠在場。有演奏者離開或回來時發 presence 事件（每一幀都會呼叫，沒變就不發）：錄音重播照它餵回來，代打與換帶頭才跟現場一樣。
   * @param {number[]} slots
   * @param {number} nowMs  performance.now()
   */
  setPresence(slots, nowMs) {
    const present = new Set(slots), clock = this._clockAt(nowMs);
    let changed = false;
    for (const p of this._performers) {
      if (typeof p.slot !== 'number') continue;
      const wasAbsent = p.absentSinceMs !== null;
      if (present.has(p.slot)) p.absentSinceMs = null;
      else if (p.absentSinceMs === null) p.absentSinceMs = clock;
      if (wasAbsent !== (p.absentSinceMs !== null)) changed = true;
    }
    if (!changed) return;
    this.events.queue('presence', { slots: [...slots], clockMs: clock, receivedMs: nowMs });
    this.events.flush();
  }

  // 落後跳（規格「合奏」）：不放他的下一個起音，改放他的聲部在合奏位置 e 該響著的音（起音 ≤ e < 結尾；追音，長度＝剩餘 ÷ 速度），整顆在 e 之前的跳過，
  // 游標移到第一個 > e 的起音，他的時間軸從 e 重新起算；e 落在一組近距起音中間時，同組後面的起音當這一下的組員到點自動放行（N11）——
  // 不然他下一下會被對到這組剩下的音，一直慢一組、每隔一下又跳，估速也從很短的樂譜間隔算而掉到下限。
  // e 上沒有他的音在響（休止、斷奏的空檔）時只做到跳過與移游標（控制器帶到下一個起音之前），
  // 回傳 false，由呼叫端把這一下當成提早觸發下一個起音。估速歷史從這一下重新開始：跳過的那段不是他彈的間隔。
  _jumpBehind(p, ev, clock, motion) {
    const e = this.getPositionTicks(), eSec = this._secOf(e), rate = p.tempo.playbackRate;
    const inFlight = this._takeInFlight(p, clock);
    this._flushAutoReleases(p, clock);
    if (p.stalled) { p.stalled = false; this.events.queue('stall', { group: p.index, slot: p.slot, state: 'end', clockMs: clock }); }
    const segs = p.plan.driverSegs, k = upperBound(p.plan.driverTicks, e);
    const pending = p.timed.filter((it) => it.note);   // 組裡排好、還沒響的他的音，加上游標到 e 之間的段
    for (let s = p.groupEnd; s < k; s++) pending.push(...segs[s].items);
    p.timed = [];
    p.clock = [];
    p.cursor = p.groupEnd = k;
    p.tempo.forgetHistory();
    // 他已經在響的音：結尾在 e 之前的收掉；hold 著等 e 以前起音的，改成照樂譜剩下的長度收
    this._ledger.closeByTick(e, this._clockMs, p.slot);
    this._ledger.retimeHeld(p.slot, (t) => t <= e, (t, tailSec) => clock + scaledMs(Math.max(0, this._secOf(t) + tailSec - eSec), rate));
    this._ledger.closeDue(this._clockMs);
    const chased = [], skipped = [];
    for (const it of pending) {
      if (this._sounded.has(it.note)) continue;
      if (it.note.startTick <= e && it.note.endTick > e) chased.push(it);
      else { skipped.push(it.note); this._skipped.add(it.note); }
    }
    const laneTick = chased.length || k >= segs.length ? e : segs[k].ticks;
    for (const [channel, lane] of this._plan.lanes) if (lane.targets.some((s) => s.slot === p.slot && s.kind === 'human')) this._chaseLane(channel, laneTick);
    if (chased.length || skipped.length || inFlight) this.events.queue('chase', { group: p.index, slot: p.slot, ticks: e, chased: chased.map((it) => it.note), skipped, inFlight });
    if (!chased.length) return false;
    p.tempo.accept(k, this._secOf(this._positionAt(motion)), null, motion);   // 估速從他動作那一刻的合奏位置重新起算
    const end = this._groupEnd(p, k - 1, rate, ev.source ?? null), keyup = keyupOf(ev.key);
    p.lastHead = k - 1;
    p.groupEnd = end;
    this._anchorSlice(p, k, clock, eSec, rate, e, end, keyup && LIFTED, false);   // 他這一段的錨點在 e、控制器從 e 起排、組員到點自動放行（keyup 模式同 _release）
    this._emitClock(clock);
    for (const { staff, note } of chased) this._sound(staff, note, clock + scaledMs(this._secOf(note.endTick) - eSec, rate), clock, false, false, keyup);
    this._ledger.closeDue(this._clockMs);
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
    const p = this._bySlot.get(ev.slot);
    if (ev.key == null || !p) return false;
    if (p.credit && p.credit.key === ev.key) p.credit.lifted = true;
    let clock = this._clockMs;
    if (this._playing) {   // 暫停中時鐘不走（暫停已經收掉所有音，這裡也沒有東西可收）
      clock = this._clockAt(ev.receivedMs);
      this._clockMs = clock;
      this._lastTickMs = ev.receivedMs;
    }
    const closed = this._ledger.releaseKey(ev.key, clock);
    this._ledger.closeDue(clock);
    this.events.queue('lift', { group: p.index, slot: ev.slot, key: ev.key, clockMs: clock, closed, eventTimeMs: ev.eventTimeMs ?? null, receivedMs: ev.receivedMs ?? null });
    return closed > 0;
  }

  // 演奏者 p 的 hold 放行範圍：他自己的音；他帶頭時連伴奏（'ensemble'）一起。
  _holdScopes(p) {
    return p === this._ensemble.leader ? new Set([p.slot, 'ensemble']) : new Set([p.slot]);
  }

  // 放行演奏者 p 的下一個起音（按鍵 trigger() 與前奏結束時的預按放行共用），時刻 clock（排程器時鐘）；它是一組的組頭。
  // source＝這一下的輸入來源（分組的門檻，見 _groupEnd）；inFlight＝上一組已經提早送出、取消不了的他的音（統計用，見 _chaseOrSkip）。
  // keyup＝keyup 模式的發聲方式（keyupOf()／LIFTED，null＝非 keyup 模式）：組頭等鍵放開，組裡被併入的音照檔案長度，都不 hold。
  // 他帶頭時，伴奏以這一下重新對時；不帶頭時只放他自己的音，不碰伴奏。tempoAccepted＝這一下在鎖住時已經進過估速（超前鎖，見 _trigger），放出時不再算一次。
  // motion＝他動作的時刻（估速用；預按到點放出時就是放出的時刻）。放行就用掉他的預按（之後再到點也不會重放）。
  _release(p, clock, source = null, inFlight = 0, keyup = null, tempoAccepted = false, motion = clock) {
    const j = p.cursor, seg = p.plan.driverSegs[j];
    const scoreSec = this._secOf(seg.ticks);
    const isLeader = p === this._ensemble.leader;
    p.credit = null;
    if (p.stalled) { p.stalled = false; this.events.queue('stall', { group: p.index, slot: p.slot, state: 'end', clockMs: clock }); }
    // 還沒開始彈的人第一次放行：他的控制器之前沒有排過（跟著合奏走的那段只到他的入場點），先把他的控制器軌帶到這個起音之前的狀態
    if (p.anchor === null) for (const [channel, lane] of this._plan.lanes) if (lane.targets.some((s) => s.slot === p.slot && s.kind === 'human')) this._chaseLane(channel, seg.ticks);
    // 估速（停手與變速的判斷見 tempo.js）：間隔從他上一次按下的起音（組頭）算起
    if (!tempoAccepted) p.tempo.accept(j, scoreSec, p.lastHead === null ? null : this._secOf(p.plan.driverSegs[p.lastHead].ticks), motion);
    const rate = p.tempo.playbackRate;                              // 這一下估完的速度
    const end = this._groupEnd(p, j, rate, source);                 // 按不及的近距起音併進這一組：[j＋1, end) 到點自動放行
    // 已經到期、tick 還沒來得及放的音（與控制器）要在游標前進之前放：結尾對齊這個起音的才會 hold，下面的 releaseHeld 才收得到它；也要在追音之前，同譜表的新音才截得到它們
    this._emitTimed();
    p.lastHead = j;
    p.cursor = j + 1;
    p.groupEnd = end;
    this.events.queue('release', { group: p.index, slot: p.slot, index: j, ticks: seg.ticks, clockMs: clock });
    if (end > j + 1) {
      const merged = p.plan.driverSegs.slice(j + 1, end).map((s, i) => ({ index: j + 1 + i, ticks: s.ticks }));
      this.events.queue('group', { group: p.index, slot: p.slot, index: j, ticks: seg.ticks, merged, clockMs: clock });
    }

    this._ledger.closeByTick(seg.ticks, this._clockMs, p.slot);    // 他的音 endTick ≤ 這個起音的，先收
    this._ledger.releaseHeld(this._holdScopes(p), seg.ticks, clock, rate);   // 結尾對齊這個起音（或更早的起音）而 hold 著的音：他的音（帶頭時連電腦音）都在按下的這一刻收（錨點就是按下的時刻）
    this._ledger.closeDue(this._clockMs);
    this._emitClock(this._clockMs);
    // 早按：上一段還沒輪到的音落在這個起音的「垂直 tick」之前，不能再照原時刻放（會跟他不同步、甚至倒序）。改跳到 T_k 的垂直狀態：還該響著的追音、整顆在身後的跳過，控制器改送 T_k 之前的狀態（_chaseOrSkip）。錨點因此永遠是按下的時刻。
    this._chaseOrSkip(p, seg.ticks, scoreSec, clock, inFlight, isLeader);
    this._anchorSlice(p, j + 1, clock, scoreSec, rate, -Infinity, end, keyup && LIFTED, isLeader);   // 這一段（含組裡起音之間的段）的錨點、組裡的音與控制器；帶頭時連伴奏（佇列此時是空的）
    this._emitClock(clock);                                         // 他起音那個 tick 上、送他的合成器的控制器（program change 等）在他的音之前
    for (const { staff, note } of seg.items) this._sound(staff, note, clock + scaledMs(this._secOf(note.endTick) - scoreSec, rate), clock, false, false, keyup);
    this._emitTimed();                                              // 同 tick 的伴奏音與控制器（dueMs ＝ 這一刻）跟他的音同刻
    this._emitClock(this._clockMs);
    this._ledger.closeDue(this._clockMs);                           // 零長度的音
  }

  // 近距起音分組：從組頭 j 往後串，相鄰兩個起音的樂譜間隔依目前速度換成真實時間，比這個輸入來源的最短間隔還短（按不及；鍵盤 0.06 秒，tempo.js 的 minPressIntervalSec）就併進來，一直串到不按不及為止；
  // 有長度上限的來源（手勢，tempo.js 的 maxGroupSpanSec）再加一條：這個起音距組頭的真實時間不超過上限，不然停在這裡，下一次揮手就按得到。
  // 彈得慢間隔被拉開、併的就少，彈得快併的就多。回傳這一組的結束（不含）。
  _groupEnd(p, j, rate, source) {
    const segs = p.plan.driverSegs, minSec = minPressIntervalSec(source), spanSec = maxGroupSpanSec(source), headSec = this._secOf(segs[j].ticks);
    let m = j + 1;
    while (m < segs.length && (this._secOf(segs[m].ticks) - this._secOf(segs[m - 1].ticks)) / rate < minSec
      && (this._secOf(segs[m].ticks) - headSec) / rate < spanSec) m++;
    return m;
  }

  // 演奏者 p 組裡被併入的起音 s 到了它排定的時刻 atMs：做兩件跟「按下它」一樣的事——收掉他的聲部裡 endTick ≤ 它的音、放行 hold 著等它
  // （或更早起音）的音（收在 atMs ＋ 剩餘長度 ÷ 速度）。不動估速與去抖：它們只看他實際的按鍵。
  _autoRelease(p, s, atMs) {
    const ticks = p.plan.driverSegs[s].ticks;
    p.cursor = s + 1;
    p.lastAutoMs = atMs;
    this._ledger.closeByTick(ticks, this._clockMs, p.slot);
    this._ledger.releaseHeld(this._holdScopes(p), ticks, atMs, p.tempo.playbackRate);
    this.events.queue('autoRelease', { group: p.index, slot: p.slot, index: s, ticks, dueMs: atMs, clockMs: this._clockMs });
  }

  // 他提早按下一組時，這一組還沒到的自動放行依序在按下的這一刻做完（之後的放行與垂直切片才對得上 hold 與收音的狀態）。
  _flushAutoReleases(p, clock) {
    if (p.cursor >= p.groupEnd) return;
    const rest = [];
    for (const item of p.clock) {
      if (item.autoRelease !== undefined) this._autoRelease(p, item.autoRelease, clock);
      else rest.push(item);
    }
    p.clock = rest;
  }

  // 他按下時，組裡已經提早帶時間戳送出、還沒到時刻的他的音有幾顆（取消不了，會在按下之後 ≤ LOOKAHEAD_MS 響；統計用），並清空記錄
  _takeInFlight(p, clock) {
    let n = 0;
    for (const dueMs of p.ownSent) if (dueMs > clock + EPS_MS) n++;
    p.ownSent = [];
    return n;
  }

  // 早按時的垂直切片（N2；Antescofo 的 @tight＋@local、DAW 的 Chase Events）：演奏者 p 按下起音 T_k（ticks）時，佇列裡還沒輪到、起音在 T_k 之前的音，endTick > T_k 的追音（現在發聲，長度＝檔案裡 T_k 到結尾的剩餘長度 ÷ 速度，hold 照舊，見 _sound），
  // endTick ≤ T_k 的整顆在他身後，跳過（記進 _skipped，isFinished 才算得對）。處理的是他自己的佇列；他帶頭時連伴奏的佇列一起（withEnsemble），依建批次的順序，同 tick 的音排在一起，所以追音順序就是樂譜順序。
  // 還沒送出的控制器不逐一重播：先把控制器軌帶到 T_k 之前的狀態（_chaseLane，在追音之前），還沒送出的整體參數 SysEx 依序馬上送（N12）。組裡被併入、還沒送出的他的音（own）同理；已經提早送出的取消不了（inFlight，記在 chase 事件裡）。
  _chaseOrSkip(p, ticks, scoreSec, clock, inFlight = 0, withEnsemble = false) {
    const E = this._ensemble;
    const left = withEnsemble ? bySeq(p.timed, E.timed) : p.timed;
    const leftClock = withEnsemble ? bySeq(p.clock, E.clock) : p.clock;
    if (!left.length && !leftClock.length && !inFlight) return;
    p.timed = [];
    p.clock = [];
    if (withEnsemble) { E.timed = []; E.clock = []; }
    let lanes = null;   // 有還沒送出的控制器的輸入 channel
    const notes = [];
    for (const it of left) {
      if (it.note) notes.push(it);
      else if (it.sysex) this._router.sendSysex(it.ev.data);
      else (lanes ??= new Set()).add(it.ev.channel);
    }
    for (const c of leftClock) if (c.ev) (lanes ??= new Set()).add(c.ev.channel);   // 自動放行已經在按下時做完了（_flushAutoReleases）
    if (lanes) for (const channel of lanes) this._chaseLane(channel, ticks);
    if (!notes.length && !inFlight) return;
    const chased = [], skipped = [];
    for (const it of notes) {
      if (it.note.endTick > ticks) {
        chased.push(it.note);
        this._sound(it.staff, it.note, clock + scaledMs(this._secOf(it.note.endTick) - scoreSec, p.tempo.playbackRate), clock, false, false, it.mode);
      } else {
        skipped.push(it.note);
        this._skipped.add(it.note);
      }
    }
    this.events.queue('chase', { group: p.index, slot: p.slot, ticks, chased, skipped, inFlight });
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

  // 讓一顆音發聲：記進 _sounded（每顆音恰好一次），交給發聲帳本 noteOn 並登記（hold、尾巴收尾、先進先出見 voices.js 的 sound()）。
  // hold 歸誰：演奏者的譜表歸他自己（等他自己的下一個起音）、伴奏的譜表歸合奏（等帶頭的人的起音）；音長看同一個人的速度。
  // dueMs＝預定發聲的時鐘時刻（你的音就是按下的那一刻）；fromTick＝由 tick() 放出（遲到統計只算這種）；timed＝你的合成器也照 lookahead 帶時間戳（組裡被併入的音）。
  // mode＝keyup 模式的發聲方式（keyupOf()／LIFTED，undefined／null＝非 keyup 模式）。
  _sound(staff, note, offMs, dueMs, fromTick = false, timed = false, mode = null) {
    this._sounded.add(note);
    const human = staff.kind === 'human';
    const owner = human ? this._bySlot.get(staff.slot) : this._holdOwner();
    this._ledger.sound(staff, note, offMs, dueMs, {
      holdScope: human ? staff.slot : 'ensemble', holdTicks: owner.plan.driverTicks, holdFrom: owner.cursor,
      rate: owner.tempo.playbackRate, fromTick, clockMs: this._clockMs, timed, mode: mode ?? null,
    });
  }

  // 所有演奏者與合奏的 timed 佇列裡、時刻已到（≤ limitMs）的項目依 (時刻, 建批次順序) 合併送出：伴奏的音、組裡他的音、送電腦合成器的控制器、SysEx。
  // fromTick＝由 tick() 呼叫（遲到統計只算這種，見 _sound）。組裡他的音照 lookahead 帶時間戳（主執行緒卡住也不會擠在一起），提早送出的記下來（_takeInFlight）。
  // 每個佇列只看最前面的項目（佇列內照原順序），單人時就是以前單一佇列的順序。
  _emitTimed(limitMs = this._clockMs, fromTick = false) {
    const queues = [this._ensemble.timed];
    for (const p of this._performers) queues.push(p.timed);
    const idx = new Array(queues.length).fill(0);
    for (;;) {
      let best = -1, it = null;
      for (let q = 0; q < queues.length; q++) {
        const x = queues[q][idx[q]];
        if (x === undefined || x.dueMs > limitMs + EPS_MS) continue;
        if (it === null || x.dueMs < it.dueMs || (x.dueMs === it.dueMs && x.seq < it.seq)) { best = q; it = x; }
      }
      if (best < 0) break;
      idx[best]++;
      if (it.note) {
        this._sound(it.staff, it.note, it.offMs, it.dueMs, fromTick, it.own, it.mode);
        if (it.own && it.dueMs > this._clockMs + EPS_MS) it.owner.ownSent.push(it.dueMs);
      } else if (it.sysex) this._router.sendSysex(it.ev.data, this._router.stampTime(it.dueMs));
      else this._sendControl(it);
    }
    if (idx[0]) this._ensemble.timed.splice(0, idx[0]);
    this._performers.forEach((p, i) => { if (idx[i + 1]) p.timed.splice(0, idx[i + 1]); });
  }

  // 所有演奏者與合奏的 clock 佇列裡、時刻已到（≤ limitMs）的項目依 (時刻, 建批次順序) 合併做：送他的合成器的控制器、組裡起音的自動放行。不提早（沒有 lookahead）：limitMs
  // 一律是時鐘。
  _emitClock(limitMs) {
    const queues = [this._ensemble.clock];
    for (const p of this._performers) queues.push(p.clock);
    const idx = new Array(queues.length).fill(0);
    for (;;) {
      let best = -1, it = null;
      for (let q = 0; q < queues.length; q++) {
        const x = queues[q][idx[q]];
        if (x === undefined || x.dueMs > limitMs + EPS_MS) continue;
        if (it === null || x.dueMs < it.dueMs || (x.dueMs === it.dueMs && x.seq < it.seq)) { best = q; it = x; }
      }
      if (best < 0) break;
      idx[best]++;
      if (it.autoRelease !== undefined) this._autoRelease(it.owner, it.autoRelease, it.dueMs);
      else this._sendControl(it);
    }
    if (idx[0]) this._ensemble.clock.splice(0, idx[0]);
    this._performers.forEach((p, i) => { if (idx[i + 1]) p.clock.splice(0, idx[i + 1]); });
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

  /** 量測：這首歌目前合奏的速度區間 { lo, hi }（帶頭的人的，rateBoundsFor 依他的聲部起音間隔算出的複本）。 */
  rateBounds() { return { ...this._holdOwner().tempo.bounds }; }

  // 按鍵嘗試的事件（按鍵記錄 pressLog() 是它的訂閱者）。result：'released' 放行、'blocked' 被去抖擋掉、'prelude' 前奏中的預按、'rest' 休止符鎖的預按、
  // 'ahead' 揮手超前被鎖住、'takeover' 代打交還時接手電腦剛替他放的音（不重彈）；
  // jumped＝落後跳到合奏位置（_jumpBehind）。ev 是輸入事件（見 trigger()）：來源與事件發生的時刻原樣記下（用槽位觸發時是 null）。
  _pressEvent(p, ev, clockMs, result, jumped = false) {
    this.events.queue('press', { group: p.index, slot: ev.slot, source: ev.source ?? null, key: ev.key ?? null, result, jumped, clockMs, eventTimeMs: ev.eventTimeMs ?? null, receivedMs: ev.receivedMs ?? null });
  }

  /** 量測：這一輪每次按鍵嘗試的記錄（複本）。clockMs 是排程器時鐘（暫停不走）；重設（stop／restart／換歌）時清空。 */
  pressLog() { return this._pressLog.log(); }

  /** 量測：這一輪每次放開的記錄（keyup 模式；複本）：槽位、鍵、排程器時鐘、收了幾顆音與兩個時刻。重設時清空。 */
  liftLog() { return this._pressLog.liftLog(); }

  /** 開啟錄音用的事件記錄（錨點、換錨、放行、每顆音實際發聲與收音的時刻、早按處理；見 scheduler.js 的 eventLogSubscriber）。 */
  enableEventLog() {
    if (!this._eventLog) this._eventLog = eventLogSubscriber(this.events);
  }

  /** 這一輪的事件記錄（複本；沒開就是空陣列）。重設（stop／restart／換歌）時清空。 */
  eventLog() { return this._eventLog ? this._eventLog.log() : []; }

  /**
   * 由 midiPlayer.js 的排程 tick（~12ms）每次呼叫：推進時鐘、放出到時間的伴奏音與組裡的音、收掉到期的音。
   * 演奏者觸發的起音永遠不在這裡放出，只來自 trigger()（例外：預按——前奏、休止符、揮手超前鎖——到點放出，與電腦代打中的人的起音）。
   * @param {number} nowMs  performance.now()
   * @param {number} [audioNow]  AudioContext 的目前時間（秒）。有給就啟用 lookahead：LOOKAHEAD_MS 以內要發聲／收音的電腦音
   *        提早帶時間戳送出；沒給（AudioContext 還沒就緒）就照到期時刻才發聲、不帶時間戳。
   */
  tick(nowMs, audioNow) {
    if (!this._playing || !this._score) return; // 沒有樂譜（load(null)）時空轉
    this._ensureEnsembleAnchored();
    const dt = this._lastTickMs == null ? 0 : Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));
    this._lastTickMs = nowMs;
    this._clockMs += dt;
    const timed = Number.isFinite(audioNow);
    this._router.setAudioBase(timed ? { audio: audioNow, clock: this._clockMs } : null);  // 只在這個 tick 內有效：按鍵、暫停的呼叫一律立刻處理
    try {
      this._askForecasters();   // 先換錨再收音發聲：這個 tick 放出的電腦音就照新的速度
      this._rosterTick();       // 換帶頭的人也在收音發聲之前：這個 tick 放出的伴奏就跟著新的帶頭者
      this._tickBody(timed ? this._clockMs + LOOKAHEAD_MS : this._clockMs);
      this._queueStateEvents();
    } finally {
      this._router.setAudioBase(null);
      this.events.flush();   // 對外事件在這個 tick 的合成器呼叫都送出之後才發
    }
  }

  // 狀態改變的事件，只在改變的那一刻發一次：各演奏者的播放頭停在他的下一個起音（停格開始；他按下去時 _release() 發「結束」）、
  // 所有音都發過聲而且收完（播完，整首一次）。
  _queueStateEvents() {
    for (const p of this._performers) {
      const reach = this._reachClockMs(p);
      if (!p.stalled && reach !== null && this._clockMs >= reach - EPS_MS) {
        p.stalled = true;
        this.events.queue('stall', { group: p.index, slot: p.slot, state: 'start', clockMs: reach });
      }
    }
    if (!this._finishSent && this.isFinished()) {
      this._finishSent = true;
      this.events.queue('finish', { clockMs: this._clockMs });
    }
  }

  // 問每位有掛預報器的演奏者（沒有預報器的什麼都不做）
  _askForecasters() {
    for (const p of this._performers) {
      const f = this._forecasters[p.index];
      if (f) this._applyForecast(p, f.forecast(this._forecastView(p)));
    }
  }

  // 給預報器看的唯讀資料：游標（下一個要他按的起音：還在進行的一組之後的那個）、時鐘、目前的錨點（可能已經換過錨）、這一段起點
  // （他上一次按的起音；改指派之後還沒按過就是前一個起音）與下一個要按的起音的樂譜秒（前奏時起點是 null、最後一段時下一個起音是
  // null）、速度追蹤目前的速度與區間。
  _forecastView(p) {
    const segs = p.plan.driverSegs, next = p.groupEnd, from = p.lastHead ?? next - 1;
    return {
      group: p.index, cursor: next, clockMs: this._clockMs, anchor: p.anchor && { ...p.anchor },
      segmentStartSec: from >= 0 ? this._secOf(segs[from].ticks) : null,
      nextOnsetSec: next < segs.length ? this._secOf(segs[next].ticks) : null,
      rate: p.tempo.playbackRate, rateBounds: { ...p.tempo.bounds },
    };
  }

  // 段中換錨（N2「預報入口」）：預報說他會在 f.atMs 按下一個起音，條件符合時以（現在, 此刻的樂譜位置 pos, r′）為新錨點，把他的佇列（他帶頭時連伴奏的）裡還沒送出、樂譜位置在 pos 之後的音與控制器照 r′ 重排時刻；同 tick 的、lookahead 已送出的、已經在響的、pos 之前已過期的都碰不到。
  // 近距起音分組進行中時，「下一個起音」是下一個要他按的組頭（組裡的起音到點自動放行，一起依新速度重排）。
  _applyForecast(p, f) {
    if (!f) return;
    const now = this._clockMs, j = p.groupEnd, next = p.plan.driverSegs[j], a = p.anchor;
    const reach = this._reachClockMs(p, j);
    const applied = j >= 1 && !!next && !!a && reach !== null && now < reach && f.atMs > now
      && Math.abs(f.atMs - reach) >= this.cfg.forecastMinChangeMs;
    this.events.queue('forecast', { group: p.index, index: j, clockMs: now, atMs: f.atMs, uncertaintyMs: f.uncertaintyMs ?? null, source: f.source ?? null, applied });
    if (!applied) return;
    const pos = a.scoreSec + ((now - a.clockMs) * a.rate) / 1000;   // 此刻的樂譜位置（還沒走到下一個起音：now < reach）
    const { lo, hi } = p.tempo.bounds;
    const rate = Math.min(hi, Math.max(lo, ((this._secOf(next.ticks) - pos) * 1000) / (f.atMs - now)));
    const anchor = { slice: a.slice, clockMs: now, scoreSec: pos, rate };
    const E = this._ensemble, withEnsemble = E.anchor === a;
    p.anchor = anchor;
    if (withEnsemble) E.anchor = anchor;
    let retimed = 0;
    // 控制器、組裡他的音與自動放行（兩個佇列都是）跟電腦音一起重排，時刻的換算相同；他帶頭時代打中的人的佇列也是（跟著合奏）
    const items = withEnsemble ? [...p.timed, ...p.clock, ...E.timed, ...E.clock, ...this._performers.filter((q) => q.status === 'substitute').flatMap((q) => [...q.timed, ...q.clock])] : [...p.timed, ...p.clock];
    for (const q of items) {
      const startSec = this._secOf(itemTick(q));
      if (startSec <= pos) continue;                                  // 已經過期、只是還沒放出：照原時刻（馬上）放
      q.dueMs = now + ((startSec - pos) * 1000) / rate;
      if (!q.note) continue;
      q.offMs = q.dueMs + scaledMs(this._secOf(q.note.endTick) - startSec, rate);
      retimed++;
    }
    this.events.queue('reanchor', { group: p.index, slice: a.slice, clockMs: now, scoreSec: pos, rate, retimed });
  }

  _tickBody(horizonMs) {
    this._ledger.closeDue(this._clockMs, horizonMs);     // 先收再放：到期的舊音在同一個 tick 要發聲的新音之前關掉（同音高的相連音才不會被連帶關掉）
    this._emitTimed(horizonMs, true);
    this._emitClock(this._clockMs);                      // 送他的合成器的控制器、組裡起音的自動放行：不提早
    this._ledger.closeDue(this._clockMs, horizonMs);     // 剛發聲就到期的短音
    // 預按到點放出。前奏鎖：他的播放頭走到入場點；休止符鎖：合奏走到他的起音；超前鎖：合奏走到只差 ENSEMBLE.AHEAD_RELEASE_BEATS 拍。放行時刻取「剛好到達」的那一刻
    //（不是這個 tick 的時鐘），他這一段的錨點因此接在合奏的時間軸上；落在這一刻到現在之間的電腦音由 _release() 裡的 _emitTimed() 補放。
    // 放出也算他觸發了一下（「正在彈」從這一刻算：休止中的原帶頭者在休止符鎖放出時拿回帶頭，見規格「合奏」）。
    for (const p of this._performers) {
      const c = p.credit;
      if (!c) continue;
      const tick = p.plan.driverTicks[p.groupEnd];
      const at = c.kind === 'prelude' ? this._reachClockMs(p)
        : this._ensembleReachMs(c.kind === 'ahead' ? this._ticksBefore(tick, ENSEMBLE.AHEAD_RELEASE_BEATS) : tick);
      if (at === null || this._clockMs < at - EPS_MS) continue;
      // keyup 模式的預按：放出時鍵還按著就等 keyup，已經放開就照檔案長度收
      const keyup = c.key != null ? (c.lifted ? LIFTED : keyupOf(c.key)) : null;
      p.lastTriggerMs = Math.max(p.lastTriggerMs, at);
      this._flushAutoReleases(p, at);
      this._release(p, at, c.source, 0, keyup, c.kind === 'ahead');
    }
  }

  // tick 往前 beats 拍的位置（SMPTE 一拍 ENSEMBLE.SMPTE_BEAT_SEC）
  _ticksBefore(tick, beats) {
    const s = this._score;
    return s.timeDivision ? tick - beats * s.timeDivision : s.secondsToMIDITicks(this._secOf(tick) - beats * ENSEMBLE.SMPTE_BEAT_SEC);
  }

  // 合奏走到 target（tick）的時鐘時刻；還沒走到回 null。依合奏錨點推回去，夾在錨點與現在之間（跳過去、停住等不倒退造成的到達算錨點那一刻）。
  _ensembleReachMs(target) {
    if (this.getPositionTicks() < target - 1e-6) return null;
    const a = this._ensemble.anchor;
    return Math.min(this._clockMs, Math.max(a.clockMs, a.clockMs + ((this._secOf(target) - a.scoreSec) * 1000) / a.rate));
  }
}
