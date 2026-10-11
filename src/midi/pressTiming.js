// ============================================================
//  pressTiming.js — 按鍵節奏：估速（playbackRate）與去抖（純邏輯，無 DOM／CDN）
//
//  scheduler.js 在每次有效觸發時用這裡的兩個函式：
//    · estimatePlaybackRate：用最近幾個「有效按鍵」的位置推出你現在的速度（樂譜秒 ÷ 真實秒）。MIDI 檔本身的 BPM 已經
//      包含在樂譜秒裡（midiTicksToSeconds 走過速度表），所以「檔案 BPM × 這個比值」就是你現在的有效 BPM。
//    · debounceWindowMs：兩次有效按鍵太近就忽略第二次（擋手抖、手勢重複觸發）。
//  數字的來源是 test/tools/rate-eval.mjs 的模擬評估（用曲庫實際的樂譜、七種演奏者模型），不是憑感覺。
// ============================================================

// 估速視窗：最近 8 個間隔（9 個按鍵）。評估結果：只看最近 1 個間隔，手抖會被直接放大（誤差約是視窗法的 2 倍）；
// 固定檔案速度在你的速度偏離檔案時誤差高達 100～200ms；視窗 4～8 個按鍵在所有情境都穩，8 個最好。
export const RATE_WINDOW_INTERVALS = 8;
// 速度的合理範圍：同一毫秒連按（估出趨近無限大）或隔很久才按（趨近 0）都夾在這個範圍。
export const MIN_PLAYBACK_RATE = 0.1;
export const MAX_PLAYBACK_RATE = 4;

// 去抖窗口＝預估這一步真實長度的 60%（取自同事 SmartEnsemble 的做法），夾在 [50, 500]ms。下限比它的 150ms 低：
// 125ms 的十六分音符要彈得出來；再加上取「你上一次的按鍵間隔」較小者，讓你加速時窗口跟著縮小。
// 「上一次的按鍵間隔」要算所有按鍵嘗試（包含被忽略的）：只算被接受的，一開始就比檔案快的人，每隔一下的按鍵會一直被擋、
// 速度永遠學不起來。
export const DEBOUNCE_FRACTION = 0.6;
export const DEBOUNCE_MIN_MS = 50;
export const DEBOUNCE_MAX_MS = 500;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * 依最近的有效按鍵估 playbackRate。
 * 用「視窗頭尾」的比值（Δ樂譜秒 ÷ Δ真實秒），不是逐個間隔的比值再平均：每個按鍵時刻的誤差（手抖）只會在頭尾各出現
 * 一次，不會隨間隔個數累積；逐間隔平均則會把每個短間隔的誤差都放大進來。
 * @param {{ scoreSec: number, ms: number }[]} history  有效按鍵，由舊到新；scoreSec＝該按鍵放行的 segment 的樂譜秒，
 *        ms＝按下時刻（排程器時鐘，不含暫停）
 * @param {number} fallback  不足 2 個按鍵（沒有間隔可估）時回傳的值，通常是目前的 playbackRate
 */
export function estimatePlaybackRate(history, fallback = 1) {
  if (history.length < 2) return fallback;
  const last = history[history.length - 1];
  const first = history[Math.max(0, history.length - 1 - RATE_WINDOW_INTERVALS)];
  const realSec = Math.max(1e-3, (last.ms - first.ms) / 1000); // 同一毫秒連按時避免除以 0
  return clamp((last.scoreSec - first.scoreSec) / realSec, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
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
 * 一串延遲量（毫秒）的統計，給 window.__stats() 量測用（電腦音比排好的時刻晚多少、按鍵事件在主執行緒佇列等了多久）。
 * p50／p99 用「最近排名法」：第 ceil(q × n) 小的那個值，不內插，所以結果一定是真的出現過的樣本。數字進位到 0.1ms。
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

/**
 * 按鍵負擔：照原速（樂譜速度）彈需要的按鍵頻率。給 library-scan／測試用，不是排程器的限制。
 * 做法：要按的起音（每個不同的樂譜秒算一次）排序後，平均＝按鍵數 ÷（最後一個 − 第一個的秒數）；最忙 1 秒＝滑動視窗
 * （雙指標，時間 O(n)）：對每個起音 i，往回找最早的 j 使 secs[i] − secs[j] ≤ 1，視窗大小 i−j+1 的最大值。
 * @param {number[]} secs  要按的起音的樂譜秒數（可以重複、不必排序）
 * @returns {{ presses: number, perSecAvg: number, perSecPeak: number }}
 */
export function pressLoad(secs) {
  const t = [...new Set(secs)].sort((a, b) => a - b);
  let peak = 0;
  for (let i = 0, j = 0; i < t.length; i++) {
    while (t[i] - t[j] > 1) j++;
    peak = Math.max(peak, i - j + 1);
  }
  const span = t.length > 1 ? t[t.length - 1] - t[0] : 0;
  return { presses: t.length, perSecAvg: span > 0 ? t.length / span : 0, perSecPeak: peak };
}
