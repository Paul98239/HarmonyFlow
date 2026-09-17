// ============================================================
//  humanPerformer.js — 逐小節同步排程器（純邏輯，無 DOM／CDN）
//
//  合奏總譜靠共用小節格線同步（見 midiParser.js 的 buildMeasureGrid()）：所有聲部（含被指派
//  出去的）共用同一個樂曲位置 _posSec，位置照全體演奏者揮手節奏估出的共用拍速（相對樂譜原速
//  的倍率 rate，見 createTempoEstimator()）連續前進，不等任何人、也不看誰觸發——這樣才會像
//  真實樂團一樣「所有人在同一個拍點上」，不會有各聲部各自推進、漂移成不同進度的問題（這是從
//  同事的單人鋼琴專案 smartplay.js 移植過來的舊模型套到合奏總譜會出現的毛病：各聲部音符密度
//  不同，「一手勢＝一步」在聲部之間節奏語意不對等）。_posSec 直接比對音符的 startSeconds／
//  endSeconds（parseMidi() 已依 tempoMap 換算好），不需要在這裡重算 tick↔秒的對應。
//
//  每個小節開始時，所有聲部預設由伴奏合成器（電腦）播出，且被指派聲部的那條「代打」channel
//  刻意調低音量（CC7）。演奏者若在這個小節內做一次有效拋物線手勢，這個聲部就從共用位置正確
//  的地方「接手」——之後這個小節剩餘的音改由真人合成器（全音量）播出，同時餵一筆時間樣本給
//  拍速估計器；整個小節都沒揮手，這個聲部就整小節由電腦代打補完（局部代打）。接手只換「之後
//  新 noteOn 的音」要走哪顆合成器，正在響的音留在原本那顆合成器上自然結束，不重疊發聲、不
//  提前切斷。
//
//  沒有前奏特例、沒有 lookahead 佇列：所有聲部的音符都是共用位置推進到 startSeconds 才
//  noteOn、推進到 endSeconds 才 noteOff，每個 tick 只處理「已經到期」的部分。velocity 一律
//  用樂譜原值，不套用手勢公式；不重播 CC／pitch-bend，音色只在 load() 時套用一次。
// ============================================================

import { buildMeasureGrid } from './midiParser.js';

export const DEFAULT_PERFORMER_CONFIG = Object.freeze({
  drumChannel: 9,              // MIDI 規格：第 10 個 channel（索引 9）是打擊
  takeoverLookaheadMs: 180,    // 揮手時距小節結束不到這個時間，視為在搶下一小節（避免準時揮卻沒聲音）
  standInVolumeCc: 64,         // 被指派聲部「電腦代打」那條 channel 的音量（CC7，GM 預設 100，
                                // 約 −6dB）；一接手就跳到真人軌全音量，對比聽得出來，不動 velocity
});

const CHANNELS_PER_PORT = 16;

/* ═══════════════════════════════════════════
   輸出 channel 分配（沿用舊版邏輯，不變）
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

// 聲部→輸出 channel：伴奏合成器（accompSynth）現在要幫「全部」聲部各配一個 channel——包含
// 被指派聲部的代打 channel（見檔頭說明）；真人合成器（humanSynth）只需要幫被指派的聲部配
// channel。兩個池子各自獨立配額用完的聲部回報在 unplaced，這一輪不會出聲。
function buildVoices(score, assignments, accompSynth, humanSynth, cfg) {
  const voices = new Map(); // partId → voice
  const unplaced = [];

  const notesByPart = new Map(); // score.notes 已依 startTick 排序，照順序分組即可
  for (const note of score.notes) {
    let list = notesByPart.get(note.partId);
    if (!list) notesByPart.set(note.partId, (list = []));
    list.push(note);
  }

  const { byPartId: autoChannelOf, unplaced: autoUnplaced } =
    allocateChannels(score.parts, melodicChannelsFor(accompSynth, cfg.drumChannel), cfg.drumChannel);
  unplaced.push(...autoUnplaced);

  const assignedParts = score.parts.filter((p) => assignments.has(p.id));
  const { byPartId: humanChannelOf, unplaced: humanUnplaced } =
    allocateChannels(assignedParts, melodicChannelsFor(humanSynth, cfg.drumChannel), cfg.drumChannel);
  unplaced.push(...humanUnplaced);

  for (const p of score.parts) {
    const autoChannel = autoChannelOf.get(p.id);
    if (autoChannel === undefined) continue; // 伴奏 channel 都用完了，這一輪整個聲部不出聲
    const humanChannel = humanChannelOf.get(p.id) ?? null;
    voices.set(p.id, {
      partId: p.id,
      slot: assignments.get(p.id) ?? null,
      notes: notesByPart.get(p.id) || [],
      autoChannel,
      humanChannel,
      assigned: humanChannel !== null,
      cursor: 0,                // 下一個「還沒排程」的音符在 notes 裡的位置
      sounding: new Map(),      // note(音高) → { endSeconds, viaHuman }
      owner: 'auto',            // 'auto' | 'human'：這一刻新 noteOn 要走哪顆合成器
      ownedMeasure: -1,         // owner 是針對哪個小節判定的
      claimMeasure: -1,         // 在小節尾聲揮手時，預約下一小節的擁有權
      lastSeq: null,            // 上次觀察到的手勢 triggerSeq，null＝還沒對過基準
    });
  }
  return { voices, unplaced };
}

/* ═══════════════════════════════════════════
   共用拍速估計：由全體演奏者的手勢節奏估一個相對樂譜原速的倍率
   ═══════════════════════════════════════════ */
const TEMPO_CFG = Object.freeze({
  minGapMs: 250,          // 兩次觸發間隔小於這個值當雜訊（同一次拋物線被算兩次之類）丟棄
  maxGapMs: 6000,         // 大於這個值代表這個人停手太久，丟棄、只更新基準時刻
  minRate: 0.5, maxRate: 2,          // 單次觀察值的合理範圍，超出視為誤判丟棄
  rateFloor: 0.6, rateCeil: 1.8,     // 平滑後最終拍速的範圍
  smoothing: 0.25,        // 每個有效樣本讓 rate 往目標值追近的比例
  maxStepRatio: 0.12,     // 單次樣本最多能改變 rate 多少（相對目前值），避免抽搐
  samplesPerSlot: 5,      // 每個演奏者最多留幾筆最近樣本
  idleMs: 8000,           // 全員這麼久沒有有效樣本，開始滑回原速
  idleTauMs: 4000,        // 滑回原速的時間常數
});

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 建立共用拍速估計器。只估「相對樂譜原速的倍率」，不修正相位（落拍不外顯：音符一律對齊共用
 * 拍速，不會因為誰觸發晚了就把音符往後推）。每個演奏者各自等權：中位數的中位數（先在每個
 * 演奏者內取中位數、再跨演奏者取中位數），一個人狂揮也灌不爆全體。
 */
export function createTempoEstimator(cfg = TEMPO_CFG) {
  const lastGestureMsBySlot = new Map(); // slot → 上次有效觸發的時刻
  const samplesBySlot = new Map();       // slot → rateObs[]（最近幾筆，最新在陣列尾端）
  let rate = 1;
  let lastValidSampleMs = null;
  let lastIdleMs = null;

  function recomputeRate() {
    const perSlotMedians = [];
    for (const samples of samplesBySlot.values()) {
      if (samples.length) perSlotMedians.push(median(samples));
    }
    if (!perSlotMedians.length) return;
    const target = median(perSlotMedians);
    const maxStep = Math.abs(rate) * cfg.maxStepRatio;
    const delta = Math.max(-maxStep, Math.min(maxStep, (target - rate) * cfg.smoothing));
    rate = Math.max(cfg.rateFloor, Math.min(cfg.rateCeil, rate + delta));
  }

  // 收到一次有效觸發：slot 是演奏者槽位，nominalMeasureMs 是他觸發當下所在小節、以樂譜原速
  // 算的名目長度（不乘 rate，避免正回饋——越快越准許更快，會愈滾愈快）。
  function onGesture(slot, nowMs, nominalMeasureMs) {
    const lastMs = lastGestureMsBySlot.get(slot);
    lastGestureMsBySlot.set(slot, nowMs);
    if (lastMs == null) return; // 這個人第一次揮手，還沒有間隔可以估拍速

    const gapMs = nowMs - lastMs;
    if (gapMs < cfg.minGapMs || gapMs > cfg.maxGapMs) return;
    const rateObs = nominalMeasureMs / gapMs;
    if (rateObs < cfg.minRate || rateObs > cfg.maxRate) return;

    let samples = samplesBySlot.get(slot);
    if (!samples) samplesBySlot.set(slot, samples = []);
    samples.push(rateObs);
    if (samples.length > cfg.samplesPerSlot) samples.shift();
    lastValidSampleMs = nowMs;
    recomputeRate();
  }

  // 由 tick() 每次呼叫：全員 idleMs 沒有有效樣本就清空樣本、以 τ≈idleTauMs 指數滑回原速。
  function idle(nowMs) {
    if (lastValidSampleMs != null && nowMs - lastValidSampleMs > cfg.idleMs) {
      samplesBySlot.clear();
      lastGestureMsBySlot.clear();
      lastValidSampleMs = null;
    }
    if (samplesBySlot.size === 0 && rate !== 1) {
      const dtMs = lastIdleMs == null ? 0 : nowMs - lastIdleMs;
      if (dtMs > 0) rate += (1 - rate) * (1 - Math.exp(-dtMs / cfg.idleTauMs));
    }
    lastIdleMs = nowMs;
  }

  function reset() {
    lastGestureMsBySlot.clear();
    samplesBySlot.clear();
    rate = 1;
    lastValidSampleMs = null;
    lastIdleMs = null;
  }

  return { get rate() { return rate; }, onGesture, idle, reset };
}

/* ═══════════════════════════════════════════
   HumanPerformer
   ═══════════════════════════════════════════ */
export class HumanPerformer {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_PERFORMER_CONFIG, ...config };
    this.accompSynth = null;   // 伴奏合成器（電腦播的部分：未指派聲部＋被指派聲部的代打 channel）
    this.humanSynth = null;    // 真人聲部合成器（被指派聲部接手後的部分）
    this._score = null;
    this._grid = [];           // buildMeasureGrid() 的結果；空陣列＝無法算小節（SMPTE division）
    this._measureCursor = 0;   // 上次算出的小節 index，只前進不回頭（位置只會前進或歸零）
    this._voices = new Map();  // partId → voice
    this._tempo = createTempoEstimator();
    this.unplacedPartIds = [];
    this._playing = false;
    this._posSec = 0;          // 全體共用的樂曲位置
    this._lastTickMs = null;   // null＝下一次 tick() 不推進位置，只記錄基準（剛 play() 或剛 tick 過一次）
  }

  setSynths(accompSynth, humanSynth) {
    this.accompSynth = accompSynth;
    this.humanSynth = humanSynth;
  }

  /**
   * 載入這首歌：建立聲部、套初始音色，準備好共用小節格線。
   * @param {import('./midiParser.js').ParsedMidi} score  parseMidi() 的結果（不會被修改）
   * @param {Map<string,number>|[string,number][]} assignments  partId → 演奏者槽位
   */
  load(score, assignments) {
    this.stop();
    this._score = score || null;
    this._grid = score ? buildMeasureGrid(score) : [];
    this._measureCursor = 0;
    this._voices = new Map();
    this.unplacedPartIds = [];
    this._posSec = 0;
    if (!score) return;

    const assignMap = assignments instanceof Map ? assignments : new Map(assignments || []);
    const partById = new Map(score.parts.map((p) => [p.id, p]));

    const { voices, unplaced } = buildVoices(score, assignMap, this.accompSynth, this.humanSynth, this.cfg);
    this._voices = voices;
    this.unplacedPartIds = unplaced;

    for (const voice of this._voices.values()) {
      const part = partById.get(voice.partId);
      this._applyInitialPatch(this.accompSynth, voice.autoChannel, part);
      // 代打 channel 的音量在這裡就要明講成 standInVolumeCc／GM 預設 100 兩者之一：channel
      // 是跨曲重複使用的，CC7 不在「reset all controllers」的清單裡，上一首歌留下的值會沿用
      // 下去，不能只在「是代打」的情況下才送。
      try { this.accompSynth?.controllerChange(voice.autoChannel, 7, voice.assigned ? this.cfg.standInVolumeCc : 100); } catch (err) {}
      if (voice.assigned) this._applyInitialPatch(this.humanSynth, voice.humanChannel, part);
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
    this._lastTickMs = null; // 避免暫停期間累積的時間被當成一次巨大的 dt，把位置瞬間推老遠
  }

  // 暫停：收掉還在響的音，位置與拍速都保留（下次播放從原位置、原拍速繼續）。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    this.silence();
  }

  // 收掉所有正在響的音。兩條路徑（真人／伴奏）都補一次 CC123 All Notes Off 當保險，避免
  // sounding 這份記錄跟實際發聲不同步時留下關不掉的長音。
  silence() {
    for (const voice of this._voices.values()) {
      for (const [note, info] of voice.sounding) {
        const synth = info.viaHuman ? this.humanSynth : this.accompSynth;
        const channel = info.viaHuman ? voice.humanChannel : voice.autoChannel;
        try { synth?.noteOff(channel, note); } catch (err) {}
      }
      voice.sounding.clear();
      try { this.accompSynth?.controllerChange(voice.autoChannel, 123, 0); } catch (err) {}
      if (voice.humanChannel !== null) {
        try { this.humanSynth?.controllerChange(voice.humanChannel, 123, 0); } catch (err) {}
      }
    }
  }

  // 停止／換歌前的清場：收音＋位置與每個聲部的擁有權狀態全部歸零。
  stop() {
    this.pause();
    this._posSec = 0;
    this._measureCursor = 0;
    this._tempo.reset();
    for (const voice of this._voices.values()) {
      voice.cursor = 0;
      voice.owner = 'auto';
      voice.ownedMeasure = -1;
      voice.claimMeasure = -1;
      voice.lastSeq = null;
    }
  }

  isPlaying() { return this._playing; }

  isFinished() {
    if (!this._score) return false;
    if (this._posSec < this._score.durationSeconds) return false;
    for (const voice of this._voices.values()) {
      if (voice.sounding.size > 0) return false;
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
    const dtMs = this._lastTickMs == null ? 0 : nowMs - this._lastTickMs;
    this._lastTickMs = nowMs;

    this._tempo.idle(nowMs);
    this._advancePosition(dtMs);
    this._syncOwnership(nowMs, getGestureFor);
    this._emitDueNotes();
  }

  // 位置直接在「秒」這個維度前進，不重算 tick↔秒：note.startSeconds／endSeconds、
  // grid[].startSeconds／endSeconds 都已經由 parseMidi() 依原曲 tempo map 換算好，樂譜自己
  // 的漸慢／漸快因此仍會被尊重——rate 只是均勻縮放這條已經有速度曲線的時間軸，不是另外疊加。
  _advancePosition(dtMs) {
    if (dtMs <= 0) return;
    this._posSec += (dtMs / 1000) * this._tempo.rate;
  }

  // 目前位置落在第幾個小節。position 只會前進或在 stop() 時歸零，游標只需要往前追、不用
  // 每次都從頭二分搜尋。沒有格線（SMPTE）回傳 -1。
  _currentMeasureIndex() {
    const grid = this._grid;
    if (!grid.length) return -1;
    while (this._measureCursor + 1 < grid.length && grid[this._measureCursor + 1].startSeconds <= this._posSec) {
      this._measureCursor++;
    }
    return this._measureCursor;
  }

  // 每個小節開始都重設成電腦代打（'auto'）；被指派聲部若在這個小節內偵測到新的拋物線觸發，
  // 就接手（'human'）並餵一筆樣本給拍速估計器。揮手時已經逼近小節尾聲（< takeoverLookaheadMs）
  // 就改成預約下一小節，避免「準時揮手卻因為小節剛好在這一瞬間切換而沒接到」。
  _syncOwnership(nowMs, getGestureFor) {
    const m = this._currentMeasureIndex();
    if (m < 0) return; // 沒有格線：所有聲部維持 load() 時的 'auto'，全部由電腦播（見檔頭說明）

    const measure = this._grid[m];
    const nominalMeasureMs = (measure.endSeconds - measure.startSeconds) * 1000;
    const remainMs = ((measure.endSeconds - this._posSec) / this._tempo.rate) * 1000;

    for (const voice of this._voices.values()) {
      if (!voice.assigned) continue;

      if (voice.ownedMeasure !== m) {
        voice.owner = voice.claimMeasure === m ? 'human' : 'auto';
        voice.claimMeasure = -1;
        voice.ownedMeasure = m;
      }

      const gesture = getGestureFor(voice.partId);
      if (voice.lastSeq === null) { voice.lastSeq = gesture.triggerSeq; continue; } // 首次只記基準
      if (gesture.triggerSeq === voice.lastSeq) continue;
      voice.lastSeq = gesture.triggerSeq;

      this._tempo.onGesture(voice.slot, nowMs, nominalMeasureMs);

      if (remainMs <= this.cfg.takeoverLookaheadMs) voice.claimMeasure = m + 1;
      else voice.owner = 'human';
    }
  }

  // 每個聲部：先關掉到期的音，再把新到期的音開出去（一步一步推進 cursor，同一 startSeconds
  // 的音符＝和弦，會在同一次呼叫裡一起處理）。
  _emitDueNotes() {
    for (const voice of this._voices.values()) {
      this._releaseDue(voice);
      while (voice.cursor < voice.notes.length && voice.notes[voice.cursor].startSeconds <= this._posSec) {
        const note = voice.notes[voice.cursor];
        const { synth, channel } = this._synthAndChannelFor(voice);
        try { synth?.noteOn(channel, note.note, note.velocity); } catch (err) {}
        voice.sounding.set(note.note, { endSeconds: note.endSeconds, viaHuman: voice.owner === 'human' });
        voice.cursor++;
      }
    }
  }

  // 關掉這個聲部裡「原譜判定該結束」的音——用它發聲當下記錄的那顆合成器關閉，不是用現在的
  // owner（owner 可能在這顆音還響著的時候就換了，見檔頭「接手」說明：正在響的音留在原本
  // 那顆合成器上自然結束）。
  _releaseDue(voice) {
    for (const [note, info] of [...voice.sounding]) {
      if (info.endSeconds > this._posSec) continue;
      const synth = info.viaHuman ? this.humanSynth : this.accompSynth;
      const channel = info.viaHuman ? voice.humanChannel : voice.autoChannel;
      try { synth?.noteOff(channel, note); } catch (err) {}
      voice.sounding.delete(note);
    }
  }

  _synthAndChannelFor(voice) {
    if (voice.owner === 'human' && voice.humanChannel !== null) {
      return { synth: this.humanSynth, channel: voice.humanChannel };
    }
    return { synth: this.accompSynth, channel: voice.autoChannel };
  }
}
