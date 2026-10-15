// performancePlan.js — 演奏計畫（純邏輯，無 DOM）：依樂譜＋指派建出譜表（staff：發聲與輸出 channel 的單位）、driver 群組、總音數與 hold 容差上限。
// 載入、改指派時重建，之後不變；游標、錨點、電腦音佇列這些執行期狀態在排程器的群組狀態（scheduler.js）。
// 現在永遠只有一個群組（所有被指派的槽位、全部的 follower）；多群組時 follower 跟誰、群組怎麼對時屬於多人分工規則，等手勢接回再定。
// 一個 MuseScore 樂器是一個 part，底下有一個以上 staff（鋼琴兩行譜＝兩個）；指派以 part 為單位，發聲與輸出 channel 以 staff 為單位。
// 控制器屬於輸入 channel（parser 的 channelLanes），扇出到所有來源是該 channel 的譜表（lanes）；播放中途的控制器跟 follower 音一樣依 driver 起音切段。

import { rateBoundsFor } from './tempo.js';
import { GM_DEFAULT_VOLUME, holdCapTicksFor } from './voices.js';
import { byFileOrder } from './midiParser.js';

// ── 譜表（staff）建構 ──

// 一個 part 的 staff 規格：沒有 staves 的 part（手工組的舊資料形狀）視為單一 staff，id 沿用 part.id
export function staffSpecsOf(part) {
  if (part.staves) return part.staves.map((s) => ({ ...s, partId: part.id }));
  return [{ id: part.id, partId: part.id, program: part.program ?? 0, bank: part.bank ?? { msb: 0, lsb: 0 }, percussionKit: !!part.percussionKit, init: null }];
}

// 音符屬於哪個 staff：舊資料形狀的音符沒有 staffId，用 partId（同 staffSpecsOf 的單一 staff id）
export const staffKeyOf = (note) => note.staffId ?? note.partId;

function makeStaff(spec, slot, notes, kind, channel) {
  return {
    id: spec.id, partId: spec.partId, slot, kind, channel, notes,
    sourceChannel: spec.channel,   // 檔案裡的（絕對）輸入 channel：控制器軌依它扇出（舊資料形狀沒有）
    program: spec.program ?? 0, bank: spec.bank, init: spec.init ?? null, percussionKit: !!spec.percussionKit,
    baseVolume: spec.init?.volume ?? GM_DEFAULT_VOLUME, // 檔案 tick 0 的 CC7，沒有就是 GM 預設 100；載入時送一次
    sounding: new Map(),    // 音高 → [{ endTick, offMs }]：正在響的音，同音高重疊時先進先出收音（voices.js 操作它）
  };
}

// 這個 staff 被指派給誰（槽位，沒有回 undefined）。指派單位是 part，但多行譜的 part 也可只指派其中一個 staff：staff id 優先於 part id
export const slotOfSpec = (assignments, spec) => assignments.get(spec.id) ?? assignments.get(spec.partId);

// 指派表可以是 Map 或 [partId／staffId, 槽位][]（同 Scheduler.load()）
const toAssignMap = (assignments) => (assignments instanceof Map ? assignments : new Map(assignments || []));

// 指派與未指派兩個池子的 staff 規格（依總譜順序）：指派的走真人合成器、未指派的走電腦輔助合成器，各自配輸出 channel。portsNeeded() 與 buildPlan() 共用
export function staffPools(score, assignments) {
  const assignMap = toAssignMap(assignments);
  const assigned = [], assist = [];
  for (const part of score?.parts || []) {
    for (const spec of staffSpecsOf(part)) (slotOfSpec(assignMap, spec) !== undefined ? assigned : assist).push(spec);
  }
  return { assigned, assist };
}

// 兩個池子各自配輸出 channel（voices.js 的 allocate()）；配額用完的 staff 回報在 unplaced，這一輪不出聲
function buildStaves(score, assignments, router) {
  const staves = new Map(); // staffId → staff
  const unplaced = [];

  const notesByStaff = new Map(); // score.notes 已依 startTick 排序，照順序分組即可
  for (const n of score.notes) {
    const key = staffKeyOf(n);
    let list = notesByStaff.get(key);
    if (!list) notesByStaff.set(key, (list = []));
    list.push(n);
  }

  const { assigned, assist } = staffPools(score, assignments);
  const { humanCh, assistCh, unplaced: u } = router.allocate(assigned, assist);
  unplaced.push(...u);

  for (const spec of assigned) {
    const channel = humanCh.get(spec.id);
    if (channel === undefined) continue;
    staves.set(spec.id, makeStaff(spec, slotOfSpec(assignments, spec), notesByStaff.get(spec.id) || [], 'human', channel));
  }
  for (const spec of assist) {
    const channel = assistCh.get(spec.id);
    if (channel === undefined) continue;
    staves.set(spec.id, makeStaff(spec, null, notesByStaff.get(spec.id) || [], 'assist', channel));
  }
  return { staves, unplaced };
}

// ── 控制器 ──

// 播放中途的 bank select 若會讓輸出 channel 在打擊與旋律之間互換（打擊的判定同 parser：bank MSB 120），不送到這個譜表：
// 輸出 channel 是依打擊／旋律分配的，中途互換要重新分配（不做，見 buildControls 的警告）。
export const switchesKit = (staff, ev) => ev.type === 'controlChange' && ev.data1 === 0 && (ev.value === 120) !== staff.percussionKit;

// 狀態補送（chase）不送 tick 0 的 bank select／program change：tick 0 的音色是初始音色的事（staff.program／bank，A9），從控制器軌重送可能矛盾
const isPatchEvent = (ev) => ev.type === 'programChange' || (ev.type === 'controlChange' && (ev.data1 === 0 || ev.data1 === 32));
export const stateEvents = (events) => events.filter((ev) => ev.ticks > 0 || !isPatchEvent(ev));

// 每條控制器軌扇出到所有「來源是這個輸入 channel」而且分到了輸出 channel 的譜表；同一個輸出（合成器＋channel）只算一次
// （同一種鼓組的打擊譜表共用一個打擊槽）。回傳 輸入 channel → { events: 控制器軌, targets: 譜表 }，只收有事件也有目標的。
function buildLanes(score, staves) {
  const lanes = new Map();
  for (const [channel, events] of score.channelLanes ?? []) {
    if (!events.length) continue;
    const outputs = new Set(), targets = [];
    for (const staff of staves.values()) {
      const out = `${staff.kind}:${staff.channel}`;
      if (staff.sourceChannel === channel && !outputs.has(out)) { outputs.add(out); targets.push(staff); }
    }
    if (targets.length) lanes.set(channel, { events, targets });
  }
  return lanes;
}

// 每首歌每種警告只出現一次（改指派會重建計畫）
const warned = new WeakMap();   // score → Set<警告種類>
function warnOnce(score, kind, message) {
  let kinds = warned.get(score);
  if (!kinds) warned.set(score, (kinds = new Set()));
  if (kinds.has(kind)) return;
  kinds.add(kind);
  console.warn(message);
}

// SysEx 轉送規則（分類見 parts.js 的 classifySysex）：'reset'（GM／GM2 On、GM Off、GS Reset、XG On）不送，會清掉我們每個 channel 的設定；
// 'global'（GS／XG 不指定 part 的參數，與 Universal Real Time 的 Device Control 7F dev 04 01～05）兩個合成器都送、時間照檔案；
// 'skip'（指定 part 的參數，輸出 channel 重新分配後位址對不上；其他廠商、資料請求、F7 escape 等分不出的）略過，不猜。
const RESET_SYSEX = new Set(['gmOn', 'gmOff', 'gm2On', 'gsReset', 'xgOn']);
export function sysexAction(ev) {
  if (RESET_SYSEX.has(ev.category)) return 'reset';
  if (ev.category === 'gsParameter' || ev.category === 'xgParameter') return ev.channelSpecific ? 'skip' : 'global';
  if (ev.category === 'universalRealTime' && ev.data[2] === 0x04 && ev.data[3] >= 0x01 && ev.data[3] <= 0x05) return 'global';
  return 'skip';
}

// 播放中途（tick > 0）的控制器與整體參數 SysEx，依檔案順序（tick → 軌序 → 軌內序）；tick 0 的是狀態，載入時一次送（scheduler.js 的 _sendInitialState）。
// 控制器分成送真人合成器（human）與電腦合成器（assist）的目標譜表，SysEx 是 { ev, sysex: true } 兩邊都送。
// 會讓打擊與旋律互換的 bank select 不送（switchesKit）；略過的 SysEx 與 bank select 整首各警告一次。
function buildControls(score, lanes) {
  const controls = [];
  let switched = 0;
  for (const { events, targets } of lanes.values()) {
    const human = targets.filter((s) => s.kind === 'human'), assist = targets.filter((s) => s.kind === 'assist');
    for (const ev of events) {
      if (ev.ticks === 0) continue;
      if (!targets.some((s) => switchesKit(s, ev))) { controls.push({ ev, human, assist }); continue; }
      const h = human.filter((s) => !switchesKit(s, ev)), a = assist.filter((s) => !switchesKit(s, ev));
      switched += targets.length - h.length - a.length;
      if (h.length || a.length) controls.push({ ev, human: h, assist: a });
    }
  }
  if (switched) warnOnce(score, 'kitSwitch', `這首歌有 ${switched} 處播放中途的 bank select 會讓輸出 channel 在打擊與旋律之間互換，沒有送出（輸出 channel 是依打擊／旋律分配的）`);
  let skipped = 0;
  for (const ev of score.systemEvents ?? []) {
    const action = sysexAction(ev);
    if (action === 'skip') skipped++;
    else if (action === 'global' && ev.ticks > 0) controls.push({ ev, sysex: true });
  }
  if (skipped) warnOnce(score, 'sysex', `這首歌有 ${skipped} 個 SysEx 沒有送出（指定 part 的參數，或分不出用途的訊息）`);
  return controls.sort((a, b) => byFileOrder(a.ev, b.ev));
}

// ── driver 群組 ──

// 某 tick 屬於第幾段：第 k 個 driver 起音（含）到第 k+1 個之前＝第 k+1 段，第一個 driver 起音之前＝第 0 段（前奏）。二分搜尋 upper bound，driverTicks 遞增
export function sliceOfTick(driverTicks, tick) {
  const a = driverTicks;
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= tick) lo = mid + 1; else hi = mid; }
  return lo;
}

// 一個 driver 群組（現在永遠一個）：
//  · driverSegs：沿用 parser 的 segment 但只留 driver staff 的音；整個 segment 沒有 driver 的音或都排不進 channel 就不收（一次按鍵不該只推進一個不會響的 segment）。
//  · slots：指派了有音符的 staff 的槽位才有資格觸發；全都不算就是自動播放。
//  · followers：所有 follower 音依 startTick 排序，sliceFirst 記下每一段的第一個在哪；controls／controlFirst 同理
//    （落在你某個起音 tick 上的控制器屬於那個起音啟動的段，跟同 tick 的音一起在按下的那次呼叫裡送）。
//  · hasPrelude：前奏鎖要不要生效；rateBounds：速度區間。
function buildGroup(score, staves, controls) {
  const driverSegs = [], driverTicks = [];
  for (const seg of score.segments) {
    const items = [];
    for (const note of seg.notes) {
      const staff = staves.get(staffKeyOf(note));
      if (staff && staff.kind === 'human') items.push({ staff, note });
    }
    if (items.length) { driverSegs.push({ ticks: seg.ticks, items }); driverTicks.push(seg.ticks); }
  }
  const slots = new Set();
  for (const staff of staves.values()) {
    if (staff.kind === 'human' && staff.notes.length) slots.add(staff.slot);
  }
  const followers = [];
  for (const note of score.notes) {
    const staff = staves.get(staffKeyOf(note));
    if (staff && staff.kind === 'assist') followers.push({ staff, note });
  }
  // 第 s 段的 follower ＝ followers[sliceFirst[s], sliceFirst[s+1])，控制器同理（見 firstOfEachSlice）
  const slices = driverSegs.length + 1;
  const sliceFirst = firstOfEachSlice(followers, (f) => f.note.startTick, driverTicks, slices);
  const controlFirst = firstOfEachSlice(controls, (c) => c.ev.ticks, driverTicks, slices);
  // 第 0 段有 follower 的音就是前奏（純 tick 比較）；沒有 driver（整首自動播放）不鎖
  const hasPrelude = driverSegs.length > 0 && sliceFirst[1] > sliceFirst[0];
  // 速度區間：相鄰 driver 起音的樂譜間隔取中位數換算（tempo.js 的 rateBoundsFor()）
  const driverSecsList = driverTicks.map((t) => score.midiTicksToSeconds(t));
  const rateBounds = rateBoundsFor(driverSecsList.slice(1).map((t, i) => t - driverSecsList[i]));
  return { slots, driverSegs, driverTicks, followers, sliceFirst, controls, controlFirst, hasPrelude, rateBounds };
}

// first[s]＝第一個屬於第 s 段（含）以後的項目位置，第 s 段的項目＝[first[s], first[s+1])（長度＝段數＋1）。items 依 tick 排序所以段編號遞增，掃一遍即可
function firstOfEachSlice(items, tickOf, driverTicks, slices) {
  const first = new Array(slices + 1).fill(items.length);
  let s = 0;
  for (let i = 0; i < items.length; i++) {
    const slice = sliceOfTick(driverTicks, tickOf(items[i]));
    while (s <= slice) first[s++] = i;
  }
  return first;
}

/**
 * 這一輪的演奏計畫（載入、改指派時重建；沒有樂譜時是空計畫）。router 分配輸出 channel（voices.js 的 allocate()）。
 * @returns {{ staves: Map<string, object>, unplaced: string[], totalNotes: number, holdCapTicks: number, lanes: Map<number, object>, groups: object[] }}
 *   staves：staffId → staff；unplaced：輸出 channel 排不進去（旋律 staff 超過 60 個、鼓組超過 4 種）的 staff，這一輪不出聲；
 *   totalNotes：所有排得進 channel 的音；holdCapTicks：hold 對齊容差上限；lanes：控制器軌的扇出（buildLanes）；
 *   globalSysex：要送的整體參數 SysEx（依檔案順序，載入時送界線之前的）；groups：driver 群組。
 */
export function buildPlan(score, assignments, router) {
  if (!score) {
    const group = { slots: new Set(), driverSegs: [], driverTicks: [], followers: [], sliceFirst: [], controls: [], controlFirst: [], hasPrelude: false, rateBounds: rateBoundsFor([]) };
    return { staves: new Map(), unplaced: [], totalNotes: 0, holdCapTicks: 0, lanes: new Map(), globalSysex: [], groups: [group] };
  }
  const { staves, unplaced } = buildStaves(score, toAssignMap(assignments), router);
  let totalNotes = 0;
  for (const staff of staves.values()) totalNotes += staff.notes.length;
  const lanes = buildLanes(score, staves);
  const globalSysex = (score.systemEvents ?? []).filter((ev) => sysexAction(ev) === 'global');
  return { staves, unplaced, totalNotes, holdCapTicks: holdCapTicksFor(score), lanes, globalSysex, groups: [buildGroup(score, staves, buildControls(score, lanes))] };
}
