// ============================================================
//  statForecaster.js — 統計預報器（子專案 D）：「你到現在還沒按」的條件中位數。純邏輯，無 DOM。
//
//  模型：這一段的實際長度 D 服從對數常態 ln D ~ N(ln μ, σ²)，μ＝樂譜長度 ÷ 按下當時估到的速度（排程器原本的預測），σ 用最近
//  window 段「實際 ÷ 預測」的對數的均方根線上估計（夾在 [sigmaMin, sigmaMax]）。按下之後經過了 τ 你還沒按，D 的條件分布就是
//  「D > τ」，預報＝按下的時刻＋中位數(D | D > τ)：τ 遠小於 μ 時就是 μ（行為跟沒有預報一樣），越過 μ 之後逐漸往後延，
//  剩下的電腦音因此放慢，不會先跑完再停格等你。
//
//  app 預設不掛（鍵盤的行為不變）；評估工具（test/tools/replay-eval.mjs）與測試用 scheduler.setForecaster() 掛上。
//  spike 的得失（spec 第 2 節）：真實卡農記錄 |誤差| p90 131 → 110ms，但跳過 0% → 2%；節奏穩的演奏者整體稍差。
// ============================================================

/* ═══════════════════════════════════════════
   標準常態分布
   ═══════════════════════════════════════════ */

// 互補誤差函數 erfc（Numerical Recipes 的 erfcc：全範圍相對誤差 < 1.2e-7，所以深尾的機率也準）
function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** 標準常態的右尾機率 Q(z)＝P(Z > z)。用 erfc 直接算（不用 1 − Φ：z 大時 1 − Φ 會變成 0）。 */
export const normalTail = (z) => 0.5 * erfc(z / Math.SQRT2);

/** 標準常態的 CDF Φ(z)＝P(Z ≤ z)。 */
export const normalCdf = (z) => 0.5 * erfc(-z / Math.SQRT2);

// Acklam 的反函數（有理函數近似，全範圍相對誤差 < 1.15e-9）：中段一組、兩端的尾巴一組
const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
const P_LOW = 0.02425;

/** 標準常態的反函數 Φ⁻¹(p)。p ≤ 0 回 −∞、p ≥ 1 回 +∞。 */
export function normalQuantile(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const tail = (q) => (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  if (p < P_LOW) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - P_LOW) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
}

/* ═══════════════════════════════════════════
   條件中位數與預報器
   ═══════════════════════════════════════════ */

/**
 * ln D ~ N(ln μ, σ²)，已知 D > τ 時 D 的中位數（毫秒）。推導：要找 d 使 P(D > d) ＝ P(D > τ) ÷ 2，換成標準常態就是
 * Q(w) ＝ Q(z) ÷ 2，z ＝ ln(τ／μ)／σ，d ＝ μ·e^(σw)。τ ＝ 0 時 w ＝ 0（d ＝ μ）；τ ＝ μ 時 w ＝ Φ⁻¹(0.75) ≈ 0.674。
 * z > 30 時 Q(z) 小到浮點數表示不了，改用漸近式 w ≈ z ＋ ln2／z（由 Q(w) ≈ φ(w)／w 推得，誤差遠小於毫秒）。
 */
export function conditionalMedianMs(muMs, sigma, tauMs) {
  if (!(tauMs > 0)) return muMs;
  const z = Math.log(tauMs / muMs) / sigma;
  const w = z > 30 ? z + Math.LN2 / z : -normalQuantile(normalTail(z) / 2);   // Q(w)＝Q(z)／2 ⇔ w＝−Φ⁻¹(Q(z)／2)（常態對稱）
  return muMs * Math.exp(sigma * w);
}

/**
 * 建一個統計預報器（掛在排程器的一個 driver 群組上：scheduler.setForecaster(群組, 預報器)）。排程器每個 tick 呼叫
 * forecast(view)：view 見 scheduler.js 的 _forecastView()。回傳 { atMs, uncertaintyMs, source } 或 null（不預報）。
 * 段的追蹤只看 view：段號（anchor.slice）變了就是新的一段，起點與預測長度取這一段第一次看到的錨點（按下的時刻與當時的速度），
 * 之後同一段的換錨不影響它們。上一段是按鍵啟動、而且段號剛好加 1 時，才把它的「實際 ÷ 預測」記進 σ 的估計（改指派、重播造成的
 * 跳號不算；前奏不算：前奏鎖讓你的第一下最早只能在入場點放行，那不是節奏的誤差）。
 */
export function createStatForecaster({ window = 8, sigmaMin = 0.03, sigmaMax = 0.6 } = {}) {
  let seg = null;           // 目前這一段：{ slice, startClockMs, muMs（前奏、最後一段是 null：沒有要預報的起音） }
  const logErrors = [];     // 最近 window 段的 ln(實際長度 ÷ 預測長度)
  const sigma = () => {
    if (!logErrors.length) return null;
    const rms = Math.sqrt(logErrors.reduce((s, e) => s + e * e, 0) / logErrors.length);   // 模型的平均是 0（預測不偏），所以用均方根
    return Math.min(sigmaMax, Math.max(sigmaMin, rms));
  };
  return {
    sigma,
    forecast(view) {
      const a = view.anchor;
      if (!a) return null;
      if (!seg || a.slice !== seg.slice) {
        if (seg && seg.muMs !== null && a.slice === seg.slice + 1) {
          logErrors.push(Math.log((a.clockMs - seg.startClockMs) / seg.muMs));
          if (logErrors.length > window) logErrors.shift();
        }
        const pressed = view.cursor >= 1 && view.nextOnsetSec !== null;   // 這一段是按鍵啟動的、而且還有下一個起音
        seg = { slice: a.slice, startClockMs: a.clockMs, muMs: pressed ? ((view.nextOnsetSec - view.segmentStartSec) * 1000) / a.rate : null };
      }
      if (seg.muMs === null) return null;
      const s = sigma();
      if (s === null) return null;                                         // 還沒有任何一段的誤差：先不預報
      return { atMs: seg.startClockMs + conditionalMedianMs(seg.muMs, s, view.clockMs - seg.startClockMs), uncertaintyMs: null, source: 'stat' };
    },
  };
}
