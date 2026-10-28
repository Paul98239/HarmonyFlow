// main.js — 組裝：把各功能接在一起、開機流程、開發用 __stats／__pressLog／__visionLog／__latency。

import * as midiPlayer from './midi/midiPlayer.js';
import { initUi, setLoadingStatus, dismissLoading, showError } from './ui.js';
import { startVision, setPoseCountListener, setPerformanceStateListener, warmPoseModel, visionLog, visionFrameStats, getCameraInfo, setFrameLogRecording, clearFrameLog } from './vision/vision.js';
import { startKeyboardTrigger, getInputDelays } from './input/keyboard.js';
import { createGestureTrigger } from './input/gestureTrigger.js';
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
    合奏: midiPlayer.ensembleStats(),
    按鍵事件等待ms: summarizeMs(keyWaits),
    音訊輸出: audio,
    估計按下到出聲ms: audioFixedMs === null ? null : { 固定音訊段ms: audioFixedMs, ...summarizeMs(keyWaits.map((x) => x + audioFixedMs)) },
  };
};

window.__pressLog = midiPlayer.pressLog;

// copy(__visionLog())：這一段演奏（從頭播起，暫停與曲終不記）的逐幀紀錄（兩手手腕、上半身節點的原始／world／平滑座標與 presence、偵測、鎖定的手、推論耗時）與追蹤層的鎖定／釋放事件，
// 查手點互相干擾與多出來的 ID 用；__visionLog(15) 只取最後 15 秒。先按 ❚❚ 再切 DevTools 打指令，打字的那段就不會記進去。
window.__visionLog = visionLog;

// 長任務（主執行緒連續忙 50ms 以上，這段時間按鍵與按鈕都沒反應）：[開始時刻, 長度]，__latency() 依時刻歸到當時的現場人數。Firefox 沒有這個 API，記 null。
const longTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask') ? [] : null;
if (longTasks) {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push([e.startTime, e.duration]);
    if (longTasks.length > 5000) longTasks.splice(0, 2500);
  }).observe({ type: 'longtask', buffered: true });
}

// __latency()：不同「現場人數」下的推論與主執行緒負擔。每個人數一組：推論（detectForVideo，在 Worker）耗時與佔 Worker 的比例、偵測器有跑／只追蹤分開的推論耗時、
// 主執行緒處理每幀的耗時與佔比、攝影機拍下→送出、拍下→結果進主執行緒、長任務、排程 tick 的實際間隔（超過 LOOKAHEAD_MS 的次數越多，電腦音越可能來不及提早帶時間戳送進 worklet）；
// 鏡頭規格與音訊輸出那一段（輸出延遲、worklet 渲染區塊）跟人數無關，各附一份。
// 流程：選人數 → 開鏡頭、播放彈 20～30 秒 → 換下一個人數（同一段演奏裡換：從頭播會清空逐幀紀錄），最後 copy(__latency())。排程 tick 與逐幀紀錄都只在播放中記錄。
window.__latency = () => {
  const { byCount, segments } = visionFrameStats();
  const ticks = midiPlayer.tickIntervals();
  const round1 = (x) => Math.round(x * 10) / 10;
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const result = {};
  for (const [count, g] of Object.entries(byCount)) {
    const mine = segments.filter((s) => s.count === Number(count));
    const seconds = mine.reduce((acc, s) => acc + (s.to - s.from), 0) / 1000;
    const spanMs = mine.reduce((acc, s) => acc + (s.end - s.from), 0);
    const tickMs = ticks.filter(([t]) => mine.some((s) => t >= s.from && t <= s.to)).map(([, dt]) => dt);
    const taskMs = longTasks?.filter(([t]) => mine.some((s) => t >= s.from && t <= s.end)).map(([, ms]) => ms);
    result[`現場人數 ${count}`] = {
      秒數: round1(seconds),
      幀數: g.frames,
      幀率: seconds > 0 ? round1(g.frames / seconds) : null,
      平均在場人數: round1(g.present / g.frames),
      推論ms: summarizeMs(g.detectMs),
      '推論ms（偵測器有跑）': summarizeMs(g.detectWithDetector),
      '推論ms（只追蹤）': summarizeMs(g.detectTrackingOnly),
      '推論佔比%': spanMs > 0 ? round1((sum(g.detectMs) / spanMs) * 100) : null,
      整幀ms: summarizeMs(g.frameMs),
      '主執行緒佔比%': spanMs > 0 ? round1((sum(g.frameMs) / spanMs) * 100) : null,
      拍下到處理ms: summarizeMs(g.captureLagMs),
      拍下到結果ms: summarizeMs(g.resultLagMs),
      長任務: taskMs ? { 次數: taskMs.length, 最長ms: round1(Math.max(0, ...taskMs)), 總ms: round1(sum(taskMs)) } : null,
      排程tick間隔ms: { ...summarizeMs(tickMs), [`超過${midiPlayer.LOOKAHEAD_MS}ms`]: tickMs.filter((x) => x > midiPlayer.LOOKAHEAD_MS).length },
    };
  }
  result.鏡頭 = getCameraInfo();
  result.音訊輸出 = midiPlayer.audioLatency();
  return result;
};

async function bootSystem() {
  midiPlayer.startPlayer(); // 計時器不靠 import 副作用啟動
  // 播放器由這裡交給 ui.js；畫面先同步接好，開機期間 #app-shell 是 inert
  initUi(midiPlayer);
  setPoseCountListener(midiPlayer.setPlayerCount);
  // 逐幀紀錄跟著演奏走：從頭播時清空（跟按鍵錄音同一個起點），只在演奏模式播放中記
  midiPlayer.setPlaybackRestartListener(clearFrameLog);
  let recording = false;
  midiPlayer.playerStore.addEventListener('change', () => {
    const { transport, mode } = midiPlayer.playerStore.state;
    const on = transport === 'playing' && mode === 'perform';
    if (on !== recording) setFrameLogRecording(recording = on);
  });

  // 視覺與音源並行，兩邊都就緒才收起載入畫面，避免「看得到骨架、按播放卻沒聲音」的空窗期
  const [visionOk, midiOk] = await Promise.all([
    startVision({ onStatus: setLoadingStatus, onError: showError }),
    midiPlayer.warmUpMidiEngine(),
  ]);

  // 觸發來源：鍵盤（槽位 'kb'）與揮手（槽位 1~4＝演奏者 ID）並存，都進同一個入口 triggerInput
  startKeyboardTrigger(midiPlayer.triggerInput, midiPlayer.KEYBOARD_SLOT, midiPlayer.liftInput);
  const onGesture = createGestureTrigger(midiPlayer.triggerInput);
  setPerformanceStateListener((state) => { onGesture(state); midiPlayer.setPresentSlots(state.presentSlots); });

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
