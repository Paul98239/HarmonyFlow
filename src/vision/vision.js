// ============================================================
//  vision.js — MediaPipe 骨架偵測模組
//  WebGL 視訊渲染 + 多人 ID 鎖定追蹤 + 自適應平滑濾波（最多 4 人）
// ============================================================

// 直接從 CDN 匯入（不經 import map），版本綁 @latest：不手動維護版本號，代價是
// jsDelivr 對 @latest 有快取（瀏覽器端 7 天／邊緣節點 12 小時），版本可能在快取到期
// 後無預警改變，且不同使用者吃到新版的時間點不一致。
import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";
import { PersonTracker, buildDetection } from "./tracking.js";
import { ArcDetector } from "./gesture.js";

/* ═══════════════════════════════════════════
   ⚙️ 基礎設定
   ═══════════════════════════════════════════ */
const CONFIG = {
  // 攝影機解析度與幀率的「上限」（getUserMedia 用 max 而非只給 ideal）：外接攝影機的原生模式
  // 常是 1080p60，真的拿到會讓每幀多搬四倍像素、rVFC 一秒觸發 60 次推論，多數機器跟不上。
  // 用 max 收成硬上限後瀏覽器會自行降採樣；實際協商到的規格會在啟動時印到 console。
  width: 854,
  height: 480,
  frameRate: 30,
  maxUsers: 4, // 最多鎖定並顯示的目標人數
};

// 三種 pose 模型：lite 最快但抖動較明顯，full／heavy 較穩但推論成本高。目前預設 lite；
// 抽成表格＋ loadPoseModel()／setPoseModel()，讓日後切換只需要接一個下拉選單。
const POSE_MODELS = {
  lite: "./src/assets/pose_landmarker_lite.task",
  full: "./src/assets/pose_landmarker_full.task",
  heavy: "./src/assets/pose_landmarker_heavy.task",
};
const DEFAULT_POSE_MODEL = "lite";

// MediaPipe 的 numPoses（同時追幾個人）。這個數字決定 MediaPipe 的工作模式：「追到的人數 ≥
// numPoses」時偵測器跳過、每個人的 ROI 由上一幀的 landmark 延續——沒有幽靈骨架、節點最穩；
// 「追到的人數 < numPoses」時偵測器每幀重跑，幽靈與抖動都是這個狀態的產物。
// landmarker 開頁時以 DEFAULT_POSE_COUNT 預先建好、其餘 1~maxUsers 的 numPoses 在背景預建
// （見 landmarkerPool），但還沒在系統控制 bar 選「現場人數」之前不推論（chosenPoseCount 為 0
// 時 processFrame 跳過 detectForVideo）。使用者選了 N 才武裝偵測，numPoses 與追蹤層的槽位數
// （＝ ID 上限）都設成 N（見 setPoseCount）。設小了多出來的人不會被偵測到，這是設定的字面意思。
const DEFAULT_POSE_COUNT = CONFIG.maxUsers;
const POSE_COLORS = ["#00FFFF", "#FF6B6B", "#51CF66", "#FFD43B"]; // 4 人的代表色彩（依鎖定槽位對應）
const BONE_WIDTH = 2;      // 骨架連線寬度（px）
const JOINT_RADIUS = 2;    // 關節圓點半徑（px）
const TAU = Math.PI * 2;
// 嘴巴中點正下方的虛擬「下巴」節點偏移量：以肩寬為單位（跟 ArcDetector 門檻、ID 標籤字級
// 同一套慣例），人離鏡頭遠近不同時偏移比例才會一致，不用固定 px。
const CHIN_OFFSET_RATIO = 0.18;
// 慣用手鎖定：連續這麼久沒有新觸發（毫秒）才放開鎖定，讓使用者能換手。
const HAND_LOCK_RELEASE_MS = 3000;

const FRAME_ERROR_THRESHOLD = 90; // 連續幾幀處理失敗才判定為持續性錯誤並顯示錯誤畫面（約 1.5~3 秒）

// 誰匹配誰、新面孔何時鎖定空位——純邏輯在 tracking.js。
// let 而非 const：槽位數要跟系統控制 bar 的「現場人數」走（applyPoseCount 會用新的 maxUsers 重建）。
let tracker = new PersonTracker({ maxUsers: CONFIG.maxUsers });

// 手勢：每個鎖定槽位左右手各一個 ArcDetector（拋物線手勢 → 換音符的觸發，見
// humanPerformer.js；不輸出音量）。每幀算出「每個槽位（＝演奏者 ID）的拋物線觸發序號
// （→ humanPerformer 的前進許可）」＋「這一幀真的在場的槽位」，經 setPerformanceStateListener
// 註冊的回呼送給播放器（midi/midiPlayer.js）。沒有 tempo 這回事，全曲固定用樂譜原速。
const MP_LEFT_WRIST = 15, MP_RIGHT_WRIST = 16;
const MP_LEFT_ELBOW = 13, MP_RIGHT_ELBOW = 14;
const MP_LEFT_SHOULDER = 11, MP_RIGHT_SHOULDER = 12;
// 手掌點（拇指／食指／小指）：跟手腕平均起來當「手掌＋手腕合併」的單一座標，供 ArcDetector
// 追蹤與骨架繪製的合併大點共用（見 renderSkeletonOverlay()）。
const MP_LEFT_HAND = [17, 19, 21], MP_RIGHT_HAND = [18, 20, 22];
const arcDetectors = Array.from({ length: CONFIG.maxUsers },
  () => ({ left: new ArcDetector(), right: new ArcDetector() }));
// 合成雙手 ArcDetector 時需要「上一幀各手的 triggerSeq」才能判斷有沒有新觸發（見
// combineArcTriggers()）；ArcDetector 本身的 triggerSeq 是累加值，不是「這一幀有沒有觸發」的旗標。
const arcLastSeqBySlot = Array.from({ length: CONFIG.maxUsers },
  () => ({ left: 0, right: 0, combinedSeq: 0, lockedHand: null, lastTriggerMs: undefined }));
// 注意：combinedSeq 刻意不在這裡歸零。humanPerformer.js 靠它「有沒有變」判斷有沒有新觸發，
// 歸零會讓下一次比對誤判成一次新事件、平白多彈一個音（實測發現：走出鏡頭超過 SLOT_RELEASE_MS、
// 按重置骨架 ID、改現場人數都會呼叫到這裡）。combinedSeq 單調遞增、永不重置。
const resetSlotDetectors = (arcSlot, lastSeq) => {
  arcSlot.left.reset(); arcSlot.right.reset();
  lastSeq.left = 0; lastSeq.right = 0;
  lastSeq.lockedHand = null; lastSeq.lastTriggerMs = undefined;
};
// 一次歸位所有槽位的手勢偵測器（重置骨架 ID、關閉攝影機、人數改變重建追蹤器時共用）。
const resetAllSlotDetectors = () => {
  for (let slot = 0; slot < arcDetectors.length; slot++) {
    resetSlotDetectors(arcDetectors[slot], arcLastSeqBySlot[slot]);
  }
};
const EMPTY_PERFORMANCE_STATE = { arcTriggerSeqBySlot: {}, presentSlots: [] };
// 槽位這一幀沒有 active track 時的「不在場起算時刻」（0 ＝在場）。連續不在場超過
// SLOT_RELEASE_MS 才把偵測器整個 reset；在那之前只餵 null 讓強度平滑衰減，
// 避免追蹤閃斷一兩幀就讓那一路整段靜音。
const slotInactiveSinceMs = new Array(CONFIG.maxUsers).fill(0);
const SLOT_RELEASE_MS = 1000;

let performanceStateListener = null;
let lastSentState = null;
let lastEmitMs = 0;            // 上一次真的送出的時刻（心跳用，見 emitGesturePerformanceState）
// 必須明顯小於 midi/midiPlayer.js 的 GATE_STALE_MS(250ms)：那兩個常數是一對，改動任一邊都要一起看。
const EMIT_HEARTBEAT_MS = 100;

function performanceStatesDiffer(a, b) {
  if (!a || !b) return true;
  if (a.presentSlots.length !== b.presentSlots.length) return true;
  for (let i = 0; i < a.presentSlots.length; i++) {
    if (a.presentSlots[i] !== b.presentSlots[i]) return true;
  }
  // triggerSeq 是離散事件的累加計數：任何變動都代表「有新的拋物線谷底」，一定要送，
  // 不能只在超過門檻時才送。
  for (let id = 1; id <= CONFIG.maxUsers; id++) {
    if ((a.arcTriggerSeqBySlot[id] || 0) !== (b.arcTriggerSeqBySlot[id] || 0)) return true;
  }
  return false;
}

// 只在 arcTriggerSeqBySlot 有意義變化時才送，免得每幀都打一次——但再久也一定會送一次（心跳），
// 因為「沒有變化」跟「沒有訊號」是兩件事。midi/humanPerformer.js 用「多久沒有新的 triggerSeq」
// 判斷要不要切成電腦代打模式；有了心跳，「還有沒有訊號」只由這裡決定，看門狗才恢復成字面意思：
// 真的沒有幀在跑（分頁切走、迴圈停掉）。
function emitGesturePerformanceState(state, nowMs) {
  const heartbeatDue = nowMs - lastEmitMs >= EMIT_HEARTBEAT_MS;
  if (!heartbeatDue && !performanceStatesDiffer(state, lastSentState)) return;
  lastSentState = state;
  lastEmitMs = nowMs;
  if (performanceStateListener) {
    try { performanceStateListener(state); }
    catch (e) { console.warn("⚠️ 手勢狀態監聽者拋錯", e); }
  }
}

/* ═══════════════════════════════════════════
   🎞️ 播放環境能力偵測
   ═══════════════════════════════════════════ */
// requestVideoFrameCallback 能精準對齊視訊幀（新幀到達才觸發，比 rAF 輪詢更省電更準時）；
// scheduleNextFrame() 依此決定排程 API：支援則用 rVFC，否則降級為 requestAnimationFrame。
const useRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;

/* ═══════════════════════════════════════════
   🖥️ DOM 參照
   ═══════════════════════════════════════════ */
const video = document.getElementById("webcam");
const glCanvas = document.getElementById("gl-canvas");
const overlayCanvas = document.getElementById("overlay-canvas");
const ctx2d = overlayCanvas.getContext("2d");

// 載入畫面的狀態文字與錯誤畫面都不在這裡畫：由 startVision({ onStatus, onError }) 的回呼交給
// src/ui.js（遮罩的唯一擁有者）。
let onStatus = null;
let onError = null;
const stageHint = document.getElementById("stage-hint"); // 舞台中央的提示（攝影機關閉／還沒選現場人數）

/* ═══════════════════════════════════════════
   🧠 狀態
   ═══════════════════════════════════════════ */
let poseLandmarker = null;
let gl = null;      // WebGL context
let glTexture = null;      // video texture
let glProgram = null;      // shader program
let consecutiveFrameErrors = 0; // 連續幀處理失敗計數，超過 FRAME_ERROR_THRESHOLD 才視為持續性錯誤
let lastProcessedVideoTime = -1; // 上一次真的送去推論的 video.currentTime（rAF 降級路徑用來跳過重複幀）
let visionFileset = null; // FilesetResolver 的結果，切換模型時重用，不必重新載入 WASM
let currentModelVariant = DEFAULT_POSE_MODEL;
let currentPoseCount = DEFAULT_POSE_COUNT; // 目前使用中的 landmarker 的 numPoses（見 DEFAULT_POSE_COUNT）
let chosenPoseCount = 0;                   // 系統控制 bar 選的「現場人數」；0 ＝ 還沒選 ＝ 不推論
// numPoses(1~maxUsers) → 已建好（或建置中）的 PoseLandmarker promise，只對 currentModelVariant
// 有效。開機建好 DEFAULT_POSE_COUNT 那份後，其餘人數在背景預建；選人數（setPoseCount）時池子
// 裡多半已經有了，直接秒切換不必等模型重建。切換 model 變體（setPoseModel）時整組作廢重建。
let landmarkerPool = new Map();
let poolGeneration = 0; // 每次 setPoseModel 切變體 +1，讓切換前就在背景建置中的舊變體實例作廢
let latestRequestedPoseCount = 0; // setPoseCount 的「最後一次呼叫勝出」判斷用

// ── 幀迴圈 ──
// frameHandle：已排程的下一幀代號（rVFC 與 rAF 的 id 都 ≥ 1，0 ＝ 沒有排程中的回呼）。
// isLoopStopped：迴圈停止中（攝影機關閉、致命錯誤）；已排隊的回呼另外真的取消掉（見 stopFrameLoop），
// 旗標只是第二道防線。
let frameHandle = 0;
let isLoopStopped = true;

// ── 攝影機狀態機（見下方「攝影機開啟／關閉」）──
let cameraStream = null;          // 開啟中的 MediaStream；null ＝ 關閉
let cameraState = "off";          // "off" | "starting" | "on" | "stopping"
let cameraOffReason = "";         // 關閉時舞台提示的文字；"" ＝ 使用者主動關閉（顯示預設文字）
let cameraOp = Promise.resolve(); // start／stop／ended 序列化用的 promise 鏈
let cameraStateListener = null;

/* ═══════════════════════════════════════════
   🎨 WebGL 初始化
   ═══════════════════════════════════════════ */
const VERT_SRC = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying   vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    // 水平鏡像：翻轉 U 軸
    v_texCoord = vec2(1.0 - a_texCoord.x, a_texCoord.y);
  }
`;

const FRAG_SRC = `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_sampler;
  void main() {
    gl_FragColor = texture2D(u_sampler, v_texCoord);
  }
`;

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader 編譯失敗：${log}`);
  }
  return shader;
}

function initWebGL() {
  gl = glCanvas.getContext("webgl", {
    alpha: false,              // 不需要透明（底層畫布）
    desynchronized: true,      // 低延遲提示
    antialias: false,          // 視訊不需要 AA
    powerPreference: "high-performance"
  });

  if (!gl) throw new Error("WebGL 不可用");

  gl.clearColor(0, 0, 0, 1);

  const vert = compileShader(gl.VERTEX_SHADER, VERT_SRC);
  const frag = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);

  glProgram = gl.createProgram();
  gl.attachShader(glProgram, vert);
  gl.attachShader(glProgram, frag);
  gl.linkProgram(glProgram);

  if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
    throw new Error("Shader 連結失敗：" + gl.getProgramInfoLog(glProgram));
  }

  gl.useProgram(glProgram);
  gl.deleteShader(vert);
  gl.deleteShader(frag);

  // 全螢幕四邊形頂點：position (clip-space) + texCoord (UV)
  const vertices = new Float32Array([
    -1, -1, 0, 1,
    1, -1, 1, 1,
    -1, 1, 0, 0,
    1, 1, 1, 0,
  ]);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(glProgram, "a_position");
  const aTex = gl.getAttribLocation(glProgram, "a_texCoord");

  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);

  gl.enableVertexAttribArray(aTex);
  gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

  glTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.uniform1i(gl.getUniformLocation(glProgram, "u_sampler"), 0);
}

// GPU driver 重置／分頁長時間背景化可能造成 WebGL context 遺失。不 preventDefault() 瀏覽器就
// 不會嘗試恢復；恢復後重新執行 initWebGL() 重建 shader／texture／buffer。
glCanvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  console.warn("⚠️ WebGL context 遺失，等待瀏覽器恢復…");
});
glCanvas.addEventListener("webglcontextrestored", () => {
  try { initWebGL(); } catch (err) { showError("WebGL 恢復失敗", String(err)); }
});

// 畫布尺寸跟著實際視訊尺寸走；#canvas-container 滿版、子 canvas 是 object-fit:cover，
// 裁切由 CSS 自動生效，不需要 JS 介入。
function syncCanvasSize() {
  const vw = video.videoWidth || CONFIG.width;
  const vh = video.videoHeight || CONFIG.height;

  if (glCanvas.width !== vw || glCanvas.height !== vh) {
    glCanvas.width = vw;
    glCanvas.height = vh;
    overlayCanvas.width = vw;
    overlayCanvas.height = vh;
    gl.viewport(0, 0, vw, vh);
  }
}

function renderVideoGL() {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function isFacePoint(i) { return i >= 0 && i <= 10; }

// 手腕＋手掌（拇指／食指／小指）平均起來的合併座標——ArcDetector 追蹤與骨架繪製的合併大點
// 共用同一個計算（見 renderSkeletonOverlay()）。手腕本身不可見就視為這隻手不在畫面。
function mergedHandPoint(sm, wristIdx, handIdxs) {
  const wrist = sm[wristIdx];
  if (!wrist.visible) return null;
  let sx = wrist.x, sy = wrist.y, n = 1;
  for (const i of handIdxs) {
    const p = sm[i];
    if (p.visible) { sx += p.x; sy += p.y; n++; }
  }
  return { x: sx / n, y: sy / n };
}

// 兩肩中點當虛擬「脖子」節點——MediaPipe Pose 沒有脖子 landmark。
function virtualNeckPoint(lm) {
  const ls = lm[MP_LEFT_SHOULDER], rs = lm[MP_RIGHT_SHOULDER];
  if (!(ls.visible ?? true) || !(rs.visible ?? true)) return null;
  return { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
}

// 嘴巴兩節點中點下方的虛擬「下巴」節點，供骨架畫成倒三角形（見 renderSkeletonOverlay()）。
function virtualChinPoint(lm, shoulderWidth) {
  const left = lm[9], right = lm[10];
  if (!(left.visible ?? true) || !(right.visible ?? true)) return null;
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2 + CHIN_OFFSET_RATIO * shoulderWidth,
  };
}

// 把一個在場槽位的骨架餵給它那對 ArcDetector（拋物線手勢 → 換音符觸發）。回傳的
// leftVisible／rightVisible 供 combineArcTriggers() 判斷鎖定的手是否該放開。
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
  };
}

// 合成雙手的 ArcDetector 結果，並套用「自動鎖定慣用手」：哪隻手先做出有效拋物線就鎖定它，
// 之後只認那隻手的觸發——避免另一隻閒置手被模型猜出來後在畫面上飄移、湊出假拋物線造成誤觸發
// （實測發現的問題）。鎖定的手連續不可見、或連續 HAND_LOCK_RELEASE_MS 沒有新觸發，才放開讓
// 使用者換手。combinedSeq 是槽位自己的累加計數，供 midi/humanPerformer.js 判斷「有沒有新事件」。
// state 就是 arcLastSeqBySlot[slot]，逐幀被這個函式直接改動（歸位見 resetSlotDetectors）。
function combineArcTriggers(state, arc, nowMs) {
  const { left, right, leftVisible, rightVisible } = arc;

  if (state.lockedHand === "left" && !leftVisible) state.lockedHand = null;
  if (state.lockedHand === "right" && !rightVisible) state.lockedHand = null;
  if (state.lockedHand && nowMs - (state.lastTriggerMs ?? nowMs) > HAND_LOCK_RELEASE_MS) {
    state.lockedHand = null;
  }

  const leftChanged = left.triggerSeq !== state.left;
  const rightChanged = right.triggerSeq !== state.right;
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

// 精簡骨架只畫手勢相關的手臂鏈（肩-肘-手掌大點）＋臉部簡化輪廓，不畫 PoseLandmarker.POSE_CONNECTIONS
// 全身連線（髖／膝／踝／腳掌都不畫，這些點沒有被任何手勢或播放邏輯讀取）。
// 只到肘為止：肘→手掌大點那一段要連到合併後的座標（見 renderSkeletonOverlay()），不是原始
// 手腕點，兩者位置不同，用索引表連不出正確的線（會跟畫出來的大點之間留一截空隙）。
const ARM_CONNECTIONS = [
  { start: MP_LEFT_SHOULDER, end: MP_LEFT_ELBOW },
  { start: MP_RIGHT_SHOULDER, end: MP_RIGHT_ELBOW },
];
// 臉部只標關鍵五官：雙眼（2/5）、鼻子（0）各畫一個獨立節點、不連線；嘴巴兩節點（9/10）
// 加上下方的虛擬下巴節點（virtualChinPoint()）連成一個倒三角形。
const MOUTH_PAIR = [9, 10];
const HAND_DOT_RADIUS = JOINT_RADIUS * 2.2; // 手腕＋手掌合併後的大點，比一般關節明顯

/* ═══════════════════════════════════════════
   🖊️ 2D 覆蓋層繪製骨架（依鎖定槽位上色，同一人跨幀顏色不變）
   ═══════════════════════════════════════════ */
function renderSkeletonOverlay(activeTracks) {
  const W = overlayCanvas.width;
  const H = overlayCanvas.height;

  ctx2d.clearRect(0, 0, W, H);
  if (activeTracks.length === 0) return;

  ctx2d.save();
  ctx2d.translate(W, 0);
  ctx2d.scale(-1, 1); // 水平鏡像（與 WebGL shader 一致）

  for (const track of activeTracks) {
    const color = POSE_COLORS[track.slot % POSE_COLORS.length];

    // 低可見度（遮擋/猜測）的關節不繪製。visible 由 tracking.js 算好（可見度先 EMA 平滑、
    // 再套遲滯門檻），這裡不自己比門檻，否則邊緣關節會逐幀閃爍。
    // 骨架累積成 Path2D 後一次畫完，不用 DrawingUtils 逐條逐點畫。
    const lm = track.smoothed;
    const ls = lm[MP_LEFT_SHOULDER], rs = lm[MP_RIGHT_SHOULDER];
    const shoulderWidth = Math.hypot(ls.x - rs.x, ls.y - rs.y);

    // 只畫目前鎖定的那隻手（未鎖定時兩隻都畫，讓使用者看得到還沒決定）：另一隻閒置手在畫面上
    // 消失，使用者才看得出系統現在認哪隻手（見 combineArcTriggers() 的自動鎖定慣用手邏輯）。
    const lockedHand = arcLastSeqBySlot[track.slot]?.lockedHand;
    const showLeftHand = lockedHand !== "right";
    const showRightHand = lockedHand !== "left";
    // 手腕＋手掌合併點要先算出來：畫肘→手掌那一段連線、跟畫手掌大點都要用同一個座標，
    // 兩處對不齊就會看起來中間有空隙。
    const leftHand = showLeftHand ? mergedHandPoint(lm, MP_LEFT_WRIST, MP_LEFT_HAND) : null;
    const rightHand = showRightHand ? mergedHandPoint(lm, MP_RIGHT_WRIST, MP_RIGHT_HAND) : null;
    const neck = virtualNeckPoint(lm);
    const chin = virtualChinPoint(lm, shoulderWidth);

    const bones = new Path2D();
    for (const c of ARM_CONNECTIONS) {
      const p = lm[c.start], q = lm[c.end];
      if (!(p.visible ?? true) || !(q.visible ?? true)) continue;
      bones.moveTo(p.x * W, p.y * H);
      bones.lineTo(q.x * W, q.y * H);
    }
    // 肘 → 手掌合併點：連到合併後的座標，不是原始手腕點，線才會直接接上下面畫的大點。
    const lElbow = lm[MP_LEFT_ELBOW], rElbow = lm[MP_RIGHT_ELBOW];
    if (leftHand && (lElbow.visible ?? true)) {
      bones.moveTo(lElbow.x * W, lElbow.y * H);
      bones.lineTo(leftHand.x * W, leftHand.y * H);
    }
    if (rightHand && (rElbow.visible ?? true)) {
      bones.moveTo(rElbow.x * W, rElbow.y * H);
      bones.lineTo(rightHand.x * W, rightHand.y * H);
    }
    // 兩肩到虛擬脖子節點的連線。
    if (neck) {
      bones.moveTo(ls.x * W, ls.y * H); bones.lineTo(neck.x * W, neck.y * H);
      bones.moveTo(rs.x * W, rs.y * H); bones.lineTo(neck.x * W, neck.y * H);
    }
    // 嘴巴兩節點＋虛擬下巴節點連成倒三角形。
    if (chin) {
      const mLeft = lm[MOUTH_PAIR[0]], mRight = lm[MOUTH_PAIR[1]];
      bones.moveTo(mLeft.x * W, mLeft.y * H); bones.lineTo(mRight.x * W, mRight.y * H);
      bones.moveTo(mRight.x * W, mRight.y * H); bones.lineTo(chin.x * W, chin.y * H);
      bones.moveTo(chin.x * W, chin.y * H); bones.lineTo(mLeft.x * W, mLeft.y * H);
    }
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = BONE_WIDTH;
    ctx2d.stroke(bones);

    // 關節點：肩／肘／脖子／下巴正常大小；雙眼與鼻子各畫一個獨立節點、不連線；手腕與手掌
    // （拇指/食指/小指）合併畫成一個較大的點，跟 updateSlotArc() 的 mergedHandPoint() 用
    // 同一套合併邏輯，畫面跟手勢追蹤的點位一致。
    const joints = new Path2D();
    const addJoint = (x, y, radius) => {
      // arc 從角度 0（圓的右端）起筆，先 moveTo 過去，否則會從上一個圓拉一條線過來
      joints.moveTo(x + radius, y);
      joints.arc(x, y, radius, 0, TAU);
    };
    // 0=鼻子、2=左眼中心、5=右眼中心、9/10=嘴角（見 MOUTH_PAIR）。
    for (const i of [MP_LEFT_SHOULDER, MP_RIGHT_SHOULDER, MP_LEFT_ELBOW, MP_RIGHT_ELBOW,
                      0, 2, 5, MOUTH_PAIR[0], MOUTH_PAIR[1]]) {
      const p = lm[i];
      if (!(p.visible ?? true)) continue;
      addJoint(p.x * W, p.y * H, JOINT_RADIUS);
    }
    if (neck) addJoint(neck.x * W, neck.y * H, JOINT_RADIUS);
    if (chin) addJoint(chin.x * W, chin.y * H, JOINT_RADIUS);
    if (leftHand) addJoint(leftHand.x * W, leftHand.y * H, HAND_DOT_RADIUS);
    if (rightHand) addJoint(rightHand.x * W, rightHand.y * H, HAND_DOT_RADIUS);
    ctx2d.fillStyle = color;
    ctx2d.fill(joints);
    ctx2d.lineWidth = 1;
    ctx2d.stroke(joints);
  }

  ctx2d.restore();

  // ID 標籤在鏡像轉換之外繪製（否則文字會左右反轉），座標手動換算成鏡像後的螢幕座標
  ctx2d.save();
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "bottom";
  ctx2d.strokeStyle = "rgba(0,0,0,.75)";

  for (const track of activeTracks) {
    const color = POSE_COLORS[track.slot % POSE_COLORS.length];
    const lm = track.smoothed;
    const head = lm[0]; // 鼻子
    const anchor = (head && (head.visible ?? true))
      ? head
      : lm.find((p, i) => isFacePoint(i) && (p.visible ?? true));
    if (!anchor) continue;

    // 以肩寬換算此人在畫面上的尺度，讓字級隨遠近縮放；範圍收窄避免忽大忽小
    const shoulderWidthPx = Math.hypot((lm[11].x - lm[12].x) * W, (lm[11].y - lm[12].y) * H);
    const fontSizePx = Math.max(18, Math.min(36, shoulderWidthPx * 0.4));
    const headTopOffsetPx = Math.max(fontSizePx * 1.3, shoulderWidthPx * 0.7); // 眼睛到頭頂的估計距離

    const sx = (1 - anchor.x) * W;                  // 水平鏡像
    const sy = anchor.y * H - headTopOffsetPx / 2;   // 眼睛與頭頂的中點

    ctx2d.font = `bold ${fontSizePx.toFixed(0)}px Consolas, monospace`;
    ctx2d.lineWidth = Math.max(3, fontSizePx * 0.12);

    const label = `ID ${track.id}`;
    ctx2d.fillStyle = color;
    ctx2d.strokeText(label, sx, sy);
    ctx2d.fillText(label, sx, sy);
  }

  ctx2d.restore();
}

/* ═══════════════════════════════════════════
   🎬 核心幀處理
   ═══════════════════════════════════════════ */
function processFrame() {
  frameHandle = 0;           // 這一次回呼已經觸發，沒有排程中的了（startFrameLoop 據此決定要不要排新的）
  if (isLoopStopped) return; // 已停止：連已排隊的回呼也一併作廢（取消失敗時的第二道防線）

  // rAF 降級路徑：rAF 跟著螢幕更新率跑（常見 60Hz），攝影機多半只有 30fps，不比對的話同一張
  // 視訊幀會被送進 MediaPipe 推論兩次。rVFC 路徑只在新幀到達時才觸發，不需要這道檢查。
  if (!useRVFC) {
    if (video.currentTime === lastProcessedVideoTime) {
      scheduleNextFrame();
      return;
    }
    lastProcessedVideoTime = video.currentTime;
  }

  // 單一幀處理過程中的任何例外都不該讓整條追蹤迴圈永久卡死：吞下例外、跳過這一幀，下一幀
  // 繼續嘗試；只有連續失敗超過 FRAME_ERROR_THRESHOLD 幀才真的顯示錯誤畫面並停止。
  try {
    syncCanvasSize();

    const nowMs = performance.now();

    // ▶ MediaPipe 偵測（上限 currentPoseCount）。還沒選「現場人數」（chosenPoseCount 0）就不推論；
    //   模型切換中（poseLandmarker 為 null）也一樣。其餘管線照跑：tracker.update([]) 讓舊 track
    //   自然過期、心跳照送 presentSlots: []、攝影機畫面照畫（畫面不會凍結）。
    const rawPoses = (poseLandmarker && chosenPoseCount)
      ? (poseLandmarker.detectForVideo(video, nowMs)?.landmarks ?? [])
      : [];

    // ▶ 依位置將偵測結果匹配到已鎖定的槽位（並平滑）——實際演算法見 tracking.js，純粹依螢幕
    // 位置判斷、不使用服裝顏色。buildDetection 對座標異常／不像人的偵測回傳 null 先濾掉；
    // 同一具身體的重複偵測由 tracker.update() 自己挑該留哪一筆。
    const detections = rawPoses.map((lm) => buildDetection(lm)).filter(Boolean);

    tracker.update(detections, nowMs);
    const activeTracks = tracker.getActiveTracks();

    // ▶ 手勢：每個槽位（＝演奏者 ID）左右手各一個 ArcDetector（拋物線換音符觸發），
    //   另外回報這一幀真的在場的槽位。
    const arcTriggerSeqBySlot = {};
    const presentSlots = [];
    // 先把 active track 攤成「槽位 → track」的查表。上限是追蹤器目前的槽位數（＝設定的現場人數）：
    // 追蹤器只有 2 個槽位時，送出去的 map 不該還帶 3、4 這種永遠是空的 key。
    const slotCount = tracker.cfg.maxUsers;
    const trackBySlot = new Array(slotCount).fill(null);
    for (const t of activeTracks) trackBySlot[t.slot] = t;

    for (let slot = 0; slot < slotCount; slot++) {
      const track = trackBySlot[slot];
      const arcDet = arcDetectors[slot];
      let arc;
      if (track) {
        slotInactiveSinceMs[slot] = 0;
        presentSlots.push(slot + 1);
        arc = updateSlotArc(arcDet, track, nowMs);
      } else {
        // 不在場：釋放窗內兩隻手都餵「看不到」讓拋物線追蹤中斷；連續不在場超過
        // SLOT_RELEASE_MS 才真的 reset（清掉狀態，下次鎖進來從乾淨開始）。
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
    emitGesturePerformanceState({ arcTriggerSeqBySlot, presentSlots }, nowMs);

    // ▶ WebGL 渲染攝影機畫面當背景
    renderVideoGL();

    // ▶ 2D 覆蓋層繪製骨架（漏偵測一兩幀的人用最後一次的骨架撐住，見 tracking.js 的 getDrawableTracks）
    renderSkeletonOverlay(tracker.getDrawableTracks(nowMs));

    consecutiveFrameErrors = 0;
  } catch (err) {
    consecutiveFrameErrors++;
    console.error(`⚠️ 幀處理失敗（連續第 ${consecutiveFrameErrors} 次）：`, err);
    if (consecutiveFrameErrors > FRAME_ERROR_THRESHOLD) {
      stopFrameLoop(); // 停止排程下一幀，避免無意義地持續狂噴同一個錯誤
      showError("姿勢追蹤發生持續性錯誤", "請重新整理頁面。若問題持續發生，請確認鏡頭或顯示卡驅動狀態。");
      return;
    }
  }

  scheduleNextFrame();
}

function scheduleNextFrame() {
  if (isLoopStopped) return;
  frameHandle = useRVFC
    ? video.requestVideoFrameCallback(processFrame) // 精準對齊視訊幀，只在新幀到達時觸發
    : requestAnimationFrame(processFrame);          // 降級：rAF 輪詢
}

// 停止追蹤迴圈（攝影機關閉、致命錯誤）。除了設旗標擋掉已排隊的回呼，也真的把它取消掉。
function stopFrameLoop() {
  isLoopStopped = true;
  if (frameHandle) {
    if (useRVFC) video.cancelVideoFrameCallback(frameHandle);
    else cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }
}

// （重新）啟動追蹤迴圈。只有沒有排程中的回呼時才排新的，否則兩條迴圈同時跑、每幀推論兩次。
// lastProcessedVideoTime 歸位讓 rAF 路徑不會把新串流的第一幀當成重複幀。
function startFrameLoop() {
  isLoopStopped = false;
  lastProcessedVideoTime = -1;
  if (!frameHandle) scheduleNextFrame();
}

/* ═══════════════════════════════════════════
   🧰 工具函式
   ═══════════════════════════════════════════ */
function setStatus(msg) { onStatus?.(msg); }

function showError(title, detail = "") { onError?.(title, detail); }

/* ═══════════════════════════════════════════
   📷 攝影機開啟／關閉（畫質／幀率封頂、可停可開）
   ═══════════════════════════════════════════ */
// getUserMedia 失敗時給使用者看的文字。開機失敗的錯誤畫面（initSystem）與執行期重開失敗的
// 舞台提示／系統控制 bar 狀態列（startCamera）共用同一張表。
const CAMERA_ERROR_MESSAGES = {
  NotAllowedError: ["鏡頭權限被拒絕", "請在瀏覽器設定中允許本頁面使用鏡頭。"],
  NotFoundError: ["找不到鏡頭", "請確認裝置已連接鏡頭。"],
  DevicesNotFoundError: ["找不到鏡頭", "請確認裝置已連接鏡頭。"],
  NotReadableError: ["鏡頭被佔用", "請關閉其他正在使用鏡頭的應用程式。"],
  TrackStartError: ["鏡頭被佔用", "請關閉其他正在使用鏡頭的應用程式。"],
  OverconstrainedError: ["鏡頭不支援要求的畫質", "請調整 vision.js 的 CONFIG 解析度／幀率設定，或改用其他鏡頭。"],
};
function cameraErrorText(err, fallbackTitle = "鏡頭開啟失敗") {
  return CAMERA_ERROR_MESSAGES[err?.name] || [fallbackTitle, err?.message || String(err)];
}

// track.stop() 之後裝置在瀏覽器程序裡是非同步釋放的（Firefox／Windows 尤其明顯），緊接著重開
// 會拿到 NotReadableError／AbortError；要等真實時間。只重試一次。
const CAMERA_REOPEN_RETRY_MS = 400;
async function openCamera() {
  try {
    return await requestCameraStream();
  } catch (err) {
    if (err.name !== "NotReadableError" && err.name !== "AbortError") throw err;
    console.warn(`⚠️ 鏡頭暫時無法開啟（${err.name}），${CAMERA_REOPEN_RETRY_MS}ms 後重試一次`);
    await new Promise((r) => setTimeout(r, CAMERA_REOPEN_RETRY_MS));
    return requestCameraStream();
  }
}

async function requestCameraStream() {
  // width／height／frameRate 三項都給「上限」（max）而非只給偏好：ideal 只是偏好，瀏覽器有權
  // 直接給 1080p60。ideal 仍一併給，讓它在多個合法模式中優先挑最接近我們想要的那個。
  const constraints = {
    width: { ideal: CONFIG.width, max: CONFIG.width },
    height: { ideal: CONFIG.height, max: CONFIG.height },
    frameRate: { ideal: CONFIG.frameRate, max: CONFIG.frameRate },
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  } catch (err) {
    if (err.name !== "OverconstrainedError") throw err;
    // 極少數驅動只回報固定模式、不支援降採樣，會拒絕上限約束。退回純偏好值先把畫面跑起來。
    console.warn("⚠️ 鏡頭不接受上限約束，退回偏好值重試（實際規格可能高於設定）");
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: CONFIG.width },
        height: { ideal: CONFIG.height },
        frameRate: { ideal: CONFIG.frameRate },
      },
      audio: false,
    });
  }

  // 約束只是「請求」，不同瀏覽器／驅動的套用程度不一：實際協商到的規格若明顯超出設定上限
  // （推論負擔會提高）才需要提醒，一切正常時不印。
  const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
  if (settings.width > CONFIG.width || settings.height > CONFIG.height ||
      settings.frameRate > CONFIG.frameRate + 1) {
    console.warn("⚠️ 鏡頭輸出高於設定上限——此裝置／瀏覽器未完全套用約束，推論負擔會提高");
  }
  return stream;
}

// 把一條新串流接上 <video> 並等到第一幀可用。開機（initSystem）與執行期重開（startCamera）共用。
async function attachCamera() {
  const stream = await openCamera();
  cameraStream = stream;
  video.srcObject = stream;

  // 執行期攝影機中斷（USB 被拔除、被其他應用程式搶走、驅動重置）會讓 track 觸發 ended，
  // 視為「鏡頭已關閉」：舞台提示＋系統控制 bar 的按鈕變成「開啟鏡頭」，按一下就重連。
  // 自己呼叫 track.stop() 依規格不會觸發 ended，但仍用串流身分擋掉舊串流遲來的事件。
  stream.getVideoTracks()[0]?.addEventListener("ended", () => onCameraEnded(stream));

  await video.play();
  await new Promise((resolve) => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return resolve();
    video.addEventListener("loadeddata", resolve, { once: true });
  });
  syncCanvasSize();
}

// 收掉攝影機（按鈕關閉、ended、開啟失敗的收尾共用）。reason 是舞台提示要顯示的文字
// （"" ＝ 使用者主動關閉，顯示預設的「鏡頭已關閉」）。
// 不呼叫 tracker.hardReset()：既有槽位維持原狀，重開後空著的槽位才會被新偵測到的人取用。
function detachCamera(reason) {
  stopFrameLoop();
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  video.srcObject = null;
  // srcObject 為 null 時 <video> 依規格「什麼都不呈現」；Firefox 有「最後一幀黏住」的回報，
  // 多加一個 class 讓 CSS 把它藏起來當保險（visibility，不是 display:none——之後還要靠這個元素跑 rVFC）。
  video.classList.add("is-off");
  cameraOffReason = reason;
  try { gl?.clear(gl.COLOR_BUFFER_BIT); } catch (e) { /* context 可能正在遺失 */ }
  ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  resetAllSlotDetectors();
  slotInactiveSinceMs.fill(0);
  // 讓播放器立刻知道沒有人在場（改由電腦代打），不等它的斷訊看門狗。
  emitGesturePerformanceState(EMPTY_PERFORMANCE_STATE, performance.now());
}

// start／stop／ended 一律排進同一條 promise 鏈依序執行：<video> 的 srcObject 在 play() 尚未
// resolve 時被換掉會讓 play() 以 AbortError reject；按鈕的 disabled 擋不住 ended 事件。
function enqueueCameraOp(op) {
  const run = cameraOp.then(op, op);
  cameraOp = run.catch(() => {});
  return run;
}

function setCameraState(state) {
  cameraState = state;
  refreshStageHint();
  if (cameraStateListener) {
    try { cameraStateListener(getCameraState()); }
    catch (e) { console.warn("⚠️ 鏡頭狀態監聽者拋錯", e); }
  }
}

function onCameraEnded(stream) {
  if (stream !== cameraStream) return;
  enqueueCameraOp(() => {
    if (stream !== cameraStream) return; // 排隊期間已經被換掉／關掉
    detachCamera("鏡頭已中斷，可能被拔除或被其他程式取用");
    setCameraState("off");
  });
}

// 舞台中央的提示（#stage-hint）唯一的擁有者：攝影機關閉（含中斷／開啟失敗）優先，其次是
// 「還沒選現場人數」；兩者都不成立就藏起來。JS 只切 hidden 屬性＋寫 textContent（文字沒變就不寫）。
const HINT_CAMERA_OFF = "鏡頭已關閉";
const HINT_CHOOSE_COUNT = "請在上方選擇現場人數後開始偵測";
function refreshStageHint() {
  if (!stageHint) return;
  let text = "";
  if (cameraState !== "on") text = cameraOffReason || HINT_CAMERA_OFF;
  else if (!chosenPoseCount) text = HINT_CHOOSE_COUNT;
  if (stageHint.textContent !== text) stageHint.textContent = text;
  stageHint.hidden = !text;
}

/* ═══════════════════════════════════════════
   🧠 Pose 模型載入／numPoses 實例池
   ═══════════════════════════════════════════ */
// 純粹建置，不動任何模組層狀態——這份實例在被 activate 之前都只是「建好放著」，可能是背景
// 預建的其他人數，不該搶著把 currentModelVariant／currentPoseCount 改成自己的值。
async function loadPoseModel(variant, numPoses) {
  const modelAssetPath = POSE_MODELS[variant];
  if (!modelAssetPath) throw new Error(`未知的 pose 模型：${variant}`);

  return PoseLandmarker.createFromOptions(visionFileset, {
    // 不設 baseOptions.canvas：GPU delegate 官方文件說「GPU 處理時要綁」，但那是指把畫面
    // 交給 MediaPipe 用 GPU texture 處理的情境；我們只吃 landmark 座標，畫面渲染是自己另外
    // 管理的 WebGL context（見檔案開頭），兩邊搶同一個 canvas 反而會衝突，所以刻意不設。
    baseOptions: { modelAssetPath, delegate: "GPU" },
    runningMode: "VIDEO",
    numPoses,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false // 不需要分割遮罩，明寫掉而不是靠預設值
  });
}

// 拿（或開始建）某個人數的 landmarker，一律針對 currentModelVariant；同一個人數重複呼叫共用
// 同一個建置中的 promise，不會重複建置。用 poolGeneration 擋過期結果：呼叫當下記住世代，
// 建置完成時若世代已經變了（代表使用者中途用 setPoseModel 切了變體），直接關掉這份、不放進
// 池子——避免舊變體的實例被誤當成新變體的快取。
function getPooledLandmarker(numPoses) {
  const cached = landmarkerPool.get(numPoses);
  if (cached) return cached;
  const myGeneration = poolGeneration;
  const promise = loadPoseModel(currentModelVariant, numPoses).then((landmarker) => {
    if (myGeneration !== poolGeneration) {
      landmarker.close();
      throw new Error("pose 模型變體已切換，捨棄過期的建置結果");
    }
    return landmarker;
  });
  landmarkerPool.set(numPoses, promise);
  promise.catch(() => {
    if (landmarkerPool.get(numPoses) === promise) landmarkerPool.delete(numPoses);
  });
  return promise;
}

// 背景把其餘人數都預建好，之後選人數時多半已經在池子裡、秒切換。任何一個失敗都不擋其他
// 人數也不擋主流程——這純粹是「讓之後選人數更快」的背景工作，失敗了退回「選的時候才建」，
// 行為不會比沒有這個池子差，所以失敗只 warn。
function warmUpRemainingCounts(excludeCount) {
  for (let n = 1; n <= CONFIG.maxUsers; n++) {
    if (n === excludeCount) continue;
    getPooledLandmarker(n).catch((err) => console.warn(`⚠️ 背景預建 numPoses=${n} 失敗`, err));
  }
}

/* ═══════════════════════════════════════════
   🚀 初始化流程
   ═══════════════════════════════════════════ */
async function initSystem() {
  try {
    setStatus("正在初始化 WebGL 渲染引擎⋯");
    initWebGL();

    setStatus("正在載入 WASM 視覺模組⋯");
    visionFileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );

    setStatus("正在載入 Pose 模型⋯");
    poseLandmarker = await getPooledLandmarker(DEFAULT_POSE_COUNT);
    currentPoseCount = DEFAULT_POSE_COUNT;
    warmUpRemainingCounts(DEFAULT_POSE_COUNT); // 背景預建其餘人數，不 await、不擋開機流程

    setStatus("正在啟動鏡頭⋯");
    // 開機走的就是系統控制 bar 「開啟鏡頭」同一條路，只是失敗時這裡仍視為致命（error overlay）。
    await startCamera();

    // 載入畫面不在這裡收起：要等 MIDI 引擎那一路也就緒（見 main.js 的 bootSystem）。
    return true;

  } catch (err) {
    console.error("初始化失敗：", err);
    const [title, detail] = cameraErrorText(err, "初始化失敗");
    showError(title, detail);
    return false;
  }
}

/* ═══════════════════════════════════════════
   🔌 外部 API 與快捷鍵
   ═══════════════════════════════════════════ */
// 重置骨架 ID：釋放所有已鎖定的槽位、候選名單與身分記憶，讓下一幀重新鎖定
export function hardReset() {
  tracker.hardReset();
  resetAllSlotDetectors();
  slotInactiveSinceMs.fill(0);
  emitGesturePerformanceState(EMPTY_PERFORMANCE_STATE, performance.now());
  ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// 註冊「手勢演奏狀態」的監聽者（main.js 把它接到播放器的 setGesturePerformanceState）。
// 每次回呼收到 { arcTriggerSeqBySlot: {1..maxUsers → 拋物線觸發的累加計數，變動代表有新的
// 一次有效拋物線}, presentSlots: [在場的 ID] }。
export function setPerformanceStateListener(fn) {
  performanceStateListener = typeof fn === "function" ? fn : null;
}

// 目前使用中的 pose 模型變體（"lite" / "full" / "heavy"）
export function getPoseModelVariant() {
  return currentModelVariant;
}

// 執行期切換 pose 模型。lite 抖動明顯時可切到 full／heavy 換取穩定度，代價是推論較慢。
// 目前只有 lite 在用，這條路徑很少被呼叫：整個實例池是綁著「單一模型變體」設計的（池子只
// 存這個變體的 1~maxUsers 份），切變體代表舊變體那些實例全部沒用了，作廢重建。
export async function setPoseModel(variant) {
  if (!POSE_MODELS[variant]) throw new Error(`未知的 pose 模型：${variant}`);
  if (!visionFileset || variant === currentModelVariant) return;

  const previousVariant = currentModelVariant;
  const staleEntries = [...landmarkerPool.entries()]; // [numPoses, promise][]，切失敗時要復原
  poolGeneration++; // 讓舊變體所有建置中／已建好的池子項目在完成時自己作廢
  landmarkerPool.clear();
  currentModelVariant = variant;

  const activeCount = currentPoseCount;
  let landmarker;
  try {
    landmarker = await getPooledLandmarker(activeCount);
  } catch (err) {
    // 新變體建置失敗：把舊變體的池子復原、變體名稱改回去，舊實例都還活著、沒被關掉，
    // poseLandmarker 也沒被動過，行為等同「這次切換沒發生過」。
    console.error(`❌ 切換 pose 模型失敗（${variant}），還原為 ${previousVariant}`, err);
    poolGeneration++; // 再 +1：萬一剛剛失敗的建置晚一步才 resolve，也不會被誤當成當前世代
    currentModelVariant = previousVariant;
    landmarkerPool = new Map(staleEntries);
    throw err;
  }
  poseLandmarker = landmarker;
  currentPoseCount = activeCount;
  warmUpRemainingCounts(activeCount);

  // 舊變體的實例確定沒人用了才關掉（等它們各自 resolve，避免正在切換空窗期 processFrame
  // 手上還拿著即將被關閉的舊實例）。
  for (const [, entry] of staleEntries) {
    entry.then((lm) => { if (lm !== landmarker) lm.close(); }).catch(() => {});
  }
}

// 「現場人數」確定之後的監聽者（main.js 把它接到播放器的 setPlayerCount：分譜的「指派演奏者」
// 下拉跟著列到 n）。跟 setCameraStateListener 同一種寫法。
let poseCountListener = null;
export function setPoseCountListener(fn) {
  poseCountListener = typeof fn === "function" ? fn : null;
}

// 系統控制 bar 選的「現場人數」；0 ＝ 還沒選（此時不推論）。
// 不是 landmarker 的 numPoses（那是 currentPoseCount，開頁就預建成 4）。
export function getPoseCount() {
  return chosenPoseCount;
}

// 系統控制 bar 「現場人數」：從實例池拿（或等）對應人數的 landmarker，切成使用中，並武裝
// 偵測。池子裡已經有的話幾乎是同步完成，不會有感延遲；還沒有的話退回等待建置完成，行為
// 跟沒有池子時一樣。latestRequestedPoseCount 確保連續快速切換時最後一次呼叫才會真的生效
// （不會因為前一次呼叫晚 resolve 而把畫面切回舊的人數）。
export async function setPoseCount(count) {
  if (!Number.isInteger(count) || count < 1 || count > CONFIG.maxUsers) {
    throw new Error(`現場人數必須是 1~${CONFIG.maxUsers} 的整數：${count}`);
  }
  if (!visionFileset) throw new Error("視覺系統尚未就緒，無法設定現場人數");
  latestRequestedPoseCount = count;
  const landmarker = await getPooledLandmarker(count);
  if (latestRequestedPoseCount !== count) return; // 等待期間使用者又選了別的人數，這次不算數
  poseLandmarker = landmarker;
  currentPoseCount = count;
  applyPoseCount(count);
}

// 人數確定之後：武裝偵測、追蹤層的槽位數（＝ ID 上限）跟著人數走。換槽位數要重建
// PersonTracker，效果等於「重置骨架 ID」。人數沒變就只是武裝偵測。
function applyPoseCount(count) {
  chosenPoseCount = count;
  if (tracker.cfg.maxUsers !== count) {
    tracker = new PersonTracker({ maxUsers: count });
    resetAllSlotDetectors();
    slotInactiveSinceMs.fill(0);
    ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    emitGesturePerformanceState(EMPTY_PERFORMANCE_STATE, performance.now());
  }
  refreshStageHint();
  if (poseCountListener) {
    try { poseCountListener(count); }
    catch (e) { console.warn("⚠️ 現場人數監聽者拋錯", e); }
  }
}

/* ═══════════════════════════════════════════
   📷 攝影機開關（系統控制 bar 的按鈕；開機也走同一條路）
   ═══════════════════════════════════════════ */
// 監聽者收到 { on, busy, message }：on ＝ 攝影機開著、busy ＝ 開啟／關閉進行中（按鈕該 disabled）、
// message ＝ 關閉的原因或開啟失敗的文字（"" ＝ 使用者自己關的）。ui.js 用它畫按鈕與狀態列。
export function getCameraState() {
  return {
    on: cameraState === "on",
    busy: cameraState === "starting" || cameraState === "stopping",
    message: cameraOffReason,
  };
}

export function setCameraStateListener(fn) {
  cameraStateListener = typeof fn === "function" ? fn : null;
}

// 開啟攝影機（已開著就直接返回）。失敗時把 srcObject 等收乾淨、把原因留在 message 再拋出——
// attachCamera 可能已經把串流接上才失敗（play() 被拒），不能留半套狀態。
export function startCamera() {
  return enqueueCameraOp(async () => {
    if (cameraState === "on") return;
    setCameraState("starting");
    try {
      await attachCamera();
      video.classList.remove("is-off");
      startFrameLoop();
      cameraOffReason = "";
      setCameraState("on");
    } catch (err) {
      detachCamera(cameraErrorText(err).join("："));
      setCameraState("off");
      throw err;
    }
  });
}

// 關閉攝影機（已關著就直接返回）：停迴圈、停 track、清畫面、通知播放器沒有人在場。
export function stopCamera() {
  return enqueueCameraOp(async () => {
    if (cameraState === "off") return;
    setCameraState("stopping");
    detachCamera("");
    setCameraState("off");
  });
}

/* ═══════════════════════════════════════════
   🧹 資源清理
   ═══════════════════════════════════════════ */
window.addEventListener("beforeunload", () => {
  stopFrameLoop();
  cameraStream?.getTracks().forEach((t) => t.stop());
  // poseLandmarker 只是池子裡「目前使用中」的那份，其餘背景預建的實例也要一起關掉。
  for (const entry of landmarkerPool.values()) entry.then((lm) => lm.close()).catch(() => {});

  if (gl) {
    gl.deleteTexture(glTexture);
    gl.deleteProgram(glProgram);
    const ext = gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
});

/* ═══════════════════════════════════════════
   ▶️ 啟動（必須由呼叫端明確呼叫）
   ═══════════════════════════════════════════ */
// 啟動攝影機與姿勢偵測。由 main.js 明確呼叫 startVision()，不靠模組頂層的 import 副作用啟動
// （那樣「攝影機會不會開」會取決於有沒有人 import 到這個檔案，搬動 import 就默默黑畫面）。
// 回傳 promise，resolve 值為是否初始化成功（失敗時已經經由 onError 回呼顯示錯誤畫面）。
// 重複呼叫安全：一律回傳同一個 promise，不會啟動第二次。
let startPromise = null;
export function startVision({ onStatus: statusFn, onError: errorFn } = {}) {
  if (!startPromise) {
    onStatus = typeof statusFn === "function" ? statusFn : null;
    onError = typeof errorFn === "function" ? errorFn : null;
    startPromise = initSystem();
  }
  return startPromise;
}
