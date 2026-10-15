// main.js — 進入點（composition root）：把各功能接在一起，功能之間不互相 import。
// 資源下載交給瀏覽器原生 preload；pose 模型要選了現場人數才用到，不預載，開機完成後由 warmPoseModel() 暖機。

import * as midiPlayer from './midi/midiPlayer.js';
import { initUi, setLoadingStatus, dismissLoading, showError } from './ui.js';
import { startVision, setPoseCountListener, warmPoseModel } from './vision/vision.js';
import { startKeyboardTrigger, getInputDelays } from './keyboard.js';
import { summarizeMs } from './midi/tempo.js';

// 開發用：console 輸入 __stats() 讀延遲統計。只量 JS 層，音訊段由「音訊輸出」補上，「估計按下到出聲ms」把整條路串起來。
window.__stats = () => {
  const audio = midiPlayer.audioLatency();
  const keyWaits = getInputDelays();
  // 固定音訊段＝worklet 平均等半個渲染區塊＋內部延遲＋輸出延遲；瀏覽器沒提供的欄位（null）算 0，所以是下限
  const audioFixedMs = audio ? Math.round(((audio.渲染區塊ms ?? 0) / 2 + (audio.內部延遲ms ?? 0) + (audio.輸出延遲ms ?? 0)) * 10) / 10 : null;
  return {
    速度倍率: Math.round(midiPlayer.playbackRate() * 1000) / 1000,
    速度範圍: (({ lo, hi }) => ({ 下限: Math.round(lo * 1000) / 1000, 上限: Math.round(hi * 100) / 100 }))(midiPlayer.rateBounds()),
    電腦音遲到ms: midiPlayer.lateStats(),
    早按處理: midiPlayer.chaseStats(),
    按鍵事件等待ms: summarizeMs(keyWaits),
    音訊輸出: audio,
    估計按下到出聲ms: audioFixedMs === null ? null : { 固定音訊段ms: audioFixedMs, ...summarizeMs(keyWaits.map((x) => x + audioFixedMs)) },
  };
};

// 開發用：copy(__pressLog()) 匯出錄音 v2（欄位見規格文件「開發／執行」）。
window.__pressLog = midiPlayer.pressLog;

async function bootSystem() {
  midiPlayer.startPlayer(); // 200ms UI tick 與 12ms 排程 tick，不靠 import 副作用
  // ui.js 不 import 播放器，由這裡交進去；畫面同步先接好，開機期間 #app-shell 是 inert
  initUi(midiPlayer);
  setPoseCountListener(midiPlayer.setPlayerCount);

  // 視覺與音源並行，兩邊都就緒才收起載入畫面，避免「看得到骨架、按播放卻沒聲音」的空窗期
  const [visionOk, midiOk] = await Promise.all([
    startVision({ onStatus: setLoadingStatus, onError: showError }),
    midiPlayer.warmUpMidiEngine(),
  ]);

  // 觸發來源目前是鍵盤，揮手暫時關閉；手勢接回時用 midiPlayer.triggerSlot(槽位)（見規格文件）
  startKeyboardTrigger(midiPlayer.triggerInput, midiPlayer.KEYBOARD_SLOT);

  // 視覺初始化失敗時錯誤畫面已經顯示，載入畫面不收、inert 也維持
  if (!visionOk) return;

  // 音源初始化失敗不擋進場（攝影機、骨架都還能用），狀態列由播放器寫明。
  setLoadingStatus(midiOk ? '✅ 準備就緒' : '⚠️ 已就緒，但音源引擎載入失敗');
  dismissLoading();
  warmPoseModel(); // 開機完成之後才在背景暖機姿勢模型，使用者第一次選現場人數時不必等下載
}

// 清掉曾註冊的 Service Worker 與 Cache Storage，免得攔截 src/assets/ 的請求；背景執行、不擋啟動
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
