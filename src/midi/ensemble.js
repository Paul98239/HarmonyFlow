// ensemble.js — 合奏的判斷規則：門檻數字、拍與 ms 的換算、名單（誰先開始演奏）與帶頭的人怎麼挑。純函式與資料結構，不碰合成器與排程器的狀態。
// 規則見規格（docs/design-spec.md）「合奏」（使用者是不熟音樂的一般人、老年人：區間寬、要連續幾下才處理）。

// 應用層數字（起始值，之後用錄音調；不是規格）。拍＝四分音符（timeDivision tick）；門檻＝max(拍數 × 目前一拍的 ms, ms 下限)，ms 下限＝150 BPM 時的長度，歌再快也不再縮。
export const ENSEMBLE = Object.freeze({
  TIE_BEATS: 1 / 4, TIE_MIN_MS: 150,                       // 兩人開始的時刻差不到這麼多就算同時
  GESTURE_CONFIRM_BEATS: 4, GESTURE_CONFIRM_MIN_MS: 3000,  // 揮手要在第一下之後這麼久內再揮一下，才算真的開始（擋幽靈 ID、誤觸發）
  SLIGHT_BEATS: 1 / 4, SLIGHT_MIN_MS: 100,                 // 稍快／稍慢
  OFF_BEATS: 1 / 2, OFF_MIN_MS: 200,                       // 偏離：同方向連續 OFF_PERSIST 下才處理
  LOST_BEATS: 1, LOST_MIN_MS: 400,                         // 脫隊：這一下就處理
  SYNC_EXIT_BEATS: 1 / 8, SYNC_EXIT_MIN_MS: 50,            // 退回同步要比這個小（進出用不同門檻，免得在邊界閃）
  OFF_PERSIST: 2,
  REST_HANDOVER_BEATS: 1,                                  // 帶頭的人的休止還剩這麼多拍以上才交棒
  REST_LOCK_BEATS: 1,                                      // 下一個起音前面的休止至少這麼長、觸發時離它還有這麼多拍以上：休止符鎖
  AHEAD_RELEASE_BEATS: 1 / 2,                              // 超前鎖：合奏走到只超前這麼多時放出
  STAGE1_GRACE_FRACTION: 1 / 2, STAGE1_GRACE_MIN_MS: 200,  // 第一段（換帶頭）寬限＝他這一步預估長度的一半
  ABSENT_STAGE1_MS: 500,                                   // 揮手的人連續這麼久不在鏡頭裡：第一段不等寬限
  MAJORITY_PERSIST: 2,                                     // 三人以上的多數決：各自連續幾下偏離
  MISSED_BEHIND_BEATS: 1 / 2,                              // 合奏超過他的那一下這麼多，才算錯過
  STAGE2_K: 4, STAGE2_BEATS: 4, STAGE2_MIN_MS: 2000,       // 第二段（代打）：錯過 K 下且離上一下這麼久
  STAGE2_SPARSE_BEATS: 8, STAGE2_SPARSE_MIN_MS: 5000,      // 聲部稀疏時：錯過 1 下且離上一下這麼久
  ABSENT_STAGE2_MS: 1000,                                  // 不在鏡頭這麼久且錯過 1 下：直接代打
  IDLE_REST_BEATS: 1,                                      // 第二段：他下一個起音前面的休止至少這麼長，「離上一下多久」就從合奏走到那個起音算（休止中本來就不用按）
  ACTIVE_BEATS: 4, ACTIVE_MIN_MS: 2000,                    // 正在彈：離上一下不超過這麼久
  RECOVER_BEATS: 1 / 4, RECOVER_PERSIST: 2,                // 多數決出狀況的人連續幾下 |x| 小於這個才恢復
  STEADY_RATIO: 1.5, STEADY_PRESSES: 3,                    // 停住、代打回來的人：相鄰間隔的隱含速度差小於這個倍數才接成一串，至少這麼多下
  STEADY_BEATS: 2, STEADY_MIN_MS: 1000,                    // 這一串跨過這麼久（拍長照他自己的速度）就恢復
  SMPTE_BEAT_SEC: 0.5,                                     // SMPTE 檔沒有四分音符，一拍當 0.5 樂譜秒
});

/** 門檻（ms）：拍數換成目前一拍的 ms，跟 ms 下限取大。 */
export const threshold = (beats, minMs, beatMsValue) => Math.max(beats * beatMsValue, minMs);

/** 從樂譜位置 tick 起一拍（四分音符）在速度 rate 下的真實 ms；SMPTE（timeDivision 是 null）用 ENSEMBLE.SMPTE_BEAT_SEC。 */
export function beatMs(score, tick, rate) {
  const sec = score.timeDivision ? score.midiTicksToSeconds(tick + score.timeDivision) - score.midiTicksToSeconds(tick) : ENSEMBLE.SMPTE_BEAT_SEC;
  return (sec * 1000) / rate;
}

/**
 * 相對時間 x（ms，正＝超前、負＝落後）落在哪個區間：同步／稍快稍慢／偏離／脫隊（規格「合奏」）。prevZone＝他上一下的區間：
 * 不是同步時，|x| 要退到 SYNC_EXIT 以內才回到同步（進出用不同門檻，免得在邊界閃）。
 */
export function classifyOffset(xMs, beatMsValue, prevZone) {
  const a = Math.abs(xMs), E = ENSEMBLE;
  if (a >= threshold(E.LOST_BEATS, E.LOST_MIN_MS, beatMsValue)) return 'lost';
  if (a >= threshold(E.OFF_BEATS, E.OFF_MIN_MS, beatMsValue)) return 'off';
  if (a >= threshold(E.SLIGHT_BEATS, E.SLIGHT_MIN_MS, beatMsValue)) return 'slight';
  return prevZone !== 'sync' && a > threshold(E.SYNC_EXIT_BEATS, E.SYNC_EXIT_MIN_MS, beatMsValue) ? 'slight' : 'sync';
}

/** 第一段防呆的寬限（ms）：合奏停在帶頭的人的下一個起音之後，再等他這一步預估長度（stepMs）的一半，至少 STAGE1_GRACE_MIN_MS。 */
export const stage1GraceMs = (stepMs) => Math.max(stepMs * ENSEMBLE.STAGE1_GRACE_FRACTION, ENSEMBLE.STAGE1_GRACE_MIN_MS);

/**
 * 第二段防呆（規格「合奏」）：要不要由電腦代打。任一成立：錯過 ≥ k 下而且離他上一下 ≥ max(STAGE2_BEATS 拍, STAGE2_MIN_MS)；錯過 ≥ 1 下而且離上一下
 * ≥ max(STAGE2_SPARSE_BEATS 拍, STAGE2_SPARSE_MIN_MS)（聲部很稀疏）；錯過 ≥ 1 下而且連續 ABSENT_STAGE2_MS 不在鏡頭裡。
 */
export function shouldSubstitute({ missed, sinceLastMs, beatMs: beat, absentMs = 0, k = ENSEMBLE.STAGE2_K }) {
  const E = ENSEMBLE;
  if (missed < 1) return false;
  return (missed >= k && sinceLastMs >= threshold(E.STAGE2_BEATS, E.STAGE2_MIN_MS, beat))
    || sinceLastMs >= threshold(E.STAGE2_SPARSE_BEATS, E.STAGE2_SPARSE_MIN_MS, beat)
    || absentMs >= E.ABSENT_STAGE2_MS;
}

/**
 * 正在彈：不在休止裡，而且還在等他自己的下一個起音（彈長音時），或離他上一下不超過 max(4 拍, 2 秒)。
 * waiting＝他的下一個起音照他自己的速度還沒到期——彈長音、或剛按完的人不能因為「一陣子沒按」就被當成沒在彈。
 */
export function isActive({ sinceLastMs, beatMs: beat, resting, waiting = false }) {
  if (resting) return false;
  return waiting || sinceLastMs <= threshold(ENSEMBLE.ACTIVE_BEATS, ENSEMBLE.ACTIVE_MIN_MS, beat);
}

/**
 * 名單：依「第一次演奏」的動作時刻排；差不到 tieMs 算同時，同時的照指派下拉順序（order 小的在前）。順序之後不因快慢重排，
 * 只有移出（remove）與清空（clear）。provisional＝揮手的人還沒連續揮兩下確認。
 */
export class Roster {
  constructor() { this._entries = []; }   // { slot, motionMs, order, provisional }，依名次排

  admit(slot, { motionMs, order, tieMs, provisional = false }) {
    if (this.has(slot)) return;
    const entry = { slot, motionMs, order, provisional };
    let i = this._entries.findIndex((e) => e.motionMs > motionMs);
    if (i < 0) i = this._entries.length;
    // 跟前後差不到窗口的算同時，照下拉順序：往前換過下拉順序比他後面的，往後讓過下拉順序比他前面的（揮手確認晚到，動作卻比先收到的鍵盤早）
    while (i > 0 && motionMs - this._entries[i - 1].motionMs < tieMs && order < this._entries[i - 1].order) i--;
    while (i < this._entries.length && this._entries[i].motionMs - motionMs < tieMs && this._entries[i].order < order) i++;
    this._entries.splice(i, 0, entry);
  }

  confirm(slot) { const e = this._entries.find((x) => x.slot === slot); if (e) e.provisional = false; }
  hasConfirmed() { return this._entries.some((e) => !e.provisional); }
  remove(slot) { this._entries = this._entries.filter((e) => e.slot !== slot); }
  has(slot) { return this._entries.some((e) => e.slot === slot); }
  isProvisional(slot) { return this._entries.find((e) => e.slot === slot)?.provisional ?? false; }
  firstMotionMs(slot) { return this._entries.find((e) => e.slot === slot)?.motionMs; }
  slots() { return this._entries.map((e) => e.slot); }
  clear() { this._entries = []; }
}

/**
 * 停住、代打回來的人「穩定的一串」：run＝{ startMs, prevMs, prevSec, prevRate, presses }，motionMs＝這一下的動作時刻、sec＝他這一下的樂譜秒。
 * 跟上一段的隱含速度差 ≥ STEADY_RATIO 倍就從上一下重新起算；restart（落後跳）、時間或位置沒往前就從這一下起算。
 */
export function extendSteadyRun(run, motionMs, sec, restart = false) {
  if (!run || restart || motionMs <= run.prevMs || sec <= run.prevSec) return { startMs: motionMs, prevMs: motionMs, prevSec: sec, prevRate: null, presses: 1 };
  const rate = ((sec - run.prevSec) * 1000) / (motionMs - run.prevMs);
  // 對數差：快 1.5 倍與慢 1.5 倍對稱
  const broken = run.prevRate !== null && Math.abs(Math.log(rate / run.prevRate)) >= Math.log(ENSEMBLE.STEADY_RATIO);
  return { startMs: broken ? run.prevMs : run.startMs, prevMs: motionMs, prevSec: sec, prevRate: rate, presses: broken ? 2 : run.presses + 1 };
}

/** 穩定的一串夠長了：至少 STEADY_PRESSES 下、跨過 max(STEADY_BEATS 拍, STEADY_MIN_MS)。 */
export const isSteadyRun = (run, beatMsValue) => !!run && run.presses >= ENSEMBLE.STEADY_PRESSES
  && run.prevMs - run.startMs >= threshold(ENSEMBLE.STEADY_BEATS, ENSEMBLE.STEADY_MIN_MS, beatMsValue);

/** 名單上第一個符合條件的槽位；都不符合回 null。 */
export function pickLeader(slots, isCandidate) {
  for (const slot of slots) if (isCandidate(slot)) return slot;
  return null;
}
