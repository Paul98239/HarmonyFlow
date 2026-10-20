// 版本固定 1.1.0：bundle、loader JS、.wasm 三個檔必須同一版。不用 @latest：jsDelivr 邊緣節點曾同時回傳不同版本的 loader JS 與 .wasm
// （2026-10-07 實測），載入時 assignWasmExports 讀到 undefined 而失敗。升級時這裡的 import 與 WASM_BASE 一起改。
import { FilesetResolver, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/vision_bundle.mjs";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm";
const LANDMARKER_OPTIONS = {
  runningMode: "VIDEO",
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  outputSegmentationMasks: false, // 不需要分割遮罩，明寫掉而不是靠預設值
};

let landmarker = null;
let modelIndex = 0; // 目前採用的模型來源（modelUrls 的索引）；CDN 失敗改用本地之後不再重試已經壞掉的那個

async function freshFileset() {
  // true＝WASM 載 ES module 版：module Worker 不能用 importScripts
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE, true);
  // 同一個 Worker 第二次建立時 ES module 版的載入程式不會再執行，會報「ModuleFactory not set」；加查詢字串讓它重新載入（官方 mediapipe-samples-web 同做法）
  fileset.wasmLoaderPath = `${fileset.wasmLoaderPath}?cb=${Date.now()}`;
  return fileset;
}

const build = async (url, delegate, numPoses) =>
  PoseLandmarker.createFromOptions(await freshFileset(), { baseOptions: { modelAssetPath: url, delegate }, numPoses, ...LANDMARKER_OPTIONS });

// 哪個模型來源失敗就換下一個（CDN 為主、本地為備）；兩個來源都無法用 GPU 建起來時，最後用 CPU 再試一次（推論會慢很多，但比沒有好）
async function create(modelUrls, numPoses) {
  for (;;) {
    const idx = modelIndex;
    try {
      return await build(modelUrls[idx], "GPU", numPoses);
    } catch (err) {
      if (idx >= modelUrls.length - 1) break;
      console.warn(`姿勢模型載入失敗（${modelUrls[idx]}），改用 ${modelUrls[idx + 1]}`, err);
      modelIndex = idx + 1;
    }
  }
  console.warn("⚠️ 姿勢模型無法用 GPU 建置，改用 CPU（推論會變慢）");
  return build(modelUrls[modelIndex], "CPU", numPoses);
}

async function handle(msg) {
  if (msg.type === "configure") {
    try {
      // 第一次選人數才建；之後換人數原地 setOptions，不重建（重建在 Iris Xe 上第一次推論要好幾秒）
      if (landmarker) await landmarker.setOptions({ numPoses: msg.numPoses });
      else landmarker = await create(msg.modelUrls, msg.numPoses);
      self.postMessage({ type: "configured", id: msg.id, modelIndex });
    } catch (err) {
      self.postMessage({ type: "configureFailed", id: msg.id, message: String(err?.message ?? err) });
    }
  } else if (msg.type === "detect") {
    try {
      const t0 = performance.now();
      const { landmarks } = landmarker.detectForVideo(msg.bitmap, msg.ts);
      self.postMessage({ type: "result", ts: msg.ts, inferMs: performance.now() - t0, landmarks });
    } catch (err) {
      self.postMessage({ type: "detectFailed", ts: msg.ts, message: String(err?.message ?? err) });
    } finally {
      msg.bitmap.close();
    }
  }
}

// 一次只處理一則：換人數（setOptions，非同步）進行中送來的畫面要排在它後面，不能拿改到一半的 landmarker 推論
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data)).catch((err) => console.error("⚠️ 姿勢推論 Worker 處理訊息失敗", err));
};

self.postMessage({ type: "ready" });
