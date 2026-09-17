// ============================================================
//  main.js — 進入點（composition root）：把各功能接在一起，功能之間不互相 import。
//
//  資源下載交給瀏覽器原生機制：index.html 的 <link rel="preload"> 在背景抓 src/assets/ 的
//  pose 模型與 soundfont，MediaPipe／SpessaSynth 依官方用法取同一個 URL，不會重抓。
// ============================================================

import * as midiPlayer from './midi/midiPlayer.js';
import { initUi, setLoadingStatus, dismissLoading, showError } from './ui.js';
import { startVision, setPerformanceStateListener, setPoseCountListener } from './vision/vision.js';

async function bootSystem() {
  midiPlayer.startPlayer(); // 200ms UI tick 與 12ms 排程 tick，不靠 import 副作用
  // 畫面先接好（同步、不等網路）：ui.js 不 import 播放器，由這裡交進去；開機期間 #app-shell 是 inert。
  initUi(midiPlayer);
  // 系統控制的「現場人數」→ 分譜的「指派演奏者」下拉列到 n。
  setPoseCountListener(midiPlayer.setPlayerCount);

  // 視覺（攝影機＋WebGL＋pose 模型）與音源（MIDI 引擎＋soundfont）並行推進，
  // 兩邊都就緒才收起載入畫面，避免「看得到骨架、按播放卻沒聲音」的空窗期。
  // startVision() 就是姿勢追蹤唯一的啟動點；載入文字與錯誤畫面經回呼交給 ui.js 的遮罩函式。
  const [visionOk, midiOk] = await Promise.all([
    startVision({ onStatus: setLoadingStatus, onError: showError }),
    midiPlayer.warmUpMidiEngine(),
  ]);

  // 拋物線手勢 → 指派給真人的聲部：vision.js 每幀把各演奏者 ID 的觸發計數／在場清單交給播放器。
  setPerformanceStateListener(midiPlayer.setGesturePerformanceState);

  // 視覺初始化失敗時錯誤畫面已經顯示，載入畫面不收、inert 也維持
  if (!visionOk) return;

  // 音源初始化失敗不擋進場（攝影機、骨架都還能用），狀態列由播放器寫明。
  setLoadingStatus(midiOk ? '✅ 準備就緒' : '⚠️ 已就緒，但音源引擎載入失敗');
  dismissLoading();
}

// 舊版頁面曾註冊 Service Worker 並留下 Cache Storage；一次性清掉，讓曾開過舊版的瀏覽器
// 不再攔截 src/assets/ 的請求。跑在背景、不擋啟動流程。
function cleanupLegacyServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((reg) => reg.unregister()))
      .catch(() => {});
  }
  if (window.caches?.keys) {
    caches.keys()
      .then((names) => names.filter((n) => n.startsWith('harmonyflow-assets-')).forEach((n) => caches.delete(n)))
      .catch(() => {});
  }
}

bootSystem()
  .catch((err) => {
    console.error('❌ 系統啟動失敗', err);
    setLoadingStatus('啟動失敗，請重新整理頁面');
  })
  .finally(cleanupLegacyServiceWorker);
