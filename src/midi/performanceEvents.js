// ============================================================
//  performanceEvents.js — 演奏的對外事件：排程器在 trigger()／tick()／暫停等呼叫裡先把事件排隊，呼叫結束、合成器的呼叫都送出
//  之後才發給訂閱者（flush）——訂閱者的工作不會擋在你的音前面。訂閱者丟出的例外被隔離（印 console.error 後略過），不影響演奏。
//  統計（遲到、早按處理、按鍵記錄）是這裡的標準訂閱者；視覺化與測試工具之後也直接訂閱。純邏輯，無 DOM。
//
//  事件（press／release／anchor／chase／stall 帶 group：driver 群組編號，現在永遠是 0；noteOn／noteOff 是譜表的事件、finish 是整首的，不帶）：
//    press    { slot, source, result: 'released'｜'blocked'｜'prelude', clockMs, eventTimeMs }   每一次按鍵嘗試
//    release  { index, ticks, clockMs }                       放行第 index 個 driver segment（你的起音）
//    anchor   { slice, clockMs, scoreSec, rate }              啟動一段電腦聲部（錨點）
//    noteOn   { note, noteId, staffId, kind, dueMs, clockMs, timed, fromTick, lateMs }   kind：'human'（你的）｜'assist'（電腦的）
//    noteOff  { note, noteId, staffId, kind, offMs, clockMs, timed }
//    chase    { ticks, chased: note[], skipped: note[] }      你早按時上一段殘餘的電腦音：追音與跳過
//    stall    { state: 'start'｜'end', clockMs }              播放頭停在你的下一個起音（等你按）／你按下去
//    finish   { clockMs }                                     所有音都發過聲而且收完
// ============================================================

import { summarizeMs } from './pressTiming.js';

// 量測用：電腦音遲到量最多留幾筆（超過就丟最舊的），避免長時間播放無限成長。
const LATE_SAMPLES_MAX = 5000;
// 按鍵記錄最多留幾筆（超過就丟最舊的），避免長時間播放無限成長。
const PRESS_LOG_MAX = 20000;

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
    // 只記 tick() 放出的：按鍵呼叫內同刻放出的音（時鐘就是按下的那一刻）沒有「等 tick」這回事，記進去只會把統計稀釋成 0。
    if (e.fromTick) {
      sub.samples.push(e.lateMs);
      if (sub.samples.length > LATE_SAMPLES_MAX) sub.samples.shift();
    }
  });
  return sub;
}

/** 標準訂閱者：你早按時的追音與跳過（見 scheduler.js 的 chaseStats()）。 */
export function chaseStatsSubscriber(events) {
  const sub = { counts: { presses: 0, chased: 0, skipped: 0 }, stats() { return { ...this.counts }; }, reset() { this.counts = { presses: 0, chased: 0, skipped: 0 }; } };
  events.on('chase', (e) => {
    sub.counts.presses++;
    sub.counts.chased += e.chased.length;
    sub.counts.skipped += e.skipped.length;
  });
  return sub;
}

/** 標準訂閱者：每次按鍵嘗試的記錄（見 scheduler.js 的 pressLog()）。 */
export function pressLogSubscriber(events) {
  const sub = { entries: [], log() { return this.entries.map((p) => ({ ...p })); }, reset() { this.entries = []; } };
  events.on('press', (e) => {
    sub.entries.push({ slot: e.slot, clockMs: e.clockMs, released: e.result === 'released', source: e.source, eventTimeMs: e.eventTimeMs });
    if (sub.entries.length > PRESS_LOG_MAX) sub.entries.shift();
  });
  return sub;
}
