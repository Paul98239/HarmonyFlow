// ============================================================
//  performancePlan.js — 演奏計畫：依樂譜＋指派建出這一輪的譜表（staff：發聲與輸出 channel 的單位）與 driver 群組（每個群組：
//  有資格觸發的槽位、自己的 driver segment 與起音 tick、段索引、前奏旗標、速度區間、歸它跟隨的 follower），以及總音數與 hold
//  容差上限。載入、改指派時重建，之後不變（靜態）；游標、錨點、電腦音佇列這些執行期狀態在排程器的群組狀態裡（scheduler.js）。
//  現在永遠只有一個群組：包含所有被指派的槽位、擁有全部的 follower，行為等於「任何人按一下都推進同一條序列」。多個群組時
//  follower 跟哪個群組走、群組之間怎麼對時，是多人分工規則的一部分，等手勢接回再定。純邏輯，無 DOM。
//
//  聲部單位：parser 把一個 MuseScore 樂器切成 part，part 底下有一個以上的 staff（一個譜表 × 一個樂器 channel，例如鋼琴
//  兩行譜是兩個 staff）。指派以 part 為單位，part 的所有 staff 共用同一個槽位；發聲與輸出 channel 以 staff 為單位。
//  沒有 staves 的 part（手工組的舊資料形狀）自動視為單一 staff。
// ============================================================

import { rateBoundsFor } from './pressTiming.js';
import { GM_DEFAULT_VOLUME } from './outputRouter.js';
import { holdCapTicksFor } from './voiceLedger.js';

/* ═══════════════════════════════════════════
   譜表（staff）建構
   ═══════════════════════════════════════════ */

// 一個 part 底下的 staff 規格：新資料形狀直接用 part.staves；沒有 staves 的 part（手工組的舊資料形狀）視為單一 staff，
// id 沿用 part.id。
export function staffSpecsOf(part) {
  if (part.staves) return part.staves.map((s) => ({ ...s, partId: part.id }));
  return [{ id: part.id, partId: part.id, program: part.program ?? 0, bank: part.bank ?? { msb: 0, lsb: 0 }, percussionKit: !!part.percussionKit, init: null }];
}

// 音符屬於哪個 staff：新資料形狀有 staffId；舊資料形狀的音符沒有，用 partId（跟 staffSpecsOf 的單一 staff id 一致）。
export const staffKeyOf = (note) => note.staffId ?? note.partId;

function makeStaff(spec, slot, notes, kind, channel) {
  return {
    id: spec.id, partId: spec.partId, slot, kind, channel, notes,
    program: spec.program ?? 0, bank: spec.bank, init: spec.init ?? null, percussionKit: !!spec.percussionKit,
    baseVolume: spec.init?.volume ?? GM_DEFAULT_VOLUME, // 檔案 tick 0 的 CC7，沒有就是 GM 預設 100；載入時送一次
    sounding: new Map(),    // 音高 → [{ endTick, offMs }]：正在響的音；同音高重疊時依發聲順序排隊，先進先出收音（發聲帳本 voiceLedger.js 操作它）
  };
}

// 這個 staff 被指派給誰（槽位，沒有指派回 undefined）。指派的單位是 part，單聲部的多行譜（例如鋼琴一個 part 兩個 staff）
// 也可以只指派其中一個 staff：staff id 的指派優先於 part id 的。
export const slotOfSpec = (assignments, spec) => assignments.get(spec.id) ?? assignments.get(spec.partId);

// 指派表可以是 Map 或 [partId／staffId, 槽位][]（同 Scheduler.load()）
const toAssignMap = (assignments) => (assignments instanceof Map ? assignments : new Map(assignments || []));

// 指派與未指派兩個池子的 staff 規格（依總譜順序）：指派的走真人合成器、未指派的走電腦輔助合成器，兩個池子各自配輸出 channel。
// 排程器的 portsNeeded() 與 buildPlan() 共用，池子怎麼分只寫在這裡。
export function staffPools(score, assignments) {
  const assignMap = toAssignMap(assignments);
  const assigned = [], assist = [];
  for (const part of score?.parts || []) {
    for (const spec of staffSpecsOf(part)) (slotOfSpec(assignMap, spec) !== undefined ? assigned : assist).push(spec);
  }
  return { assigned, assist };
}

// 指派聲部與未指派聲部各自配輸出 channel（見 outputRouter.js 的 allocate()），配額用完的 staff 回報在 unplaced，這一輪不會出聲。
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

/* ═══════════════════════════════════════════
   driver 群組
   ═══════════════════════════════════════════ */

// 某個 tick 屬於第幾段：落在第 k 個 driver 起音（含）到第 k+1 個之前＝第 k+1 段；第一個 driver 起音之前＝第 0 段（前奏）。
// 二分搜尋「≤ tick 的 driver 起音有幾個」（upper bound）。driverTicks 是遞增的。
export function sliceOfTick(driverTicks, tick) {
  const a = driverTicks;
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= tick) lo = mid + 1; else hi = mid; }
  return lo;
}

// 一個 driver 群組（現在永遠一個：所有被指派的槽位、全部的 follower）：
//  · driverSegs：沿用 parser 的 segment（同一個 startTick 的所有音），只留 driver staff 的音；整個 segment 沒有 driver 的音
//    或都排不進 channel 就不收（一次按鍵不該只推進一個不會響的 segment）。driverTicks＝每個 driver segment 的 tick。
//  · slots：指派了有音符的 staff 的槽位才有資格觸發；指派了但完全沒有音符（或都排不進 channel）的槽位不算，全都不算就是自動播放。
//  · followers：所有 follower staff 的音依 startTick 排序（score.notes 本來就排好了），sliceFirst 記下每一段的第一個在哪。
//  · hasPrelude：前奏鎖要不要生效；rateBounds：速度區間（見下）。
function buildGroup(score, staves) {
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
  // sliceFirst[s]：第一個屬於第 s 段（含）以後的 follower 位置，第 s 段的 follower ＝ [sliceFirst[s], sliceFirst[s+1])（長度＝段數＋1）。
  // followers 依 startTick 排序，段編號因此遞增：掃一遍，每遇到一個 follower，把還沒設定、編號 ≤ 它的段都設成這個位置。
  const slices = driverSegs.length + 1;
  const sliceFirst = new Array(slices + 1).fill(followers.length);
  let s = 0;
  for (let i = 0; i < followers.length; i++) {
    const slice = sliceOfTick(driverTicks, followers[i].note.startTick);
    while (s <= slice) sliceFirst[s++] = i;
  }
  // 第 0 段（第一個 driver 起音之前）有 follower 的音就是前奏。純 tick 比較，沒有誤差；沒有 driver 時（整首自動播放）不鎖。
  const hasPrelude = driverSegs.length > 0 && sliceFirst[1] > sliceFirst[0];
  // 速度區間：這個群組的聲部（含多個聲部的聯集）相鄰起音的樂譜間隔取中位數換算，見 pressTiming.js 的 rateBoundsFor()
  const driverSecsList = driverTicks.map((t) => score.midiTicksToSeconds(t));
  const rateBounds = rateBoundsFor(driverSecsList.slice(1).map((t, i) => t - driverSecsList[i]));
  return { slots, driverSegs, driverTicks, followers, sliceFirst, hasPrelude, rateBounds };
}

/**
 * 這一輪的演奏計畫（載入、改指派時重建；沒有樂譜時是空的計畫）。router 分配輸出 channel（outputRouter.js 的 allocate()）。
 * @returns {{ staves: Map<string, object>, unplaced: string[], totalNotes: number, holdCapTicks: number, groups: object[] }}
 *   staves：staffId → staff；unplaced：輸出 channel 排不進去（旋律 staff 超過 60 個、鼓組超過 4 種）的 staff，這一輪不出聲；
 *   totalNotes：所有排得進 channel 的音（播完要全部發過聲）；holdCapTicks：hold 對齊容差的上限；groups：driver 群組（現在永遠一個）。
 */
export function buildPlan(score, assignments, router) {
  if (!score) {
    const group = { slots: new Set(), driverSegs: [], driverTicks: [], followers: [], sliceFirst: [], hasPrelude: false, rateBounds: rateBoundsFor([]) };
    return { staves: new Map(), unplaced: [], totalNotes: 0, holdCapTicks: 0, groups: [group] };
  }
  const { staves, unplaced } = buildStaves(score, toAssignMap(assignments), router);
  let totalNotes = 0;
  for (const staff of staves.values()) totalNotes += staff.notes.length;
  return { staves, unplaced, totalNotes, holdCapTicks: holdCapTicksFor(score), groups: [buildGroup(score, staves)] };
}
