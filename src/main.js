// main.js — 組裝：把各功能接在一起、開機流程、開發用 __stats／__pressLog。

import * as midiPlayer from './midi/midiPlayer.js';
import { initUi, setLoadingStatus, dismissLoading, showError } from './ui.js';
import { startVision, setPoseCountListener, warmPoseModel } from './vision/vision.js';
import { startKeyboardTrigger, getInputDelays } from './input/keyboard.js';
import { summarizeMs } from './midi/tempo.js';

// __stats() 只量 JS 層，音訊段由「音訊輸出」補上，「估計按下到出聲ms」把整條路串起來。
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

window.__pressLog = midiPlayer.pressLog;

async function bootSystem() {
  midiPlayer.startPlayer(); // 計時器不靠 import 副作用啟動
  // 播放器由這裡交給 ui.js；畫面先同步接好，開機期間 #app-shell 是 inert
  initUi(midiPlayer);
  setPoseCountListener(midiPlayer.setPlayerCount);

  // 視覺與音源並行，兩邊都就緒才收起載入畫面，避免「看得到骨架、按播放卻沒聲音」的空窗期
  const [visionOk, midiOk] = await Promise.all([
    startVision({ onStatus: setLoadingStatus, onError: showError }),
    midiPlayer.warmUpMidiEngine(),
  ]);

  // 觸發來源目前是鍵盤；手勢接回見規格文件「手勢輸出目前沒有接收者」
  startKeyboardTrigger(midiPlayer.triggerInput, midiPlayer.KEYBOARD_SLOT, midiPlayer.liftInput);

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
