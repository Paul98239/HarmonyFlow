// ============================================================
//  main.js — 進入點（composition root）：把各功能接在一起，功能之間不互相 import。
//
//  資源下載交給瀏覽器原生機制：index.html 的 <link rel="preload"> 在背景抓 src/assets/ 的
//  pose 模型與 soundfont，MediaPipe／SpessaSynth 依官方用法取同一個 URL，不會重抓。
// ============================================================

import * as midiPlayer from './midi/midiPlayer.js';
import { initUi, setLoadingStatus, dismissLoading, showError } from './ui.js';
import { startVision, setPoseCountListener } from './vision/vision.js';
import { startKeyboardTrigger, getInputDelays } from './keyboard.js';
import { summarizeMs } from './midi/pressTiming.js';

// 開發用量測：在 console 輸入 __stats() 讀取。電腦音遲到量（12ms 的排程 tick 放出電腦音，比排好的時刻晚多少）與鍵盤事件
// 在主執行緒佇列裡等待的時間——用來判斷影像算繪／姿勢推論把主執行緒卡住的程度，在你的機器上是不是真的聽得出來。
// 這兩個只量 JS 層；音訊這一段（worklet 的 render quantum、AudioContext 的內部與輸出延遲）由「音訊輸出」補上，
// 「估計按下到出聲ms」＝每個按鍵的事件等待 ＋ 固定的音訊段，把整條路串起來，看延遲主要落在哪一段。
window.__stats = () => {
  const audio = midiPlayer.audioLatency();
  const keyWaits = getInputDelays();
  // 固定音訊段：worklet 平均等半個渲染區塊 ＋ 內部延遲 ＋ 輸出延遲。瀏覽器沒提供的欄位（null）算 0，所以是下限、不是上限。
  const audioFixedMs = audio ? Math.round(((audio.渲染區塊ms ?? 0) / 2 + (audio.內部延遲ms ?? 0) + (audio.輸出延遲ms ?? 0)) * 10) / 10 : null;
  return {
    速度倍率: Math.round(midiPlayer.playbackRate() * 100) / 100,
    電腦音遲到ms: midiPlayer.lateStats(),
    按鍵事件等待ms: summarizeMs(keyWaits),
    音訊輸出: audio,
    估計按下到出聲ms: audioFixedMs === null ? null : { 固定音訊段ms: audioFixedMs, ...summarizeMs(keyWaits.map((x) => x + audioFixedMs)) },
  };
};

// 開發用：彈完在 console 輸入 copy(__pressLog())，貼進 test/tools/recordings/<名稱>.json 留存，供離線分析。
// 時間是排程器時鐘（暫停不計），跟 sim.mjs 的座標一樣。
window.__pressLog = midiPlayer.pressLog;

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

  // 觸發來源目前是鍵盤（分譜下拉的「PC 鍵盤手」，每按一下放行全曲的下一個 segment）：揮手暫時關閉，vision.js 的手勢狀態不接進播放器。
  startKeyboardTrigger(midiPlayer.triggerSlot, midiPlayer.KEYBOARD_SLOT);

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
