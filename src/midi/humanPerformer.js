// ============================================================
//  humanPerformer.js — 逐步觸發排程器（純邏輯，無 DOM／CDN）
//
//  沒有連續播放的時鐘，只有離散的「前進一步」。
//
//  指派聲部：依起始 tick 把音符分組成一步一步（同 tick 的多顆音＝和弦，一起算一步）。你每
//  做一次有效拋物線（vision.js 的 ArcDetector，triggerSeq 變動）就前進一步：關掉「原本該在
//  這一步結束」的音、開新的一步（樂譜原始 velocity），沒有任何快慢限制——你多快觸發，音符
//  就多快出來；一顆音會持續響到你觸發下一步、且原譜判定它該結束為止，不會被意外切斷。第一
//  次觸發如果第一步之前還有伴奏（前奏），只播前奏、不算前進一步。
//
//  伴奏（未指派的聲部）：沒有 Sequencer，改成反應式排程——每次任一位演奏者前進一步，就把
//  「這一步到（這位演奏者）下一步之間」原本該出現的伴奏音符，依原始時間差排入佇列，用
//  performance.now() 為準即時觸發 note-on／note-off。伴奏的進度完全綁在「目前所有演奏者中
//  推進最遠的那一位」，不會自己跑到前面。沒有任何聲部被指派時，整份當「伴奏」處理，改成
//  照真實經過時間連續自動播放（等同以前的整份播放）。
//
//  不重播 CC／pitch-bend：每個聲部的音色（bank/program）只在 load() 時套用一次，之後不跟著
//  播放過程逐一重放原始事件（刻意的簡化）。
// ============================================================

export const DEFAULT_PERFORMER_CONFIG = Object.freeze({
  drumChannel: 9,        // MIDI 規格：第 10 個 channel（索引 9）是打擊
  autoLookaheadSec: 3,   // 沒有人指派任何聲部時，整份自動播放每次預先排程的範圍（秒）
});

const CHANNELS_PER_PORT = 16;

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

// 把已依 startTick 排序的音符分組成一步一步：同 tick 的多顆音（和弦）算一步。
function groupIntoSteps(notes) {
  const steps = [];
  let current = null;
  for (const n of notes) {
    if (!current || current.startTick !== n.startTick) {
      current = { startTick: n.startTick, notes: [] };
      steps.push(current);
    }
    current.notes.push(n);
  }
  return steps;
}

export class HumanPerformer {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_PERFORMER_CONFIG, ...config };
    this.accompSynth = null;   // 伴奏合成器（未指派的聲部）
    this.humanSynth = null;    // 真人聲部合成器（指派的聲部）
    this._controlled = [];     // 每個指派聲部一筆，見 load()
    this._accompaniment = [];  // 扁平陣列：{ note, outChannel }，依 startSeconds 排序
    this._accompCursor = 0;    // 下一個「還沒排程」的伴奏音符在陣列中的位置
    this._accompChannels = []; // 伴奏用到的輸出 channel，all-notes-off 時要逐一清
    this._pending = [];        // 已排程、還沒到期的伴奏事件 { dueMs, fn }
    this.unplacedPartIds = []; // 輸出 channel 不夠用而排不進去的聲部（這一輪不會出聲）
    this._playing = false;
    this._playStartMs = null;  // 沒有指派任何聲部時，整份自動播放的起始時刻
    this._autoPlayedSec = 0;   // 同上，已經排程到的位置
  }

  setSynths(accompSynth, humanSynth) {
    this.accompSynth = accompSynth;
    this.humanSynth = humanSynth;
  }

  /**
   * 載入這首歌：指派聲部分組成步驟，未指派聲部攤平成伴奏清單。
   * @param {import('./midiParser.js').ParsedMidi} score  parseMidi() 的結果（不會被修改）
   * @param {string[]} assignedPartIds  要交給真人的聲部 id
   */
  load(score, assignedPartIds) {
    this.stop();
    this._controlled = [];
    this._accompaniment = [];
    this._accompCursor = 0;
    this._accompChannels = [];
    this._pending = [];
    this.unplacedPartIds = [];
    this._playStartMs = null;
    this._autoPlayedSec = 0;
    if (!score) return;

    const assigned = Array.isArray(assignedPartIds) ? assignedPartIds : [];
    const assignedSet = new Set(assigned);
    const partById = new Map(score.parts.map((p) => [p.id, p]));

    const notesByPart = new Map(); // score.notes 已依 startTick 排序，照順序分組即可
    for (const note of score.notes) {
      let list = notesByPart.get(note.partId);
      if (!list) notesByPart.set(note.partId, (list = []));
      list.push(note);
    }

    // ── 指派聲部：分組成步驟 ──
    const humanParts = assigned.map((id) => partById.get(id)).filter(Boolean);
    const { byPartId: humanChannelOf, unplaced: humanUnplaced } =
      allocateChannels(humanParts, melodicChannelsFor(this.humanSynth, this.cfg.drumChannel), this.cfg.drumChannel);
    this.unplacedPartIds.push(...humanUnplaced);

    for (const p of humanParts) {
      const outChannel = humanChannelOf.get(p.id);
      if (outChannel === undefined) continue;
      this._applyInitialPatch(this.humanSynth, outChannel, p);
      const steps = groupIntoSteps(notesByPart.get(p.id) || []);
      this._controlled.push({
        partId: p.id,
        outChannel,
        steps,
        cursorIndex: 0,
        sounding: new Map(), // note → endTick
        lastTriggerSeq: null,
        didLeadIn: false,
      });
    }

    // ── 未指派聲部：攤平成伴奏清單 ──
    const accompParts = score.parts.filter((p) => !assignedSet.has(p.id));
    const { byPartId: accompChannelOf, unplaced: accompUnplaced } =
      allocateChannels(accompParts, melodicChannelsFor(this.accompSynth, this.cfg.drumChannel), this.cfg.drumChannel);
    this.unplacedPartIds.push(...accompUnplaced);

    for (const p of accompParts) {
      const outChannel = accompChannelOf.get(p.id);
      if (outChannel === undefined) continue;
      this._applyInitialPatch(this.accompSynth, outChannel, p);
      this._accompChannels.push(outChannel);
    }
    this._accompaniment = score.notes
      .filter((n) => accompChannelOf.has(n.partId))
      .map((n) => ({ note: n, outChannel: accompChannelOf.get(n.partId) }));
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
    if (!this._controlled.length) {
      // 沒有人指派任何聲部：整份當伴奏，照真實經過時間連續播放；用 _autoPlayedSec 記住
      // 已經排到哪，暫停再繼續時起始時刻要往回推，不會平白多算一段暫停期間的時間。
      this._playStartMs = performance.now() - this._autoPlayedSec * 1000;
    }
  }

  // 暫停：清掉還沒到期的伴奏排程（避免暫停期間累積、恢復時一次爆音）、收掉還在響的音。
  pause() {
    this._playing = false;
    this._pending = [];
    this.silence();
  }

  silence() {
    for (const part of this._controlled) {
      for (const note of part.sounding.keys()) {
        try { this.humanSynth?.noteOff(part.outChannel, note); } catch (err) {}
      }
      part.sounding.clear();
    }
    if (this.accompSynth) {
      for (const ch of this._accompChannels) {
        try { this.accompSynth.controllerChange(ch, 123, 0); } catch (err) {} // CC123 All Notes Off
      }
    }
  }

  // 停止／換歌前的清場：收音＋游標歸零。
  stop() {
    this.pause();
    for (const part of this._controlled) {
      part.cursorIndex = 0;
      part.lastTriggerSeq = null;
      part.didLeadIn = false;
      part.sounding.clear();
    }
    this._accompCursor = 0;
    this._playStartMs = null;
    this._autoPlayedSec = 0;
  }

  isPlaying() { return this._playing; }

  isFinished() {
    const controlledDone = this._controlled.every((p) => p.cursorIndex >= p.steps.length);
    return controlledDone && this._accompCursor >= this._accompaniment.length;
  }

  /**
   * 由 midiPlayer.js 的排程 tick（~12ms）每次呼叫。
   * @param {number} nowMs  performance.now()
   * @param {(partId:string) => {present:boolean, triggerSeq:number}} getGestureFor
   *        該聲部指派 ID 目前的手勢狀態：present＝在場、triggerSeq＝拋物線觸發的累加計數。
   */
  tick(nowMs, getGestureFor) {
    if (!this._playing) return;

    while (this._pending.length && this._pending[0].dueMs <= nowMs) {
      const ev = this._pending.shift();
      try { ev.fn(); } catch (err) {}
    }

    if (!this._controlled.length) {
      // 沒有人指派任何聲部：整份當伴奏，照真實經過時間連續往前排程。
      const elapsedSec = (nowMs - this._playStartMs) / 1000;
      const horizon = elapsedSec + this.cfg.autoLookaheadSec;
      this._scheduleAccompInRange(this._autoPlayedSec, horizon, 0, this._playStartMs);
      this._autoPlayedSec = horizon;
      return;
    }

    for (const part of this._controlled) {
      const g = (getGestureFor && getGestureFor(part.partId)) || { present: false, triggerSeq: 0 };
      let triggered = false;
      if (part.lastTriggerSeq === null) {
        // 剛 load() 完的第一次觀察：只記錄基準，不當成「這一刻剛觸發」。
        part.lastTriggerSeq = g.triggerSeq;
      } else if (g.triggerSeq !== part.lastTriggerSeq) {
        part.lastTriggerSeq = g.triggerSeq;
        triggered = true;
      }
      if (triggered) this._advanceControlled(part, nowMs);
    }
  }

  // 前進一步：第一次觸發如果第一步之前還有伴奏（前奏），只排前奏、不前進；之後每次觸發
  // 關掉「原本該在這一步結束」的音、開新的一步，並把「這一步到下一步之間」的伴奏排入佇列。
  _advanceControlled(part, nowMs) {
    if (!part.didLeadIn) {
      part.didLeadIn = true;
      const to = part.steps.length ? part.steps[0].notes[0].startSeconds : Infinity;
      this._scheduleAccompInRange(0, to, 0, nowMs);
      return;
    }

    if (part.cursorIndex >= part.steps.length) return; // 已經彈完了，之後的觸發沒有效果

    const step = part.steps[part.cursorIndex];
    const stepSeconds = step.notes[0].startSeconds;

    this._releaseDueControlled(part, step.startTick);
    for (const n of step.notes) {
      try { this.humanSynth?.noteOn(part.outChannel, n.note, n.velocity); } catch (err) {}
      part.sounding.set(n.note, n.endTick);
    }
    part.cursorIndex++;

    const to = part.cursorIndex < part.steps.length
      ? part.steps[part.cursorIndex].notes[0].startSeconds
      : Infinity;
    this._scheduleAccompInRange(stepSeconds, to, stepSeconds, nowMs);
  }

  // 關掉這個聲部裡「原本該在 uptoTick（含）之前結束」的音——一顆音持續響到你觸發下一步、
  // 且原譜判定它該結束為止，不是用實際秒數算時長。
  _releaseDueControlled(part, uptoTick) {
    for (const [note, endTick] of [...part.sounding]) {
      if (endTick <= uptoTick) {
        try { this.humanSynth?.noteOff(part.outChannel, note); } catch (err) {}
        part.sounding.delete(note);
      }
    }
  }

  // 排程「原本落在 [fromSec, toSec) 這段時間內」、還沒排程過的伴奏音符；每顆音的實際延遲＝
  // 它原始時間跟 originSec 的差，從 nowMs 這一刻起算（originSec 通常等於 fromSec，也就是
  // 剛推進到的這一步／這一刻）。伴奏清單已依 startSeconds 排序，游標只前進不回頭。
  _scheduleAccompInRange(fromSec, toSec, originSec, nowMs) {
    while (this._accompCursor < this._accompaniment.length) {
      const entry = this._accompaniment[this._accompCursor];
      const sec = entry.note.startSeconds;
      if (sec < fromSec) { this._accompCursor++; continue; } // 已排序，理論上不會發生，防呆用
      if (sec >= toSec) break;
      this._accompCursor++;
      const delayMs = Math.max(0, sec - originSec) * 1000;
      this._scheduleNoteEvents(entry, nowMs + delayMs);
    }
  }

  _scheduleNoteEvents(entry, onMs) {
    const { note, outChannel } = entry;
    const offMs = onMs + Math.max(1, note.durationSeconds * 1000);
    this._pending.push({
      dueMs: onMs,
      fn: () => { try { this.accompSynth?.noteOn(outChannel, note.note, note.velocity); } catch (err) {} },
    });
    this._pending.push({
      dueMs: offMs,
      fn: () => { try { this.accompSynth?.noteOff(outChannel, note.note); } catch (err) {} },
    });
    // 佇列不大（每次只新增一兩顆音的 on/off），插入排序的成本可接受。
    this._pending.sort((a, b) => a.dueMs - b.dueMs);
  }
}
