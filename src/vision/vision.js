// vision.js — 攝影機、WebGL 視訊與骨架繪製、姿勢模型生命週期；逐幀呼叫追蹤（tracking.js）與手勢（gesture.js），送出手勢狀態（main.js 註冊 input/gestureTrigger.js 接收）

import { PersonTracker, buildDetection } from "./tracking.js";
import {
  MP_LEFT_WRIST, MP_RIGHT_WRIST, MP_LEFT_ELBOW, MP_RIGHT_ELBOW, MP_LEFT_SHOULDER, MP_RIGHT_SHOULDER,
  updateGestures, resetGestures,
} from "./gesture.js";

const CONFIG = {
  // 攝影機解析度與幀率的「上限」（getUserMedia 用 max 而非只給 ideal）：外接攝影機的原生模式常是 1080p60，真的拿到會讓每幀多搬四倍像素、rVFC 一秒觸發 60 次推論，多數機器跟不上；
  // 用 max 收成硬上限後瀏覽器會自行降採樣，實際協商到的規格若超出會在 console 警告。
  width: 854,
  height: 480,
  frameRate: 30,
  maxUsers: 4, // 最多鎖定並顯示的目標人數
};

// 只用 lite 模型（最快、抖動也最明顯，但足夠用）。CDN 為主、本地副本為備：Google 官方 storage 的 /1/ 是釘死的版本（內容與本地副本逐位元相同），實測比 GitHub Pages 快得多（0.6 秒 vs 100 秒以上）；
// CDN 失敗（網路錯誤、HTTP 錯誤、下載到一半斷線、檔案壞了）才改載本地。不用逾時當備援條件——慢不等於壞。
const POSE_MODEL_URLS = [
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  "./src/assets/pose_landmarker_lite.task",
];
let poseModelIndex = 0; // Worker 回報的目前來源（POSE_MODEL_URLS 的索引）；改用本地之後 warmPoseModel() 不再暖 CDN

// 暖機：載入畫面收起之後，用低優先序的 fetch 把姿勢模型（約 5.8MB）先抓進 HTTP 快取（Google storage 的 Cache-Control: public, max-age=3600），使用者第一次選現場人數時 MediaPipe 對同一個 URL 的請求直接命中。
// 不用 <link rel="preload">：模型要等選了人數才會用到，沒在幾秒內用掉 Chrome 會在 console 報黃色警告；呼叫端也刻意等開機完成才叫，不跟開頁時 8.4MB 的音色庫搶頻寬。失敗不處理：之後真的載入時會走備援並留下 warn。
export function warmPoseModel() {
  if (poseModelIndex !== 0) return;   // 已改用本地副本，不必暖 CDN
  fetch(POSE_MODEL_URLS[0], { priority: "low" }).then((r) => r.arrayBuffer()).catch(() => {});
}

// MediaPipe 的 numPoses（同時追幾個人）決定它的工作模式：「追到的人數 ≥ numPoses」時偵測器跳過、每個人的 ROI 由上一幀的 landmark 延續——沒有幽靈骨架、節點最穩；
// 「追到的人數 < numPoses」時偵測器每幀重跑，幽靈與抖動都是這個狀態的產物。設小了多出來的人不會被偵測到，這是設定的字面意思。
// landmarker 在 Worker（poseWorker.js）裡、只有一份：選了「現場人數」N 才建 numPoses=N 的那份，之後換人數用 setOptions() 原地更新；追蹤層的槽位數（＝ ID 上限）也設成 N（setPoseCount）。
// 推論放在 Worker：detectForVideo 是同步的、會卡住呼叫它的執行緒（官方文件），放在主執行緒時按鍵、按鈕與伴奏排程都要排隊等它（見 docs/mediapipe-performance-reference.md）。

const POSE_COLORS = ["#00FFFF", "#FF6B6B", "#51CF66", "#FFD43B"]; // 4 人的代表色彩（依鎖定槽位對應）
const BONE_WIDTH = 2;      // 骨架連線寬度（px）
const JOINT_RADIUS = 2;    // 關節圓點半徑（px）
const TAU = Math.PI * 2;
// 嘴巴中點正下方的虛擬「下巴」節點偏移量：以肩寬為單位（同 ArcDetector 門檻、ID 標籤字級的慣例），人離鏡頭遠近不同時比例才一致。
// 原本 0.18 是在混合單位下訂的（肩寬以畫面寬、往下的距離以畫面高為單位），2026-10-28 換成同一把尺時乘上 16:9 的 0.5625，畫出來的位置不變
const CHIN_OFFSET_RATIO = 0.10;

const FRAME_ERROR_THRESHOLD = 90; // 連續幾幀處理失敗才判定為持續性錯誤並顯示錯誤畫面（約 1.5~3 秒）

// 誰匹配誰、新面孔何時鎖定空位，都在 tracking.js。let 而非 const：槽位數要跟「現場人數」走（applyPoseCount 會用新的 maxUsers 重建）。
let tracker = new PersonTracker({ maxUsers: CONFIG.maxUsers });

// 手勢（gesture.js 的 updateGestures()）：每幀算出「每個槽位（＝演奏者 ID）的拋物線觸發序號」＋「這一幀真的在場的槽位」，
// 經 setPerformanceStateListener 註冊的回呼送出。main.js 註冊 input/gestureTrigger.js 的監聽，揮手與鍵盤並存。
const EMPTY_PERFORMANCE_STATE = { arcTriggerSeqBySlot: {}, arcTroughMsBySlot: {}, presentSlots: [] };

let performanceStateListener = null;
let lastSentState = null;
let lastEmitMs = 0;            // 上一次真的送出的時刻（心跳用，見 emitGesturePerformanceState）
// 接收端若有斷訊看門狗，它的門檻必須明顯大於這個心跳間隔。
const EMIT_HEARTBEAT_MS = 100;

// 逐幀紀錄（開發用）：console 的 copy(__visionLog()) 匯出。遮住一隻手時手點互相干擾、選的人數比現場人數多時多出來的幽靈 ID，都要有逐幀的原始資料才查得出來；
// 也是不同現場人數下主執行緒負擔（推論與整幀耗時）的來源，見 main.js 的 __latency()。每幀一列；滿了一次丟最舊的八分之一，免得每筆 shift()。
// 只記演奏中（main.js 依播放狀態切 setFrameLogRecording）：停下來切 DevTools 打指令時鏡頭拍到的打字的手不會混進紀錄。
const FRAME_LOG_MAX = 20000;       // 30fps 約 11 分鐘
const TRACKER_EVENT_LOG_MAX = 3000;
let frameLog = [];
let trackerEvents = [];
let frameLogRecording = false;
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);
const r4 = (v) => (v === null || v === undefined ? null : Math.round(v * 10000) / 10000);
// 「節點」欄記脖子以下全部 22 點（11～32：肩、肘、腕、手掌、髖、膝、踝、腳跟、腳尖；v4／v5 只到 24）：調過濾器與尺度用（test/tools/pose-filter-eval.mjs），
// 也留給之後的肢體動作。不在記錄時依 presence 篩點：「猜出來的點」本身就是要從紀錄量門檻的資料
const LOG_JOINTS = Array.from({ length: 22 }, (_, i) => 11 + i);

// 33 個點外框的 (寬＋高) ÷ 2（正規化座標），參考用：MediaPipe 的 pose 平滑不用它，用的是推論框（landmarks_smoothing_calculator.cc 的 OBJECT_SCALE_ROI），拿不到
function landmarkBoxScale(lm) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of lm) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return (maxX - minX + maxY - minY) / 2;
}

function jointRow(track) {
  const { raw, rawWorld, smoothed } = track;
  return [
    track.slot + 1, r3(landmarkBoxScale(raw)),
    ...LOG_JOINTS.flatMap((j) => [r3(raw[j].x), r3(raw[j].y), r3(raw[j].visibility)]),
    ...LOG_JOINTS.flatMap((j) => (rawWorld ? [r4(rawWorld[j].x), r4(rawWorld[j].y), r4(rawWorld[j].z)] : [null, null, null])),
    ...LOG_JOINTS.flatMap((j) => [r3(smoothed[j].x), r3(smoothed[j].y)]),
    ...LOG_JOINTS.map((j) => r3(raw[j].presence)),
  ];
}

function recordFrame(ts, startMs, detectMs, rawCount, detections, activeTracks, gestureRows, captureLagMs, detectorRan, resultLagMs) {
  const events = tracker.drainEvents();   // 不記的時候也要取走，不然追蹤層的事件一直累積
  if (!frameLogRecording) return;
  const rawBySlot = new Map(activeTracks.map((t) => [t.slot + 1, t.raw]));
  const wrist = (raw, i) => (raw ? [r3(raw[i].x), r3(raw[i].y), r3(raw[i].visibility)] : [null, null, null]);
  frameLog.push([
    Math.round(ts), chosenPoseCount, rawCount, r1(detectMs), r1(performance.now() - startMs),
    detections.map((d) => [r3(d.centroid.x), r3(d.centroid.y), r3(d.scale), r3(d.meanVisibility), d.strictPlausible ? 1 : 0]),
    gestureRows.map(([id, sw, lx, ly, rx, ry, lock, seq]) => {
      const raw = rawBySlot.get(id);
      return [id, r3(sw), r3(lx), r3(ly), r3(rx), r3(ry), lock, seq, ...wrist(raw, MP_LEFT_WRIST), ...wrist(raw, MP_RIGHT_WRIST)];
    }),
    captureLagMs === null ? null : r1(captureLagMs), detectorRan, resultLagMs === null ? null : r1(resultLagMs),
    activeTracks.map(jointRow),
  ]);
  if (frameLog.length > FRAME_LOG_MAX) frameLog.splice(0, frameLog.length - (FRAME_LOG_MAX - (FRAME_LOG_MAX >> 3)));
  trackerEvents.push(...events);
  if (trackerEvents.length > TRACKER_EVENT_LOG_MAX) trackerEvents.splice(0, trackerEvents.length - (TRACKER_EVENT_LOG_MAX - (TRACKER_EVENT_LOG_MAX >> 3)));
}

// 播放中才記（暫停、曲終、試聽不記）；clearFrameLog() 在從頭開始播時清空，跟按鍵錄音同一個起點
export function setFrameLogRecording(on) { frameLogRecording = on; }
export function clearFrameLog() { frameLog = []; trackerEvents = []; }

// 匯出這一段演奏的逐幀紀錄與追蹤層事件（seconds 有給就只取最後一幀往回 seconds 秒）；欄位說明附在資料裡。
export function visionLog(seconds = null) {
  const from = seconds === null ? -Infinity : (frameLog.at(-1)?.[0] ?? 0) - seconds * 1000;
  return {
    version: 6,
    exportedAt: new Date().toISOString(),
    seconds,
    poseCount: chosenPoseCount,
    cameraOn: cameraState === "on",
    video: { w: video.videoWidth || CONFIG.width, h: video.videoHeight || CONFIG.height },
    columns: {
      frame: ["t（送去推論的時刻；沒推論時是處理時刻；performance.now，ms）", "現場人數", "MediaPipe 偵測筆數", "推論ms（在 Worker）", "主執行緒處理ms",
        "偵測[[肩中點 x, y, 尺度（v3 以前是肩寬）, 平均可見度, 嚴格可信 0/1]]",
        "追蹤[[ID, 尺度, 左手腕 x, y, 右手腕 x, y（平滑後，手腕不可見是 null；v3 以前是肩寬與手腕＋手掌合併點）, 鎖定的手, 累加計數, 原始左腕 x, y, 可見度, 原始右腕 x, y, 可見度]]",
        "拍下→送出ms（rVFC 的 captureTime；瀏覽器沒提供是 null）", "偵測器可能有跑（上一次偵測筆數 < numPoses 是 1，否則 0；沒推論是 null）",
        "拍下→結果進主執行緒ms（沒有拍下時刻時從送出算起；沒推論是 null）",
        `節點[[ID, 33 點外框尺度（參考用，不是 MediaPipe 平滑的尺度）, 原始 x, y, 可見度 ×${LOG_JOINTS.length} 點, world x, y, z（公尺）×${LOG_JOINTS.length} 點, 平滑後 x, y ×${LOG_JOINTS.length} 點, 原始 presence ×${LOG_JOINTS.length} 點（v5 起；在畫面範圍內的機率，模型沒給是 null）]]，點依序是 ${LOG_JOINTS.join(",")}（v6 起；v4／v5 是 11～24）`],
      trackerEvent: "{ t, type: lock｜loss｜duplicate, slot（ID）；lock 另有 scale 尺度、vis 平均可見度、strict }",
    },
    frames: frameLog.filter((f) => f[0] >= from),
    trackerEvents: trackerEvents.filter((e) => e.t >= from),
  };
}

// 依現場人數分組的幀耗時（main.js 的 __latency() 用）。segments＝同一個人數連續的時間段（幀間隔超過 1 秒就斷開，鏡頭關著的空檔不算），排程 tick 的間隔靠它歸到對應的人數。
// end＝段內最後一幀處理完的時刻的下限（送出→推論→主執行緒處理依序發生，傳遞時間不計）：佔比的分母算到這裡，比例不會超過 100%。
export function visionFrameStats() {
  const byCount = {}, segments = [];
  for (const [t, count, , detectMs, frameMs, , tracks, captureLagMs, detectorRan, resultLagMs] of frameLog) {
    if (!count) continue;
    const g = (byCount[count] ??= { frames: 0, detectMs: [], frameMs: [], present: 0, detectWithDetector: [], detectTrackingOnly: [], captureLagMs: [], resultLagMs: [] });
    g.frames++; g.detectMs.push(detectMs); g.frameMs.push(frameMs); g.present += tracks.length;
    if (detectorRan === 1) g.detectWithDetector.push(detectMs);
    else if (detectorRan === 0) g.detectTrackingOnly.push(detectMs);
    if (captureLagMs !== null) g.captureLagMs.push(captureLagMs);
    if (resultLagMs !== null) g.resultLagMs.push(resultLagMs);
    const end = t + detectMs + frameMs;
    const last = segments.at(-1);
    if (last && last.count === count && t - last.to < 1000) { last.to = t; last.end = end; }
    else segments.push({ count, from: t, to: t, end });
  }
  return { byCount, segments };
}

export const getCameraInfo = () => cameraInfo;

function performanceStatesDiffer(a, b) {
  if (!a || !b) return true;
  if (a.presentSlots.length !== b.presentSlots.length) return true;
  for (let i = 0; i < a.presentSlots.length; i++) {
    if (a.presentSlots[i] !== b.presentSlots[i]) return true;
  }
  // triggerSeq 是離散事件的累加計數：任何變動都代表「有新的拋物線谷底」，一定要送，不能只在超過門檻時才送。
  for (let id = 1; id <= CONFIG.maxUsers; id++) {
    if ((a.arcTriggerSeqBySlot[id] || 0) !== (b.arcTriggerSeqBySlot[id] || 0)) return true;
  }
  return false;
}

// 只在 arcTriggerSeqBySlot 有意義變化時才送，免得每幀都打一次——但再久也一定會送一次（心跳），因為「沒有變化」跟「沒有訊號」是兩件事。
// 有了心跳，接收端的斷訊看門狗才是字面意思：真的沒有幀在跑（分頁切走、迴圈停掉）。
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

// requestVideoFrameCallback（rVFC）只在新幀到達時觸發，比 rAF 輪詢省電也準；不支援時 scheduleNextFrame() 降級為 requestAnimationFrame。
const useRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;

const video = document.getElementById("webcam");
const glCanvas = document.getElementById("gl-canvas");
const overlayCanvas = document.getElementById("overlay-canvas");
const ctx2d = overlayCanvas.getContext("2d");

// 載入畫面的狀態文字與錯誤畫面不在這裡畫：由 startVision({ onStatus, onError }) 的回呼交給 src/ui.js（遮罩的唯一擁有者）。
let onStatus = null;
let onError = null;
const stageHint = document.getElementById("stage-hint"); // 舞台中央的提示（攝影機關閉／還沒選現場人數）

let poseWorker = null;          // 姿勢推論的 Worker（startPoseWorker()）；null ＝ 還沒載入
let landmarkerReady = false;    // Worker 裡的 landmarker 建好了（第一次選人數之後）
let inFlight = null;            // 送進 Worker、還沒拿到結果的那一張：{ ts, captureTime, captureLagMs, detectorRan }；同一時間只送一張
let pendingFrame = null;        // 等結果期間又來的新畫面（只記最新一張的拍下時刻）：結果一回來就送，不等下一次 rVFC
let configureSeq = 0;           // 換人數的請求編號：等待期間又選了別的人數，舊的這次不算數
const pendingCalls = new Map(); // Worker 請求編號 → { resolve, reject }
let gl = null;      // WebGL context
let glTexture = null;      // video texture
let glProgram = null;      // shader program
let consecutiveFrameErrors = 0; // 連續幀處理失敗計數，超過 FRAME_ERROR_THRESHOLD 才視為持續性錯誤
let lastProcessedVideoTime = -1; // 上一次真的送去推論的 video.currentTime（rAF 降級路徑用來跳過重複幀）
let currentPoseCount = 0; // 目前使用中的 landmarker 的 numPoses；0 ＝ 還沒建過任何一份
let chosenPoseCount = 0;  // 系統控制 bar 選的「現場人數」；0 ＝ 還沒選 ＝ 不推論
let lastRawCount = 0;     // 上一次推論的偵測筆數：小於 numPoses 時 MediaPipe 這一幀會重跑偵測器（pose_landmarker_graph.cc 的跳過條件），逐幀紀錄據此標記
// 下一張送去推論的換成空白畫面（重置骨架 ID、鏡頭關掉後立起）：MediaPipe 追到的人數夠了就不再找人，一直跟著原本追到的人；空白畫面讓它這張追丟、下一張重跑偵測器，等同用手遮一下鏡頭
let forgetTracking = false;
let cameraInfo = null;    // 鏡頭實際協商到的規格與可調範圍（__latency 用），見 describeCamera()

// frameHandle：已排程的下一幀代號（rVFC 與 rAF 的 id 都 ≥ 1，0＝沒有排程中的回呼）。isLoopStopped：迴圈停止中（攝影機關閉、致命錯誤）；已排隊的回呼另外真的取消掉（stopFrameLoop），旗標只是第二道防線。
let frameHandle = 0;
let isLoopStopped = true;

let cameraStream = null;          // 開啟中的 MediaStream；null ＝ 關閉
let cameraState = "off";          // "off" | "starting" | "on" | "stopping"
let cameraOffReason = "";         // 關閉時舞台提示的文字；"" ＝ 使用者主動關閉（顯示預設文字）
let cameraOp = Promise.resolve(); // start／stop／ended 序列化用的 promise 鏈
let cameraStateListener = null;

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

// GPU driver 重置／分頁長時間背景化可能造成 WebGL context 遺失；不 preventDefault() 瀏覽器就不會嘗試恢復，恢復後重新 initWebGL() 重建 shader／texture／buffer。
glCanvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  console.warn("⚠️ WebGL context 遺失，等待瀏覽器恢復…");
});
glCanvas.addEventListener("webglcontextrestored", () => {
  try { initWebGL(); } catch (err) { showError("WebGL 恢復失敗", String(err)); }
});

// 畫布尺寸跟著實際視訊尺寸走；#canvas-container 滿版、子 canvas 是 object-fit:cover，裁切由 CSS 處理，不需要 JS 介入。
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

function uploadVideoTexture(source) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

// source："sent"＝畫送出推論前已上傳的那一張（sendFrame）；"live"＝沒有推論時，上傳 <video> 當下這張再畫
function renderVideoGL(source) {
  if (source === "live") uploadVideoTexture(video);
  else {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
  }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function isFacePoint(i) { return i >= 0 && i <= 10; }

// 兩肩中點當虛擬「脖子」節點——MediaPipe Pose 沒有脖子 landmark。
function virtualNeckPoint(lm) {
  const ls = lm[MP_LEFT_SHOULDER], rs = lm[MP_RIGHT_SHOULDER];
  if (!(ls.visible ?? true) || !(rs.visible ?? true)) return null;
  return { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
}

// 嘴巴兩節點中點下方的虛擬「下巴」節點，供骨架畫成倒三角形（見 renderSkeletonOverlay()）。shoulderWidth 以畫面寬為單位，往下的距離除以 aspect 換回以畫面高為單位。
function virtualChinPoint(lm, shoulderWidth, aspect) {
  const left = lm[9], right = lm[10];
  if (!(left.visible ?? true) || !(right.visible ?? true)) return null;
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2 + CHIN_OFFSET_RATIO * shoulderWidth / aspect,
  };
}

// 精簡骨架只畫手臂鏈（肩-肘-手腕-手掌）＋臉部簡化輪廓，不畫全身連線（髖／膝／踝／腳掌沒有被任何手勢或播放邏輯讀取）。
// 手照 MediaPipe 原本的節點與連線（POSE_CONNECTIONS 的手部那幾條）：手腕、小指、食指、拇指各一點，兩隻手都畫。
const ARM_CONNECTIONS = [
  [MP_LEFT_SHOULDER, MP_LEFT_ELBOW], [MP_RIGHT_SHOULDER, MP_RIGHT_ELBOW],
  [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
];
const ARM_JOINTS = [MP_LEFT_SHOULDER, MP_RIGHT_SHOULDER, MP_LEFT_ELBOW, MP_RIGHT_ELBOW, 15, 16, 17, 18, 19, 20, 21, 22];
// 臉部只標關鍵五官：雙眼（2/5）、鼻子（0）各畫一個獨立節點、不連線；嘴巴兩節點（9/10）加上虛擬下巴節點（virtualChinPoint()）連成倒三角形。
const MOUTH_PAIR = [9, 10];

// 2D 覆蓋層繪製骨架：依鎖定槽位上色，同一人跨幀顏色不變。
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

    // 低可見度（遮擋/猜測）的關節不繪製。visible 由 tracking.js 算好（可見度先 EMA 平滑、再套遲滯門檻），這裡不自己比門檻，否則邊緣關節會逐幀閃爍。骨架累積成 Path2D 後一次畫完，不用 DrawingUtils 逐條逐點畫。
    const lm = track.smoothed;
    const ls = lm[MP_LEFT_SHOULDER], rs = lm[MP_RIGHT_SHOULDER];
    const shoulderWidth = Math.hypot(ls.x - rs.x, (ls.y - rs.y) * track.aspect);
    const neck = virtualNeckPoint(lm);
    const chin = virtualChinPoint(lm, shoulderWidth, track.aspect);

    const bones = new Path2D();
    for (const [a, b] of ARM_CONNECTIONS) {
      const p = lm[a], q = lm[b];
      if (!(p.visible ?? true) || !(q.visible ?? true)) continue;
      bones.moveTo(p.x * W, p.y * H);
      bones.lineTo(q.x * W, q.y * H);
    }
    if (neck) {
      bones.moveTo(ls.x * W, ls.y * H); bones.lineTo(neck.x * W, neck.y * H);
      bones.moveTo(rs.x * W, rs.y * H); bones.lineTo(neck.x * W, neck.y * H);
    }
    if (chin) {
      const mLeft = lm[MOUTH_PAIR[0]], mRight = lm[MOUTH_PAIR[1]];
      bones.moveTo(mLeft.x * W, mLeft.y * H); bones.lineTo(mRight.x * W, mRight.y * H);
      bones.moveTo(mRight.x * W, mRight.y * H); bones.lineTo(chin.x * W, chin.y * H);
      bones.moveTo(chin.x * W, chin.y * H); bones.lineTo(mLeft.x * W, mLeft.y * H);
    }
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = BONE_WIDTH;
    ctx2d.stroke(bones);

    // 關節點：手臂鏈（含手腕與手掌三點）、脖子、下巴；雙眼與鼻子各畫一個獨立節點、不連線。
    const joints = new Path2D();
    const addJoint = (x, y, radius) => {
      // arc 從角度 0（圓的右端）起筆，先 moveTo 過去，否則會從上一個圓拉一條線過來
      joints.moveTo(x + radius, y);
      joints.arc(x, y, radius, 0, TAU);
    };
    // 0=鼻子、2=左眼中心、5=右眼中心、9/10=嘴角（見 MOUTH_PAIR）。
    for (const i of [...ARM_JOINTS, 0, 2, 5, MOUTH_PAIR[0], MOUTH_PAIR[1]]) {
      const p = lm[i];
      if (!(p.visible ?? true)) continue;
      addJoint(p.x * W, p.y * H, JOINT_RADIUS);
    }
    if (neck) addJoint(neck.x * W, neck.y * H, JOINT_RADIUS);
    if (chin) addJoint(chin.x * W, chin.y * H, JOINT_RADIUS);
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

// rVFC 回呼帶 (now, metadata)，rAF 降級路徑只有 now：metadata.captureTime＝攝影機拍下這張的時刻，用來量「拍下→送出」與「拍下→結果進主執行緒」。
function processFrame(_now, metadata) {
  frameHandle = 0;           // 這一次回呼已經觸發，沒有排程中的了（startFrameLoop 據此決定要不要排新的）
  if (isLoopStopped) return; // 已停止：連已排隊的回呼也一併作廢（取消失敗時的第二道防線）

  // rAF 降級路徑：rAF 跟著螢幕更新率（常見 60Hz）跑，攝影機多半只有 30fps，不比對的話同一張視訊幀會被送進 MediaPipe 兩次；rVFC 路徑只在新幀到達時觸發，不需要這道檢查。
  if (!useRVFC) {
    if (video.currentTime === lastProcessedVideoTime) {
      scheduleNextFrame();
      return;
    }
    lastProcessedVideoTime = video.currentTime;
  }

  // 單一幀的任何例外都不該讓整條追蹤迴圈永久卡死：吞下例外、跳過這一幀，下一幀繼續；連續失敗超過 FRAME_ERROR_THRESHOLD 幀才顯示錯誤畫面並停止。
  try {
    syncCanvasSize();
    const captureTime = metadata?.captureTime ?? null;
    if (landmarkerReady && chosenPoseCount) {
      // ▶ MediaPipe 偵測（上限 currentPoseCount）在 Worker：同一時間只送一張，結果回來才做追蹤／手勢／繪製（handlePoseResult）；等結果期間來的畫面只記最新一張
      if (inFlight) pendingFrame = { captureTime };
      else sendFrame(captureTime);
    } else {
      // ▶ 還沒選「現場人數」或模型還沒建好就不推論；其餘管線照跑：tracker.update([]) 讓舊 track 自然過期、心跳照送 presentSlots: []、攝影機畫面照畫（不凍結）。
      const nowMs = performance.now();
      runPipeline(nowMs, nowMs, [], 0, captureTime === null ? null : nowMs - captureTime, null, null, [], "live");
    }
  } catch (err) {
    frameFailed(err);
  }

  scheduleNextFrame();
}

function frameFailed(err) {
  consecutiveFrameErrors++;
  console.error(`⚠️ 幀處理失敗（連續第 ${consecutiveFrameErrors} 次）：`, err);
  if (consecutiveFrameErrors > FRAME_ERROR_THRESHOLD) {
    stopFrameLoop(); // 停止排程下一幀，避免無意義地持續狂噴同一個錯誤
    showError("姿勢追蹤發生持續性錯誤", "請重新整理頁面。若問題持續發生，請確認鏡頭或顯示卡驅動狀態。");
  }
}

// 把目前這一張畫面交給 Worker。ts＝送出時刻：detectForVideo 的時間戳（必須遞增），也是這張畫面在追蹤與手勢裡的時刻。
function sendFrame(captureTime) {
  const ts = performance.now();
  pendingFrame = null;   // 取的是 video 當下最新的一張，等著的那張已經包含在內
  inFlight = { ts, captureTime, captureLagMs: captureTime === null ? null : ts - captureTime, detectorRan: lastRawCount < currentPoseCount ? 1 : 0 };
  const source = forgetTracking ? new ImageData(video.videoWidth || CONFIG.width, video.videoHeight || CONFIG.height) : video;
  forgetTracking = false;
  const blank = source !== video;
  createImageBitmap(source).then(
    (bitmap) => {
      if (isLoopStopped || !poseWorker) { bitmap.close(); inFlight = null; return; }
      // 背景要畫送去推論的這一張（結果回來時 renderVideoGL("sent")），骨架才跟畫面裡的手是同一個瞬間；bitmap 交給 Worker 之後就不能用，所以先上傳。
      // 空白畫面（重置 ID、重開鏡頭）那一次改傳當下的畫面：貼圖裡可能還是關鏡頭之前的舊畫面；這一幀追蹤層沒有可畫的骨架，不會不同步
      uploadVideoTexture(blank ? video : bitmap);
      poseWorker.postMessage({ type: "detect", bitmap, ts }, [bitmap]);
    },
    (err) => { inFlight = null; frameFailed(err); },
  );
}

function handlePoseResult({ ts, inferMs, landmarks, worldLandmarks }) {
  const sent = inFlight;
  inFlight = null;
  if (!sent || sent.ts !== ts || isLoopStopped) return;   // 鏡頭關掉之後才回來的結果不用
  const startMs = performance.now();
  lastRawCount = landmarks.length;
  try {
    runPipeline(ts, startMs, landmarks, inferMs, sent.captureLagMs, sent.detectorRan, startMs - (sent.captureTime ?? ts), worldLandmarks);
  } catch (err) {
    frameFailed(err);
  }
  if (pendingFrame && !isLoopStopped) sendFrame(pendingFrame.captureTime);
}

// 偵測結果到了之後的管線。ts＝這張畫面的時刻（追蹤與手勢的時間基準），startMs＝主執行緒開始處理的時刻（逐幀紀錄的主執行緒耗時從這裡算）。
function runPipeline(ts, startMs, rawPoses, detectMs, captureLagMs, detectorRan, resultLagMs, rawWorlds = [], videoSource = "sent") {
  // ▶ 依位置將偵測結果匹配到已鎖定的槽位（並平滑），演算法見 tracking.js。buildDetection 對座標異常／不像人的偵測回傳 null 先濾掉；同一具身體的重複偵測由 tracker.update() 自己挑該留哪一筆。
  const aspect = (video.videoHeight || CONFIG.height) / (video.videoWidth || CONFIG.width);
  const detections = rawPoses.map((lm, i) => buildDetection(lm, { world: rawWorlds[i] ?? null, aspect })).filter(Boolean);

  tracker.update(detections, ts);
  const activeTracks = tracker.getActiveTracks();

  // ▶ 手勢（gesture.js）：每個槽位（＝演奏者 ID）左右手各一個 ArcDetector，另外回報這一幀真的在場的槽位；槽位數＝追蹤器目前的槽位數（＝現場人數）。
  // 最低點的時刻用這張畫面被拍下的時刻（rVFC 的 captureTime；瀏覽器沒提供就用 ts）：揮手的動作時刻，排程器拿來估速、比先後
  const gesture = updateGestures(activeTracks, tracker.cfg.maxUsers, ts, captureLagMs === null ? ts : ts - captureLagMs);
  emitGesturePerformanceState(gesture, ts);

  // ▶ WebGL 渲染攝影機畫面當背景：有推論時是送去推論的那一張，沒推論時是當下這張
  renderVideoGL(videoSource);

  // ▶ 2D 覆蓋層繪製骨架（漏偵測一兩幀的人用最後一次的骨架撐住，見 tracking.js 的 getDrawableTracks）
  renderSkeletonOverlay(tracker.getDrawableTracks(ts));

  recordFrame(ts, startMs, detectMs, rawPoses.length, detections, activeTracks, gesture.frame, captureLagMs, detectorRan, resultLagMs);
  consecutiveFrameErrors = 0;
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
  pendingFrame = null;
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

function setStatus(msg) { onStatus?.(msg); }

function showError(title, detail = "") { onError?.(title, detail); }

// getUserMedia 失敗時給使用者看的文字：開機失敗的錯誤畫面（initSystem）與執行期重開失敗的舞台提示／狀態列（startCamera）共用。
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

// track.stop() 之後裝置在瀏覽器程序裡非同步釋放（Firefox／Windows 尤其明顯），緊接著重開會拿到 NotReadableError／AbortError，要等真實時間；只重試一次。
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
  // width／height／frameRate 都給「上限」（max）而非只給偏好：ideal 只是偏好，瀏覽器有權直接給 1080p60；ideal 仍一併給，讓它在多個合法模式中優先挑最接近的。
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

  // 約束只是「請求」，不同瀏覽器／驅動套用程度不一：實際協商到的規格明顯超出上限（推論負擔會提高）才提醒，一切正常時不印。
  const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
  if (settings.width > CONFIG.width || settings.height > CONFIG.height ||
      settings.frameRate > CONFIG.frameRate + 1) {
    console.warn("⚠️ 鏡頭輸出高於設定上限——此裝置／瀏覽器未完全套用約束，推論負擔會提高");
  }
  return stream;
}

// 鏡頭實際協商到的規格與可調範圍（__latency 用）：幀率偏低時分得出是鏡頭給得少還是推論跟不上；曝光欄位只有支援的瀏覽器／驅動才有（Firefox 沒有 getCapabilities）。
function describeCamera(track) {
  const s = track?.getSettings?.() ?? {};
  const c = track?.getCapabilities?.() ?? {};
  return {
    設定: { 寬: s.width ?? null, 高: s.height ?? null, 幀率: s.frameRate ?? null, 曝光模式: s.exposureMode ?? null, 曝光時間: s.exposureTime ?? null },
    可調範圍: { 幀率: c.frameRate ?? null, 曝光模式: c.exposureMode ?? null, 曝光時間: c.exposureTime ?? null },
  };
}

// 把一條新串流接上 <video> 並等到第一幀可用。開機（initSystem）與執行期重開（startCamera）共用。
async function attachCamera() {
  const stream = await openCamera();
  cameraStream = stream;
  cameraInfo = describeCamera(stream.getVideoTracks()[0]);
  video.srcObject = stream;

  // 執行期攝影機中斷（USB 被拔、被其他應用程式搶走、驅動重置）會讓 track 觸發 ended，視為「鏡頭已關閉」：舞台提示＋按鈕變「開啟鏡頭」，按一下即重連。自己呼叫 track.stop() 依規格不會觸發 ended，但仍用串流身分擋掉舊串流遲來的事件。
  stream.getVideoTracks()[0]?.addEventListener("ended", () => onCameraEnded(stream));

  await video.play();
  await new Promise((resolve) => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return resolve();
    video.addEventListener("loadeddata", resolve, { once: true });
  });
  syncCanvasSize();
}

// 收掉攝影機（按鈕關閉、ended、開啟失敗的收尾共用）。reason 是舞台提示要顯示的文字（""＝使用者主動關閉，顯示預設的「鏡頭已關閉」）。
// 不呼叫 tracker.hardReset()：既有槽位維持原狀，重開後空著的槽位才會被新偵測到的人取用；MediaPipe 的追蹤則在重開後第一張清掉（forgetTracking）。
function detachCamera(reason) {
  stopFrameLoop();
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  video.srcObject = null;
  // srcObject 為 null 時 <video> 依規格什麼都不呈現；Firefox 有「最後一幀黏住」的回報，多加 class 讓 CSS 藏起來當保險（用 visibility 不是 display:none——之後還要靠這個元素跑 rVFC）
  video.classList.add("is-off");
  cameraOffReason = reason;
  try { gl?.clear(gl.COLOR_BUFFER_BIT); } catch (e) { /* context 可能正在遺失 */ }
  ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  resetGestures();
  forgetTracking = true;
  // 讓接收端立刻知道沒有人在場，不等它的斷訊看門狗。
  emitGesturePerformanceState(EMPTY_PERFORMANCE_STATE, performance.now());
}

// start／stop／ended 一律排進同一條 promise 鏈依序執行：<video> 的 srcObject 在 play() 尚未 resolve 時被換掉會讓 play() 以 AbortError reject；按鈕的 disabled 擋不住 ended 事件。
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

// 舞台中央提示（#stage-hint）的唯一擁有者：攝影機關閉（含中斷／開啟失敗）優先，其次是「還沒選現場人數」，兩者都不成立就藏起來。JS 只切 hidden＋寫 textContent（文字沒變不寫）。
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

// 開機時載入姿勢推論的 Worker（module Worker 從 CDN 載 tasks-vision），收到 ready 才算就緒；Worker 檔或 CDN 載入失敗會觸發 error 事件。
function startPoseWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./poseWorker.js", import.meta.url), { type: "module" });
    worker.onerror = (e) => reject(new Error(`姿勢推論 Worker 載入失敗${e.message ? `：${e.message}` : ""}`));
    worker.onmessage = ({ data }) => {
      if (data.type !== "ready") return;
      worker.onmessage = onPoseWorkerMessage;
      worker.onerror = onPoseWorkerError;
      poseWorker = worker;
      resolve();
    };
  });
}

function onPoseWorkerMessage({ data: msg }) {
  if (msg.type === "result") {
    handlePoseResult(msg);
  } else if (msg.type === "detectFailed") {
    inFlight = null;
    frameFailed(new Error(msg.message));
  } else if (msg.type === "configured" || msg.type === "configureFailed") {
    const call = pendingCalls.get(msg.id);
    pendingCalls.delete(msg.id);
    if (msg.type === "configured") {
      poseModelIndex = msg.modelIndex;
      call?.resolve();
    } else {
      call?.reject(new Error(msg.message));
    }
  }
}

// Worker 執行中出現沒接住的錯誤：之後不一定還有結果回來（骨架會停在最後一張），當成持續性錯誤處理；等待中的換人數一併失敗。
function onPoseWorkerError(e) {
  console.error("⚠️ 姿勢推論 Worker 發生錯誤", e.message ?? e);
  for (const call of pendingCalls.values()) call.reject(new Error("姿勢推論 Worker 發生錯誤"));
  pendingCalls.clear();
  stopFrameLoop();
  showError("姿勢追蹤發生持續性錯誤", "請重新整理頁面。若問題持續發生，請確認鏡頭或顯示卡驅動狀態。");
}

let callSeq = 0;
function callPoseWorker(msg) {
  return new Promise((resolve, reject) => {
    const id = ++callSeq;
    pendingCalls.set(id, { resolve, reject });
    poseWorker.postMessage({ ...msg, id });
  });
}

async function initSystem() {
  try {
    setStatus("正在初始化 WebGL 渲染引擎⋯");
    initWebGL();

    setStatus("正在載入 WASM 視覺模組⋯");
    await startPoseWorker();

    // Pose landmarker 完全懶惰載入，開機不建：選人數之前 processFrame() 本來就不推論，開機搶建一份只會白白拖慢開機、多養一份常駐記憶體；開機只先載入 Worker 與 tasks-vision。

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

// 重置骨架 ID：釋放所有已鎖定的槽位與候選名單，MediaPipe 也重新找人（forgetTracking），讓下一幀重新鎖定
export function hardReset() {
  tracker.hardReset();
  resetGestures();
  forgetTracking = true;
  emitGesturePerformanceState(EMPTY_PERFORMANCE_STATE, performance.now());
  ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// 註冊「手勢演奏狀態」的監聽者；每次回呼收到 { arcTriggerSeqBySlot: {1..maxUsers → 拋物線觸發的累加計數，變動代表有新的一次有效拋物線}, presentSlots: [在場的 ID] }。main.js 註冊的是 input/gestureTrigger.js 的監聽。
export function setPerformanceStateListener(fn) {
  performanceStateListener = typeof fn === "function" ? fn : null;
}

// 「現場人數」確定之後的監聽者（main.js 接到播放器的 setPlayerCount，分譜的「指派演奏者」下拉跟著列到 n）。寫法同 setCameraStateListener。
let poseCountListener = null;
export function setPoseCountListener(fn) {
  poseCountListener = typeof fn === "function" ? fn : null;
}

// 系統控制 bar 選的「現場人數」；0 ＝ 還沒選（此時不推論）。
// 不是 landmarker 的 numPoses（那是 currentPoseCount，懶惰載入、第一次選人數才建）。
export function getPoseCount() {
  return chosenPoseCount;
}

// 系統控制 bar 「現場人數」：懶惰建置對應人數的 landmarker，建好才換手並武裝偵測——等待期間（第一次選人數或這個人數還沒建過時約 1~2 秒）畫面用舊的那份（若有）繼續推論不凍結；成功不特別提示，失敗才由 src/ui.js 顯示在系統控制 bar。
export async function setPoseCount(count) {
  if (!Number.isInteger(count) || count < 1 || count > CONFIG.maxUsers) {
    throw new Error(`現場人數必須是 1~${CONFIG.maxUsers} 的整數：${count}`);
  }
  if (!poseWorker) throw new Error("視覺系統尚未就緒，無法設定現場人數");

  // 已經是這個 numPoses（重選同一個值／失敗後重試）：不重建，只要把偵測武裝起來。
  if (landmarkerReady && currentPoseCount === count) { applyPoseCount(count); return true; }

  // 第一次在 Worker 裡建，之後原地 setOptions；Worker 依序處理，等待期間主執行緒照常、骨架停在上一張
  const seq = ++configureSeq;
  await callPoseWorker({ type: "configure", numPoses: count, modelUrls: POSE_MODEL_URLS.map((u) => new URL(u, document.baseURI).href) });
  if (seq !== configureSeq) return false; // 被更新的請求取代，這次不算數（不是錯誤）

  landmarkerReady = true;
  currentPoseCount = count;
  lastRawCount = 0;              // 換了設定就重新開始追蹤，第一幀一定跑偵測器
  applyPoseCount(count);
  return true;
}

// 人數確定之後：武裝偵測，追蹤層的槽位數（＝ ID 上限）跟著人數走。換槽位數要重建 PersonTracker，效果等於「重置骨架 ID」；人數沒變就只是武裝偵測。
function applyPoseCount(count) {
  chosenPoseCount = count;
  if (tracker.cfg.maxUsers !== count) {
    tracker = new PersonTracker({ maxUsers: count });
    resetGestures();
    ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    emitGesturePerformanceState(EMPTY_PERFORMANCE_STATE, performance.now());
  }
  refreshStageHint();
  if (poseCountListener) {
    try { poseCountListener(count); }
    catch (e) { console.warn("⚠️ 現場人數監聽者拋錯", e); }
  }
}

// getCameraState() 回傳 { on, busy, message }：on＝攝影機開著、busy＝開啟／關閉進行中（按鈕該 disabled）、message＝關閉的原因或開啟失敗的文字（""＝使用者自己關的）。ui.js 用它畫按鈕與狀態列。
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

// 開啟攝影機（已開著就直接返回）。失敗時把 srcObject 等收乾淨、把原因留在 message 再拋出：attachCamera 可能已把串流接上才失敗（play() 被拒），不能留半套狀態。
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

window.addEventListener("beforeunload", () => {
  stopFrameLoop();
  cameraStream?.getTracks().forEach((t) => t.stop());
  poseWorker?.terminate();
  poseWorker = null;

  if (gl) {
    gl.deleteTexture(glTexture);
    gl.deleteProgram(glProgram);
    const ext = gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
});

// 啟動攝影機與姿勢偵測。必須由 main.js 明確呼叫 startVision()，不靠模組頂層的 import 副作用（那樣「攝影機會不會開」會取決於有沒有人 import 到這個檔案，搬動 import 就默默黑畫面）。
// 回傳 promise，resolve 值為是否初始化成功（失敗時已經經由 onError 回呼顯示錯誤畫面）。重複呼叫安全：一律回傳同一個 promise，不會啟動第二次。
let startPromise = null;
export function startVision({ onStatus: statusFn, onError: errorFn } = {}) {
  if (!startPromise) {
    onStatus = typeof statusFn === "function" ? statusFn : null;
    onError = typeof errorFn === "function" ? errorFn : null;
    startPromise = initSystem();
  }
  return startPromise;
}
