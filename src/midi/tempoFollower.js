// ============================================================
//  tempoFollower.js — 速度追蹤：你的有效按鍵歷史 → 速度估計 playbackRate（命名同官方 Sequencer：樂譜秒 ÷ 真實秒）、停手與變速
//  的判斷（N6），以及去抖（距離上一次有效按鍵太近的第二下忽略，N7）。估速與去抖窗口的純數學在 pressTiming.js；這裡保管狀態、
//  套用規則。每個 driver 群組一份（現在只有一個群組）。純邏輯，無 DOM。
// ============================================================

import { estimatePlaybackRate, debounceWindowMs, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE } from './pressTiming.js';

// 停手與變速的判斷（accept()）：這一下隱含的速度 x ＝ Δ樂譜秒 ÷ Δ真實秒。
//  · x 低於這首歌的速度區間下緣（兩次按鍵隔超過 30 秒對應的長度，見 pressTiming.js 的 rateBoundsFor）＝停手：歷史清掉、速度維持。
//  · 已經學到速度（歷史裡至少 LEARNED_INTERVALS 個間隔）時，x 跟目前估計差超過 SURPRISE_RATIO 倍＝「驚訝」，先不拿來估速；
//    下一下的隱含速度若跟它差在 CONFIRM_RATIO 倍以內就兩下一起接受（你真的變速了，歷史從驚訝那一下重新開始），否則當成停手／失誤。
//  · 還沒學到速度時一律接受：區間內的任何速度都學得到。不用「預測間隔的幾倍」當門檻：預測間隔是用目前速度算的，連按之後只有 0.1 秒，
//    慢下來的人每一下都超過門檻、被當成停手，速度就永遠鎖在連按時的快速。
const LEARNED_INTERVALS = 3;
const SURPRISE_RATIO = 3;
const CONFIRM_RATIO = 1.6;

export class TempoFollower {
  constructor() {
    this.playbackRate = 1;     // 你現在的速度（樂譜秒 ÷ 真實秒）；依最近 8 個按鍵估（pressTiming.js）
    this._rateBounds = { lo: MIN_PLAYBACK_RATE, hi: MAX_PLAYBACK_RATE }; // 這首歌的速度區間（rateBoundsFor，計畫依你的聲部起音間隔算）
    this._history = [];        // 有效按鍵 [{ scoreSec, ms }]，估速用
    this._lastAcceptClock = null;     // 上一次有效按鍵的時鐘（去抖用）
    this._lastAttemptClock = null;    // 上一次按鍵嘗試（含被忽略的）的時鐘
    this._lastAttemptIntervalMs = Infinity; // 前兩次按鍵嘗試之間的間隔（去抖窗口用）
    this._surprise = null;     // 驚訝的那一下 { x: 隱含速度, press: { scoreSec, ms } }，等下一下確認是變速還是停手
  }

  get bounds() { return this._rateBounds; }

  // 唯讀快照（複本，給排程器的 inspect()）
  snapshot() {
    return {
      history: this._history.map((h) => ({ ...h })),
      lastAcceptClock: this._lastAcceptClock,
      lastAttemptClock: this._lastAttemptClock,
      lastAttemptIntervalMs: this._lastAttemptIntervalMs,
      surprise: this._surprise && { x: this._surprise.x, press: { ...this._surprise.press } },
    };
  }

  // 這首歌的速度區間（載入、改指派時依你的聲部重算）
  setBounds(bounds) { this._rateBounds = bounds; }

  // 去抖：窗口依「這一步預估的真實長度」與「你上一次的按鍵間隔」；不論這次被接受與否，都算一次按鍵嘗試（只算被接受的，
  // 一開始就比檔案快的人每隔一下的按鍵會一直被擋，速度學不起來）。第一次有效按鍵沒有前一個可比，不去抖。
  // expectedMs：這一步（上一個起音到這個起音）依目前速度預估的真實長度（沒有上一個起音時不會用到）。回傳這一下要不要擋掉。
  attempt(clock, expectedMs) {
    let blocked = false;
    if (this._lastAcceptClock != null) {
      blocked = clock - this._lastAcceptClock < debounceWindowMs(expectedMs, this._lastAttemptIntervalMs);
    }
    if (this._lastAttemptClock != null) this._lastAttemptIntervalMs = clock - this._lastAttemptClock;
    this._lastAttemptClock = clock;
    return blocked;
  }

  // 接受這一下（放行第 j 個 driver segment）：更新歷史與速度估計，記下這次有效按鍵的時鐘。prevScoreSec＝上一個 driver 起音的樂譜秒
  // （第一下沒有）。
  accept(j, scoreSec, prevScoreSec, clock) {
    this._updateRate(j, scoreSec, prevScoreSec, clock);
    this._lastAcceptClock = clock;
  }

  _updateRate(j, scoreSec, prevScoreSec, clock) {
    const B = this._rateBounds, press = { scoreSec, ms: clock };
    if (j === 0 || this._lastAcceptClock == null) { this._history = [press]; return; }   // 第一下（或改指派後的第一下）：沒有間隔可估
    const dS = scoreSec - prevScoreSec, dT = Math.max(1e-3, (clock - this._lastAcceptClock) / 1000);
    const x = dS / dT;                                           // 這一下隱含的速度
    if (x < B.lo) { this._history = [press]; this._surprise = null; return; }   // 空檔超過區間：停手，這次間隔不拿來估速（速度維持原本的值）
    const learned = this._history.length - 1 >= LEARNED_INTERVALS;
    if (learned && Math.abs(Math.log(x / this.playbackRate)) > Math.log(SURPRISE_RATIO)) {
      const s = this._surprise;
      if (s && Math.abs(Math.log(x / s.x)) < Math.log(CONFIRM_RATIO)) {
        this._history = [s.press, press];                        // 連兩下一致：真的變速，歷史從驚訝那一下重新開始
        this._surprise = null;
      } else {
        this._surprise = { x, press };                           // 先不信這一下，等下一下確認
        return;
      }
    } else {
      if (this._surprise) { this._history = [this._surprise.press]; this._surprise = null; }   // 上一下是停手／失誤：歷史從那一下重新開始
      this._history.push(press);
    }
    this.playbackRate = estimatePlaybackRate(this._history, this.playbackRate, B);
  }

  // 播放中改指派：去抖與估速歷史清掉（舊的間隔對不上新的 driver 序列），速度估計保留。
  forgetHistory() {
    this._history = [];
    this._lastAcceptClock = null;
    this._lastAttemptClock = null;
    this._lastAttemptIntervalMs = Infinity;
    this._surprise = null;
  }

  // 重設（停止、重播）：連速度一起回到剛載入的樣子（1×）；速度區間是這首歌的，不動。
  reset() {
    this.forgetHistory();
    this.playbackRate = 1;
  }
}
