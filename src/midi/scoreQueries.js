// ============================================================
//  scoreQueries.js — 衍生層：從解析結果算出來的查詢——全曲的垂直切片（segments）、某個 tick 之前的控制器狀態與 chase 序列。
//  純邏輯，無 DOM／CDN 依賴。
// ============================================================

import { byFileOrder } from './instruments.js';

/** @typedef {import('./midiParser.js').LaneEvent} LaneEvent */
/** @typedef {import('./midiParser.js').ControllerState} ControllerState */

// 全曲的垂直切片（名稱借自 MuseScore 的 Segment：同一個 tick 上所有譜表的音）。notes 已依 startTick 排序，所以相同
// startTick 的音一定相鄰，一次線性掃描就分完（時間 O(n)）。這是「總譜觸發」的最小單位：排程器一次放行一個 segment，
// 全曲所有聲部在同一次呼叫內一起起音，上下對齊由結構保證，不靠時間比對。
export function buildSegments(notes) {
  const segments = [];
  for (const note of notes) {
    const last = segments[segments.length - 1];
    if (last && last.ticks === note.startTick) last.notes.push(note);
    else segments.push({ ticks: note.startTick, notes: [note] });
  }
  return segments;
}

/* ═══════════════════════════════════════════
   控制器狀態查詢與 chase 序列
   ═══════════════════════════════════════════ */

// 用途：你早按、垂直切片跳過一段時，補上那一段的控制器狀態（例如中間踩下又放開的踏板）；暫停後續播；播放中改指派、
// 輸出 channel 重新分配時重送狀態。目前還沒有呼叫端（演奏不重播控制器）。
// 依據：MIDI 1.0（RPN／NRPN 先選參數再送 data entry；選了新參數之後，那個參數保留舊值直到收到新的 data entry；收到 MSB 時
// LSB 視為 0）、GM2 §3.5.2（CC121 的重設表）、GM2 §3.3.1（Bank Select 要等下一個 Program Change 才生效）。
// 對照官方 SpessaSynth：Sequencer 跳時間（setTimeTo）時，選參數／data entry／bank select 依序全部重送、其他 CC 只送最後一次、
// CC121 當成狀態重設而不重送；這裡是同一個概念，但每個狀態只留決定它的最少事件。

const CC = Object.freeze({
  BANK_MSB: 0, DATA_MSB: 6, BANK_LSB: 32, DATA_LSB: 38, DATA_INC: 96, DATA_DEC: 97,
  NRPN_LSB: 98, NRPN_MSB: 99, RPN_LSB: 100, RPN_MSB: 101, RESET_ALL: 121, MONO: 126, POLY: 127,
});
// CC121 Reset All Controllers（GM2 §3.5.2）：調變 0、表情 127、延音踏板 0、滑音開關 0、持音踏板 0、弱音踏板 0；另外 pitch bend
// 回中心、channel pressure 回 0、RPN 回 null（7F 7F）。音量、聲像、program、bank、滑音時間（CC5）、殘響／合唱深度不動。
// （GML-v1 §3.2.5.2 是這張表的子集；GM2 這張跟官方 SpessaSynth 依 RP-015 的實作一致。）
const RESET_CC = new Map([[1, 0], [11, 127], [64, 0], [65, 0], [66, 0], [67, 0]]);
// 瞬間指令，不留狀態、不重播：All Sound Off、All Notes Off、Omni Off／On（GM2 §3.5.4／§3.5.5：只關音、不改模式）。
const INSTANT_CC = new Set([120, 123, 124, 125]);
const SELECT_CC = new Set([CC.RPN_MSB, CC.RPN_LSB, CC.NRPN_MSB, CC.NRPN_LSB]);
const DATA_CC = new Set([CC.DATA_MSB, CC.DATA_LSB, CC.DATA_INC, CC.DATA_DEC]);

// 原檔沒有、由狀態推出來要補送的事件（CC121 之後的預設值、選參數）：位置借用推出它的那個事件（排序用），id 是 null。
function syntheticEvent(at, type, data1, data2) {
  const value = type === 'pitchBend' ? (data2 << 7) | data1 : type === 'channelAftertouch' ? data1 : data2;
  return { id: null, synthetic: true, ticks: at.ticks, trackIndex: at.trackIndex, eventIndex: at.eventIndex, channel: at.channel, type, data1, data2, value };
}

/**
 * 一個 channel 的控制器狀態：依原檔順序逐一 apply() 這個 channel 的控制器軌事件。snapshot()＝目前的狀態；chase()＝把一個
 * 「全新、或照這個檔案播到更早位置」的 channel 帶到目前狀態的最少事件，依原檔順序。apply() 每個事件 O(1)；chase() 與 snapshot()
 * 是 O(狀態數)，所以呼叫端可以邊播邊 apply，需要時再 chase()。
 */
export class ChannelStateTracker {
  constructor() {
    this._cc = new Map();          // 一般控制器 → { value, event }：event 是 chase 要送的（原檔事件，或 CC121 之後合成的預設值）；null＝不必送
    this._bank = { msb: null, lsb: null };   // 最後一次的 CC0／CC32 事件（bank 暫存器）
    this._program = null;          // { event, bankMsb, bankLsb }：最後一個 program change，與它當下生效的 bank 事件
    this._pitchBend = null;        // { value, event }
    this._pressure = null;         // { value, event }
    this._poly = new Map();        // 音高 → 最後一個 poly pressure 事件
    this._mode = null;             // 最後一個 CC126（mono）／CC127（poly）
    this._regs = { rpn: [null, null], nrpn: [null, null] };   // 選參數的暫存器 [MSB 事件, LSB 事件]
    this._current = null;          // 'rpn'｜'nrpn'｜null：最後選的是哪一種
    this._params = new Map();      // 'rpn:MSB:LSB' → { type, msb, lsb, value: [MSB, LSB], adjusted, sessions }
    this._open = null;             // 目前選取的參數正在進行的 session（選參數之後第一個 data entry 開始，再選參數就結束）
    this._lastSelect = null;       // 最後一個改了選參數暫存器的事件（CC121 之後是合成的 RPN null）：還原選參數時借它的位置
    this._dataRaw = new Map();     // CC6／38／96／97 最後的原始值（只給快照）
  }

  /** @param {LaneEvent} ev  同一個 channel 的控制器軌事件，依原檔順序 */
  apply(ev) {
    if (ev.type === 'programChange') { this._program = { event: ev, bankMsb: this._bank.msb, bankLsb: this._bank.lsb }; return; }
    if (ev.type === 'pitchBend') { this._pitchBend = { value: ev.value, event: ev }; return; }
    if (ev.type === 'channelAftertouch') { this._pressure = { value: ev.value, event: ev }; return; }
    if (ev.type === 'polyAftertouch') { this._poly.set(ev.data1, ev); return; }
    const cc = ev.data1;
    if (INSTANT_CC.has(cc)) return;
    if (cc === CC.RESET_ALL) this._resetAll(ev);
    else if (cc === CC.MONO || cc === CC.POLY) this._mode = ev;
    else if (cc === CC.BANK_MSB) this._bank.msb = ev;
    else if (cc === CC.BANK_LSB) this._bank.lsb = ev;
    else if (SELECT_CC.has(cc)) this._select(ev);
    else if (DATA_CC.has(cc)) this._data(ev);
    else this._cc.set(cc, { value: ev.value, event: ev });
  }

  // CC121：之前設過的才需要在 chase 裡送合成的預設值；從沒設過的本來就是預設值，不送（MuseScore 每個 channel 在 tick 0 都送 CC121）。
  _resetAll(ev) {
    for (const [cc, value] of RESET_CC) {
      const prev = this._cc.get(cc);
      this._cc.set(cc, { value, event: prev?.event ? syntheticEvent(ev, 'controlChange', cc, value) : null });
    }
    this._pitchBend = { value: 8192, event: this._pitchBend?.event ? syntheticEvent(ev, 'pitchBend', 0, 64) : null };
    this._pressure = { value: 0, event: this._pressure?.event ? syntheticEvent(ev, 'channelAftertouch', 0, 0) : null };
    if (this._current) {   // 選過參數才需要還原成 RPN null；從沒選過等同 null
      this._regs.rpn = [syntheticEvent(ev, 'controlChange', CC.RPN_MSB, 127), syntheticEvent(ev, 'controlChange', CC.RPN_LSB, 127)];
      this._current = 'rpn';
      this._lastSelect = this._regs.rpn[1];
    }
    this._open = null;
  }

  _select(ev) {
    const cc = ev.data1;
    const type = cc === CC.RPN_MSB || cc === CC.RPN_LSB ? 'rpn' : 'nrpn';
    this._regs[type][cc === CC.RPN_MSB || cc === CC.NRPN_MSB ? 0 : 1] = ev;
    this._current = type;
    this._open = null;
    this._lastSelect = ev;
  }

  // data entry 套到目前選的參數；沒選、只選了一半、或選的是 RPN null（7F 7F）就沒有作用。
  _data(ev) {
    this._dataRaw.set(ev.data1, ev.data2);
    const p = this._currentParam();
    if (!p) return;
    if (!this._open) { this._open = { events: [], hasMsb: false }; p.sessions.push(this._open); }
    this._open.events.push(ev);
    if (ev.data1 === CC.DATA_MSB) { p.value = [ev.data2, 0]; p.adjusted = false; this._open.hasMsb = true; }   // MIDI 1.0：收到 MSB 時 LSB 視為 0
    else if (ev.data1 === CC.DATA_LSB) p.value = [p.value[0], ev.data2];
    else p.adjusted = true;   // CC96／97：一次加減多少各家不同（官方 SpessaSynth 不處理），快照不換算，只在 chase 裡原樣重播
  }

  _currentParam() {
    if (!this._current) return null;
    const [msbEv, lsbEv] = this._regs[this._current];
    if (!msbEv || !lsbEv) return null;
    const msb = msbEv.data2, lsb = lsbEv.data2;
    if (this._current === 'rpn' && msb === 127 && lsb === 127) return null;
    const key = `${this._current}:${msb}:${lsb}`;
    let p = this._params.get(key);
    if (!p) this._params.set(key, (p = { type: this._current, msb, lsb, value: [null, null], adjusted: false, sessions: [] }));
    return p;
  }

  /** @returns {ControllerState} 見 midiParser.js 的型別說明 */
  snapshot() {
    const cc = new Array(128).fill(null);
    for (const [n, s] of this._cc) cc[n] = s.value;
    if (this._bank.msb) cc[CC.BANK_MSB] = this._bank.msb.value;
    if (this._bank.lsb) cc[CC.BANK_LSB] = this._bank.lsb.value;
    for (const [n, v] of this._dataRaw) cc[n] = v;
    const reg = (type, i) => this._regs[type][i]?.value ?? null;
    cc[CC.RPN_MSB] = reg('rpn', 0); cc[CC.RPN_LSB] = reg('rpn', 1); cc[CC.NRPN_MSB] = reg('nrpn', 0); cc[CC.NRPN_LSB] = reg('nrpn', 1);
    return {
      cc,
      program: this._program?.event.value ?? null,
      programBank: this._program ? { msb: this._program.bankMsb?.value ?? null, lsb: this._program.bankLsb?.value ?? null } : null,
      pitchBend: this._pitchBend?.value ?? null,
      channelPressure: this._pressure?.value ?? null,
      polyPressure: new Map([...this._poly].map(([key, ev]) => [key, ev.value])),
      mode: this._mode ? (this._mode.data1 === CC.MONO ? 'mono' : 'poly') : null,
      selection: this._current ? { type: this._current, msb: reg(this._current, 0), lsb: reg(this._current, 1) } : null,
      parameters: new Map([...this._params].map(([key, p]) => [key, { type: p.type, msb: p.msb, lsb: p.lsb, value: [...p.value], adjusted: p.adjusted }])),
    };
  }

  /** @returns {LaneEvent[]}  依原檔順序；合成的事件 synthetic: true、id: null */
  chase() {
    const items = [];   // { at: 決定順序的事件, events: 要送的事件 }
    const add = (at, events) => items.push({ at, events });
    for (const s of this._cc.values()) if (s.event) add(s.event, [s.event]);
    if (this._mode) add(this._mode, [this._mode]);
    const { msb, lsb } = this._bank;
    if (this._program) {
      const { event, bankMsb, bankLsb } = this._program;
      add(event, [bankMsb, bankLsb, event].filter(Boolean));   // program 連同它當下生效的 bank select
      if (msb && msb !== bankMsb) add(msb, [msb]);              // program 之後又送、還沒被 program change 用到的 bank select
      if (lsb && lsb !== bankLsb) add(lsb, [lsb]);
    } else {
      if (msb) add(msb, [msb]);
      if (lsb) add(lsb, [lsb]);
    }
    if (this._pitchBend?.event) add(this._pitchBend.event, [this._pitchBend.event]);
    if (this._pressure?.event) add(this._pressure.event, [this._pressure.event]);
    for (const ev of this._poly.values()) add(ev, [ev]);
    for (const g of this._parameterGroups()) add(g.at, g.events);
    // 選參數的還原接在原檔的位置（還沒結束的 session 的第一個事件，沒有就是最後一次選參數），不是放在最後：官方 SpessaSynth 會把
    // GS 的 NRPN（例如 1/8 vibrato rate）換成 CC76 等控制器，原檔之後若又直接送那個 CC，順序錯了值就會被蓋掉。所有參數群組都在
    // 最後一次選參數之前結束，所以這個位置一定在它們之後。
    const tail = this._selectionTail();
    if (tail.length) add(this._open?.events[0] ?? this._lastSelect, tail);
    items.sort((a, b) => byFileOrder(a.at, b.at));   // sort 是穩定排序：同一個位置（同一個 CC121 推出來的）維持加入順序
    return items.flatMap((i) => i.events);
  }

  // 每個參數的值由「最後一個含 MSB 的 session 起」的 session 決定（更早的被那個 MSB 蓋掉）；每個 session 前面補選參數。這樣重播
  // 之後的值跟照檔案播一樣——不管接收端是「收到 MSB 時 LSB 歸 0」（MIDI 1.0），還是「選參數時清掉 data entry 暫存器」（官方
  // SpessaSynth）。目前參數還沒結束的 session 不放在這裡，留到 _selectionTail() 才送（CC96／97 不能重複套用）。
  _parameterGroups() {
    const groups = [];
    for (const p of this._params.values()) {
      const from = Math.max(0, p.sessions.findLastIndex((s) => s.hasMsb));
      const kept = p.sessions.slice(from).filter((s) => s !== this._open);
      if (!kept.length) continue;
      const [msbCC, lsbCC] = p.type === 'rpn' ? [CC.RPN_MSB, CC.RPN_LSB] : [CC.NRPN_MSB, CC.NRPN_LSB];
      const events = kept.flatMap((s) => [syntheticEvent(s.events[0], 'controlChange', msbCC, p.msb), syntheticEvent(s.events[0], 'controlChange', lsbCC, p.lsb), ...s.events]);
      groups.push({ at: kept.at(-1).events.at(-1), events });
    }
    return groups;
  }

  // 把選參數的暫存器還原成目前的狀態：先另一種、再目前這一種（最後選的那一種就是目前的），再重播目前參數還沒結束的 session。
  _selectionTail() {
    if (!this._current) return [];
    const other = this._current === 'rpn' ? 'nrpn' : 'rpn';
    return [...this._regs[other].filter(Boolean), ...this._regs[this._current].filter(Boolean), ...(this._open?.events ?? [])];
  }
}

function trackerAt(lane, tick) {
  const tracker = new ChannelStateTracker();
  for (const ev of lane) { if (ev.ticks >= tick) break; tracker.apply(ev); }
  return tracker;
}

/** 某個 tick 之前（不含）這個 channel 的控制器狀態。lane＝parsed.channelLanes.get(channel)。O(這個 tick 之前的事件數)。 */
export function controllerStateAt(lane, tick) { return trackerAt(lane, tick).snapshot(); }

/** 把 channel 帶到這個 tick 之前（不含）狀態的最少事件，依原檔順序（合約見 ChannelStateTracker）。 */
export function chaseEventsAt(lane, tick) { return trackerAt(lane, tick).chase(); }
