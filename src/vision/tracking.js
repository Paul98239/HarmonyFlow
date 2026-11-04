// tracking.js — 多人槽位追蹤與平滑：這一幀這個人該貼哪個已鎖定槽位、新面孔何時才能鎖定空位，加上逐節點的 One Euro 平滑（OneEuroFilter）。
// 純粹依位置（螢幕座標接近程度，門檻依這個人的尺度縮放，見 bodyScaleOf）判斷，不用服裝顏色；ID 只是槽位編號的顯示提示，不做身分認回。

const round3 = (v) => Math.round(v * 1000) / 1000;

export const DEFAULT_TRACKING_CONFIG = Object.freeze({
  maxUsers: 4,

  // 以下「尺度」＝bodyScaleOf()（以畫面寬為單位）：正面時就是肩寬，側身時不縮，所以原本以肩寬訂的比例照用。
  // 位置門檻＝max(gatePos, gatePosRatio × 這個人的尺度)：同一個動作站得近的人在正規化座標上走得比較遠；絕對值下限給遠處的小人。
  gatePos: 0.15,
  gatePosRatio: 0.45,
  // 漏配緩衝期內（missCount > 0 且漏配 ≤ missGraceMs）門檻放寬到 max(上面的門檻, graceGate, graceGateRatio × 尺度)：MediaPipe 在「手在頭部交叉」這類姿勢期間
  // 會把整個人的位置估歪一大段，放寬讓附近的偵測仍能配對回他本人。這段放寬只在單人、或鄰居很遠時真的生效（見 ambiguityRatio）。
  graceGate: 0.45,
  graceGateRatio: 1.5,
  // 歧義收斂：不管上面算出多寬，門檻一律再夾到「到最近的另一個槽位的距離 × ambiguityRatio」以內（下限 ambiguityFloorRatio × 尺度，保留真人一幀內的正常位移）。
  // 單人時沒有鄰居，門檻就是上面的寬鬆值；多人站成一排時自動縮到鄰居距離的一半。
  ambiguityRatio: 0.5,
  // 站得很近時每個人周圍仍保留的最小防護半徑（尺度單位）。多人近距離實測骨架會互相黏到對方身上，所以調高到 0.4 讓門檻不會收斂得太窄；
  // 沒辦法用公式算準，需照實機測試繼續調。
  ambiguityFloorRatio: 0.4,

  // 「同一具身體」的判準（dedupe／幽靈抑制／配對讓先鎖定的先挑／硬保險四處共用，見 isSameBody）：
  // 兩筆偵測（或兩個槽位）的肩膀中點距離 < max(sameBodyDist, sameBodyRatio × 較小的尺度) 就視為同一具身體：兩個真人的肩膀中點不可能靠到半個肩寬以內，
  // 而幽靈（MediaPipe 對同一具身體多吐一組骨架）是同一對肩膀、中點幾乎重合。取較小的尺度：站在使用者正後方、看起來比較小的第二個人，才不會被近處那個人的尺度吞掉。
  sameBodyDist: 0.03,
  sameBodyRatio: 0.5,
  // 「一具身體只能有一個 ID」的硬保險（_releaseDuplicateTracks）：兩個 live 槽位連續這麼久
  // 都判定為同一具身體才釋放較晚鎖定的那個；單幀誤判不該砍掉一個正在使用的 ID。
  duplicateTrackConfirmMs: 200,

  // 候選人跨幀關聯的距離（「這一幀這筆偵測是不是上一幀那個候選人」），一樣以尺度為單位。
  pendingAssocDist: 0.15,
  pendingAssocDistRatio: 1.0,
  // 尺度本身也要平滑，否則單幀的雜訊會讓上面那些門檻跟著跳動；0.1 同 ForgeRhythm 的 updateBodyScale（spec 11.9 第 3 點）。
  scaleEmaAlpha: 0.1,

  // 繪製用的短暫保留（getDrawableTracks）：
  // MediaPipe 偶爾漏一幀，已鎖定的人這一幀沒配對到偵測就會整具骨架眨一下，所以 getDrawableTracks() 把「最後一次配對到之後 drawHoldMs 內」的槽位也交給繪製端
  // （100ms＝3 幀，人真的離開仍幾乎立刻消失）。手勢與在場名單仍用嚴格的 getActiveTracks()。
  drawHoldMs: 100,
  // 以下門檻以「毫秒」計而不是幀數，行為與幀率脫鉤。
  trackLossMs: 1500,      // 未匹配超過這段時間就釋放鎖定
  lockConfirmMs: 231,     // 新目標需持續出現這麼久才鎖定空位
  // 可見度平滑＋遲滯：visibility 是唯一沒經過 OneEuroFilter 的欄位，在門檻附近抖動時手腕、腳踝這類邊緣關節會逐幀出現又消失。
  // 先 EMA 壓雜訊，再用 on／off 兩道門檻留死區；結果寫進 smoothed[i].visible（布林），繪製端直接用。
  visibilityEmaAlpha: 0.3,
  visibilityOnGate: 0.55,
  visibilityOffGate: 0.45,
  // 候選新目標（尚未鎖定）這一幀沒匹配到偵測時允許保留多久再丟棄（不讓累積時間歸零）：站在邊緣或背光的人偵測不穩，否則可能永遠湊不滿 lockConfirmMs。
  // 能否鎖定仍要求這一幀確實有匹配到偵測，所以這個寬限不會讓早已離開的候選人憑空鎖到槽位。
  pendingGraceMs: 400,
  // 已鎖定槽位剛開始漏配、漏配時間落在 0~missGraceMs 時，逐幀配對改用 graceGate 放寬門檻；固定寬限長度（不隨 missCount 遞減），避免姿勢做到一半保護力就先失效
  missGraceMs: 1320,

  // 非人物體防呆（hasHumanGeometry／buildDetection）。幾何檢查（肩寬範圍、肩膀要在髖部上方）是硬拒絕；可見度分兩級：
  //   - 嚴格（coreVisibilityMin／overallVisibilityMin）：鎖定新候選人時用，可見度很低的骨架多半是對背景圖案或半個身體的誤判，不該拿到 ID。
  //   - 寬鬆（…Tracked）：延續已在追蹤的人時用；手臂橫過胸前、側身時另一側肩膀可見度常掉到 0.4~0.5，這一幀的骨架仍比「不畫」更接近事實。
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

// 非人物體防呆：過濾 MediaPipe 對背景圖案／假人模型等非人物件誤判出的姿勢。
// 幾何上像不像一個人：肩寬在合理範圍、髖部可信時肩膀要在髖部上方。這是硬拒絕。
function hasHumanGeometry(landmarks, cfg, aspect) {
  const lS = landmarks[11], rS = landmarks[12];
  const lH = landmarks[23], rH = landmarks[24];

  const shoulderWidth = Math.hypot(lS.x - rS.x, (lS.y - rS.y) * aspect);
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

// 由原始 landmark 建立一筆「偵測」：肩膀中點是位置匹配與「同一具身體」判定的唯一依據；回傳 null 代表數值異常、幾何不像真人、或可見度連寬鬆門檻都不到，呼叫端須過濾掉。
// aspect＝畫面高 ÷ 寬：正規化座標的 y 乘它才跟 x 同一把尺（尺度、距離、平滑的 y 速度、手勢的深度都用；track 與候選人也帶著它）。
export function buildDetection(landmarks, { cfg = DEFAULT_TRACKING_CONFIG, world = null, aspect }) {
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];
  if (![lShoulder, rShoulder, lHip, rHip].every(isFinitePoint)) return null;
  if (!hasHumanGeometry(landmarks, cfg, aspect)) return null;

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
  // scale＝「這個人在畫面上有多大」（所有位置門檻、平滑速度與手勢門檻的單位），見 bodyScaleOf；
  // 它跟「離攝影機多近」正相關，候選新身分多於空槽位時優先鎖定最靠近鏡頭的人。
  const scale = bodyScaleOf(landmarks, BODY_SCALE_TORSO_RATIO, aspect);

  // meanVisibility 給 dedupeDetections 在沒有既有 track 可對照時挑「比較可信的那一筆」用。
  // world＝同一筆偵測的 worldLandmarks（公尺、原點在兩髖中間），只給逐幀紀錄用
  return { landmarks, world, centroid, scale, aspect, meanVisibility, strictPlausible };
}

// 兩筆偵測／兩個 track／候選人的肩膀中點距離（y 乘 aspect，跟尺度同一把尺）。三種物件都有 centroid、scale、aspect 欄位，
// 所以下面這幾個函式對它們通用。
function centroidDistance(a, b) {
  return Math.hypot(a.centroid.x - b.centroid.x, (a.centroid.y - b.centroid.y) * a.aspect);
}

// 「同一具身體」的半徑：max(絕對值, 比例 × 較小的尺度)。拿不到尺度時退回純絕對值。
function sameBodyGate(a, b, cfg) {
  const w = Math.min(a.scale ?? 0, b.scale ?? 0);
  return Math.max(cfg.sameBodyDist, cfg.sameBodyRatio * (Number.isFinite(w) ? w : 0));
}

export function isSameBody(a, b, cfg = DEFAULT_TRACKING_CONFIG) {
  return centroidDistance(a, b) < sameBodyGate(a, b, cfg);
}

// 這筆偵測「延續既有 track」的程度：離最近的 anchor 幾個尺度（越小越像）。沒有 anchor 時
// 回傳 Infinity，排序時就只剩可見度在決定。
function continuityRank(det, anchors) {
  let best = Infinity;
  for (const a of anchors) {
    if (!a) continue;
    const scale = Math.max(a.scale ?? 0, 1e-3);
    best = Math.min(best, centroidDistance(a, det) / scale);
  }
  return best;
}

// 同一幀內，同一具身體只留一筆偵測（MediaPipe 對同一人多吐一組骨架時）。
// 留哪一筆不能「留陣列第一筆」：MediaPipe 多人模式的輸出順序是上一幀的追蹤框排前面、
// 這一幀重新偵測到的框 push 到尾端，於是真人常在尾端、靠 landmark 延續下來的幽靈在前面。
// 順位：①最能延續既有 track 的（離最近的 anchor 幾個尺度）②平均可見度較高的。
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

// 尺度＝max(肩寬, c × 軀幹長)，以畫面寬為單位：側身時肩寬縮到接近 0，軀幹長（肩膀中點到髖中點）不縮；髖部看不到時只用肩寬。
// 正規化座標的 x 以寬、y 以高為單位，y 先乘 aspect（＝高 ÷ 寬）：不換的話 16:9 畫面上直的軀幹長會多算 1.78 倍，正面站著的人尺度就變成肩寬的兩倍多。
// c＝0.6：正面時肩寬 ÷ 軀幹長，MediaPipe 官方範例人像量到 0.63、2026-10-29 三段逐幀紀錄量到 0.68～0.72，取略小的值讓正面時由肩寬決定（門檻維持原本以肩寬訂的意思）、
// 側身時約為正面肩寬的 0.95（量法：test/tools/pose-filter-eval.mjs 的 c）。
export const BODY_SCALE_TORSO_RATIO = 0.6;
const HIP_VISIBILITY_MIN = 0.5;

export function bodyScaleOf(landmarks, c, aspect) {
  const ls = landmarks[11], rs = landmarks[12], lh = landmarks[23], rh = landmarks[24];
  const shoulderWidth = Math.hypot(ls.x - rs.x, (ls.y - rs.y) * aspect);
  if (!((lh.visibility ?? 0) >= HIP_VISIBILITY_MIN && (rh.visibility ?? 0) >= HIP_VISIBILITY_MIN)) return shoulderWidth;
  const torso = Math.hypot((ls.x + rs.x - lh.x - rh.x) / 2, ((ls.y + rs.y - lh.y - rh.y) / 2) * aspect);
  return Math.max(shoulderWidth, c * torso);
}

// One Euro（Casiez, Roussel, Vogel, CHI 2012, DOI 10.1145/2207676.2208639），照 MediaPipe 的 one_euro_filter.cc：
// 速度＝(這一幀原始值 − 上一幀原始值) × valueScale ÷ dt，先以 dCutoff 低通；截止頻率＝minCutoff＋beta × |速度|；輸出＝以該截止頻率低通。
// 一階低通的輸出永遠落在上一個輸出與這一幀輸入之間，不會過衝；時間戳沒有變新時原樣回傳輸入、不改狀態（MediaPipe 同）。
// 每個節點依序過 ONE_EURO_STAGES 的每一層（10-28 的量測表在 docs/superpowers/subproject-1/2026-10-28-pose-filter-redesign.md）：
//   人數 1：MediaPipe 內建已先平滑一層（min_cutoff 0.05、beta 80，速度除以它的推論框尺度），我們再加 EXTRA 一層（內建之後靜止時手腕仍抖 0.5～1.4px）。
//     EXTRA 照作者的順序在 v3 舊紀錄上掃（beta 0 先定壓抖動的 minCutoff，再取最快動作延遲 ≤ 10ms 的最小 beta，同一把尺重掃 9.8ms）。
//   人數 ≥ 2：MediaPipe 不平滑；先用 MEDIAPIPE_EQUIVALENT 補上它那一層，再接同一個 EXTRA，兩種人數的骨架一樣穩、一樣跟手。
//     MediaPipe 的速度除以推論框尺度（pose_landmarks_detector_graph.cc 把下一幀的推論框接到平滑的 OBJECT_SCALE_ROI，(寬＋高) ÷ 2，像素），
//     我們除以 track.scale（肩寬），所以 beta＝80 ÷（推論框是幾個肩寬）。2026-10-28 實測（test/tools/mp-smoothing-scale/）：官方範例人像在無頭 Chromium 裡等速平移，
//     人數 2 的原始輸出過這一層、跟人數 1 的真平滑逐幀比，移動中的平均落後量在 6.2（15～240px/s）、6.5（10～30px/s）個肩寬時一致；取 6，偏差 < 0.07px。
//   2026-10-29 用 v6 紀錄（canon-2duet-visionlog-20261029-*，有真的靜止段）重掃：mc 0.5～8 × beta 5～40 的抖動、延遲都在目標內，mc 2、beta 20 不換；
//     EXTRA 改用 2D 合成速度（speed2d，見 OneEuroFilter2D）：x、y 各算各時谷底比原始晚一幀的觸發超過一成（時刻差 p90 48ms），2D 降到 32ms 以內、靜止抖動多不到 0.03px。
//     MediaPipe 等效層照 MediaPipe 各算各。量測表在 docs/superpowers/subproject-1/2026-10-28-subproject1-review.md 6.9。
const MP_ROI_SHOULDERS = 6;
const MEDIAPIPE_EQUIVALENT = Object.freeze({ minCutoff: 0.05, beta: 80 / MP_ROI_SHOULDERS, dCutoff: 1 });
const EXTRA = Object.freeze({ minCutoff: 2, beta: 20, dCutoff: 1, speed2d: true });
export const ONE_EURO_STAGES = Object.freeze({
  single: Object.freeze([EXTRA]),
  multi: Object.freeze([MEDIAPIPE_EQUIVALENT, EXTRA]),
});

// MediaPipe 人數 1 時先把每個節點的可見度低通一次（pose_landmarks_detector_graph.cc 的 SmoothLandmarksVisibility，low_pass_filter_alpha 0.1），人數 ≥ 2 沒有；
// 追蹤層在人數 ≥ 2 時補上同一次低通，再做自己的 EMA 與遲滯（visibilityEmaAlpha），兩種人數的節點一樣不閃
const MEDIAPIPE_VISIBILITY_ALPHA = 0.1;

const oneEuroAlpha = (cutoff, dtS) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dtS));

export class OneEuroFilter {
  constructor({ minCutoff, beta, dCutoff }) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  filter(x, tMs, valueScale) {
    if (this.lastT !== null && tMs <= this.lastT) return x;
    if (this.lastRaw === null) {
      this.lastRaw = x; this.out = x; this.dx = 0; this.lastT = tMs;
      return x;
    }
    const dtS = (tMs - this.lastT) / 1000;
    this.dx += oneEuroAlpha(this.dCutoff, dtS) * ((x - this.lastRaw) * valueScale / dtS - this.dx);
    this.out += oneEuroAlpha(this.minCutoff + this.beta * Math.abs(this.dx), dtS) * (x - this.out);
    this.lastRaw = x;
    this.lastT = tMs;
    return this.out;
  }
  reset() {
    this.lastRaw = null;
    this.out = null;
    this.dx = 0;
    this.lastT = null;
  }
}

// 同一個 One Euro，但 x、y 共用一個截止頻率：速度＝√(dx̂² + dŷ²)（兩軸的速度各自先以 dCutoff 低通），斜著揮時兩軸一起放開，不會一軸先到谷底、另一軸還在拖。
// y 不動時跟 1D 逐幀相同。這是我們的改法，不是 MediaPipe 的（它各軸各算）。
export class OneEuroFilter2D {
  constructor({ minCutoff, beta, dCutoff }) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.lastRaw = null;
    this.out = null;
    this.dx = 0;
    this.dy = 0;
    this.lastT = null;
  }
  filter(p, tMs, vsX, vsY) {
    if (this.lastT !== null && tMs <= this.lastT) return p;
    if (this.lastRaw === null) {
      this.lastRaw = p; this.out = { x: p.x, y: p.y }; this.lastT = tMs;
      return this.out;
    }
    const dtS = (tMs - this.lastT) / 1000, ad = oneEuroAlpha(this.dCutoff, dtS);
    this.dx += ad * ((p.x - this.lastRaw.x) * vsX / dtS - this.dx);
    this.dy += ad * ((p.y - this.lastRaw.y) * vsY / dtS - this.dy);
    const a = oneEuroAlpha(this.minCutoff + this.beta * Math.hypot(this.dx, this.dy), dtS);
    this.out = { x: this.out.x + a * (p.x - this.out.x), y: this.out.y + a * (p.y - this.out.y) };
    this.lastRaw = p;
    this.lastT = tMs;
    return this.out;
  }
}

// PersonTracker：多人 ID 鎖定狀態機（固定 maxUsers 個槽位，ID 恆等於槽位編號 1~maxUsers）。
export class PersonTracker {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_TRACKING_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.tracks = new Array(this.cfg.maxUsers).fill(null);
    this.pending = []; // 候選新目標，尚未持續出現足夠時間
    this.events = [];  // 鎖定／釋放的紀錄（開發用）：vision.js 每幀 drainEvents() 取走，給 __visionLog 匯出，查「多出來的 ID 是怎麼被鎖進去的」
  }

  hardReset() { this.reset(); }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  _logEvent(nowMs, type, slot, extra) {
    this.events.push({ t: Math.round(nowMs), type, slot: slot + 1, ...extra });
  }

  // 對外 API：回傳「這一幀真的偵測到的人」，語意跟 getActiveTracks() 一致，只是欄位精簡過。
  getTrackedUsers() {
    return this.getActiveTracks().map((t) => ({ id: t.id, slot: t.slot, landmarks: t.smoothed }));
  }

  // 給手勢與在場名單用：回傳「這一幀真的有比對到偵測」的 track（missCount === 0）。人消失後槽位在 trackLossMs 緩衝期內仍佔著（短暫漏偵測不立刻釋放），
  // 但緩衝期間畫面不該還畫著停在原地的骨架——緩衝期純粹是內部的槽位保留機制。
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

  // 到最近的另一個「上一幀有配對到」的槽位的肩膀中點距離；沒有這種鄰居時是 Infinity。只算上一幀確實有人的槽位（update() 算成本時 missCount 還沒遞增）：
  // 漏配中的槽位的人可能已經走掉，拿它的舊位置去收斂鄰居的門檻，會讓一個人一離場就把旁邊的人卡到動彈不得。
  _nearestOtherTrackDist(track) {
    let best = Infinity;
    for (const other of this.tracks) {
      if (!other || other === track || other.missCount > 0) continue;
      best = Math.min(best, centroidDistance(track, other));
    }
    return best;
  }

  // 「這筆偵測貼上這個槽位的 ID」的成本；Infinity＝不允許。門檻三層：基本門檻 → 漏配緩衝期放寬 → 依最近鄰居收斂（見 DEFAULT_TRACKING_CONFIG 的「逐幀配對」）。
  // 純粹依位置判斷，不看顏色；比對上一次的實際位置、不做速度外插——外插會把單幀雜訊往錯誤方向多推一截。
  _trackDetectionCost(track, det, nowMs) {
    const { gatePos, gatePosRatio, graceGate, graceGateRatio,
            ambiguityRatio, ambiguityFloorRatio, missGraceMs } = this.cfg;

    let gate = Math.max(gatePos, gatePosRatio * track.scale);
    const inGraceWindow = track.missCount > 0 && (nowMs - track.lastSeenMs) <= missGraceMs;
    if (inGraceWindow) {
      gate = Math.max(gate, graceGate, graceGateRatio * track.scale);
    }
    // 歧義收斂：門檻不得超過到最近鄰居距離的一半（單人時鄰居距離是 Infinity，等於不收斂），
    // 但保留 ambiguityFloorRatio × 尺度給真人一幀內的正常位移。
    gate = Math.max(
      Math.min(gate, ambiguityRatio * this._nearestOtherTrackDist(track)),
      ambiguityFloorRatio * track.scale);

    const posDist = centroidDistance(track, det);
    if (posDist > gate) return Infinity;
    return posDist / gate;
  }

  // 幫剛確認鎖定的新候選人挑槽位：ID 只是顯示提示，不做身分認回，直接給任一個空槽位
  _resolveSlotForNewIdentity() {
    const freeSlot = this.tracks.findIndex((t) => t === null);
    return freeSlot;
  }

  _createTrack(slot, det, nowMs) {
    const n = det.landmarks.length;
    // 人數 1 時 MediaPipe 已先平滑過一層，人數 ≥ 2 時沒有（參考文件第 6 點），兩邊各一串（ONE_EURO_STAGES）
    const stages = this.cfg.maxUsers === 1 ? ONE_EURO_STAGES.single : ONE_EURO_STAGES.multi;
    const track = {
      slot,
      id: slot + 1, // ID 恆等於槽位編號（1~maxUsers），純粹是顯示提示，不做身分認回
      centroid: { ...det.centroid },
      // 這個人在畫面上的尺度（bodyScaleOf），位置門檻、平滑的速度與手勢門檻都以它為單位；在 _updateTrack 裡以 EMA 更新。
      scale: det.scale,
      aspect: det.aspect,
      lockedAtMs: nowMs,     // 鎖定時刻；兩個槽位落在同一具身體上時，用它決定誰比較新
      duplicateSinceMs: 0,   // 與另一個槽位重疊的起算時刻（0 ＝ 目前沒有重疊）
      // 只濾 x／y：整個專案沒有任何地方讀 z。每個節點一串，每層是一個 OneEuroFilter2D（speed2d）或 x、y 各一個 OneEuroFilter
      filters: Array.from({ length: n }, () => stages.map((s) => (s.speed2d ? new OneEuroFilter2D(s) : { x: new OneEuroFilter(s), y: new OneEuroFilter(s) }))),
      // 人數 ≥ 2 才有：補上 MediaPipe 單人時對可見度做的那一次低通（見 MEDIAPIPE_VISIBILITY_ALPHA）的狀態，每個節點一個
      visLowPass: this.cfg.maxUsers === 1 ? null : det.landmarks.map((p) => p.visibility ?? 1),
      smoothed: det.landmarks.map((p) => ({ ...p })),
      missCount: 0,       // 0 ＝這一幀真的匹配到偵測（getActiveTracks 據此決定是否繪製）
      lastSeenMs: nowMs   // 最後一次匹配到的時間；釋放槽位與漏配寬限期都以此為準
    };
    this._updateTrack(track, det, nowMs);
    return track;
  }

  _updateTrack(track, det, nowMs) {
    const { visibilityEmaAlpha, visibilityOnGate, visibilityOffGate,
            scaleEmaAlpha } = this.cfg;
    track.missCount = 0;
    track.lastSeenMs = nowMs;
    track.centroid = det.centroid;
    track.aspect = det.aspect;
    track.raw = det.landmarks;  // 這一幀沒平滑的原始 landmark（開發用的逐幀紀錄讀它）
    track.rawWorld = det.world;
    track.scale += (det.scale - track.scale) * scaleEmaAlpha;
    // One Euro 的速度以「這個人的尺度／秒」計，遠近一致；y 的位移先乘 aspect 換成跟 x 同一把尺（MediaPipe 平滑前也先換成像素）
    const vsX = 1 / track.scale, vsY = det.aspect / track.scale;
    const chain = (layers, p) => {
      for (const l of layers) p = l instanceof OneEuroFilter2D ? l.filter(p, nowMs, vsX, vsY) : { x: l.x.filter(p.x, nowMs, vsX), y: l.y.filter(p.y, nowMs, vsY) };
      return p;
    };

    // 上一幀的結果當作可見度 EMA 與遲滯的狀態來源（第一幀 prev 是 _createTrack 複製的原始 landmarks，沒有 visible 欄位，退回用 onGate 判定初始狀態）
    const prev = track.smoothed, lowPass = track.visLowPass;
    track.smoothed = det.landmarks.map((p, i) => {
      let rawVis = p.visibility ?? 1;
      if (lowPass) rawVis = lowPass[i] += (rawVis - lowPass[i]) * MEDIAPIPE_VISIBILITY_ALPHA;
      const prevVis = prev[i]?.visibility ?? rawVis;
      const visibility = prevVis + (rawVis - prevVis) * visibilityEmaAlpha;
      const wasVisible = prev[i]?.visible ?? (visibility >= visibilityOnGate);
      const { x, y } = chain(track.filters[i], { x: p.x, y: p.y });
      return {
        x,
        y,
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
      // 這一幀沒被貪婪匹配選中的偵測，仍可能是已鎖定的某人的第二組骨架（幽靈）。不擋的話它會被當成「不明新人」持續累積，滿 lockConfirmMs 後鎖進另一個空槽，同一個真人同時冒出兩個 ID。
      // 判準就是 isSameBody（肩膀中點 < 半個肩寬），跟 dedupe、硬保險三處同一道；只擋這麼窄是刻意的——差超過半個肩寬的就當第二個人。
      if (this.tracks.some((t) => t && isSameBody(t, d, this.cfg))) return;
      // 鎖定新 ID 要用嚴格的可見度門檻；寬鬆門檻是留給「已經在追蹤的人」的（見 buildDetection）。
      if (!d.strictPlausible) return;
      unmatched.push(d);
    });

    const usedPending = new Set();
    const nextPending = [];

    for (const det of unmatched) {
      let bestIdx = -1, bestDist = Infinity;
      const assocDist = Math.max(pendingAssocDist, pendingAssocDistRatio * det.scale);
      this.pending.forEach((p, pi) => {
        if (usedPending.has(pi)) return;
        const dist = centroidDistance(p, det);
        if (dist < assocDist && dist < bestDist) { bestDist = dist; bestIdx = pi; }
      });

      if (bestIdx >= 0) {
        usedPending.add(bestIdx);
        const p = this.pending[bestIdx];
        p.centroid = det.centroid;
        p.aspect = det.aspect;
        p.det = det;
        p.lastSeenMs = nowMs;
        p.matchedThisFrame = true;
        nextPending.push(p);
      } else {
        nextPending.push({
          centroid: det.centroid,
          aspect: det.aspect,
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

    // 候選人數可能多於空槽位：優先鎖定尺度較大（離攝影機較近）的人，避免背景／邊緣的路人搶走鏡頭前主要使用者的槽位；沒搶到的候選人不丟棄，下一幀繼續排序。
    // 兩個條件都要滿足才可鎖定：①累積出現時間夠久 ②這一幀確實有匹配到偵測（寬限期會讓短暫漏配的候選人留在名單裡，不檢查的話已走出畫面的候選人會拿著過期的 det 鎖進槽位）。
    const ready = nextPending.filter(
      (p) => p.matchedThisFrame && nowMs - p.firstSeenMs >= this.cfg.lockConfirmMs);
    ready.sort((a, b) => b.det.scale - a.det.scale);

    for (const p of ready) {
      const slot = this._resolveSlotForNewIdentity();
      if (slot === -1) continue; // 這幀空槽位已被更靠近鏡頭的候選人用完，留著下一幀再排隊
      this.tracks[slot] = this._createTrack(slot, p.det, nowMs);
      this._logEvent(nowMs, 'lock', slot, { scale: round3(p.det.scale), vis: round3(p.det.meanVisibility), strict: p.det.strictPlausible });
      p.isLocked = true; // 已鎖定，下方過濾掉
    }

    this.pending = nextPending.filter((p) => !p.isLocked);
  }

  // 「一具身體只能有一個 ID」的最後一道硬保險：dedupe 與候選人抑制應已擋掉幽靈，這裡收萬一漏網的——兩個 live 槽位的肩膀中點落在同一具身體的半徑內（isSameBody）
  // 連續 duplicateTrackConfirmMs 就釋放較晚鎖定的那個。
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
      this._logEvent(nowMs, 'duplicate', track.slot);
    }
  }

  // 每幀：把目前鎖定槽位與這一幀的偵測結果做最佳匹配（貪婪法，槽位數少故足夠）。傳進來的是 buildDetection 的結果（可以還沒 dedupe）：同一具身體的重複偵測在這裡用目前槽位當 anchor 挑該留哪一筆。
  update(rawDetections, nowMs) {
    const detections = dedupeDetections(rawDetections, this.cfg, this.tracks);
    const usedDetIdx = new Set();
    const usedSlot = new Set();
    const candidates = [];

    this.tracks.forEach((track, slot) => {
      if (!track) return;
      // 跟一個先鎖定的槽位是同一具身體（偏離肩膀的幽靈曾被鎖成 ID、又疊回真人）就讓它先挑：只比成本的話，偵測離後鎖那個的舊位置比較近就被它搶走，真人換成幽靈的 ID；而後鎖那個在漏配時不算 live，硬保險也收不到
      const yields = this.tracks.some((o) => o && o.lockedAtMs < track.lockedAtMs && isSameBody(o, track, this.cfg));
      detections.forEach((det, di) => {
        const cost = this._trackDetectionCost(track, det, nowMs);
        if (cost !== Infinity) candidates.push({ slot, di, cost, yields });
      });
    });
    candidates.sort((a, b) => (a.yields - b.yields) || (a.cost - b.cost));

    for (const { slot, di } of candidates) {
      if (usedSlot.has(slot) || usedDetIdx.has(di)) continue;
      usedSlot.add(slot);
      usedDetIdx.add(di);
      this._updateTrack(this.tracks[slot], detections[di], nowMs);
    }

    this.tracks.forEach((track, slot) => {
      if (!track || usedSlot.has(slot)) return;
      track.missCount++; // missCount === 0 是「這一幀真的有人」的判準（見 getActiveTracks）
      if (nowMs - track.lastSeenMs > this.cfg.trackLossMs) {
        this.tracks[slot] = null;
        this._logEvent(nowMs, 'loss', slot);
      }
    });

    this._releaseDuplicateTracks(nowMs);
    this._updatePendingCandidates(detections, usedDetIdx, nowMs);
  }
}
