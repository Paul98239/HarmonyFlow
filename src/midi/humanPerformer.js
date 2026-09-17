// ============================================================
//  humanPerformer.js — 拍級事件驅動排程器（純邏輯，無 DOM／CDN）
//
//  沒有背景時鐘、沒有拍速估計：共用拍位只在「有效觸發」發生的那一刻才前進，其他時間完全
//  靜止。每個聲部有自己的播放頭 `playSec`（依真實經過時間前進）與上限 `limitSec`（播放頭
//  不能超過的界線）——觸發只做一件事：把某個聲部的上限推到「這一拍結束」。
//
//  指派聲部：演奏者在目前拍上還有沒播出的音，觸發就在原地把上限推到拍尾（claim）；沒有的
//  話，把共用拍位跳到下一個「有意義的拍」（任一被指派聲部有音符從那一拍開始的拍，休止符
//  跟正在響的長音都不算，自動被跳過），再 claim。跳過的過程中，其他被指派聲部若剛好也有
//  音符落在被跳過的拍上，這一輪沒被自己的演奏者觸發＝直接靜音丟棄，不會被電腦補（沒有
//  代打），也不會因為共用拍位路過就被誤判成發聲——這是這個排程器最容易出錯的地方，見
//  `_advanceBeat()` 的註解。
//
//  未指派聲部（真正的電腦伴奏）：上限永遠等於 `_frontierSec`（全域值＝目前所有指派演奏者
//  推進最遠的那一位），完全不受自己有沒有觸發影響，任何一次觸發把拍位往前推，伴奏就跟著
//  反應式播放——沿用最早版本「伴奏進度綁在推進最遠的那一位」的語意。完全沒有人被指派時，
//  `_frontierSec` 從 `load()` 就直接設成 `Infinity`，等同整份照真實經過時間連續自動播放。
//
//  正在響的音只由它自己的合成器、在 `playSec` 真的越過它自己的 `endSeconds` 時才關閉，
//  不會因為共用拍位的跳躍被提前掐斷或重疊發聲。velocity 一律用樂譜原值，不套用手勢公式；
//  不重播 CC／pitch-bend，音色只在 load() 時套用一次。
// ============================================================

import { buildBeatGrid } from './midiParser.js';

export const DEFAULT_PERFORMER_CONFIG = Object.freeze({
  drumChannel: 9, // MIDI 規格：第 10 個 channel（索引 9）是打擊
});

const CHANNELS_PER_PORT = 16;

/* ═══════════════════════════════════════════
   輸出 channel 分配
   ═══════════════════════════════════════════ */

// 這個合成器上可用的旋律輸出 channel＝跳過每個 port 的打擊槽（ch % 16 === drumChannel）。
function melodicChannelsFor(synth, drumChannel) {
  const chans = synth?.midiChannels;
  const total = Array.isArray(chans) && chans.length > 0 ? chans.length : CHANNELS_PER_PORT;
  const out = [];
  for (let ch = 0; ch < total; ch++) {
    if (ch % CHANNELS_PER_PORT !== drumChannel) out.push(ch);
  }
  return out;
}

// 幫一組聲部各自分配一個輸出 channel，避免兩個原本共用同一個原始 channel 的聲部打架。
// 鼓組固定用 drumChannel，其餘依序拿 melodicChannels 裡的號碼；配完就停手，排不進去的
// 聲部回報給呼叫端，不出聲。
function allocateChannels(parts, melodicChannels, drumChannel) {
  const byPartId = new Map();
  const unplaced = [];
  let next = 0;
  for (const p of parts) {
    const isDrum = p.percussionKit === true || p.channel === drumChannel;
    if (isDrum) { byPartId.set(p.id, drumChannel); continue; }
    if (next < melodicChannels.length) { byPartId.set(p.id, melodicChannels[next++]); continue; }
    unplaced.push(p.id);
  }
  return { byPartId, unplaced };
}

/* ═══════════════════════════════════════════
   聲部（voice）建構
   ═══════════════════════════════════════════ */

function makeVoice(partId, slot, notes, kind, channel) {
  return {
    partId, slot, kind, channel, notes,
    cursor: 0,              // 下一個「還沒排程」的音符在 notes 裡的位置
    sounding: new Map(),    // note(音高) → endSeconds
    playSec: 0,             // 這個聲部的播放頭
    limitSec: 0,            // 播放頭不能超過的界線
    claimed: false,         // 指派聲部是否曾經被自己的演奏者接手過（見 _emitDueNotes 的用法）
    lastSeq: null,          // 上次觀察到的手勢 triggerSeq，null＝還沒對過基準
  };
}

// 指派聲部只配 humanSynth 的 channel、未指派聲部只配 accompSynth 的 channel——被指派聲部
// 沒接手就是靜音，不需要幫它在 accompSynth 上保留一條代打用的 channel。兩個池子各自獨立
// 配額用完的聲部回報在 unplaced，這一輪不會出聲。
function buildVoices(score, assignments, accompSynth, humanSynth, cfg) {
  const voices = new Map(); // partId → voice
  const unplaced = [];

  const notesByPart = new Map(); // score.notes 已依 startTick 排序，照順序分組即可
  for (const n of score.notes) {
    let list = notesByPart.get(n.partId);
    if (!list) notesByPart.set(n.partId, (list = []));
    list.push(n);
  }

  const assignedParts = score.parts.filter((p) => assignments.has(p.id));
  const accompParts = score.parts.filter((p) => !assignments.has(p.id));

  const { byPartId: humanCh, unplaced: u1 } =
    allocateChannels(assignedParts, melodicChannelsFor(humanSynth, cfg.drumChannel), cfg.drumChannel);
  const { byPartId: accompCh, unplaced: u2 } =
    allocateChannels(accompParts, melodicChannelsFor(accompSynth, cfg.drumChannel), cfg.drumChannel);
  unplaced.push(...u1, ...u2);

  for (const p of assignedParts) {
    const channel = humanCh.get(p.id);
    if (channel === undefined) continue;
    voices.set(p.id, makeVoice(p.id, assignments.get(p.id), notesByPart.get(p.id) || [], 'human', channel));
  }
  for (const p of accompParts) {
    const channel = accompCh.get(p.id);
    if (channel === undefined) continue;
    voices.set(p.id, makeVoice(p.id, null, notesByPart.get(p.id) || [], 'accomp', channel));
  }
  return { voices, unplaced };
}

/* ═══════════════════════════════════════════
   HumanPerformer
   ═══════════════════════════════════════════ */
export class HumanPerformer {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_PERFORMER_CONFIG, ...config };
    this.accompSynth = null;   // 伴奏合成器（未指派聲部）
    this.humanSynth = null;    // 真人聲部合成器（被指派聲部）
    this._score = null;
    this._beats = [];          // buildBeatGrid() 的結果；空陣列＝無法算拍（SMPTE division）
    this._voices = new Map();  // partId → voice
    this._meaningful = [];     // 有意義的拍：任一被指派聲部有音符從這一拍開始（升冪、去重）
    this._mCursor = 0;         // 在 _meaningful 裡的位置，只前進不回頭
    this._beatIndex = 0;       // 目前共用拍位在 _beats 裡的 index
    this._frontierSec = 0;     // 未指派聲部的播放頭上限＝目前指派演奏者推進最遠的那一位
    this.unplacedPartIds = [];
    this._playing = false;
    this._lastTickMs = null;   // null＝下一次 tick() 不推進播放頭，只記錄基準
  }

  setSynths(accompSynth, humanSynth) {
    this.accompSynth = accompSynth;
    this.humanSynth = humanSynth;
  }

  /**
   * 載入這首歌：建立聲部、套初始音色，準備好共用拍格線與「有意義的拍」索引。
   * @param {import('./midiParser.js').ParsedMidi} score  parseMidi() 的結果（不會被修改）
   * @param {Map<string,number>|[string,number][]} assignments  partId → 演奏者槽位
   */
  load(score, assignments) {
    this.stop();
    this._score = score || null;
    this._beats = score ? buildBeatGrid(score) : [];
    this._voices = new Map();
    this.unplacedPartIds = [];
    if (!score) return;

    const assignMap = assignments instanceof Map ? assignments : new Map(assignments || []);
    const partById = new Map(score.parts.map((p) => [p.id, p]));

    const { voices, unplaced } = buildVoices(score, assignMap, this.accompSynth, this.humanSynth, this.cfg);
    this._voices = voices;
    this.unplacedPartIds = unplaced;

    for (const voice of this._voices.values()) {
      const part = partById.get(voice.partId);
      const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
      this._applyInitialPatch(synth, voice.channel, part);
      // CC7 不在「reset all controllers」清單裡，channel 又是跨曲重複使用：明確送一次 GM
      // 預設值 100，避免沿用到別的曲子／別的聲部在同一個 channel 索引上留下的音量設定。
      try { synth?.controllerChange(voice.channel, 7, 100); } catch (err) {}
    }

    this._tagNotesWithBeat();

    // 「有意義的拍」只看被指派聲部：未指派聲部的音符不需要被接手，不影響這份索引。
    const meaningfulSet = new Set();
    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human') continue;
      for (const n of voice.notes) meaningfulSet.add(n.beatIndex);
    }
    this._meaningful = [...meaningfulSet].sort((a, b) => a - b);
    this._mCursor = 0;
    this._beatIndex = this._meaningful[0] ?? 0;

    // 完全沒有人被指派時，永遠不會有觸發，_frontierSec 沒有任何路徑可以被推進——必須在這裡
    // 顯式退回「整份照真實經過時間連續自動播放」，不能指望一般邏輯自動長出這個特例。
    const hasAssigned = [...this._voices.values()].some((v) => v.kind === 'human');
    this._frontierSec = (!hasAssigned || !this._meaningful.length)
      ? Infinity
      : this._beats[this._meaningful[0]].startSeconds; // 前奏：未指派聲部先照實時播到第一個真人入場點
  }

  // 用只前進的游標把每個聲部的 notes（已依 startTick 排序）逐顆標上 beatIndex。
  _tagNotesWithBeat() {
    if (!this._beats.length) {
      for (const voice of this._voices.values()) {
        for (const n of voice.notes) n.beatIndex = 0;
      }
      return;
    }
    for (const voice of this._voices.values()) {
      let bc = 0;
      for (const n of voice.notes) {
        while (bc + 1 < this._beats.length && this._beats[bc + 1].startTick <= n.startTick) bc++;
        n.beatIndex = bc;
      }
    }
  }

  _applyInitialPatch(synth, channel, part) {
    if (!synth) return;
    try {
      synth.controllerChange(channel, 0, part.bank?.msb || 0);
      synth.controllerChange(channel, 32, part.bank?.lsb || 0);
      synth.programChange(channel, part.program || 0);
    } catch (err) { /* 初始音色設定失敗不致命 */ }
  }

  play() {
    this._playing = true;
    this._lastTickMs = null; // 避免暫停期間累積的時間被當成一次巨大的 dt，把播放頭瞬間推老遠
  }

  // 暫停：收掉還在響的音，播放頭與拍位都保留（下次播放從原處繼續）。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    this.silence();
  }

  silence() {
    for (const voice of this._voices.values()) {
      const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
      for (const note of voice.sounding.keys()) {
        try { synth?.noteOff(voice.channel, note); } catch (err) {}
      }
      voice.sounding.clear();
      try { synth?.controllerChange(voice.channel, 123, 0); } catch (err) {} // CC123 All Notes Off 當保險
    }
  }

  // 停止／換歌前的清場：收音＋每個聲部的播放狀態全部歸零。
  stop() {
    this.pause();
    for (const voice of this._voices.values()) {
      voice.cursor = 0;
      voice.playSec = 0;
      voice.limitSec = 0;
      voice.claimed = false;
      voice.lastSeq = null;
    }
    this._mCursor = 0;
    this._beatIndex = this._meaningful[0] ?? 0;
  }

  isPlaying() { return this._playing; }

  isFinished() {
    if (!this._score) return false;
    for (const voice of this._voices.values()) {
      if (voice.cursor < voice.notes.length || voice.sounding.size > 0) return false;
    }
    return true;
  }

  /**
   * 由 midiPlayer.js 的排程 tick（~12ms）每次呼叫。
   * @param {number} nowMs  performance.now()
   * @param {(partId:string) => {present:boolean, triggerSeq:number}} getGestureFor
   *        該聲部指派 ID 目前的手勢狀態：present＝在場、triggerSeq＝拋物線觸發的累加計數。
   */
  tick(nowMs, getGestureFor) {
    if (!this._playing) return;
    const dt = this._lastTickMs == null ? 0 : (nowMs - this._lastTickMs) / 1000;
    this._lastTickMs = nowMs;

    this._handleTriggers(getGestureFor);
    this._advancePlayheads(dt);
    this._emitDueNotes();
  }

  _advancePlayheads(dt) {
    if (dt <= 0) return;
    for (const voice of this._voices.values()) {
      const limit = voice.kind === 'accomp' ? this._frontierSec : voice.limitSec;
      voice.playSec = Math.min(voice.playSec + dt, limit);
    }
  }

  // 逐一檢查每個指派聲部有沒有新觸發：有的話，這一拍上這個聲部若還有沒播出的音就地
  // claim；沒有就把共用拍位推到下一個有意義的拍，再 claim。
  _handleTriggers(getGestureFor) {
    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human') continue;
      const gesture = getGestureFor(voice.partId);
      if (voice.lastSeq === null) { voice.lastSeq = gesture.triggerSeq; continue; } // 首次只記基準
      if (gesture.triggerSeq === voice.lastSeq) continue;
      voice.lastSeq = gesture.triggerSeq;

      if (this._hasPendingInCurrentBeat(voice)) this._claim(voice);
      else { this._advanceBeat(); this._claim(voice); }
    }
  }

  _hasPendingInCurrentBeat(voice) {
    const n = voice.notes[voice.cursor];
    return !!n && n.beatIndex === this._beatIndex;
  }

  // claim：只動「這一個」被觸發的聲部——播放頭夾到這一拍起點、上限至少推到這一拍結束。
  // 拍內若有多顆音符（十六分音符群），會在接下來幾個 tick 依各自原始時間差自然鋪開，不會
  // 被壓成和弦。
  //
  // 上限不能只設成「這一拍結束」：跨越好幾拍的長音（使用者的全音符案例）起點雖然落在這一
  // 拍，endSeconds 卻遠在後面，上限沒跟著延伸的話，這顆音會被 _releaseDue() 無限期晾著、
  // isFinished() 也永遠不會是 true，除非使用者再多觸發一次——但那次觸發在音樂上毫無意義
  // （沒有新的音要播），跟「一顆長音只需要一次手勢」的設計目標矛盾。所以要往前掃這一拍裡
  // 所有還沒播出的音符（同一拍＝和弦或音群），取它們 endSeconds 的最大值：這個範圍就是這次
  // claim 保證要讓其發生的東西，不會因此提前暴露下一拍才該出現的音（下一拍的音要嘛 beatIndex
  // 不同、要嘛還沒被這次觸發的演奏者接手）。
  _claim(voice) {
    voice.claimed = true;
    const beat = this._beats[this._beatIndex];
    // 播放頭只有在這個聲部目前完全沒有音在響時，才能直接跳到這一拍起點——跳過的是純粹的
    // 休止符靜默，沒有可聽見的後果。如果還有音在響（演奏者提早觸發下一步，長音的真實時長
    // 還沒走完），播放頭維持原地不動，交給 _advancePlayheads() 依真實經過時間自然推進到
    // 它自己的 endSeconds 再放：不能用這裡的跳躍把正在響的音提前切斷，即使跳躍是它自己的
    // 演奏者觸發的也一樣。
    if (voice.sounding.size === 0) {
      voice.playSec = Math.max(voice.playSec, beat.startSeconds);
    }
    let limit = beat.endSeconds;
    for (let i = voice.cursor; i < voice.notes.length && voice.notes[i].beatIndex === this._beatIndex; i++) {
      if (voice.notes[i].endSeconds > limit) limit = voice.notes[i].endSeconds;
    }
    voice.limitSec = Math.max(voice.limitSec, limit);
  }

  // 把共用拍位跳到下一個「有意義的拍」（游標只前進不回頭）。
  //
  // 這裡不能對「所有」指派聲部都把 playSec／limitSec 推到新拍起點——被路過、但沒被自己的
  // 演奏者觸發的聲部，若音符的 startSeconds 剛好等於新拍起點，會被 _emitDueNotes() 誤判成
  // 到期發聲，等於用另一個名字重新做了一次代打。正確做法：被路過的聲部只丟棄游標（沒接手
  // 的音直接靜音丟棄，不會被之後任何觸發「追討」回來），播放頭與上限完全不動；只有真正
  // 觸發這次前進的那個聲部，才會在這個函式之後緊接著呼叫的 _claim() 裡移動播放頭。
  _advanceBeat() {
    while (this._mCursor < this._meaningful.length && this._meaningful[this._mCursor] <= this._beatIndex) {
      this._mCursor++;
    }
    if (this._mCursor >= this._meaningful.length) { this._enterFinale(); return; }
    this._beatIndex = this._meaningful[this._mCursor];
    const beat = this._beats[this._beatIndex];

    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human') continue;
      while (voice.cursor < voice.notes.length && voice.notes[voice.cursor].beatIndex < this._beatIndex) {
        voice.cursor++;
      }
    }
    this._frontierSec = beat.endSeconds; // 未指派聲部的上限＝目前推進最遠的那一位
  }

  // 曲末：沒有下一個有意義的拍了，把所有聲部的上限放到無限，讓尾音／尾奏自然播完。
  _enterFinale() {
    for (const voice of this._voices.values()) voice.limitSec = Infinity;
    this._frontierSec = Infinity;
  }

  // 每個聲部：先關掉到期的音，再把新到期的音開出去（同一 startSeconds 的音符＝和弦，
  // 會在同一次呼叫裡一起處理）。
  //
  // 指派聲部在從沒被接手過之前要整個跳過：playSec／limitSec 的初始值都是 0，如果聲部第一顆
  // 音剛好也是從 tick 0 開始，「note.startSeconds(0) <= playSec(0)」在還沒有任何 claim 發生
  // 時就已經成立，會在還沒被觸發前就搶先發聲——一旦這樣，這個聲部的 cursor 提早往前跑，
  // 等真正的觸發來時 _hasPendingInCurrentBeat() 會誤判成「這拍沒東西」而立刻 advance，
  // 反而把原本該完整撐住的音提前切斷。未指派聲部（伴奏）沒有「接手」這個概念，不受影響。
  _emitDueNotes() {
    for (const voice of this._voices.values()) {
      this._releaseDue(voice);
      if (voice.kind === 'human' && !voice.claimed) continue;
      const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
      while (voice.cursor < voice.notes.length && voice.notes[voice.cursor].startSeconds <= voice.playSec) {
        const n = voice.notes[voice.cursor];
        try { synth?.noteOn(voice.channel, n.note, n.velocity); } catch (err) {}
        voice.sounding.set(n.note, n.endSeconds);
        voice.cursor++;
      }
    }
  }

  // 關掉這個聲部裡「播放頭真的越過它自己 endSeconds」的音——不會因為共用拍位的跳躍被
  // 提前掐斷，也不會重疊發聲。
  _releaseDue(voice) {
    const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
    for (const [note, endSeconds] of [...voice.sounding]) {
      if (endSeconds > voice.playSec) continue;
      try { synth?.noteOff(voice.channel, note); } catch (err) {}
      voice.sounding.delete(note);
    }
  }
}
