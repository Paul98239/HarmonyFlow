// gesture.js — 手勢：單手拋物線偵測（ArcDetector）、雙手合成（兩手各自判、同一下只算一次）、各槽位的手勢狀態（updateGestures）。純離散觸發訊號，不輸出音量、不管速度。
// 門檻以這個人的尺度（tracking.js 的 track.scale，正面時約等於肩寬）為距離單位、毫秒為時間單位，站遠站近、30fps 或 60fps 結果一致。
// 揮手現在先只看手腕；其他節點都在 track.smoothed 裡、經過同一套平滑，之後偵測別的動作時直接讀。

export const DEFAULT_ARC_CONFIG = Object.freeze({
  minScale: 0.04,           // 尺度的下限，避免遠處偵測到的極小尺度把比值放大到離譜
  staleMs: 320,             // 距上一次餵值超過這麼久 → 視為剛回到鏡頭，這一段動作作廢重來
  // 深度與死區：y 差先乘 aspect 再除以尺度。這兩個值原本（0.05、0.15）是在「y 以畫面高為單位、尺度以畫面寬為單位」的混合單位下訂的，
  // 2026-10-28 換成同一把尺時乘上 16:9 的 0.5625，16:9 下觸發不變
  reversalNoiseFloor: 0.028, // Y 方向死區（尺度單位）：從谷底回升要超過這個幅度才算「確認回升」
  // 這兩個門檻比較嚴：每次判定成立都立刻前進一步、沒有緩衝空間，調嚴降低誤觸發
  minDepthRatio: 0.084,      // 這段下沉至少要多深（尺度單位）才算一次有效拋物線
  minXSpanRatio: 0.18,      // 下沉期間至少要有這麼多橫向位移（尺度單位），用來跟「純上下抖」區分開
  // 確認那一幀的 y 上限（畫面下緣＝1）：手放到畫面外時模型仍會推估位置，往上飄一點就湊出假拋物線；0.05 的邊界留給谷底剛擦過下緣的真揮手。暫定值（2026-10-20 兩份遮手紀錄）
  maxConfirmY: 1.05,
  // 一次揮手只算一下（修正設計 §3.3）：觸發之後手要回升到「這次谷底往上 rearmRiseRatio × 這次深度」以上，下一次觸發才算；三份逐幀紀錄訂的（修正設計第 5 節）
  rearmRiseRatio: 0.5,
});

/**
 * 拋物線手勢：手同時有橫向位移＋垂直先下沉（image y 變大）再回升；不看肩膀高度、不限開口大小與左右方向，只認這個相對形狀。
 * 單一狀態機逐幀更新起點 peak（Y 最小值）與最低點 trough（Y 最大值）：
 *  - Y 持續變大：延伸 trough，累積下沉期間的橫向位移範圍。
 *  - Y 從 trough 回升超過死區（確認反轉）：下沉結束，深度與橫向位移都達標、確認這一幀手還在畫面裡（y ≤ maxConfirmY）、而且已經上膛就 triggerSeq +1；不論達不達標都以目前位置當新起點。
 *  - 上膛：觸發後要先回升過上膛線（rearmRiseRatio）才能再觸發；沒上膛時形狀照樣追蹤，只是不觸發。
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
    this.rearmY = null;         // 上一次觸發後要回升到的高度（y ≤ 它才上膛）；null＝已上膛
    this.troughMs = null;       // 目前最低點那一幀被拍下的時刻
    this.lastTriggerTroughMs = null;   // 最近一次觸發的最低點時刻：揮手的「動作時刻」（排程器估速、比先後用）
    this._lastMs = null;
  }

  /**
   * 餵一幀資料。
   * @param {{point:{x,y}|null, scale?:number, aspect:number}} frame  point＝手腕座標，scale＝這個人的尺度，aspect＝畫面高 ÷ 寬（y 差乘它才跟尺度同一把尺）
   * @param {number} nowMs  處理這一幀的時刻（停滯判斷用）
   * @param {number} [captureMs]  這一幀被攝影機拍下的時刻（記最低點用；沒有就是 nowMs）
   * @returns {{triggerSeq:number, troughMs:number|null}} troughMs＝最近一次觸發的最低點時刻
   */
  update(frame, nowMs, captureMs = nowMs) {
    const { point } = frame || {};
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      this.peakY = this.troughY = null;
      this._lastMs = null;
      return { triggerSeq: this.triggerSeq, troughMs: this.lastTriggerTroughMs };
    }

    if (this._lastMs != null && nowMs - this._lastMs > this.cfg.staleMs) this.reset();
    this._lastMs = nowMs;

    const sw = Math.max(this.cfg.minScale, frame.scale || 0);
    const { aspect } = frame;
    const { x, y } = point;

    if (this.peakY === null) {
      this.peakY = y; this.troughY = y; this.troughMs = captureMs;
      this._minX = x; this._maxX = x;
      return { triggerSeq: this.triggerSeq, troughMs: this.lastTriggerTroughMs };
    }

    if (this.rearmY !== null && y <= this.rearmY) this.rearmY = null;

    if (y >= this.troughY) {
      this.troughY = y;
      this.troughMs = captureMs;
      if (x < this._minX) this._minX = x;
      if (x > this._maxX) this._maxX = x;
    } else if ((this.troughY - y) * aspect > this.cfg.reversalNoiseFloor * sw) {
      const depth = (this.troughY - this.peakY) * aspect;
      const xSpan = this._maxX - this._minX;
      if (this.rearmY === null && depth >= this.cfg.minDepthRatio * sw && xSpan >= this.cfg.minXSpanRatio * sw && y <= this.cfg.maxConfirmY) {
        this.triggerSeq++;
        this.lastTriggerTroughMs = this.troughMs;
        this.rearmY = this.troughY - this.cfg.rearmRiseRatio * (this.troughY - this.peakY);
      }
      this.peakY = y; this.troughY = y; this.troughMs = captureMs;
      this._minX = x; this._maxX = x;
    } else {
      // 起點跟著更高的位置走，避免小雜訊被算進之後的深度
      if (y < this.peakY) this.peakY = y;
    }

    return { triggerSeq: this.triggerSeq, troughMs: this.lastTriggerTroughMs };
  }
}

// MediaPipe Pose 的地標索引；手勢追蹤與骨架繪製（vision.js）共用。
export const MP_LEFT_WRIST = 15, MP_RIGHT_WRIST = 16;
export const MP_LEFT_ELBOW = 13, MP_RIGHT_ELBOW = 14;
export const MP_LEFT_SHOULDER = 11, MP_RIGHT_SHOULDER = 12;

// 揮手吃的點：手腕；不可見就視為這隻手不在畫面。
const wristPoint = (sm, idx) => (sm[idx].visible ? { x: sm[idx].x, y: sm[idx].y } : null);

// 同一個人另一隻手的谷底跟上一次算數的觸發相差不到這麼久，算同一下（兩手一起揮）。2026-10-29 三段紀錄：一起揮的時間差 49／53 下 ≤ 143ms；
// 輪流揮除了換手那一刻（兩手都在動）都 ≥ 240ms，150～240ms 之間沒有任何一下（報告 6.9）
const TWO_HAND_MERGE_MS = 200;
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
    left: 0, right: 0, combinedSeq: 0,
    lastHand: null,       // 上一次算數的觸發是哪隻手（兩手合併用）
    firedHand: null,      // 這一幀算數的觸發是哪隻手（'left'／'right'／'both'，沒有是 null；逐幀紀錄用）
    lastTroughMs: null,   // 最近一次算數的觸發的最低點時刻；跟 combinedSeq 一樣不歸零，接收端在計數變動時讀
  };
  slotInactiveSinceMs[slot] = 0;
}
// combinedSeq 刻意不歸零：接收端靠它「有沒有變」判斷新觸發，歸零會讓下一次比對誤判成新事件、平白多彈一個音；它單調遞增、永不重置。
const resetSlotDetectors = (arcSlot, lastSeq) => {
  arcSlot.left.reset(); arcSlot.right.reset();
  lastSeq.left = 0; lastSeq.right = 0;
  lastSeq.lastHand = null; lastSeq.firedHand = null;
};
const resetAllSlotDetectors = () => {
  for (let slot = 0; slot < arcDetectors.length; slot++) {
    resetSlotDetectors(arcDetectors[slot], arcLastSeqBySlot[slot]);
  }
};

// 餵一個在場槽位的骨架給它那對 ArcDetector；座標與尺度給逐幀紀錄。
function updateSlotArc(arcDet, track, nowMs, captureMs) {
  const sm = track.smoothed;
  const { scale, aspect } = track;
  const leftPoint = wristPoint(sm, MP_LEFT_WRIST);
  const rightPoint = wristPoint(sm, MP_RIGHT_WRIST);
  return {
    left: arcDet.left.update({ point: leftPoint, scale, aspect }, nowMs, captureMs),
    right: arcDet.right.update({ point: rightPoint, scale, aspect }, nowMs, captureMs),
    leftPoint, rightPoint, scale,
  };
}

// 合成雙手：兩隻手各自判，任一隻觸發就算一下；同一幀兩隻都觸發、或另一隻手的谷底跟上一次算數的觸發相差不到 TWO_HAND_MERGE_MS，算同一下。
// 動作時刻取先到的那個谷底。state 就是 arcLastSeqBySlot[slot]，逐幀被直接改動。
function combineArcTriggers(state, arc) {
  const { left, right } = arc;
  // 只認增加：ArcDetector 停滯（超過 staleMs 沒餵值）重設時 triggerSeq 會歸零，用 !== 會把歸零當成一次新揮手
  const fired = ['left', 'right'].filter((h) => arc[h].triggerSeq > state[h]);
  state.left = left.triggerSeq;
  state.right = right.triggerSeq;
  state.firedHand = null;
  if (!fired.length) return { triggerSeq: state.combinedSeq || 0 };

  const troughMs = Math.min(...fired.map((h) => arc[h].troughMs));
  const mergedWithLast = fired.length === 1 && state.lastHand !== null && state.lastHand !== fired[0]
    && Math.abs(troughMs - state.lastTroughMs) < TWO_HAND_MERGE_MS;
  if (!mergedWithLast) {
    state.firedHand = fired.length === 2 ? 'both' : fired[0];
    state.lastHand = fired.length === 2 ? null : fired[0];   // 兩隻都用掉了，下一下不管哪隻手都是新的一下
    state.lastTroughMs = troughMs;
    state.combinedSeq = (state.combinedSeq || 0) + 1;
  }
  return { triggerSeq: state.combinedSeq || 0 };
}

/**
 * 一幀的手勢：每個槽位（＝演奏者 ID）左右手各一個 ArcDetector，回傳每個槽位的拋物線觸發累加計數與這一幀真的在場的槽位。
 * @param {{slot: number, smoothed: object[], scale: number}[]} activeTracks  追蹤層這一幀的在場名單（tracker.getActiveTracks()）
 * @param {number} slotCount  追蹤器目前的槽位數（＝現場人數）；送出去的 map 只帶這麼多個槽位
 * @param {number} nowMs
 * @param {number} [captureMs]  這一幀被攝影機拍下的時刻（沒有就是 nowMs）
 * @returns {{ arcTriggerSeqBySlot: Object<number, number>, arcTroughMsBySlot: Object<number, number|null>, presentSlots: number[], frame: Array }}
 *   arcTroughMsBySlot＝每個槽位最近一次觸發的最低點時刻（揮手的動作時刻）；frame＝逐幀紀錄用（vision.js 的 __visionLog）：
 *   在場槽位的 [ID, 尺度, 左手腕 x, y, 右手腕 x, y, 這一幀算數的觸發是哪隻手（'left'／'right'／'both'／null）, 累加計數]，手腕不可見時那隻手的座標是 null
 */
export function updateGestures(activeTracks, slotCount, nowMs, captureMs = nowMs) {
  const arcTriggerSeqBySlot = {};
  const arcTroughMsBySlot = {};
  const presentSlots = [];
  const frame = [];
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
      arc = updateSlotArc(arcDet, track, nowMs, captureMs);
    } else {
      // 不在場：兩隻手都餵「看不到」讓追蹤中斷；連續超過 SLOT_RELEASE_MS 才真的 reset（下次鎖進來從乾淨開始）。
      if (slotInactiveSinceMs[slot] === 0) slotInactiveSinceMs[slot] = nowMs;
      if (nowMs - slotInactiveSinceMs[slot] > SLOT_RELEASE_MS) {
        resetSlotDetectors(arcDet, arcLastSeqBySlot[slot]);
        arc = { left: { triggerSeq: 0 }, right: { triggerSeq: 0 } };
      } else {
        arc = {
          left: arcDet.left.update({ point: null }, nowMs),
          right: arcDet.right.update({ point: null }, nowMs),
        };
      }
    }
    const combinedArc = combineArcTriggers(arcLastSeqBySlot[slot], arc);
    arcTriggerSeqBySlot[slot + 1] = combinedArc.triggerSeq;
    arcTroughMsBySlot[slot + 1] = arcLastSeqBySlot[slot].lastTroughMs;
    if (track) {
      frame.push([slot + 1, arc.scale, arc.leftPoint?.x ?? null, arc.leftPoint?.y ?? null, arc.rightPoint?.x ?? null, arc.rightPoint?.y ?? null,
        arcLastSeqBySlot[slot].firedHand, combinedArc.triggerSeq]);
    }
  }
  return { arcTriggerSeqBySlot, arcTroughMsBySlot, presentSlots, frame };
}

// 所有槽位的手勢狀態歸位；combinedSeq 不歸零（見 resetSlotDetectors）。
export function resetGestures() {
  resetAllSlotDetectors();
  slotInactiveSinceMs.fill(0);
}

