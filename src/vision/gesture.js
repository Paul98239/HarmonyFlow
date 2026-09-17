// ============================================================
//  gesture.js — 手勢偵測（純邏輯，無 DOM／CDN 依賴）
//
//  只有一種偵測器：`ArcDetector`，拋物線手勢（手同時有橫向位移＋垂直方向先下沉再回升），
//  回升那一刻（確認反轉）觸發 `triggerSeq` +1，交給 `midi/humanPerformer.js` 當「前進一步」
//  的觸發訊號（純觸發，不輸出音量）。不依賴肩膀高度，手在胸口、腰間動都可以觸發；開口大小、
//  左右方向都不限，只看「有沒有這個下沉再回升的相對形狀」。
//
//  沒有 tempo 這回事了：全曲速度固定用樂譜原速，沒有揮手頻率控制的機制（原本的 WaveDetector
//  已移除）。
//
//  vision.js 每幀從鎖定骨架取出左右手腕／肘／肩座標，每個槽位左右手各一個 ArcDetector；
//  triggerSeq 是離散事件，「哪隻手最近觸發」需要跨幀記憶，由 vision.js 自己逐幀比對兩手的
//  triggerSeq 變化來合成（見 vision.js 的 combineArcTriggers()）。
//  所有門檻以「肩寬」為距離單位、「毫秒」為時間單位，同一動作站遠站近、30fps 或 60fps 結果一致。
// ============================================================

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export { clamp01 };

/* ═══════════════════════════════════════════
   🎯 ArcDetector — 拋物線手勢（前進一步的觸發）
   ═══════════════════════════════════════════ */
export const DEFAULT_ARC_CONFIG = Object.freeze({
  minShoulderWidth: 0.04,   // 肩寬的下限，避免遠處偵測到的極小肩寬把比值放大到離譜
  staleMs: 320,             // 距上一次餵值超過這麼久 → 視為剛回到鏡頭，這一段動作作廢重來
  reversalNoiseFloor: 0.05, // Y 方向死區（肩寬單位）：從谷底回升要超過這個幅度才算「確認回升」
  // 這兩個門檻比較嚴格（原本 0.08／0.10）：拿掉 humanPerformer.js 的快慢範圍限制之後，
  // 每一次判定成立都會立刻前進一步、播出下一個音，沒有緩衝空間，門檻調嚴一點降低誤觸發。
  minDepthRatio: 0.15,      // 這段下沉至少要多深（肩寬單位）才算一次有效拋物線
  minXSpanRatio: 0.18,      // 下沉期間至少要有這麼多橫向位移（肩寬單位），用來跟「純上下抖」區分開
});

/**
 * 拋物線手勢：手同時有橫向位移＋垂直方向先下沉（image y 變大）再回升。
 * 不看肩膀高度、不限開口大小、不限左右方向，只認這個相對形狀，純粹當一個離散的「觸發」訊號
 * （不輸出音量／深度——手勢的音量／表情這輪先不做，見 humanPerformer.js 的說明）。
 *
 * 判斷邏輯（單一狀態機，逐幀更新最高點／最低點）：
 *  - 追蹤目前這一段動作的「起點高度」（peak，Y 最小值）與「目前已知的最低點」（trough，Y 最大值）。
 *  - Y 持續變大（往下）：延伸 trough，同時累積這段下沉期間的橫向位移範圍。
 *  - Y 從 trough 回升超過死區（確認反轉）：這一段下沉結束，深度與橫向位移都達標就讓
 *    triggerSeq +1（供呼叫端偵測「有新事件」）；不管達不達標，都以目前位置當新的起點，
 *    重新開始找下一段。
 *  - 手不在畫面：中斷目前這段動作的追蹤，等手回來重新認一次。
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
      // 手不在畫面：這一段動作的追蹤中斷，等手回來重新認一次新的下沉。
      this.peakY = this.troughY = null;
      this._lastMs = null;
      return { triggerSeq: this.triggerSeq };
    }

    if (this._lastMs != null && nowMs - this._lastMs > this.cfg.staleMs) this.reset();
    this._lastMs = nowMs;

    const sw = Math.max(this.cfg.minShoulderWidth, frame.shoulderWidth || 0);
    const { x, y } = point;

    if (this.peakY === null) {
      // 剛開始追蹤：這個位置當這一段動作暫定的起點。
      this.peakY = y; this.troughY = y;
      this._minX = x; this._maxX = x;
      return { triggerSeq: this.triggerSeq };
    }

    if (y >= this.troughY) {
      // 還在往下（或持平）：延伸目前已知的最低點，累積橫向位移範圍。
      this.troughY = y;
      if (x < this._minX) this._minX = x;
      if (x > this._maxX) this._maxX = x;
    } else if (y < this.troughY - this.cfg.reversalNoiseFloor * sw) {
      // 已經比最低點回升超過死區——這段下沉結束，判斷是否是一次有效拋物線。
      const depth = this.troughY - this.peakY;
      const xSpan = this._maxX - this._minX;
      if (depth >= this.cfg.minDepthRatio * sw && xSpan >= this.cfg.minXSpanRatio * sw) {
        this.triggerSeq++;
      }
      // 不論這次算不算數，都以現在的位置當新起點，重新開始找下一段下沉。
      this.peakY = y; this.troughY = y;
      this._minX = x; this._maxX = x;
    } else {
      // 還沒明顯下沉、或還在回升死區內：讓起點跟著目前更高的位置走，避免小雜訊被算進之後的深度。
      if (y < this.peakY) this.peakY = y;
    }

    return { triggerSeq: this.triggerSeq };
  }
}
