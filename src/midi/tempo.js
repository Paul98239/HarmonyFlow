// tempo.js — 按鍵節奏：估速（playbackRate＝樂譜秒 ÷ 真實秒，命名同官方 Sequencer）、每首歌的速度區間、去抖，與保管這些狀態的 TempoFollower（N6、N7；每個 driver 群組一份）。
// 檔案 BPM 已包含在樂譜秒裡，所以「檔案 BPM × playbackRate」就是你現在的有效 BPM。常數的依據是對曲庫實際樂譜、七種演奏者模型的模擬評估（見規格文件 N6）。

// 估速視窗：最近 8 個間隔（9 個按鍵）。只看 1 個間隔手抖會被直接放大；視窗 4～8 個按鍵在所有情境都穩，8 個最好。
export const RATE_WINDOW_INTERVALS = 8;
// 速度的絕對保險範圍：只擋同一毫秒連按（趨近無限大）或隔幾分鐘才按（趨近 0）的極端；真正用的是每首歌自己的區間（rateBoundsFor）
export const MIN_PLAYBACK_RATE = 1 / 256;
export const MAX_PLAYBACK_RATE = 64;

// 每首歌的速度區間：兩次按鍵的真實間隔容許在 [PRESS_PERIOD_MIN_S, PRESS_PERIOD_MAX_S]。下界 0.06 秒 ≈ 16.7 下/秒（持續連按的上限）；
// 上界 30 秒：更久的空檔一律當成停手，不是你很慢（使用者決定）。這首歌的典型起音間隔 g（樂譜秒）對應 [g / 30, g / 0.06]，任何新 MIDI 都自動有合適的區間。
// 比 PRESS_PERIOD_MIN_S 還短的起音間隔不算典型間隔：按不及，放行時併成一下按（近距起音分組，scheduler.js）；算進去會把中位數壓小、上限低於原速。
export const PRESS_PERIOD_MIN_S = 0.06;
export const PRESS_PERIOD_MAX_S = 30;

// 近距起音分組的門檻：一個輸入來源連按兩下最短隔多久（秒），更近的起音放行時併成一組（scheduler.js）。鍵盤＝PRESS_PERIOD_MIN_S；手勢接回時量測後再加，其他來源先用鍵盤的值。
const MIN_PRESS_INTERVAL_S = { keyboard: PRESS_PERIOD_MIN_S };
export const minPressIntervalSec = (source) => MIN_PRESS_INTERVAL_S[source] ?? PRESS_PERIOD_MIN_S;

// 去抖窗口＝預估這一步真實長度的 60%（取自同事 SmartEnsemble），夾在 [50, 500]ms：下限比它的 150ms 低，125ms 的十六分音符才彈得出來；
// 再取「你上一次的按鍵間隔」較小者，加速時窗口跟著縮小。這個間隔要算所有按鍵嘗試（含被忽略的）：
// 只算被接受的話，一開始就比檔案快的人每隔一下的按鍵會一直被擋，速度學不起來。
export const DEBOUNCE_FRACTION = 0.6;
export const DEBOUNCE_MIN_MS = 50;
export const DEBOUNCE_MAX_MS = 500;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * 這首歌（你的聲部）的速度區間 { lo, hi }。
 * @param {number[]} gapSecs  你的聲部相鄰起音的樂譜間隔（秒），可以含 0、和弦錯位或快音的小間隔（< PRESS_PERIOD_MIN_S，會被略過）
 */
export function rateBoundsFor(gapSecs) {
  const gaps = gapSecs.filter((g) => g >= PRESS_PERIOD_MIN_S).sort((a, b) => a - b);
  if (!gaps.length) return { lo: MIN_PLAYBACK_RATE, hi: MAX_PLAYBACK_RATE };
  const g = gaps[Math.floor((gaps.length - 1) / 2)];   // 中位數：休止、長音的極端間隔不影響
  const lo = clamp(g / PRESS_PERIOD_MAX_S, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
  const hi = clamp(g / PRESS_PERIOD_MIN_S, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
  return hi > lo ? { lo, hi } : { lo: MIN_PLAYBACK_RATE, hi: MAX_PLAYBACK_RATE };
}

/**
 * 依最近的有效按鍵估 playbackRate。
 * 用「視窗頭尾」的比值（Δ樂譜秒 ÷ Δ真實秒），不是逐個間隔的比值再平均：每個按鍵時刻的誤差（手抖）只會在頭尾各出現
 * 一次，不會隨間隔個數累積；逐間隔平均則會把每個短間隔的誤差都放大進來。
 * @param {{ scoreSec: number, ms: number }[]} history  有效按鍵，由舊到新；scoreSec＝該按鍵放行的 segment 的樂譜秒，
 *        ms＝按下時刻（排程器時鐘，不含暫停）
 * @param {number} fallback  不足 2 個按鍵（沒有間隔可估）時回傳的值，通常是目前的 playbackRate
 * @param {{ lo: number, hi: number }} [bounds]  這首歌的速度區間（rateBoundsFor），預設是絕對保險範圍
 */
export function estimatePlaybackRate(history, fallback = 1, bounds = { lo: MIN_PLAYBACK_RATE, hi: MAX_PLAYBACK_RATE }) {
  if (history.length < 2) return fallback;
  const last = history[history.length - 1];
  const first = history[Math.max(0, history.length - 1 - RATE_WINDOW_INTERVALS)];
  const realSec = Math.max(1e-3, (last.ms - first.ms) / 1000); // 同一毫秒連按時避免除以 0
  return clamp((last.scoreSec - first.scoreSec) / realSec, bounds.lo, bounds.hi);
}

/**
 * 去抖窗口（毫秒）：距離上一次有效按鍵不到這麼久的按鍵會被忽略。
 * @param {number} expectedStepMs  預估這一步（上一個 segment 到這個 segment）依目前速度的真實長度
 * @param {number} [lastAttemptIntervalMs]  你上一次的按鍵間隔（前兩次按鍵嘗試之間，含被忽略的）；還沒有就不傳／傳 Infinity
 */
export function debounceWindowMs(expectedStepMs, lastAttemptIntervalMs = Infinity) {
  const base = Math.min(expectedStepMs, lastAttemptIntervalMs);
  return clamp(DEBOUNCE_FRACTION * base, DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS);
}

/**
 * 一串延遲量（ms）的統計，給 window.__stats() 用。p50／p99 用最近排名法（第 ceil(q × n) 小的值，不內插，結果一定是真的出現過的樣本），進位到 0.1ms。
 * @param {number[]} samples
 * @returns {{ count: number, avg: number, p50: number, p99: number, max: number, over30: number }}
 */
export function summarizeMs(samples) {
  const n = samples.length;
  if (!n) return { count: 0, avg: 0, p50: 0, p99: 0, max: 0, over30: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.ceil(q * n) - 1];
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    count: n, avg: r1(samples.reduce((a, b) => a + b, 0) / n), p50: r1(at(0.5)), p99: r1(at(0.99)), max: r1(sorted[n - 1]),
    over30: samples.filter((x) => x > 30).length, // 30ms：跟另一個聲部／節奏對不齊開始聽得出來的量級（不是規格，只是量測的刻度）
  };
}

// 停手與變速的判斷（accept()）：這一下隱含的速度 x ＝ Δ樂譜秒 ÷ Δ真實秒。
//  · x 低於速度區間下緣（兩次按鍵隔超過 30 秒）＝停手：歷史清掉、速度維持。
//  · 已學到速度（歷史至少 LEARNED_INTERVALS 個間隔）時，x 跟目前估計差超過 SURPRISE_RATIO 倍＝驚訝，先不拿來估速；下一下的隱含速度若跟它差在
//    CONFIRM_RATIO 倍以內就兩下一起接受（真的變速，歷史從驚訝那一下重新開始），否則當成停手／失誤。
//  · 還沒學到速度時一律接受。不用「預測間隔的幾倍」當門檻：預測間隔用目前速度算，連按後只有 0.1 秒，慢下來的人每一下都超過門檻被當成停手，速度就永遠鎖在連按時的快速。
const LEARNED_INTERVALS = 3;
const SURPRISE_RATIO = 3;
const CONFIRM_RATIO = 1.6;

export class TempoFollower {
  constructor() {
    this.playbackRate = 1;     // 你現在的速度（樂譜秒 ÷ 真實秒）
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

  // 去抖：窗口依這一步預估的真實長度（expectedMs，沒有上一個起音時不會用到）與你上一次的按鍵間隔；被忽略的也算一次按鍵嘗試（理由見 DEBOUNCE 常數）。
  // 第一次有效按鍵沒有前一個可比，不去抖。回傳這一下要不要擋掉。
  attempt(clock, expectedMs) {
    let blocked = false;
    if (this._lastAcceptClock != null) {
      blocked = clock - this._lastAcceptClock < debounceWindowMs(expectedMs, this._lastAttemptIntervalMs);
    }
    if (this._lastAttemptClock != null) this._lastAttemptIntervalMs = clock - this._lastAttemptClock;
    this._lastAttemptClock = clock;
    return blocked;
  }

  // 接受這一下（放行第 j 個 driver segment）：更新歷史與速度估計、記下時鐘。prevScoreSec＝上一個 driver 起音的樂譜秒（第一下沒有）
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
