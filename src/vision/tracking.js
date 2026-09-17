// ============================================================
//  tracking.js — 多人槽位追蹤核心（純邏輯，無 DOM／CDN 依賴）
//
//  誰該匹配到哪個已鎖定槽位、新面孔何時才能鎖定空位。ID 只是槽位編號的顯示提示，不做
//  身分認回：槽位釋放後下一個偵測到的人直接取用空槽位。vision.js 負責從 video
//  擷取 MediaPipe landmarks、WebGL／2D 繪製；這個檔案只處理「這一幀這個人該貼哪個槽位」，
//  純粹依位置（螢幕座標接近程度，門檻依肩寬縮放）判斷，不使用服裝顏色。
// ============================================================

import { clamp01 } from './gesture.js';

export const DEFAULT_TRACKING_CONFIG = Object.freeze({
  maxUsers: 4,

  // ── 原則：只貼標籤，不動畫面 ──────────────────────────────────────────────
  // 畫面上永遠是 MediaPipe 這一幀真的給的人；追蹤層只決定每個人貼哪個 ID。判斷不了時
  // 寧可這一幀不貼標籤，也不刪、不合併、不替換任何一筆偵測。

  // ── 逐幀配對（已鎖定槽位 vs 這一幀偵測）────────────────────────────────────
  // 位置門檻 ＝ max(gatePos, gatePosRatio × 這個人的肩寬)。以肩寬為單位是因為同一個動作，
  // 站得近的人在正規化座標上走得比較遠；絕對值下限是給遠處的小人。
  gatePos: 0.15,
  gatePosRatio: 0.45,
  // 漏配緩衝期內（missCount > 0 且漏配 ≤ missGraceMs）門檻放寬到
  // max(上面的門檻, graceGate, graceGateRatio × 肩寬)：MediaPipe 在「手在頭部交叉」這類姿勢
  // 期間會把整個人的位置估歪一大段，這段放寬讓附近的偵測仍能配對回他本人。
  // 這段放寬只在單人、或鄰居很遠時真的生效（見 ambiguityRatio）。
  graceGate: 0.45,
  graceGateRatio: 1.5,
  // 歧義收斂：不管上面算出多寬，門檻一律再夾到「到最近的另一個槽位的距離 × ambiguityRatio」
  // 以內（下限 ambiguityFloorRatio × 肩寬，保留真人一幀內的正常位移）。單人時沒有鄰居，
  // 門檻就是上面的寬鬆值；多人站成一排時門檻自動縮到鄰居距離的一半。
  ambiguityRatio: 0.5,
  // 站得很近時每個人周圍仍保留的最小防護半徑（肩寬單位）。原本 0.25，多人近距離測試後
  // 骨架會互相黏到對方身上，調高到 0.4 讓每個人的門檻不會收斂到太窄；這個數字沒辦法一次
  // 公式算準，需要照實機測試結果繼續調整方向。
  ambiguityFloorRatio: 0.4,

  // ── 「同一具身體」的判準（dedupe／幽靈抑制／硬保險三處共用，見 isSameBody）────
  // 兩筆偵測（或兩個槽位）的肩膀中點距離 < max(sameBodyDist, sameBodyRatio × 較小的肩寬)
  // 就視為同一具身體：兩個真人的肩膀中點不可能靠到半個肩寬以內，
  // 而幽靈（MediaPipe 對同一具身體多吐一組骨架）是同一對肩膀、中點幾乎重合。
  // 取較小的肩寬：站在使用者正後方、看起來比較小的第二個人，才不會被近處那個人的尺度吞掉。
  sameBodyDist: 0.03,
  sameBodyRatio: 0.5,
  // 「一具身體只能有一個 ID」的硬保險（_releaseDuplicateTracks）：兩個 live 槽位連續這麼久
  // 都判定為同一具身體才釋放較晚鎖定的那個；單幀誤判不該砍掉一個正在使用的 ID。
  duplicateTrackConfirmMs: 200,

  // 候選人跨幀關聯的距離（「這一幀這筆偵測是不是上一幀那個候選人」），一樣以肩寬為單位。
  pendingAssocDist: 0.15,
  pendingAssocDistRatio: 1.0,
  // 肩寬本身也要平滑，否則單幀的肩寬雜訊會讓上面那些門檻跟著跳動。
  shoulderWidthEmaAlpha: 0.2,

  // ── 繪製用的短暫保留（getDrawableTracks）──────────────────────────────────
  // MediaPipe 偶爾會漏掉一幀，已鎖定的人這一幀沒配對到偵測就會整具骨架眨一下。
  // getDrawableTracks() 把「最後一次配對到之後 drawHoldMs 內」的槽位也交給繪製端。
  // 100ms 是 3 幀：人真的離開仍幾乎立刻消失。手勢與在場名單仍用嚴格的 getActiveTracks()。
  drawHoldMs: 100,
  // 以下門檻以「毫秒」計而不是幀數，行為與幀率脫鉤。
  trackLossMs: 1500,      // 未匹配超過這段時間就釋放鎖定
  lockConfirmMs: 231,     // 新目標需持續出現這麼久才鎖定空位
  // 可見度平滑＋遲滯：visibility 是唯一沒經過 AdaptivePoseFilter 的欄位，在門檻附近抖動時
  // 手腕、腳踝這類邊緣關節會逐幀出現又消失。先 EMA 壓雜訊，再用 on／off 兩道門檻留一段死區。
  // 結果寫進 smoothed[i].visible（布林），繪製端直接用它。
  visibilityEmaAlpha: 0.3,
  visibilityOnGate: 0.55,
  visibilityOffGate: 0.45,
  // 候選新目標（尚未鎖定）這一幀沒匹配到偵測時，允許保留多久再丟棄（不讓累積時間歸零）。
  // 站在邊緣或背光的人偵測不穩，否則可能永遠湊不滿 lockConfirmMs。能否鎖定仍要求
  // 「這一幀確實有匹配到偵測」，所以這個寬限不會讓早已離開的候選人憑空鎖到槽位。
  pendingGraceMs: 400,
  // 已鎖定槽位剛開始漏配、漏配時間落在 0~missGraceMs 時，逐幀配對改用 graceGate 放寬門檻。
  // 固定寬限長度（不隨 missCount 遞減），避免姿勢做到一半保護力就先失效。
  missGraceMs: 1320,

  // 非人物體防呆（hasHumanGeometry／buildDetection）。幾何檢查（肩寬範圍、肩膀要在髖部上方）
  // 是硬拒絕；可見度分兩級：
  //   - 嚴格（coreVisibilityMin／overallVisibilityMin）：鎖定新候選人時用，可見度很低的骨架
  //     多半是對背景圖案或半個身體的誤判，不該拿到 ID。
  //   - 寬鬆（…Tracked）：延續已經在追蹤的人時用。手臂橫過胸前、側身時另一側肩膀的可見度
  //     常掉到 0.4~0.5，這一幀的骨架仍然比「不畫」更接近事實。
  //   低於寬鬆門檻的偵測在 buildDetection 就回傳 null（連追蹤都不參與）。
  coreVisibilityMin: 0.5,
  overallVisibilityMin: 0.3,
  coreVisibilityMinTracked: 0.3,
  overallVisibilityMinTracked: 0.2,
  minShoulderWidth: 0.015,
  maxShoulderWidth: 0.9,
  visibilityThreshold: 0.5,
});

function isFinitePoint(p) { return !!p && Number.isFinite(p.x) && Number.isFinite(p.y); }

/* ═══════════════════════════════════════════
   🧍 非人物體防呆
   MediaPipe 偶爾會對背景圖案／假人模型等非人物件誤判出一組姿勢，
   這裡過濾掉明顯不像真人骨架的偵測結果。
   ═══════════════════════════════════════════ */
// 幾何上像不像一個人：肩寬在合理範圍、髖部可信時肩膀要在髖部上方。這是硬拒絕。
function hasHumanGeometry(landmarks, cfg) {
  const lS = landmarks[11], rS = landmarks[12];
  const lH = landmarks[23], rH = landmarks[24];

  const shoulderWidth = Math.hypot(lS.x - rS.x, lS.y - rS.y);
  if (shoulderWidth < cfg.minShoulderWidth || shoulderWidth > cfg.maxShoulderWidth) return false;

  // 坐姿或下半身被裁切時髖部可見度本來就會偏低，所以只在髖部可信時才檢查「肩膀應在髖部上方」。
  const hipVis = Math.min(lH.visibility ?? 0, rH.visibility ?? 0);
  if (hipVis >= cfg.visibilityThreshold) {
    const shoulderMidY = (lS.y + rS.y) / 2, hipMidY = (lH.y + rH.y) / 2;
    if (shoulderMidY >= hipMidY) return false; // 肩膀理應在髖部上方（image y 較小）
  }
  return true;
}

// 33 點的平均可見度；沒有任何可見度數值時視為 1（等同不檢查）。
function meanLandmarkVisibility(landmarks) {
  let visSum = 0, visCount = 0;
  for (const p of landmarks) {
    if (typeof p.visibility === "number") { visSum += p.visibility; visCount++; }
  }
  return visCount > 0 ? visSum / visCount : 1;
}

function shoulderVisibility(landmarks) {
  return Math.min(landmarks[11].visibility ?? 0, landmarks[12].visibility ?? 0);
}

/* ═══════════════════════════════════════════
   🧩 由原始 landmark 建立一筆「偵測」
   肩膀中點：位置匹配與「同一具身體」判定的唯一依據。這裡完全不碰 DOM。回傳 null 代表
   這筆偵測數值異常、幾何不像真人、或可見度連寬鬆門檻都不到，呼叫端須過濾掉。
   ═══════════════════════════════════════════ */
export function buildDetection(landmarks, { cfg = DEFAULT_TRACKING_CONFIG } = {}) {
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];
  if (![lShoulder, rShoulder, lHip, rHip].every(isFinitePoint)) return null;
  if (!hasHumanGeometry(landmarks, cfg)) return null;

  // 可見度分兩級：連寬鬆門檻都不到的直接丟掉；過寬鬆但不過嚴格的偵測可以延續已經在追蹤
  // 的人，但不能拿來鎖定新 ID（strictPlausible = false，_updatePendingCandidates 據此過濾）。
  const shoulderVis = shoulderVisibility(landmarks);
  const meanVisibility = meanLandmarkVisibility(landmarks);
  if (shoulderVis < cfg.coreVisibilityMinTracked || meanVisibility < cfg.overallVisibilityMinTracked) return null;
  const strictPlausible = shoulderVis >= cfg.coreVisibilityMin && meanVisibility >= cfg.overallVisibilityMin;

  const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
  const shoulderMidY = (lShoulder.y + rShoulder.y) / 2;
  // 位置錨點就是肩膀中點：肩膀是全身最穩的兩個點（幾乎不會被裁到畫面外、很少被遮住），
  // 而且同一具身體的幽靈骨架跟真人共用同一對肩膀——isSameBody 靠的就是這一點。
  const centroid = { x: shoulderMidX, y: shoulderMidY };
  // 對外回傳的 shoulderWidth 是「這個人在畫面上有多大」的尺度（所有位置門檻的單位），
  // 必須用實際肩線長度，側身或傾斜的人才不會被系統性低估。
  const shoulderWidth = Math.hypot(lShoulder.x - rShoulder.x, lShoulder.y - rShoulder.y) || 0.08;

  // shoulderWidth 跟「離攝影機多近」正相關，候選新身分多於空槽位時優先鎖定最靠近鏡頭的人；
  // meanVisibility 給 dedupeDetections 在沒有既有 track 可對照時挑「比較可信的那一筆」用。
  return { landmarks, centroid, shoulderWidth, meanVisibility, strictPlausible };
}

// 兩筆偵測／兩個 track 的肩膀中點距離。偵測與 track 都有 centroid 與 shoulderWidth 欄位，
// 所以下面這幾個函式對兩種物件通用。
function centroidDistance(a, b) {
  return Math.hypot(a.centroid.x - b.centroid.x, a.centroid.y - b.centroid.y);
}

// 「同一具身體」的半徑：max(絕對值, 比例 × 較小的肩寬)。拿不到肩寬時退回純絕對值。
function sameBodyGate(a, b, cfg) {
  const w = Math.min(a.shoulderWidth ?? 0, b.shoulderWidth ?? 0);
  return Math.max(cfg.sameBodyDist, cfg.sameBodyRatio * (Number.isFinite(w) ? w : 0));
}

export function isSameBody(a, b, cfg = DEFAULT_TRACKING_CONFIG) {
  return centroidDistance(a, b) < sameBodyGate(a, b, cfg);
}

// 這筆偵測「延續既有 track」的程度：離最近的 anchor 幾個肩寬（越小越像）。沒有 anchor 時
// 回傳 Infinity，排序時就只剩可見度在決定。
function continuityRank(det, anchors) {
  let best = Infinity;
  for (const a of anchors) {
    if (!a) continue;
    const scale = Math.max(a.shoulderWidth ?? 0, 1e-3);
    best = Math.min(best, centroidDistance(a, det) / scale);
  }
  return best;
}

// 同一幀內，同一具身體只留一筆偵測（MediaPipe 對同一人多吐一組骨架時）。
// 留哪一筆不能「留陣列第一筆」：MediaPipe 多人模式的輸出順序是上一幀的追蹤框排前面、
// 這一幀重新偵測到的框 push 到尾端，於是真人常在尾端、靠 landmark 延續下來的幽靈在前面。
// 順位：①最能延續既有 track 的（離最近的 anchor 幾個肩寬）②平均可見度較高的。
export function dedupeDetections(detections, cfg = DEFAULT_TRACKING_CONFIG, anchors = []) {
  if (detections.length < 2) return detections.slice();
  const ranked = detections.map((det) => ({ det, continuity: continuityRank(det, anchors) }));
  ranked.sort((a, b) => (a.continuity - b.continuity)
    || ((b.det.meanVisibility ?? 1) - (a.det.meanVisibility ?? 1)));
  const kept = [];
  for (const { det } of ranked) {
    if (!kept.some((k) => isSameBody(k, det, cfg))) kept.push(det);
  }
  return kept;
}

/* ═══════════════════════════════════════════
   🎯 Adaptive Pose Filter
   「動得越像真的在動，就越信任新值」的一階平滑，外加一個等於自身群延遲的前瞻量，
   於是等速運動時輸出精準落回真值——「穩定」與「不跟隨延遲」不再互相衝突。
     ① 「有沒有在動」用 max(|Δ|, |v̂|·dt) 判斷：雜訊的方向每幀亂跳、v̂ 永遠接近 0；
        真實移動即使每幀很小，方向一致會讓 v̂ 累積起來，慢揮才不會被吃掉。
     ② alpha 從 smoothingAtRest 連續升到 maxAlpha（< 1），永遠保留一點雜訊抑制，
        靜止時 alpha 很小但不是 0，沒有凍結／解凍的階梯。
     ③ 前瞻量用平滑後的速度 v̂，長度取 dt·(1-alpha)/alpha ＝ 這個一階濾波器的群延遲。
   代價：帶前瞻的濾波器在方向反轉的瞬間會有一點過衝。
   ═══════════════════════════════════════════ */
// |Δ| 超過 jumpDist 就直接吃原值：那不是人的動作，是身分跳格／偵測跳到別人身上。
// 此時連速度估計也要清掉，否則那一大跳會被當成極高速度、被前瞻量放大出去。
// 跟 snapDist 是兩回事：snapDist 是「動到這個量級就該完全信任新值」，jumpDist 是
// 「這個位移不可能是人做出來的」。
export const DEFAULT_JUMP_DIST = 0.10; // ≈ 3 單位/秒，真人的關節到不了

/* ═══════════════════════════════════════════
   ⏩ 前瞻預測量（PREDICT_MS）—— 抵銷「上游」的延遲

   加上這一項之後，濾波器輸出的是「大約 PREDICT_MS 毫秒後這個關節會在哪」。
   濾波器自己只貢獻幾 ms 延遲，真正的延遲在上游——攝影機曝光＋傳輸解碼 → MediaPipe 推論
   → 繪製合成，30fps 下合計 60~100ms。前瞻量上限是濾波器自己的群延遲，最好也只能做到
   「不比輸入慢」，補不了上游那一段；這一項是程式裡唯一能往前推的槓桿。

   另外一條速度估計 vRaw：vHat 是用濾波後的位移算的，已被 alpha 衰減過；vRaw 用原始位移，
   沒有這個衰減。兩項各司其職：
     vHat × min(leadCapMs, 群延遲)  → 抵銷濾波器自己的延遲
     vRaw × PREDICT_MS × t²         → 抵銷上游的延遲
   權重 t²：靜止時雜訊仍會讓 t ≈ 0.14，平方後 vRaw 的雜訊幾乎不進輸出；快速移動時 t 飽和在 1。

   調整只有這一個數字：實機覺得拖 → 調高；節點會甩過頭 → 調低。調之前先用瀏覽器 DevTools
   的 Rendering 面板看實際 fps，若掉到 28 以下，該修的是效能而不是這裡。
   ═══════════════════════════════════════════ */
export const PREDICT_MS = 30;
const PREDICT_TAU_MS = 110; // vRaw 的 EMA 時間常數（約 3 幀）

export class AdaptivePoseFilter {
  constructor({ deadZone = 0.003, snapDist = 0.02, smoothingAtRest = 0.15,
                maxAlpha = 0.6, velTauMs = 110, leadCapMs = 0,
                jumpDist = DEFAULT_JUMP_DIST,
                predictMs = PREDICT_MS, predictTauMs = PREDICT_TAU_MS } = {}) {
    this.deadZone = deadZone;             // 這個量級以下的位移視為雜訊（alpha 收到最小）
    this.snapDist = snapDist;             // 這個量級以上的位移視為明確動作（alpha 到 maxAlpha）
    this.smoothingAtRest = smoothingAtRest; // 靜止時的 alpha（越小越穩、但不可為 0）
    this.maxAlpha = maxAlpha;             // alpha 上限（< 1：永遠保留一點雜訊抑制）
    this.velTauMs = velTauMs;             // 速度 EMA 的時間常數（約 3 幀）
    this.leadCapMs = leadCapMs;           // 前瞻量上限（0 ＝ 不做前瞻）
    this.jumpDist = jumpDist;             // 超過這個單幀位移視為身分跳格，直接歸位
    this.predictMs = predictMs;           // 額外往前推的預測量（見上方 PREDICT_MS）
    this.predictTauMs = predictTauMs;     // vRaw 的 EMA 時間常數
    this.xPrev = null;
    this.tPrev = null;
    this.rawPrev = null;                  // 上一幀的原始輸入（算 vRaw 用，不是濾波後的值）
    this.vHat = 0;                        // 平滑後的速度（單位／秒），用來抵銷自身群延遲
    this.vRaw = 0;                        // 原始位移算出的速度，用來抵銷上游延遲（不被 alpha 衰減）
  }
  filter(x, tMs) {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.rawPrev = x;
      this.tPrev = tMs;
      this.vHat = 0;
      this.vRaw = 0;
      return x;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1e-3);
    this.tPrev = tMs;

    const delta = x - this.xPrev;
    const absDelta = Math.abs(delta);
    // vRaw 要用「原始輸入之間」的位移，不能用 delta——delta 是原始輸入對上一幀濾波後的值，
    // 本身已經含有 alpha 的衰減。
    const rawDelta = x - this.rawPrev;
    this.rawPrev = x;

    // 非人類動作的大跳：直接歸位，不平滑也不前瞻。兩條速度估計都要清掉。
    if (absDelta > this.jumpDist) {
      this.xPrev = x;
      this.vHat = 0;
      this.vRaw = 0;
      return x;
    }

    // 「真的在動嗎」＝單幀位移 與 平滑速度所預期的位移 取大者。
    const motion = Math.max(absDelta, Math.abs(this.vHat) * dt);
    const span = this.snapDist - this.deadZone;
    const t = span > 0 ? clamp01((motion - this.deadZone) / span) : 1;
    const alpha = this.smoothingAtRest + t * (this.maxAlpha - this.smoothingAtRest);

    const xHat = this.xPrev + delta * alpha;
    const v = (xHat - this.xPrev) / dt;
    this.vHat += (v - this.vHat) * (1 - Math.exp(-dt / (this.velTauMs / 1000)));
    this.vRaw += ((rawDelta / dt) - this.vRaw) * (1 - Math.exp(-dt / (this.predictTauMs / 1000)));
    this.xPrev = xHat;

    // ① 抵銷濾波器自己的群延遲：長度 ＝ dt·(1-alpha)/alpha，夾在 leadCapMs 之內。
    // 這一項不可以再乘上 t 之類的「確定在動」係數：靜止時 v̂ 本來就在 0 附近，乘了反而在
    // 中速時補不滿群延遲。壓雜訊交給 leadCapMs。
    const leadSec = this.leadCapMs > 0
      ? Math.min(this.leadCapMs / 1000, (dt * (1 - alpha)) / alpha)
      : 0;
    // ② 抵銷上游（攝影機＋MediaPipe＋繪製）的延遲，見上方 PREDICT_MS 的說明。
    return xHat + this.vHat * leadSec + this.vRaw * (this.predictMs / 1000) * t * t;
  }
  reset() {
    this.xPrev = null;
    this.tPrev = null;
    this.rawPrev = null;
    this.vHat = 0;
    this.vRaw = 0;
  }
}

// 依關節類型分組給不同濾波參數。三個旋鈕的分工：
//   - deadZone 守「靜止時的抖動」：雜訊等級的位移落在它以下，只拿得到最小的 alpha。
//   - snapDist／maxAlpha 買「動起來的跟隨」：snapDist 是 alpha 斜坡的頂端，若訂得比真人
//     實際動作快很多，alpha 一輩子升不上去，動得越快落後越多、振幅還被壓扁。
//   - velTauMs 決定前瞻量準不準：時間常數太長時「正在加速」的速度估計嚴重落後。
const FACE_IDX = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const CORE_IDX = new Set([11, 12, 23, 24]);
const MID_IDX = new Set([13, 14, 25, 26]);
const WRIST_ANKLE_IDX = new Set([15, 16, 27, 28]);
// 手掌（小指／食指／拇指）自成一組，目前數值刻意與手腕相同，但保留獨立分組。
const HAND_IDX = new Set([17, 18, 19, 20, 21, 22]);

// leadCapMs 要明顯大於該組在 maxAlpha 下的群延遲：alpha 會隨速度下降，中速時群延遲比那個值
// 大好幾倍，cap 卡太緊就補不滿。cap 的真正用途是「限制外插距離」——靜止時 alpha 小、群延遲
// 會膨脹到數百毫秒，那時外插只會放大雜訊。
// maxAlpha 是 alpha 斜坡的頂端，動作真的快起來時輸出就靠它；靜止抖動由 deadZone／smoothingAtRest 顧。
// 所有分組共用同一個 jumpDist（DEFAULT_JUMP_DIST）。
export function getFilterParams(index) {
  if (FACE_IDX.has(index)) {
    return { deadZone: 0.007, snapDist: 0.015, smoothingAtRest: 0.09, maxAlpha: 0.58, velTauMs: 75, leadCapMs: 60 };
  }
  if (CORE_IDX.has(index)) {
    return { deadZone: 0.006, snapDist: 0.018, smoothingAtRest: 0.10, maxAlpha: 0.62, velTauMs: 75, leadCapMs: 60 };
  }
  if (MID_IDX.has(index)) {
    return { deadZone: 0.004, snapDist: 0.012, smoothingAtRest: 0.14, maxAlpha: 0.60, velTauMs: 90, leadCapMs: 45 };
  }
  if (WRIST_ANKLE_IDX.has(index)) {
    // 手腕是 gesture.js 唯一的控制訊號來源（揮手頻率 → tempo 與 velocity），調它會動到樂器控制。
    return { deadZone: 0.002, snapDist: 0.012, smoothingAtRest: 0.11, maxAlpha: 0.70, velTauMs: 110, leadCapMs: 40 };
  }
  if (HAND_IDX.has(index)) {
    // 手掌必須跟手腕用同一組參數：手掌接在手腕上，濾波強度差太多時揮手會看到手掌明顯落在
    // 手腕後面，像手掌是軟的。deadZone／snapDist 尤其要一模一樣，否則同一個動作下兩邊的 alpha 不同。
    return { deadZone: 0.002, snapDist: 0.012, smoothingAtRest: 0.11, maxAlpha: 0.70, velTauMs: 110, leadCapMs: 40 };
  }
  // 腳掌（29~32）：只拿來畫，全身最重的濾波求穩，但仍要跟得上走路抬腳。
  return { deadZone: 0.004, snapDist: 0.016, smoothingAtRest: 0.12, maxAlpha: 0.50, velTauMs: 120, leadCapMs: 60 };
}

/* ═══════════════════════════════════════════
   👥 PersonTracker — 多人 ID 鎖定狀態機
   固定 maxUsers 個「槽位」，ID 恆等於槽位編號（1~maxUsers）。
   ═══════════════════════════════════════════ */
export class PersonTracker {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_TRACKING_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.tracks = new Array(this.cfg.maxUsers).fill(null);
    this.pending = []; // 候選新目標，尚未持續出現足夠時間
  }

  hardReset() { this.reset(); }

  // 對外 API：回傳「這一幀真的偵測到的人」，語意跟 getActiveTracks() 一致，只是欄位精簡過。
  getTrackedUsers() {
    return this.getActiveTracks().map((t) => ({ id: t.id, slot: t.slot, landmarks: t.smoothed }));
  }

  // 給手勢與在場名單用：回傳「這一幀真的有比對到偵測」的 track（missCount === 0）。
  // 一個人消失後，槽位在 trackLossMs 的緩衝期內仍佔著（讓短暫的偵測漏失不會立刻釋放槽位），
  // 但緩衝期間畫面不該還畫著一具停在原地的骨架——緩衝期純粹是內部的槽位保留機制。
  getActiveTracks() {
    return this.tracks.filter((t) => t !== null && t.missCount === 0);
  }

  // 給畫面繪製用：這一幀有比對到的 track，外加「最後一次比對到之後 drawHoldMs 內」的 track
  // （用它最後一次平滑後的骨架畫），接住 MediaPipe 偶發的單幀漏偵測。手勢那一路刻意不用這個。
  getDrawableTracks(nowMs) {
    const { drawHoldMs } = this.cfg;
    return this.tracks.filter((t) => t !== null
      && (t.missCount === 0 || nowMs - t.lastSeenMs <= drawHoldMs));
  }

  // 到最近的另一個「上一幀有配對到」的槽位的肩膀中點距離；沒有這種鄰居時是 Infinity。
  // 只算上一幀確實有人的槽位（update() 在算成本時 missCount 還沒遞增）：漏配中的槽位的人可能
  // 已經走掉，拿它的舊位置去收斂鄰居的門檻，會讓一個人一離場就把旁邊的人卡到動彈不得。
  _nearestOtherTrackDist(track) {
    let best = Infinity;
    for (const other of this.tracks) {
      if (!other || other === track || other.missCount > 0) continue;
      best = Math.min(best, centroidDistance(track, other));
    }
    return best;
  }

  // 「這筆偵測貼上這個槽位的 ID」的成本；Infinity ＝ 不允許。門檻三層：
  // 基本門檻 → 漏配緩衝期放寬 → 依最近鄰居收斂（見 DEFAULT_TRACKING_CONFIG 的「逐幀配對」）。
  // 純粹依位置判斷，不看顏色：單純比對上一次的實際位置、不做速度外插——外插會把單幀雜訊
  // 往錯誤方向多推一截。
  _trackDetectionCost(track, det, nowMs) {
    const { gatePos, gatePosRatio, graceGate, graceGateRatio,
            ambiguityRatio, ambiguityFloorRatio, missGraceMs } = this.cfg;

    let gate = Math.max(gatePos, gatePosRatio * track.shoulderWidth);
    const inGraceWindow = track.missCount > 0 && (nowMs - track.lastSeenMs) <= missGraceMs;
    if (inGraceWindow) {
      gate = Math.max(gate, graceGate, graceGateRatio * track.shoulderWidth);
    }
    // 歧義收斂：門檻不得超過到最近鄰居距離的一半（單人時鄰居距離是 Infinity，等於不收斂），
    // 但保留 ambiguityFloorRatio × 肩寬給真人一幀內的正常位移。
    gate = Math.max(
      Math.min(gate, ambiguityRatio * this._nearestOtherTrackDist(track)),
      ambiguityFloorRatio * track.shoulderWidth);

    const posDist = centroidDistance(track, det);
    if (posDist > gate) return Infinity;
    return posDist / gate;
  }

  // 幫「剛確認鎖定、需要一個槽位」的新候選人挑槽位：ID 只是槽位編號的顯示提示，不做身分
  // 認回，直接給任一個空槽位即可。
  _resolveSlotForNewIdentity() {
    const freeSlot = this.tracks.findIndex((t) => t === null);
    return freeSlot;
  }

  _createTrack(slot, det, nowMs) {
    const n = det.landmarks.length;
    const track = {
      slot,
      id: slot + 1, // ID 恆等於槽位編號（1~maxUsers），純粹是顯示提示，不做身分認回
      centroid: { ...det.centroid },
      // 這個人在畫面上的尺度，所有位置門檻都以它為單位；在 _updateTrack 裡以 EMA 更新。
      shoulderWidth: det.shoulderWidth ?? 0,
      lockedAtMs: nowMs,     // 鎖定時刻；兩個槽位落在同一具身體上時，用它決定誰比較新
      duplicateSinceMs: 0,   // 與另一個槽位重疊的起算時刻（0 ＝ 目前沒有重疊）
      // 只濾 x／y：整個專案沒有任何地方讀 z。真的要用 z 時注意 AdaptivePoseFilter 的
      // deadZone／snapDist 是照影像座標的尺度調的，不能直接沿用同一組參數。
      filtersX: Array.from({ length: n }, (_, i) => new AdaptivePoseFilter(getFilterParams(i))),
      filtersY: Array.from({ length: n }, (_, i) => new AdaptivePoseFilter(getFilterParams(i))),
      smoothed: det.landmarks.map((p) => ({ ...p })),
      missCount: 0,       // 0 ＝這一幀真的匹配到偵測（getActiveTracks 據此決定是否繪製）
      lastSeenMs: nowMs   // 最後一次匹配到的時間；釋放槽位與漏配寬限期都以此為準
    };
    this._updateTrack(track, det, nowMs);
    return track;
  }

  _updateTrack(track, det, nowMs) {
    const { visibilityEmaAlpha, visibilityOnGate, visibilityOffGate,
            shoulderWidthEmaAlpha } = this.cfg;
    track.missCount = 0;
    track.lastSeenMs = nowMs;
    track.centroid = det.centroid;
    if (Number.isFinite(det.shoulderWidth)) {
      track.shoulderWidth += (det.shoulderWidth - track.shoulderWidth) * shoulderWidthEmaAlpha;
    }

    // 讀上一幀的結果當作可見度 EMA 與遲滯的狀態來源（第一幀時 prev 是 _createTrack 直接
    // 複製的原始 landmarks，沒有 visible 欄位，退回用 onGate 直接判定初始狀態）。
    const prev = track.smoothed;
    track.smoothed = det.landmarks.map((p, i) => {
      const rawVis = p.visibility ?? 1;
      const prevVis = prev[i]?.visibility ?? rawVis;
      const visibility = prevVis + (rawVis - prevVis) * visibilityEmaAlpha;
      const wasVisible = prev[i]?.visible ?? (visibility >= visibilityOnGate);
      return {
        x: track.filtersX[i].filter(p.x, nowMs),
        y: track.filtersY[i].filter(p.y, nowMs),
        visibility,
        // 遲滯：已顯示的關節要跌破 offGate 才隱藏，已隱藏的要跨過 onGate 才顯示
        visible: wasVisible ? visibility > visibilityOffGate : visibility >= visibilityOnGate
      };
    });
  }

  // 候選新目標需持續出現足夠時間才可鎖定空位，避免路人短暫入鏡搶走槽位。
  _updatePendingCandidates(detections, usedDetIdx, nowMs) {
    const hasFreeSlot = this.tracks.some((t) => t === null);
    if (!hasFreeSlot) { this.pending = []; return; }

    const { pendingAssocDist, pendingAssocDistRatio } = this.cfg;
    const unmatched = [];
    detections.forEach((d, i) => {
      if (usedDetIdx.has(i)) return;
      // 這一幀沒被貪婪匹配選中的偵測，仍可能是「已鎖定的某個人」的第二組骨架（幽靈）。
      // 若不擋，它會被當成「不明新人」持續累積，滿 lockConfirmMs 後鎖進另一個空槽，同一個
      // 真人同時冒出兩個 ID。判準就是 isSameBody（肩膀中點 < 半個肩寬），跟 dedupe、硬保險
      // 三處同一道；只擋這麼窄是刻意的——肩膀中點差超過半個肩寬的就當第二個人。
      if (this.tracks.some((t) => t && isSameBody(t, d, this.cfg))) return;
      // 鎖定新 ID 要用嚴格的可見度門檻；寬鬆門檻是留給「已經在追蹤的人」的（見 buildDetection）。
      if (!d.strictPlausible) return;
      unmatched.push(d);
    });

    const usedPending = new Set();
    const nextPending = [];

    for (const det of unmatched) {
      let bestIdx = -1, bestDist = Infinity;
      const assocDist = Math.max(pendingAssocDist, pendingAssocDistRatio * (det.shoulderWidth ?? 0));
      this.pending.forEach((p, pi) => {
        if (usedPending.has(pi)) return;
        const dist = centroidDistance(p, det);
        if (dist < assocDist && dist < bestDist) { bestDist = dist; bestIdx = pi; }
      });

      if (bestIdx >= 0) {
        usedPending.add(bestIdx);
        const p = this.pending[bestIdx];
        p.centroid = det.centroid;
        p.det = det;
        p.lastSeenMs = nowMs;
        p.matchedThisFrame = true;
        nextPending.push(p);
      } else {
        nextPending.push({
          centroid: det.centroid,
          det,
          // 以「持續出現多久」判定可否鎖定。
          firstSeenMs: nowMs,
          lastSeenMs: nowMs,
          matchedThisFrame: true,
        });
      }
    }

    // 這一幀沒匹配到任何偵測的候選人：在 pendingGraceMs 內先留著，不要把累積的時間歸零。
    this.pending.forEach((p, pi) => {
      if (usedPending.has(pi)) return;
      p.matchedThisFrame = false;
      if (nowMs - p.lastSeenMs <= this.cfg.pendingGraceMs) nextPending.push(p);
    });

    // 候選人數可能多於現有空槽位。此時優先鎖定肩寬較大（離攝影機較近）的人，避免站在背景／
    // 邊緣的路人搶走鏡頭前主要使用者的槽位。沒搶到槽位的候選人不會被丟棄，下一幀繼續參與排序。
    // 兩個條件都要滿足才可鎖定：①累積出現時間夠久 ②這一幀確實有匹配到偵測（寬限期會讓
    // 短暫漏配的候選人留在名單裡，不檢查的話已經走出畫面的候選人會拿著過期的 det 鎖進槽位）。
    const ready = nextPending.filter(
      (p) => p.matchedThisFrame && nowMs - p.firstSeenMs >= this.cfg.lockConfirmMs);
    ready.sort((a, b) => (b.det.shoulderWidth ?? 0) - (a.det.shoulderWidth ?? 0));

    for (const p of ready) {
      const slot = this._resolveSlotForNewIdentity();
      if (slot === -1) continue; // 這幀空槽位已被更靠近鏡頭的候選人用完，留著下一幀再排隊
      this.tracks[slot] = this._createTrack(slot, p.det, nowMs);
      p.isLocked = true; // 已鎖定，下方過濾掉
    }

    this.pending = nextPending.filter((p) => !p.isLocked);
  }

  // 「一具身體只能有一個 ID」——最後一道硬保險。dedupe 與候選人抑制應該在幽靈鎖進槽位之前
  // 就擋掉它；這裡是萬一漏網的收尾：兩個 live 槽位的肩膀中點落在同一具身體的半徑內
  // （isSameBody），就釋放較晚鎖定的那個。要連續重疊 duplicateTrackConfirmMs 才動手。
  _releaseDuplicateTracks(nowMs) {
    const { duplicateTrackConfirmMs } = this.cfg;
    const live = this.tracks.filter((t) => t !== null && t.missCount === 0);
    const overlapping = new Set();

    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        if (!isSameBody(a, b, this.cfg)) continue;
        overlapping.add(a.lockedAtMs <= b.lockedAtMs ? b : a); // 保留先鎖定的那個
      }
    }

    for (const track of this.tracks) {
      if (!track) continue;
      if (!overlapping.has(track)) { track.duplicateSinceMs = 0; continue; }
      if (track.duplicateSinceMs === 0) track.duplicateSinceMs = nowMs;
      if (nowMs - track.duplicateSinceMs < duplicateTrackConfirmMs) continue;
      this.tracks[track.slot] = null;
    }
  }

  // 每幀：把目前鎖定槽位與這一幀的偵測結果做最佳匹配（貪婪法，槽位數少故足夠）。
  // 傳進來的是 buildDetection 的結果（可以還沒 dedupe）：同一具身體的重複偵測在這裡
  // 用目前的槽位當 anchor 去挑該留哪一筆，呼叫端不必自己做。
  update(rawDetections, nowMs) {
    const detections = dedupeDetections(rawDetections, this.cfg, this.tracks);
    const usedDetIdx = new Set();
    const usedSlot = new Set();
    const candidates = [];

    this.tracks.forEach((track, slot) => {
      if (!track) return;
      detections.forEach((det, di) => {
        const cost = this._trackDetectionCost(track, det, nowMs);
        if (cost !== Infinity) candidates.push({ slot, di, cost });
      });
    });
    candidates.sort((a, b) => a.cost - b.cost);

    for (const { slot, di } of candidates) {
      if (usedSlot.has(slot) || usedDetIdx.has(di)) continue;
      usedSlot.add(slot);
      usedDetIdx.add(di);
      this._updateTrack(this.tracks[slot], detections[di], nowMs);
    }

    this.tracks.forEach((track, slot) => {
      if (!track || usedSlot.has(slot)) return;
      track.missCount++; // missCount === 0 是「這一幀真的有人」的判準（見 getActiveTracks）
      if (nowMs - track.lastSeenMs > this.cfg.trackLossMs) this.tracks[slot] = null;
    });

    this._releaseDuplicateTracks(nowMs);
    this._updatePendingCandidates(detections, usedDetIdx, nowMs);
  }
}
