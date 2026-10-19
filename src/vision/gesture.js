// gesture.js — 手勢：單手拋物線偵測（ArcDetector）、雙手合成與慣用手鎖定、各槽位的手勢狀態（updateGestures）。純離散觸發訊號，不輸出音量、不管速度。
// 門檻以肩寬為距離單位、毫秒為時間單位，站遠站近、30fps 或 60fps 結果一致。

export const DEFAULT_ARC_CONFIG = Object.freeze({
  minShoulderWidth: 0.04,   // 肩寬的下限，避免遠處偵測到的極小肩寬把比值放大到離譜
  staleMs: 320,             // 距上一次餵值超過這麼久 → 視為剛回到鏡頭，這一段動作作廢重來
  reversalNoiseFloor: 0.05, // Y 方向死區（肩寬單位）：從谷底回升要超過這個幅度才算「確認回升」
  // 這兩個門檻比較嚴：每次判定成立都立刻前進一步、沒有緩衝空間，調嚴降低誤觸發
  minDepthRatio: 0.15,      // 這段下沉至少要多深（肩寬單位）才算一次有效拋物線
  minXSpanRatio: 0.18,      // 下沉期間至少要有這麼多橫向位移（肩寬單位），用來跟「純上下抖」區分開
});

/**
 * 拋物線手勢：手同時有橫向位移＋垂直先下沉（image y 變大）再回升；不看肩膀高度、不限開口大小與左右方向，只認這個相對形狀。
 * 單一狀態機逐幀更新起點 peak（Y 最小值）與最低點 trough（Y 最大值）：
 *  - Y 持續變大：延伸 trough，累積下沉期間的橫向位移範圍。
 *  - Y 從 trough 回升超過死區（確認反轉）：下沉結束，深度與橫向位移都達標就 triggerSeq +1；不論達不達標都以目前位置當新起點。
 *  - 手不在畫面：中斷追蹤，等手回來重新認一次。
 */
export class ArcDetector {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_ARC_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.peakY = null;          // 這一段動作目前的起點高度（Y 最小值）
    this.troughY = null;        // 這一段動作目前已知的最低點（Y 最大值）
    this._minX = null;          // 下沉期間橫向位移範圍（用來跟「純上下抖」區分）
    this._maxX = null;
    this.triggerSeq = 0;        // 每次有效拋物線的谷底事件 +1
    this._lastMs = null;
  }

  /**
   * 餵一幀資料。
   * @param {{point:{x,y}|null, shoulderWidth?:number}} frame  point＝手掌／手腕的合併座標
   * @param {number} nowMs
   * @returns {{triggerSeq:number}}
   */
  update(frame, nowMs) {
    const { point } = frame || {};
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      this.peakY = this.troughY = null;
      this._lastMs = null;
      return { triggerSeq: this.triggerSeq };
    }

    if (this._lastMs != null && nowMs - this._lastMs > this.cfg.staleMs) this.reset();
    this._lastMs = nowMs;

    const sw = Math.max(this.cfg.minShoulderWidth, frame.shoulderWidth || 0);
    const { x, y } = point;

    if (this.peakY === null) {
      this.peakY = y; this.troughY = y;
      this._minX = x; this._maxX = x;
      return { triggerSeq: this.triggerSeq };
    }

    if (y >= this.troughY) {
      this.troughY = y;
      if (x < this._minX) this._minX = x;
      if (x > this._maxX) this._maxX = x;
    } else if (y < this.troughY - this.cfg.reversalNoiseFloor * sw) {
      const depth = this.troughY - this.peakY;
      const xSpan = this._maxX - this._minX;
      if (depth >= this.cfg.minDepthRatio * sw && xSpan >= this.cfg.minXSpanRatio * sw) {
        this.triggerSeq++;
      }
      this.peakY = y; this.troughY = y;
      this._minX = x; this._maxX = x;
    } else {
      // 起點跟著更高的位置走，避免小雜訊被算進之後的深度
      if (y < this.peakY) this.peakY = y;
    }

    return { triggerSeq: this.triggerSeq };
  }
}

// MediaPipe Pose 的地標索引；手勢追蹤與骨架繪製（vision.js）共用。
export const MP_LEFT_WRIST = 15, MP_RIGHT_WRIST = 16;
export const MP_LEFT_ELBOW = 13, MP_RIGHT_ELBOW = 14;
export const MP_LEFT_SHOULDER = 11, MP_RIGHT_SHOULDER = 12;
// 手掌點（拇指／食指／小指）：跟手腕平均成「手掌＋手腕合併」的單一座標，手勢追蹤與骨架繪製的大點共用。
export const MP_LEFT_HAND = [17, 19, 21], MP_RIGHT_HAND = [18, 20, 22];

// 手腕＋手掌平均起來的合併座標；手腕本身不可見就視為這隻手不在畫面。
export function mergedHandPoint(sm, wristIdx, handIdxs) {
  const wrist = sm[wristIdx];
  if (!wrist.visible) return null;
  let sx = wrist.x, sy = wrist.y, n = 1;
  for (const i of handIdxs) {
    const p = sm[i];
    if (p.visible) { sx += p.x; sy += p.y; n++; }
  }
  return { x: sx / n, y: sy / n };
}

// 慣用手鎖定的放開條件：HAND_LOCK_RELEASE_MS 是保險絲（停頓幾秒是正常演奏節奏，所以放寬）；真正負責換手的是 HAND_STILL_*：
// 鎖定的手連續待在小範圍內就視為靜止——MediaPipe 對被遮擋的手常猜一個可見度還過得去的位置，光調可見度遲滯沒用。
const HAND_LOCK_RELEASE_MS = 8000;
// 肩寬單位，小於 minDepthRatio(0.15)：真正的拋物線手勢一定會讓手離開這個半徑，不會誤放開正在使用的手。
const HAND_STILL_RADIUS = 0.10;
const HAND_STILL_MS = 700;       // 連續待在半徑內這麼久才放開鎖定
const SLOT_RELEASE_MS = 1000;    // 槽位連續不在場這麼久才把偵測器整個 reset

// 各槽位（＝演奏者 ID − 1）的狀態在第一次用到時才建立（ensureSlot），這裡不必知道槽位上限。
const arcDetectors = [];
// 合成雙手要比對「上一幀各手的 triggerSeq」：ArcDetector 的 triggerSeq 是累加值，不是「這一幀有沒有觸發」的旗標。
const arcLastSeqBySlot = [];
// 槽位沒有 active track 時的「不在場起算時刻」（0＝在場）；在 SLOT_RELEASE_MS 之前只餵 null 讓追蹤中斷，避免閃斷一兩幀就丟掉進行中的動作。
const slotInactiveSinceMs = [];
function ensureSlot(slot) {
  if (arcDetectors[slot]) return;
  arcDetectors[slot] = { left: new ArcDetector(), right: new ArcDetector() };
  arcLastSeqBySlot[slot] = {
    left: 0, right: 0, combinedSeq: 0, lockedHand: null, lastTriggerMs: undefined,
    stillAnchor: null, stillSinceMs: undefined,
  };
  slotInactiveSinceMs[slot] = 0;
}
// combinedSeq 刻意不歸零：接收端靠它「有沒有變」判斷新觸發，歸零會讓下一次比對誤判成新事件、平白多彈一個音；它單調遞增、永不重置。
const resetSlotDetectors = (arcSlot, lastSeq) => {
  arcSlot.left.reset(); arcSlot.right.reset();
  lastSeq.left = 0; lastSeq.right = 0;
  lastSeq.lockedHand = null; lastSeq.lastTriggerMs = undefined;
  lastSeq.stillAnchor = null; lastSeq.stillSinceMs = undefined;
};
const resetAllSlotDetectors = () => {
  for (let slot = 0; slot < arcDetectors.length; slot++) {
    resetSlotDetectors(arcDetectors[slot], arcLastSeqBySlot[slot]);
  }
};

// 餵一個在場槽位的骨架給它那對 ArcDetector；回傳可見度、座標與肩寬，供 combineArcTriggers() 判斷鎖定的手該不該放開。
function updateSlotArc(arcDet, track, nowMs) {
  const sm = track.smoothed;
  const ls = sm[MP_LEFT_SHOULDER], rs = sm[MP_RIGHT_SHOULDER];
  const shoulderWidth = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  const leftPoint = mergedHandPoint(sm, MP_LEFT_WRIST, MP_LEFT_HAND);
  const rightPoint = mergedHandPoint(sm, MP_RIGHT_WRIST, MP_RIGHT_HAND);
  return {
    left: arcDet.left.update({ point: leftPoint, shoulderWidth }, nowMs),
    right: arcDet.right.update({ point: rightPoint, shoulderWidth }, nowMs),
    leftVisible: !!leftPoint,
    rightVisible: !!rightPoint,
    leftPoint, rightPoint, shoulderWidth,
  };
}

// 合成雙手結果並「自動鎖定慣用手」：哪隻手先做出有效拋物線就鎖定它、之後只認那隻手——避免閒置手被模型猜出位置、在畫面上飄移湊出假拋物線而誤觸發。
// 放開條件：鎖定的手不可見、HAND_LOCK_RELEASE_MS 沒有新觸發、或 HAND_STILL_MS 幾乎沒在動。state 就是 arcLastSeqBySlot[slot]，逐幀被直接改動。
function combineArcTriggers(state, arc, nowMs) {
  const { left, right, leftVisible, rightVisible, leftPoint, rightPoint, shoulderWidth } = arc;

  if (state.lockedHand === "left" && !leftVisible) state.lockedHand = null;
  if (state.lockedHand === "right" && !rightVisible) state.lockedHand = null;
  if (state.lockedHand && nowMs - (state.lastTriggerMs ?? nowMs) > HAND_LOCK_RELEASE_MS) {
    state.lockedHand = null;
  }

  if (state.lockedHand) {
    const point = state.lockedHand === "left" ? leftPoint : rightPoint;
    const radius = HAND_STILL_RADIUS * Math.max(shoulderWidth || 0, 0.04);
    const dist = point && state.stillAnchor ? Math.hypot(point.x - state.stillAnchor.x, point.y - state.stillAnchor.y) : Infinity;
    if (dist > radius) {
      state.stillAnchor = point;
      state.stillSinceMs = nowMs;
    } else if (nowMs - state.stillSinceMs > HAND_STILL_MS) {
      state.lockedHand = null;
    }
  } else {
    state.stillAnchor = null;
  }

  // 只認增加：ArcDetector 停滯（超過 staleMs 沒餵值）重設時 triggerSeq 會歸零，用 !== 會把歸零當成一次新揮手
  const leftChanged = left.triggerSeq > state.left;
  const rightChanged = right.triggerSeq > state.right;
  state.left = left.triggerSeq;
  state.right = right.triggerSeq;

  if (!state.lockedHand) {
    if (leftChanged) state.lockedHand = "left";
    else if (rightChanged) state.lockedHand = "right";
  }

  const triggered = (state.lockedHand === "left" && leftChanged)
    || (state.lockedHand === "right" && rightChanged);
  if (triggered) {
    state.lastTriggerMs = nowMs;
    state.combinedSeq = (state.combinedSeq || 0) + 1;
  }
  return { triggerSeq: state.combinedSeq || 0 };
}

/**
 * 一幀的手勢：每個槽位（＝演奏者 ID）左右手各一個 ArcDetector，回傳每個槽位的拋物線觸發累加計數與這一幀真的在場的槽位。
 * @param {{slot: number, smoothed: object[]}[]} activeTracks  追蹤層這一幀的在場名單（tracker.getActiveTracks()）
 * @param {number} slotCount  追蹤器目前的槽位數（＝現場人數）；送出去的 map 只帶這麼多個槽位
 * @param {number} nowMs
 * @returns {{ arcTriggerSeqBySlot: Object<number, number>, presentSlots: number[] }}
 */
export function updateGestures(activeTracks, slotCount, nowMs) {
  const arcTriggerSeqBySlot = {};
  const presentSlots = [];
  // 攤成「槽位 → track」查表；只處理 slotCount 個槽位，送出去的 map 不該帶永遠是空的槽位
  const trackBySlot = new Array(slotCount).fill(null);
  for (const t of activeTracks) trackBySlot[t.slot] = t;

  for (let slot = 0; slot < slotCount; slot++) {
    ensureSlot(slot);
    const track = trackBySlot[slot];
    const arcDet = arcDetectors[slot];
    let arc;
    if (track) {
      slotInactiveSinceMs[slot] = 0;
      presentSlots.push(slot + 1);
      arc = updateSlotArc(arcDet, track, nowMs);
    } else {
      // 不在場：兩隻手都餵「看不到」讓追蹤中斷；連續超過 SLOT_RELEASE_MS 才真的 reset（下次鎖進來從乾淨開始）。
      if (slotInactiveSinceMs[slot] === 0) slotInactiveSinceMs[slot] = nowMs;
      if (nowMs - slotInactiveSinceMs[slot] > SLOT_RELEASE_MS) {
        resetSlotDetectors(arcDet, arcLastSeqBySlot[slot]);
        arc = { left: { triggerSeq: 0 }, right: { triggerSeq: 0 }, leftVisible: false, rightVisible: false };
      } else {
        arc = {
          left: arcDet.left.update({ point: null }, nowMs),
          right: arcDet.right.update({ point: null }, nowMs),
          leftVisible: false,
          rightVisible: false,
        };
      }
    }
    const combinedArc = combineArcTriggers(arcLastSeqBySlot[slot], arc, nowMs);
    arcTriggerSeqBySlot[slot + 1] = combinedArc.triggerSeq;
  }
  return { arcTriggerSeqBySlot, presentSlots };
}

// 所有槽位的手勢狀態歸位；combinedSeq 不歸零（見 resetSlotDetectors）。
export function resetGestures() {
  resetAllSlotDetectors();
  slotInactiveSinceMs.fill(0);
}

// 這個槽位目前鎖定的手（'left'｜'right'｜null）；骨架繪製只畫鎖定的那隻手。
export const lockedHandOf = (slot) => arcLastSeqBySlot[slot]?.lockedHand ?? null;
