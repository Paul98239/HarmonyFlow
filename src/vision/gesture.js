// gesture.js — 手勢偵測（純邏輯，無 DOM／CDN）：ArcDetector 偵測拋物線手勢（橫向位移＋垂直先下沉再回升），回升確認那一刻 triggerSeq +1。
// 純離散觸發訊號，不輸出音量、不管速度；目前觸發來源是鍵盤，手勢沒有接進播放器（接回方式見規格文件）。
// 「哪隻手最近觸發」要跨幀記憶，由 vision.js 逐幀比對兩手的 triggerSeq 合成（combineArcTriggers()）。
// 所有門檻以肩寬為距離單位、毫秒為時間單位，站遠站近、30fps 或 60fps 結果一致。

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export { clamp01 };

// ── ArcDetector：拋物線手勢（前進一步的觸發）──
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
