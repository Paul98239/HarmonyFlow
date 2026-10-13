// ============================================================
//  scheduler.js — 排程器（純邏輯，無 DOM／CDN）
//
//  時間單位：整份總譜只有一條時間軸，單位是 MIDI tick（SMF 規格唯一的時間單位；秒只是用速度表換算出來的衍生值）。
//  電腦聲部的音符對應到「你的聲部」的 tick，不是第二條時鐘。
//
//  兩種聲部（模仿同事 SmartEnsemble 的「主控／伴奏」，但以這個專案的做法為主）：
//    · driver（kind: 'human'，走 humanSynth）＝被指派的聲部。每個起音要你按一次：parser 的 segment（同一個 startTick 的所有音）
//      裡屬於 driver 的音，一次按鍵（`trigger(輸入事件)` 或 `trigger(slot, nowMs)`，鍵盤或日後的手勢）放行一個 segment，在這次呼叫內立刻 noteOn（0ms）。
//    · follower（kind: 'assist'，走 assistSynth）＝沒被指派的電腦輔助聲部。不用按：它的音依 tick 分屬 driver 起音之間的「段」，
//      按鍵啟動它負責的那一段。
//  沒有任何 driver（沒有指派，或指派的聲部都沒有音符）＝整首自動播放：只有第 0 段，從開頭照原速放完（同一條程式路徑）。
//
//  按鍵啟動它負責的那一段：第 k 次按鍵放行 driver 起音 T_k，同時記下錨點 { T_k, 按下的時刻, 速度 }，並把落在 [T_k, T_{k+1})
//  的 follower 音各自排好發聲時刻：`按下時刻 + (樂譜秒(startTick) − 樂譜秒(T_k)) ÷ playbackRate`（startTick == T_k 的在這次呼叫內
//  同刻發聲）。第 0 段（第一個 driver 起音之前的前奏）在 play() 後用 1× 起算，所以前奏照原速播、停在你的入場點。前奏還沒播完
//  時按鍵不放行（前奏鎖：不然第 1 段重新對時，前奏剩下的音就被跳過），只記預按，播到入場點由 tick() 自動放行第一個起音。
//    · 你按得比預估早（垂直切片）：按下 T_k 的那一刻，樂譜上「T_k 這個垂直 tick 響著什麼」＝ T_k 的 segment ＋ 從更早延續過來、
//      endTick > T_k 的音。上一段還沒輪到的 follower 音因此分兩種：還該響著的追音（現在發聲，長度是 T_k 到它結尾的剩餘長度 ÷ 速度），
//      整顆在你身後的跳過（不發聲）。這一段的錨點就是按下的時刻，同 tick 的電腦音永遠與你同刻（見 _chaseOrSkip 與 chaseStats）。
//      文獻：Antescofo 的 @tight＋@local（位置優先、丟棄已過去的動作）、DAW 的 Chase Events（補發還在響的音）、Dannenberg 1984 §8。
//    · 你按得比預估晚：這一段放完就靜止等你，不會越過你的下一個起音；已經開始的音照音長收完（loop 的音等你按）。
//  playbackRate（命名同官方 Sequencer：樂譜秒 ÷ 真實秒）＝最近 8 個按鍵的頭尾比值（tempoFollower.js＋pressTiming.js，模擬評估選出來的）。
//  去抖（tempoFollower.js）：兩次按鍵太近就忽略第二次（擋手抖、手勢重複觸發）。
//
//  收音：音長與起音一樣依你的速度等比例縮放（檔案音長 ÷ playbackRate，整份譜用你的 BPM 演奏）。driver 的音到期或下一次按鍵時 endTick ≤
//  新錨點的先收掉（先收再放），follower 的音從它發聲的時刻起算同一個長度。
//  hold（loop 等你按下一個起音）：音的結尾對齊、或橫跨某個還沒放行的 driver 起音（你的與電腦的一樣，見 voiceLedger.js 的 holdOf()），原長走完也不收，
//  等你按到「結尾之前（含）最後一個起音」才收，收在「該軌的時刻 ＋ 檔案裡那個起音到結尾的長度 ÷ 速度」（見 voiceLedger.js 的 releaseHeld()；你的音的時刻是
//  你按下的那一刻，電腦音的時刻是電腦走到這個起音的那一刻）。以你的聲部為準：結尾對齊起音（含匯出器統一縮短一點點的相連音）時剩餘長度是 0＝
//  起音那一刻就收，就算原長還沒走完（你比預估快）也收；橫跨起音的音在這個起音之後再響完剩餘長度。
//  是否 hold 看每顆音自己的結尾，不看它屬於哪個 segment：同 tick 你的音短、電腦音長時，短音照自己的長度收、長音等它的那個起音。
//  尾巴收尾：同一個譜表的新音發聲時，還在響的舊音（起音 tick 比新音早）的收音時刻上限＝新音發聲時刻 ＋ 檔案裡這兩顆音的重疊量
//  （結尾 tick − 新音起音 tick，最少 0）÷ 速度——舊音不會比檔案裡的重疊多響一截（糊在一起），也不丟音；hold 著的舊音在檔案沒有重疊時
//  在這裡被截成有限值。例外：檔案裡真的重疊、音高不同、舊音還在 hold（同一行譜的多聲部，重疊是樂譜本意）不修剪，長音繼續 loop。
//  同音高重疊的音依發聲順序先進先出收音（hold 著的不算），每個 noteOn 都送出一個 noteOff。以上（正在響的音）由發聲帳本 voiceLedger.js 保管。
//
//  lookahead：tick(nowMs, audioNow) 有給 AudioContext 時間時，電腦輔助聲部 LOOKAHEAD_MS 以內要發聲／收音的事件提早帶時間戳（eventOptions.time）
//  送進合成器，由 worklet 依取樣時鐘準時放，不受主執行緒卡頓影響；你的聲部永遠立即發聲、不帶時間戳。worklet 沒有取消已排程事件的
//  辦法，所以暫停時「已送出、還沒響」的音要另外送帶時間戳的 noteOff（見 outputRouter.js 的 offOpts()）。所有合成器呼叫都經過
//  outputRouter.js（輸出 channel 分配、初始音色、時間戳）。
//
//  排程器自己的時鐘（`_clockMs`）只在 tick() 前進、暫停時不走，所以暫停的時間不會被當成按鍵間隔，恢復後排好的時刻照剩下的時間放。
//  velocity 一律用樂譜原值；不重播 CC／pitch-bend，每個 staff 的初始狀態（bank／program 與 CC7／10／91／93）只在 load() 時送一次，
//  而且一定在該 channel 的第一個 noteOn 之前。
//
//  預報入口（段中換錨）：每個 driver 群組可以掛一個預報器（setForecaster()，預設沒有＝行為完全不變）。排程器每個 tick 問它「你會在
//  什麼時刻按下一個起音」，收到有效的預報就以（現在、此刻的樂譜位置、新速度）換錨，重排這一段還沒送出的電腦音（見 _applyForecast）。
//  預報只是暫時的：真正按下時照原本的流程（早按走垂直切片、晚按停格等你），下一段的速度照舊來自速度追蹤。
//
//  聲部單位（part／staff）與 driver 群組見 performancePlan.js（演奏計畫，載入、改指派時建好，之後不變）。每個 driver 群組在這裡
//  各有一份執行期狀態：游標、錨點、電腦音佇列、前奏預按、停格旗標、速度追蹤（makeGroupState()）。現在永遠只有一個群組
//  （所有被指派的槽位共用同一條 driver 序列、擁有全部的 follower）；播放頭、hold 判定、對外的 playbackRate 看第一個群組。
// ============================================================

import { TempoFollower } from './tempoFollower.js';
import { OutputRouter, portsFor } from './outputRouter.js';
import { PerformanceEvents, lateStatsSubscriber, chaseStatsSubscriber, pressLogSubscriber, eventLogSubscriber } from './performanceEvents.js';
import { VoiceLedger, scaledMs, EPS_MS } from './voiceLedger.js';
import { buildPlan, staffPools, sliceOfTick } from './performancePlan.js';

// channel 的單一來源在 outputRouter.js；synth.js 從這裡 import（對外的匯出不變）。
export { CHANNELS_PER_PORT, DEFAULT_PORTS } from './outputRouter.js';

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  drumChannel: 9, // MIDI 規格：第 10 個 channel（索引 9）是打擊
  // 預報的到達時刻跟目前預計的差不到這麼多（毫秒）就不換錨：預報器每個 tick 都會更新，免得每個 tick 都重排。應用層數字，評估工具可以調
  forecastMinChangeMs: 10,
});

// 鍵盤的演奏者槽位。肢體動作的槽位是數字 1~4（演奏者 ID），鍵盤用字串，兩者不衝突，日後可以並存。
// 單一來源：midiPlayer.js 列在指派下拉的「PC 鍵盤手」、main.js 交給 keyboard.js 的觸發槽位都用它。
export const KEYBOARD_SLOT = 'kb';

/* ═══════════════════════════════════════════
   應用層常數——不是規格
   ═══════════════════════════════════════════ */
// 每個 tick 的時間步長上限：分頁被瀏覽器節流（背景分頁的計時器可能隔好幾秒才醒來）後恢復時，時鐘最多只前進這麼多，
// 不會一次把空窗期的音全部放出來或收掉。
const MAX_TICK_DT_MS = 100;
// lookahead：tick() 把「這麼久以內就要發聲／收音」的電腦音提早帶時間戳（eventOptions.time，AudioContext 時間）送進合成器，
// 由 worklet 依取樣時鐘準時放，主執行緒被影像算繪卡住幾十毫秒也不會晚。取捨：送出去的事件 worklet 沒有取消的辦法
// （spessasynth_core 的 eventQueue 只有 push／shift），所以這段時間內的音「一定會響」。50ms 是蓋過實機量到的主執行緒
// 停頓（攝影機開著，最大約 40ms）的最小值；只用在電腦輔助聲部，你的音永遠立即發聲、不帶時間戳。
const LOOKAHEAD_MS = 50;

// 這首歌至少需要幾個 port 的 channel（不低於 DEFAULT_PORTS）：旋律 staff 每個 port 有 15 個、打擊 staff 每種鼓組 program 佔一個
// port 的打擊槽，指派與未指派兩個池子（兩個合成器）各自算，取較大的（見 outputRouter.js 的 portsFor()）。assignments 同 load()：
// Map 或 [partId, 槽位][]。
export function portsNeeded(score, assignments) {
  const { assigned, assist } = staffPools(score, assignments);
  return portsFor([assigned, assist].map((specs) => ({
    melodic: specs.filter((s) => !s.percussionKit).length,
    kits: new Set(specs.filter((s) => s.percussionKit).map((s) => s.program)),
  })));
}

/* ═══════════════════════════════════════════
   driver 群組的執行期狀態
   ═══════════════════════════════════════════ */
// 每個群組一份：計畫（plan：performancePlan.js 的群組，載入後不變）、速度追蹤 tempo，以及播放狀態（_resetPlayback() 要全部重設）。
// tempo：改指派時沿用舊的（速度估計保留，見 reassign()），沒給就新建（1×）；速度區間一律換成這個群組的計畫算的。
function makeGroupState(index, plan, tempo = new TempoFollower()) {
  tempo.setBounds(plan.rateBounds);
  return {
    index,                 // 群組編號（對外事件的 group）
    plan,
    tempo,                 // 速度估計 playbackRate、停手／變速判斷、去抖（見 tempoFollower.js）
    cursor: 0,             // 下一個要放行的 driver segment
    anchor: null,          // 目前這一段的錨點 { slice, clockMs, scoreSec, rate }
    anchoredSlice: -1,     // 已經被啟動的最大段（第 0 段＝前奏，第 k+1 段由第 k 次按鍵啟動）
    pending: [],           // 排好時刻、還沒發聲的 follower 音：[{ dueMs, offMs, staff, note }]，依 dueMs 排序
    preludeCredit: false,  // 前奏鎖期間有人預按過（布林）：播放頭到入場點時自動放行第一個起音
    stalled: false,        // 播放頭停在你的下一個起音（stall 事件只在狀態改變時發）
  };
}

/* ═══════════════════════════════════════════
   Scheduler
   ═══════════════════════════════════════════ */
export class Scheduler {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this._router = new OutputRouter(this.cfg.drumChannel);   // 兩個合成器、輸出 channel、初始音色、lookahead 時間戳：所有合成器呼叫都經過它
    this.events = new PerformanceEvents();   // 對外事件（統計、視覺化、測試工具訂閱）：trigger()／tick()／暫停等呼叫結束、合成器的呼叫都送出之後才發
    this._ledger = new VoiceLedger(this._router, this.events);   // 發聲帳本：正在響的音、hold、尾巴收尾、先進先出收音（見 voiceLedger.js）
    this._score = null;
    this._plan = buildPlan(null);   // 載入後不變的計畫（staff、driver 群組、總音數、hold 容差上限；見 performancePlan.js）
    this._groups = this._plan.groups.map((p, i) => makeGroupState(i, p));   // 每個 driver 群組的執行期狀態（現在永遠一個）
    this._forecasters = [];    // 群組編號 → 預報器（setForecaster()；預設沒有）。是設定不是播放狀態：載入、改指派、重設都不拿掉
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
  }

  setSynths(assistSynth, humanSynth) {
    this._router.setSynths(assistSynth, humanSynth);
  }

  setPortCount(ports) {
    this._router.setPortCount(ports);
  }

  /**
   * 掛上（或拿掉，傳 null）一個 driver 群組的預報器。排程器每個 tick 呼叫 forecaster.forecast(view)（view 見 _forecastView()），
   * 回傳 { atMs（預估你按下一個起音的排程器時鐘時刻）, uncertaintyMs?, source } 或 null（不預報）。預設沒有預報器：行為完全不變。
   */
  setForecaster(groupIndex, forecaster) {
    this._forecasters[groupIndex] = forecaster || undefined;
  }

  get assistSynth() { return this._router.assistSynth; }   // 電腦輔助聲部（follower）的合成器
  get humanSynth() { return this._router.humanSynth; }     // 被指派聲部（driver）的合成器
  get ports() { return this._router.ports; }               // 合成器目前有幾個 port（每個 16 個 channel）
  get playbackRate() { return this._groups[0].tempo.playbackRate; }  // 你現在的速度（樂譜秒 ÷ 真實秒，第一個群組的），命名同官方 Sequencer
  get unplacedStaffIds() { return this._plan.unplaced; }   // 輸出 channel 排不進去（旋律 staff 超過 60 個、鼓組超過 4 種）的 staff，這一輪不出聲

  _secOf(tick) {
    return this._score.midiTicksToSeconds(tick);
  }

  /**
   * 載入這首歌：建立 staff、套初始音色，把全曲的音分成 driver segment 與 follower。
   * @param {import('./midiParser.js').ParsedMidi} score  parseMidi() 的結果（不會被修改）
   * @param {Map<string,number>|[string,number][]} assignments  partId → 演奏者槽位
   */
  load(score, assignments) {
    this.stop();
    this._score = score || null;
    this._plan = buildPlan(this._score, assignments, this._router);   // 沒有樂譜時是空的計畫：tick() 空轉
    for (const staff of this._plan.staves.values()) this._router.applyInitialPatch(staff);
    this._groups = this._plan.groups.map((p, i) => makeGroupState(i, p));
    this._bindLedger();
  }

  // 發聲帳本綁定這一輪的譜表與計畫（載入、改指派之後）。hold 看第一個群組的 driver 起音（現在只有一個群組；多個群組時每顆音
  // 跟哪個群組的起音 hold，是多人分工規則的一部分）。
  _bindLedger() {
    this._ledger.bind({ staves: this._plan.staves, driverTicks: this._groups[0].plan.driverTicks, holdCapTicks: this._plan.holdCapTicks, secOf: (tick) => this._secOf(tick) });
  }

  /**
   * 播放到一半改指派（或整首自動播放 ↔ 有人演奏）：從目前的播放位置接續，不從頭。
   * 做法：量舊計畫的播放頭，算出「界線 boundary」→ 收掉還在響的音 → 依新的指派重建 staff 與計畫（同 load()）→ 起音在界線之前的音算已經過了
   * （不重播、不補放，isFinished 才算得對）→ driver 游標指到第一個 >= 界線的起音 → 以現在的時鐘為界線重新錨定這一段（速度沿用）。
   * 界線：舊計畫停格在你的下一個起音上（播放頭已走到它，還沒按）→ 那個起音的 tick（它的音還沒響）；否則是播放頭所在的 tick（含）
   * ——剛按下一個起音、播放頭還在它上面時，那個 tick 的音已經響過，不能再放一次。
   * 去抖與估速歷史清掉（舊的間隔對不上新的 driver 序列），速度估計保留；前奏鎖依新計畫重算（界線若還在新 driver 的第一個起音之前，
   * 前奏鎖照常生效）。播放／暫停狀態不變。切換的瞬間還在響的音會被收掉、不重播；lookahead 已經提早送出、還沒響的電腦音取消不了，
   * 若它的起音在界線之後，新計畫會再放一次（最多 LOOKAHEAD_MS 內的短暫重複）。
   * 群組：現在只有一個，播放頭與速度看它；多個群組時新舊群組怎麼對應是多人分工規則的一部分。
   * @param {Map<string,number|string>|[string,number|string][]} assignments  同 load()
   */
  reassign(assignments) {
    if (!this._score) return;
    const score = this._score;
    const rate = this.playbackRate;
    const pos = this.getPositionTicks();
    const old = this._groups[0];
    const next = old.plan.driverSegs[old.cursor];
    // 播放頭是浮點數（秒 ↔ tick 換算有誤差）：比大小都留一個微小量，起音 tick 是整數
    const boundary = next && pos >= next.ticks - 1e-6 ? next.ticks : pos + 1e-6;
    this.silence();
    this._plan = buildPlan(score, assignments, this._router);
    for (const staff of this._plan.staves.values()) this._router.applyInitialPatch(staff);
    // 群組狀態依新計畫重建（游標、錨點、佇列、前奏預按、停格都是新的），速度追蹤沿用舊群組的（速度估計保留）
    this._groups = this._plan.groups.map((p, i) => makeGroupState(i, p, this._groups[i]?.tempo));
    this._bindLedger();
    const g = this._groups[0];

    // 起音在界線之前的音都算已經過了（不重播、不補放）。舊佇列裡沒有需要保留的電腦音：tick／trigger 之後佇列裡的音都排在時鐘之後，
    // 起音一定在播放頭之後（界線之後）；你早按時沒輪到的音當場就追音或跳過了（見 _chaseOrSkip），不會留在佇列裡。
    this._sounded.clear();
    for (const staff of this._plan.staves.values()) {
      for (const note of staff.notes) if (note.startTick < boundary) this._sounded.add(note);
    }
    g.cursor = g.plan.driverTicks.findIndex((t) => t >= boundary);   // 第一個 >= 界線的 driver 起音；都在前面就是放完了
    if (g.cursor === -1) g.cursor = g.plan.driverTicks.length;
    this._skipped.clear();                                           // 界線之前的音都已重新記成處理過（上面的 _sounded）
    this._finishSent = false;
    g.tempo.forgetHistory();
    this._lastTickMs = null;
    // 這一段的編號＝已經放行的 driver 起音數；第 0 段（前奏）一律 1× 起算
    this._anchorSlice(g, g.cursor, this._clockMs, this._secOf(Math.max(0, boundary)), g.cursor === 0 ? 1 : rate, boundary);
    this.events.flush();
  }

  play() {
    this._playing = true;
    // 第一個 tick 的 dt 是 0；暫停的時間不會算進時鐘（時鐘只在 tick() 前進），所以不用重設任何排好的時刻。
    this._lastTickMs = null;
  }

  // 暫停：收掉還在響的音，時鐘、錨點與排好的 follower 音都保留（下次播放從原處繼續）。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    for (const g of this._groups) g.preludeCredit = false; // 預按作廢：續播後要重新按
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

  // 從頭重播：收音、退回剛載入的樣子，再接著播放（跟 stop() 共用 _resetPlayback()，只差最後一步）。
  restart() {
    this.pause();
    this._resetPlayback();
    this.play();
  }

  // 把播放狀態整個退回「剛 load() 完」的樣子：stop() 與 restart() 共用這一個函式。之後任何新增的
  // 狀態欄位都要在這裡重設（test/unit/scheduler.test.mjs 有一個整體快照比對，忘了重設會
  // 直接失敗）。呼叫端負責先收音（pause()）與決定要不要接著播放。
  _resetPlayback() {
    for (const g of this._groups) {
      g.cursor = 0;
      g.anchor = null;
      g.anchoredSlice = -1;
      g.pending = [];
      g.preludeCredit = false;
      g.stalled = false;
      g.tempo.reset();
    }
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
   * 唯讀快照（複本）：測試、工具與之後的視覺化用，取代直接讀私有欄位。陣列與物件都是新的；note 是樂譜裡的同一個物件
   * （唯讀，不複製）。groups 現在永遠一個：所有被指派的槽位共用同一條 driver 序列（多人分工等手勢接回再定）；最上層的
   * playbackRate／rateBounds／followers／sliceFirst 是第一個群組的。
   */
  inspect() {
    const withStaffId = ({ staff, note }) => ({ staffId: staff.id, note });
    const first = this._groups[0].plan;
    return {
      loaded: !!this._score,
      playing: this._playing,
      clockMs: this._clockMs,
      playbackRate: this.playbackRate,
      rateBounds: this.rateBounds(),
      totalNotes: this._plan.totalNotes,
      holdCapTicks: this._plan.holdCapTicks,
      sounded: new Set(this._sounded),
      skipped: new Set(this._skipped),
      unplacedStaffIds: [...this._plan.unplaced],
      followers: first.followers.map(withStaffId),
      sliceFirst: [...first.sliceFirst],
      groups: this._groups.map((g) => ({
        slots: [...g.plan.slots],
        segments: g.plan.driverSegs.map((s) => ({ ticks: s.ticks, items: s.items.map(withStaffId) })),
        cursor: g.cursor,
        hasPrelude: g.plan.hasPrelude,
        preludeCredit: g.preludeCredit,
        anchor: g.anchor && { ...g.anchor },
        anchoredSlice: g.anchoredSlice,
        stallMs: this._stallMsAt(g, this._clockMs),
        pending: g.pending.map((p) => ({ dueMs: p.dueMs, offMs: p.offMs, staffId: p.staff.id, note: p.note })),
        playbackRate: g.tempo.playbackRate,
        rateBounds: { ...g.tempo.bounds },
        tempo: g.tempo.snapshot(),
      })),
      staves: [...this._plan.staves.values()].map((s) => ({
        id: s.id, partId: s.partId, slot: s.slot, kind: s.kind, channel: s.channel, program: s.program, bank: s.bank && { ...s.bank },
        init: s.init && { ...s.init }, percussionKit: s.percussionKit, baseVolume: s.baseVolume, notes: [...s.notes],
        // 正在響的音攤平成一筆一顆（同音高重疊時依先進先出的順序）
        sounding: [...s.sounding].flatMap(([pitch, queue]) => queue.map((e) => ({
          pitch, endTick: e.endTick, offMs: e.offMs, holdIdx: e.holdIdx, tailSec: e.tailSec, capped: e.capped, onTime: e.onTime, note: e.note,
        }))),
      })),
    };
  }

  /** 這個 tick 屬於第幾段（第一個 driver 起音之前＝第 0 段；第一個群組的）。唯讀查詢。方法裡呼叫的 sliceOfTick(...) 是
   *  performancePlan.js 匯出的同名函式，不是這個方法自己（類別的方法名稱不會變成可以直接呼叫的變數名稱）。 */
  sliceOfTick(tick) { return sliceOfTick(this._groups[0].plan.driverTicks, tick); }

  /** 以目前的 driver 游標判斷這顆音要不要 hold（見 voiceLedger.js 的 holdOf()）。唯讀查詢，library-scan 的音符分類用。 */
  holdOf(note) { return this._ledger.holdOf(note, this._groups[0].cursor); }

  // 播完：所有音（你的與電腦的）都發過聲而且沒有還在響的音。有指派聲部但還沒按到，driver 的音沒發過，不算播完。
  isFinished() {
    if (!this._score) return false;
    if (this._sounded.size + this._skipped.size < this._plan.totalNotes) return false;   // 早按跳過的音也算處理過（沒有發聲）
    return this._ledger.isSilent();   // 沒有還在響的音
  }

  /**
   * 播放頭目前在第幾個 tick（跟 note 的 startTick／endTick 同一個座標系）：從這一段的錨點起，依速度往前走，最多走到你的
   * 下一個起音（停格等你）。看第一個群組（現在只有一個）。唯讀、無副作用。
   * @returns {number} tick（可為小數），夾在 [0, score.durationTicks]；沒有樂譜、沒有 staff、還沒開始播時 0
   */
  getPositionTicks() {
    const g = this._groups[0];
    const a = g.anchor;
    if (!this._score || this._plan.staves.size === 0 || !a) return 0;
    let sec = a.scoreSec + (Math.max(0, this._clockMs - a.clockMs) * a.rate) / 1000;
    const next = g.plan.driverSegs[g.cursor];
    if (next) sec = Math.min(sec, this._secOf(next.ticks));
    const ticks = this._score.secondsToMIDITicks(sec);
    const total = this._score.durationTicks;
    return total > 0 ? Math.min(ticks, total) : ticks;
  }

  // 排程器時鐘在 nowMs 這一刻的值：上一個 tick 的時鐘，加上之後經過的真實時間（跟 tick() 一樣有步長上限）。
  _clockAt(nowMs) {
    if (this._lastTickMs == null) return this._clockMs;
    return this._clockMs + Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));
  }

  // 群組 g 的播放頭停在你的下一個起音已經多久（毫秒）：這一段依錨點速度預計走完的時刻之後的時間；沒有下一個起音（最後一段、
  // 整首自動播放）就不會停格。
  _stallMsAt(g, clockMs) {
    const reach = this._reachClockMs(g);
    return reach === null ? 0 : Math.max(0, clockMs - reach);
  }

  // 群組 g 的播放頭依這一段的錨點速度走到你的下一個起音的時鐘時刻；沒有錨點或沒有下一個起音（最後一段、整首自動播放）回 null。
  _reachClockMs(g) {
    const a = g.anchor;
    const next = g.plan.driverSegs[g.cursor];
    if (!a || !next) return null;
    return a.clockMs + ((this._secOf(next.ticks) - a.scoreSec) * 1000) / a.rate;
  }

  // 第 0 段（前奏）在第一次需要時（第一個 tick 或第一次按鍵）用目前時鐘、1× 起算。
  _ensureAnchored(g) {
    if (g.anchoredSlice < 0) this._anchorSlice(g, 0, this._clockMs, 0, 1);
  }

  // 啟動群組 g 的第 slice 段：記下錨點，把這一段的 follower 音各自排好發聲時刻（錨點時刻 ＋ 樂譜秒差 ÷ 速度）與收音時刻（發聲時刻 ＋
  // 音符時值 ÷ 速度；結尾對齊或橫跨你某個起音的音在發聲時另外標 hold，見 _sound），成為排程佇列（依 dueMs 排序）。上一段沒放完的 follower 音在你按下時已經追音或跳過（見 _chaseOrSkip）。
  // fromTick：熱切換指派（reassign）從中間接續時，這一段裡 startTick 在它之前的音已經過了，不排進佇列（不然會一次補放）。
  _anchorSlice(g, slice, clockMs, scoreSec, rate, fromTick = -Infinity) {
    g.anchor = { slice, clockMs, scoreSec, rate };
    this.events.queue('anchor', { group: g.index, slice, clockMs, scoreSec, rate });
    g.anchoredSlice = slice;
    const { followers, sliceFirst } = g.plan;
    const from = sliceFirst[slice], to = sliceFirst[slice + 1];
    const fresh = [];
    for (let i = from; i < to; i++) {
      const { staff, note } = followers[i];
      if (note.startTick < fromTick) continue;
      const startSec = this._secOf(note.startTick);
      const dueMs = clockMs + ((startSec - scoreSec) * 1000) / rate;
      fresh.push({ dueMs, offMs: dueMs + scaledMs(this._secOf(note.endTick) - startSec, rate), staff, note });   // 起音與音長都依你的速度等比例縮放（整份譜用你的 BPM 演奏）
    }
    g.pending = fresh;   // 啟動新的一段時佇列一定是空的（上一段的電腦音在你按下時已經放完、追音或跳過）；fresh 依樂譜順序，dueMs 單調不減
  }

  /**
   * 觸發一次：放行這個槽位所屬群組的下一個 driver segment，裡面的音在這次呼叫內立刻 noteOn；同時啟動它負責的那一段 follower。
   * 兩種呼叫法走同一條路徑：trigger(輸入事件)（鍵盤，見 keyboard.js）或 trigger(槽位, 時刻)（日後的手勢、測試）。發聲與錨點用
   * 程式收到的時刻；事件發生的時刻（eventTimeMs）只記在按鍵事件與按鍵記錄裡。
   * @param {number|string|{ slot: number|string, source: string|null, eventTimeMs: number|null, receivedMs: number }} input
   *   演奏者槽位（要有指派聲部才有資格），或輸入事件：source＝來源（'keyboard'…）、eventTimeMs＝事件發生的時刻（鍵盤的
   *   event.timeStamp，跟 performance.now() 同一個時間原點）、receivedMs＝程式收到的時刻（performance.now()）
   * @param {number} [nowMs]  performance.now()（傳槽位時用；輸入事件用它自己的 receivedMs）
   * @returns {boolean} 有沒有放行（沒在播放、槽位沒有指派聲部、整首自動播放中、segment 都放行完了、被去抖忽略都回 false）
   */
  trigger(input, nowMs) {
    // 槽位的寫法補成輸入事件的形狀：沒有來源與事件發生的時刻（記 null）
    const ev = typeof input === 'object' && input !== null ? input : { slot: input, source: null, eventTimeMs: null, receivedMs: nowMs };
    try { return this._trigger(ev); }
    finally { this.events.flush(); }   // 對外事件在這次呼叫的合成器呼叫都送出之後才發
  }

  _trigger(ev) {
    const g = this._groups.find((x) => x.plan.slots.has(ev.slot));   // 這個槽位所屬的群組（現在只有一個）；找不到＝沒有資格觸發
    if (!this._playing || !g || g.cursor >= g.plan.driverSegs.length) return false;
    this._ensureAnchored(g);
    const clock = this._clockAt(ev.receivedMs);
    const j = g.cursor, seg = g.plan.driverSegs[j];
    const scoreSec = this._secOf(seg.ticks);

    // 前奏鎖：別的聲部在你的第一個起音之前有音（例如卡農：大提琴先進、你控制後進的小提琴），前奏還沒播到你的入場點時，
    // 按鍵不放行——放行會讓第 1 段用「現在」重新對時，前奏剩下的音就被跳過。這一下只記成「預按」（布林，按幾下都一樣），
    // 播放頭走到入場點的那一刻由 tick() 自動放行第一個起音。不動估速、去抖與錨點。
    if (j === 0 && g.plan.hasPrelude && clock < this._reachClockMs(g) - EPS_MS) {
      this._pressEvent(g, ev, clock, 'prelude');
      g.preludeCredit = true;
      return false;
    }

    // 去抖（見 tempoFollower.js 的 attempt()）：這一步依目前速度預估的真實長度（第一個起音沒有上一個，去抖也不會用到）
    const blocked = g.tempo.attempt(clock, j > 0 ? ((scoreSec - this._secOf(g.plan.driverSegs[j - 1].ticks)) * 1000) / g.tempo.playbackRate : 0);
    this._pressEvent(g, ev, clock, blocked ? 'blocked' : 'released');   // 放行必定接著 _release()
    if (blocked) return false;

    // 接受：把按下的時刻納入時鐘（tick 之間的那一小段）
    this._clockMs = clock;
    this._lastTickMs = ev.receivedMs;
    this._release(g, clock);
    return true;
  }

  // 放行群組 g 的下一個 driver segment（按鍵 trigger() 與前奏結束時的預按放行共用），時刻 clock（排程器時鐘）。
  _release(g, clock) {
    const j = g.cursor, seg = g.plan.driverSegs[j];
    const scoreSec = this._secOf(seg.ticks);
    if (g.stalled) { g.stalled = false; this.events.queue('stall', { group: g.index, state: 'end', clockMs: clock }); }
    g.tempo.accept(j, scoreSec, j > 0 ? this._secOf(g.plan.driverSegs[j - 1].ticks) : null, clock);   // 估速（停手與變速的判斷見 tempoFollower.js）
    const rate = g.tempo.playbackRate;                              // 這一下估完的速度
    g.cursor = j + 1;
    this.events.queue('release', { group: g.index, index: j, ticks: seg.ticks, clockMs: clock });

    this._ledger.closeByTick(seg.ticks, this._clockMs);             // driver 的音 endTick ≤ 這個起音的，先收
    this._ledger.releaseHeld(j, clock, rate);                       // 結尾對齊這個起音（或更早的起音）而 hold 著的音：你的音與電腦音都在你按下的這一刻收（錨點就是按下的時刻）
    this._ledger.closeDue(this._clockMs);
    this._emitPending(g);                                           // 已經到期的電腦音（tick 還沒來得及放的）照常放，要在追音之前：同譜表的新音才截得到它們
    // 早按：上一段還沒輪到的電腦音落在你這個起音的「垂直 tick」之前，不能再照原本的時刻放（會跟你不同步、甚至倒序）。
    // 改成跳到 T_k 的垂直狀態：還該響著的追音、整顆在身後的跳過（見 _chaseOrSkip）。錨點因此永遠是按下的時刻，同 tick 的電腦音 0ms 同刻。
    this._chaseOrSkip(g, seg.ticks, scoreSec, clock);
    this._anchorSlice(g, j + 1, clock, scoreSec, rate);             // 這一段的錨點與電腦音（佇列此時是空的）
    for (const { staff, note } of seg.items) this._sound(g, staff, note, clock + scaledMs(this._secOf(note.endTick) - scoreSec, rate), clock);
    this._emitPending(g);                                           // 同 tick 的 follower 音（dueMs ＝ 這一刻）跟你的音同刻
    this._ledger.closeDue(this._clockMs);                           // 零長度的音
  }

  // 早按時的垂直切片（Antescofo 的 @tight＋@local、DAW 的 Chase Events）：你按下 driver 起音 T_k 的這一刻，樂譜上「T_k 這個垂直
  // tick 響著什麼」＝ T_k 的 segment ＋ 從更早的 segment 延續過來、endTick > T_k 的音。群組 g 的佇列裡還沒輪到（dueMs 在按下之後）、
  // 起音在 T_k 之前的電腦音，因此分兩種：
  //  · endTick > T_k：追音——現在發聲，長度是檔案裡 T_k 到它結尾的剩餘長度 ÷ 速度（hold 規則照舊，見 _sound）。它在 T_k 本來就是和聲的一部分。
  //  · endTick ≤ T_k：整顆在你身後，跳過（記進 _skipped，isFinished 才算得對）。
  // 為什麼不照原時刻放完或加速追趕：前者樂譜前面的音會比同 tick 的音晚響（倒序）、後者讓同 tick 的電腦音晚到（你的音與電腦音不同步）。
  // 佇列依 dueMs 排序，同一個 tick 的音 dueMs 相同、排在一起，所以追音的順序就是樂譜順序。
  _chaseOrSkip(g, ticks, scoreSec, clock) {
    const left = g.pending;
    if (!left.length) return;
    g.pending = [];
    const chased = [], skipped = [];
    for (const p of left) {
      if (p.note.endTick > ticks) {
        chased.push(p.note);
        this._sound(g, p.staff, p.note, clock + scaledMs(this._secOf(p.note.endTick) - scoreSec, g.tempo.playbackRate), clock);
      } else {
        skipped.push(p.note);
        this._skipped.add(p.note);
      }
    }
    this.events.queue('chase', { group: g.index, ticks, chased, skipped });
  }

  // 讓一顆音發聲：記進 _sounded（每顆音恰好一次），交給發聲帳本 noteOn 並登記（hold、尾巴收尾、先進先出見 voiceLedger.js 的 sound()；
  // hold 看群組 g 的游標、音長看 g 的速度）。dueMs＝預定發聲的時鐘時刻（你的音就是按下的那一刻）；fromTick＝由 tick() 放出
  // （遲到統計只算這種，見 performanceEvents.js）。
  _sound(g, staff, note, offMs, dueMs, fromTick = false) {
    this._sounded.add(note);
    this._ledger.sound(staff, note, offMs, dueMs, { cursor: g.cursor, rate: g.tempo.playbackRate, fromTick, clockMs: this._clockMs });
  }

  // 群組 g 排好時刻已到的 follower 音依序發聲（佇列已依 dueMs 排序）。fromTick＝由 tick() 呼叫（遲到統計只算這種，見 _sound）。
  _emitPending(g, limitMs = this._clockMs, fromTick = false) {
    let n = 0;
    while (n < g.pending.length && g.pending[n].dueMs <= limitMs + EPS_MS) {
      const p = g.pending[n++];
      this._sound(g, p.staff, p.note, p.offMs, p.dueMs, fromTick);
    }
    if (n) g.pending.splice(0, n);
  }

  /**
   * 量測：tick() 放出的電腦音比排好的時刻晚了多少（排程器時鐘 − dueMs，毫秒）的統計。這是 tick 間隔（12ms 計時器被主執行緒
   * 的影像算繪／姿勢推論延後）造成的遲到；不含 AudioWorklet 的一個 render quantum（約 2.7ms）與瀏覽器輸出延遲。
   * 重設（stop／restart／換歌）時清空。
   */
  lateStats() { return this._lateStats.stats(); }

  /**
   * 量測：你早按時（按下那一刻上一段還有電腦音沒輪到）的處理結果：presses＝有這種情況的按鍵數、chased＝追音（T_k 還該響著、
   * 按下時補發）的顆數、skipped＝跳過（整顆在你身後）的顆數。重設（stop／restart／換歌）時清空。
   */
  chaseStats() { return this._chaseStats.stats(); }

  /** 量測：這首歌目前的速度區間 { lo, hi }（第一個群組的，rateBoundsFor 依你的聲部起音間隔算出的複本）。 */
  rateBounds() { return { ...this._groups[0].tempo.bounds }; }

  // 按鍵嘗試的事件（按鍵記錄 pressLog() 是它的訂閱者）。result：'released' 放行、'blocked' 被去抖擋掉、'prelude' 前奏中的預按。
  // ev 是輸入事件（見 trigger()）：來源與事件發生的時刻原樣記下（用槽位觸發時是 null）。
  _pressEvent(g, ev, clockMs, result) {
    this.events.queue('press', { group: g.index, slot: ev.slot, source: ev.source ?? null, result, clockMs, eventTimeMs: ev.eventTimeMs ?? null, receivedMs: ev.receivedMs ?? null });
  }

  /**
   * 量測：這一輪每次按鍵嘗試的記錄（複本）。clockMs 是排程器時鐘（暫停不走），跟 test/tools/sim.mjs 的時間座標一樣，
   * 可以直接拿去重放。重設（stop／restart／換歌）時清空。
   */
  pressLog() { return this._pressLog.log(); }

  /** 開啟錄音用的事件記錄（錨點、換錨、放行、每顆音實際發聲的時刻、早按處理；見 performanceEvents.js 的 eventLogSubscriber）。 */
  enableEventLog() {
    if (!this._eventLog) this._eventLog = eventLogSubscriber(this.events);
  }

  /** 這一輪的事件記錄（複本；沒開就是空陣列）。重設（stop／restart／換歌）時清空。 */
  eventLog() { return this._eventLog ? this._eventLog.log() : []; }

  /**
   * 由 midiPlayer.js 的排程 tick（~12ms）每次呼叫：推進時鐘、放出到時間的 follower 音、收掉到期的音。
   * driver 的起音永遠不在這裡放出，只來自 trigger()。
   * @param {number} nowMs  performance.now()
   * @param {number} [audioNow]  AudioContext 的目前時間（秒）。有給就啟用 lookahead：LOOKAHEAD_MS 以內要發聲／收音的電腦音
   *        提早帶時間戳送出；沒給（單元測試、AudioContext 還沒就緒）就照到期時刻才發聲、不帶時間戳。
   */
  tick(nowMs, audioNow) {
    if (!this._playing || !this._score) return; // 沒有樂譜（load(null)）時空轉
    for (const g of this._groups) this._ensureAnchored(g);
    const dt = this._lastTickMs == null ? 0 : Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));
    this._lastTickMs = nowMs;
    this._clockMs += dt;
    const timed = Number.isFinite(audioNow);
    this._router.setAudioBase(timed ? { audio: audioNow, clock: this._clockMs } : null);  // 只在這個 tick 內有效：按鍵、暫停的呼叫一律立刻處理
    try {
      this._askForecasters();   // 先換錨再收音發聲：這個 tick 放出的電腦音就照新的速度
      this._tickBody(timed ? this._clockMs + LOOKAHEAD_MS : this._clockMs);
      this._queueStateEvents();
    } finally {
      this._router.setAudioBase(null);
      this.events.flush();   // 對外事件在這個 tick 的合成器呼叫都送出之後才發
    }
  }

  // 狀態改變的事件，只在改變的那一刻發一次：各群組的播放頭停在你的下一個起音（停格開始；你按下去時 _release() 發「結束」）、
  // 所有音都發過聲而且收完（播完，整首一次）。
  _queueStateEvents() {
    for (const g of this._groups) {
      const reach = this._reachClockMs(g);
      if (!g.stalled && reach !== null && this._clockMs >= reach - EPS_MS) {
        g.stalled = true;
        this.events.queue('stall', { group: g.index, state: 'start', clockMs: reach });
      }
    }
    if (!this._finishSent && this.isFinished()) {
      this._finishSent = true;
      this.events.queue('finish', { clockMs: this._clockMs });
    }
  }

  // 問每個有掛預報器的群組（沒有預報器的群組什麼都不做）
  _askForecasters() {
    for (const g of this._groups) {
      const f = this._forecasters[g.index];
      if (f) this._applyForecast(g, f.forecast(this._forecastView(g)));
    }
  }

  // 給預報器看的唯讀資料：游標（下一個要放行的起音）、時鐘、目前的錨點（可能已經換過錨）、這一段起點與下一個起音的樂譜秒
  // （前奏時起點是 null、最後一段時下一個起音是 null）、速度追蹤目前的速度與區間。
  _forecastView(g) {
    const segs = g.plan.driverSegs;
    return {
      group: g.index, cursor: g.cursor, clockMs: this._clockMs, anchor: g.anchor && { ...g.anchor },
      segmentStartSec: g.cursor > 0 ? this._secOf(segs[g.cursor - 1].ticks) : null,
      nextOnsetSec: g.cursor < segs.length ? this._secOf(segs[g.cursor].ticks) : null,
      rate: g.tempo.playbackRate, rateBounds: { ...g.tempo.bounds },
    };
  }

  // 段中換錨：預報說你會在 f.atMs 按下一個起音。只在這一段是按鍵啟動的（游標 ≥ 1；前奏照 1× 播到入場點）、還有下一個起音、
  // 播放頭還沒走到它（還沒停格）、預報在現在之後、而且跟目前預計的到達時刻差到門檻（forecastMinChangeMs）以上時才換。
  // 新錨點＝（現在, 此刻的樂譜位置 p, r′）：r′＝（下一個起音的樂譜秒 − p）÷（atMs − 現在），夾在這個群組的速度區間（N6）。
  // 佇列裡（還沒送出）、樂譜位置在 p 之後的電腦音照 r′ 重排發聲與收音時刻（音長上限照 scaledMs）：不會排到現在之前、
  // 保持樂譜順序、間隔等比例。碰不到的有：跟你同 tick 的音（按下時已經發聲）、lookahead 已經送出的音（已經離開佇列，取消不了）、
  // 已經在響的音（收音時刻與 hold 照發聲當時的換算），以及已經過期、只是還沒放出的音（p 之前，照原時刻放）。
  _applyForecast(g, f) {
    if (!f) return;
    const now = this._clockMs, next = g.plan.driverSegs[g.cursor], a = g.anchor;
    const reach = this._reachClockMs(g);
    const applied = g.cursor >= 1 && !!next && !!a && reach !== null && now < reach && f.atMs > now
      && Math.abs(f.atMs - reach) >= this.cfg.forecastMinChangeMs;
    this.events.queue('forecast', { group: g.index, index: g.cursor, clockMs: now, atMs: f.atMs, uncertaintyMs: f.uncertaintyMs ?? null, source: f.source ?? null, applied });
    if (!applied) return;
    const p = a.scoreSec + ((now - a.clockMs) * a.rate) / 1000;   // 此刻的樂譜位置（還沒走到下一個起音：now < reach）
    const { lo, hi } = g.tempo.bounds;
    const rate = Math.min(hi, Math.max(lo, ((this._secOf(next.ticks) - p) * 1000) / (f.atMs - now)));
    g.anchor = { slice: a.slice, clockMs: now, scoreSec: p, rate };
    let retimed = 0;
    for (const q of g.pending) {
      const startSec = this._secOf(q.note.startTick);
      if (startSec <= p) continue;                                    // 已經過期、只是還沒放出：照原時刻（馬上）放
      q.dueMs = now + ((startSec - p) * 1000) / rate;
      q.offMs = q.dueMs + scaledMs(this._secOf(q.note.endTick) - startSec, rate);
      retimed++;
    }
    this.events.queue('reanchor', { group: g.index, slice: a.slice, clockMs: now, scoreSec: p, rate, retimed });
  }

  _tickBody(horizonMs) {
    this._ledger.closeDue(this._clockMs, horizonMs);     // 先收再放：到期的舊音在同一個 tick 要發聲的新音之前關掉（同音高的相連音才不會被連帶關掉）
    for (const g of this._groups) this._emitPending(g, horizonMs, true);
    this._ledger.closeDue(this._clockMs, horizonMs);     // 剛發聲就到期的短音
    // 前奏鎖期間有人預按過：播放頭到了入場點就放行第一個起音。放行時刻取「剛好到達」的那一刻（不是這個 tick 的時鐘），
    // 第 1 段的錨點因此接在前奏的 1× 時間軸上；落在這一刻到現在之間的電腦音由 _release() 裡的 _emitPending() 補放。
    for (const g of this._groups) {
      if (!g.preludeCredit || g.cursor !== 0) continue;
      const reach = this._reachClockMs(g);
      if (reach !== null && this._clockMs >= reach - EPS_MS) { g.preludeCredit = false; this._release(g, reach); }
    }
  }
}
