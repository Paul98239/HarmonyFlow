// ============================================================
//  performanceEvents.js — 演奏的對外事件：排程器在 trigger()／tick()／暫停等呼叫裡先把事件排隊，呼叫結束、合成器的呼叫都送出
//  之後才發給訂閱者（flush）——訂閱者的工作不會擋在你的音前面。訂閱者丟出的例外被隔離（印 console.error 後略過），不影響演奏。
//  統計（遲到、早按處理、按鍵記錄）是這裡的標準訂閱者；視覺化與測試工具之後也直接訂閱。純邏輯，無 DOM。
//
//  事件（press／release／group／autoRelease／anchor／chase／stall／forecast／reanchor 帶 group：driver 群組編號，現在永遠是 0；noteOn／noteOff
//  是譜表的事件、finish 是整首的，不帶）：
//    press    { slot, source, result: 'released'｜'blocked'｜'prelude', clockMs, eventTimeMs, receivedMs }   每一次按鍵嘗試
//    release  { index, ticks, clockMs }                       放行第 index 個 driver segment（你按的起音＝組頭）
//    group    { index, ticks, merged: [{ index, ticks }], clockMs }   組頭放行時併入的近距起音（按不及，到點自動放行）
//    autoRelease { index, ticks, dueMs, clockMs }             組裡被併入的起音到點自動放行（收掉 endTick ≤ 它的你的音、放行等它的 hold）
//    anchor   { slice, clockMs, scoreSec, rate }              啟動一段電腦聲部（錨點）
//    noteOn   { note, noteId, staffId, kind, dueMs, clockMs, timed, fromTick, lateMs }   kind：'human'（你的）｜'assist'（電腦的）
//    noteOff  { note, noteId, staffId, kind, offMs, clockMs, timed }
//    chase    { ticks, chased: note[], skipped: note[], inFlight }   你早按時上一段殘餘的電腦音與組內音：追音與跳過；inFlight＝組裡已經
//             提早帶時間戳送出、取消不了的你的音（會在按下之後 ≤ 50ms 響）
//    stall    { state: 'start'｜'end', clockMs }              播放頭停在你的下一個起音（等你按）／你按下去
//    finish   { clockMs }                                     所有音都發過聲而且收完
//    forecast { index, clockMs, atMs, uncertaintyMs, source, applied }   預報器的預報（每個 tick 一次；applied：有沒有拿來換錨）
//    reanchor { slice, clockMs, scoreSec, rate, retimed }    段中換錨（retimed：重排了幾顆還沒送出的電腦音）
//    control  { id, ticks, type, outputs: [{ kind, channel }], dueMs, clockMs }   送出一個控制器軌的事件（id＝「軌序號:軌內序號」；
//             outputs＝送到哪些輸出 channel）。控制器可能很密（pitch bend 上萬個），排程器先問 has('control') 才組內容
// ============================================================

import { summarizeMs } from './pressTiming.js';

// 量測用：電腦音遲到量最多留幾筆（超過就丟最舊的），避免長時間播放無限成長。
const LATE_SAMPLES_MAX = 5000;
// 按鍵記錄最多留幾筆（超過就丟最舊的），避免長時間播放無限成長。
const PRESS_LOG_MAX = 20000;
// 錄音用的事件記錄最多留幾筆（每顆音一筆，一首最密的歌整首約一萬多筆）。
const EVENT_LOG_MAX = 100000;

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

// 三個標準訂閱者的狀態都放在回傳物件自己的欄位（不藏在閉包裡）：排程器的重設測試通用地走整個物件圖，看得到才抓得到「忘了重設」。

/** 標準訂閱者：tick() 放出的電腦音比排好的時刻晚了多少（見 scheduler.js 的 lateStats()）。 */
export function lateStatsSubscriber(events) {
  const sub = { samples: [], stats() { return summarizeMs(this.samples); }, reset() { this.samples = []; } };
  events.on('noteOn', (e) => {
    // 只記 tick() 放出的電腦音：按鍵呼叫內同刻放出的音（時鐘就是按下的那一刻）沒有「等 tick」這回事，記進去只會把統計稀釋成 0；
    // 組裡到點放出的你的音不是電腦音。
    if (e.fromTick && e.kind === 'assist') {
      sub.samples.push(e.lateMs);
      if (sub.samples.length > LATE_SAMPLES_MAX) sub.samples.shift();
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

/** 標準訂閱者：每次按鍵嘗試的記錄（見 scheduler.js 的 pressLog()）。 */
export function pressLogSubscriber(events) {
  const sub = { entries: [], log() { return this.entries.map((p) => ({ ...p })); }, reset() { this.entries = []; } };
  events.on('press', (e) => {
    sub.entries.push({ slot: e.slot, clockMs: e.clockMs, released: e.result === 'released', source: e.source, eventTimeMs: e.eventTimeMs, receivedMs: e.receivedMs });
    if (sub.entries.length > PRESS_LOG_MAX) sub.entries.shift();
  });
  return sub;
}

/**
 * 錄音用的事件記錄（排程器的 enableEventLog() 才掛）：錨點與換錨（速度）、放行、每顆音實際發聲的時刻、早按處理，存成可以轉 JSON 的
 * 小物件，音符用 id（「軌序號:軌內序號」，同一版 parser 解析同一個檔一定相同）。實際發聲時刻（排程器時鐘）：帶時間戳的電腦音在時間戳
 * 發聲（時間戳已經過去就在送出的當下），其餘在送出的當下。
 */
export function eventLogSubscriber(events) {
  const sub = { entries: [], log() { return this.entries.map((e) => ({ ...e })); }, reset() { this.entries = []; } };
  const push = (entry) => { sub.entries.push(entry); if (sub.entries.length > EVENT_LOG_MAX) sub.entries.shift(); };
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
