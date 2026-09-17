// ============================================================
//  synth.js — spessasynth 合成器：兩個合成器（伴奏 synth／真人聲部 synthHuman）、humanGain 閘門。
//  純引擎：不知道「分譜」「指派」是什麼，也不碰 DOM。
//
//  沒有 Sequencer：兩個合成器都只接收 humanPerformer.js（拍級事件驅動排程器）送來的個別
//  noteOn／noteOff／初始 program 設定，見 humanPerformer.js 檔頭說明。
//
//  兩軌（bus）模型：被指派聲部固定走 synthHuman，velocity 一律用樂譜原值，沒被自己的演奏者
//  接手就是靜音（沒有代打）；沒被指派的聲部固定走 synth，不受任何人觸發影響，反應式播放。
// ============================================================

import { HumanPerformer } from './humanPerformer.js';

/* ═══════════════════════════════════════════
   常數
   ═══════════════════════════════════════════ */
const SOUNDFONT_URL = './src/assets/GeneralUserGS.sf3';
const FETCH_TIMEOUT_MS = 15000;

// spessasynth_lib 直接從 CDN 匯入（不經 import map）：jsDelivr 的 +esm 端點把 CJS/UMD
// 套件轉成瀏覽器能 import 的 ESM。AudioWorklet 處理器跟套件入口在同一個套件目錄下，
// 直接拼路徑，不用 import.meta.resolve（+esm 端點不是真實目錄，相對路徑推不出正確位置）。
// 版本綁 @latest：不手動維護版本號，代價是 jsDelivr 對 @latest 有快取（瀏覽器端 7 天／
// 邊緣節點 12 小時），版本可能在快取到期後無預警改變。spessasynth_lib 自己對
// spessasynth_core（core 對 stb-vorbis）宣告的相依版本本來就是 latest，管不到那一層——
// 現在外層也主動浮動，兩層都是刻意選擇，不是意外落差。
const LIB_ESM_URL = `https://cdn.jsdelivr.net/npm/spessasynth_lib@latest/+esm`;
const WORKLET_URL = `https://cdn.jsdelivr.net/npm/spessasynth_lib@latest/dist/spessasynth_processor.min.js`;

const CC_BANK_SELECT_MSB = 0;
const CC_BANK_SELECT_LSB = 32;
const CC_ALL_SOUND_OFF = 120;
const CC_RESET_ALL_CONTROLLERS = 121;
const CC_ALL_NOTES_OFF = 123;
const CHANNELS_PER_PORT = 16;
const DRUM_CHANNEL_OFFSET = 9;

const GATE_RAMP_TC = 0.03;   // humanGain on/off 的 setTargetAtTime 時間常數（防 click）

/* ═══════════════════════════════════════════
   引擎狀態
   ═══════════════════════════════════════════ */
let audioCtx, synth, masterGain;
// 真人聲部：獨立的第二個合成器 synthHuman，經一顆 humanGain（總開關，播放器決定開關、這裡只負責
// 平滑切換）接到同一個 compressor。
let synthHuman, humanGain;
let isReady = false;
let initPromise = null;
let isSongLoaded = false;
let isProcessingPlay = false;
let lastGateTarget = -1;

// 拍級事件驅動排程器（humanPerformer.js）：驅動 synth（未指派聲部，反應式播放）與
// synthHuman（指派聲部，接手才發聲），由播放器的 12ms 排程 tick 呼叫 tick()。
export const humanPerformer = new HumanPerformer();

/* ═══════════════════════════════════════════
   MIDI 引擎核心
   ═══════════════════════════════════════════ */
function channelCountOf(s) {
  return (s && Array.isArray(s.midiChannels) && s.midiChannels.length > 0)
    ? s.midiChannels.length : CHANNELS_PER_PORT;
}
function isDrumChannelIndex(ch) {
  return ch % CHANNELS_PER_PORT === DRUM_CHANNEL_OFFSET;
}

// 逾時只涵蓋「收到回應標頭」：`await fetch()` 在標頭到達時就 resolve、clearTimeout 也在那一刻
// 執行，所以 ms 不限制 body 要下載多久。soundfont 有 10.6MB，慢速連線花一兩分鐘是正常的；
// 不要把 `res.arrayBuffer()` 之類的 body 讀取搬進這個函式裡。
async function fetchWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal }); }
  finally { clearTimeout(t); }
}

export async function initEngine() {
  if (isReady) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const { WorkletSynthesizer } = await import(/* @vite-ignore */ LIB_ESM_URL);
      if (!WorkletSynthesizer) throw new Error('缺少必要匯出');

      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      await audioCtx.audioWorklet.addModule(WORKLET_URL);

      // 建構子第二個參數可傳 SynthConfig（oneOutput／audioNodeCreators／eventsEnabled），
      // 刻意不傳：兩個合成器都用標準 Web Audio API 節點（沒用 standardized-audio-context
      // 之類的包裝），也沒有監聽 spessasynth 內建的事件系統，全部吃函式庫預設值即可。
      synth = new WorkletSynthesizer(audioCtx);
      // 真人聲部的第二個合成器。走 humanGain（預設靜音）→ 同一個 compressor，
      // 跟伴奏經過同樣的動態處理、每單位 velocity 的響度也一致。
      synthHuman = new WorkletSynthesizer(audioCtx);
      humanPerformer.setSynths(synth, synthHuman);
      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 6;
      compressor.ratio.value = 2;
      compressor.attack.value = 0.005;
      compressor.release.value = 0.1;
      masterGain = audioCtx.createGain();
      // 音量固定在 2.0，不提供面板拉桿——要調大小聲請直接調電腦本機的音量。
      masterGain.gain.value = 2.0;
      humanGain = audioCtx.createGain();
      humanGain.gain.value = 0; // 預設靜音，播放中且有指派才由 updateHumanGain 拉起來
      // 伴奏那一軌不掛額外的 gain：它是「我的聲部」音量的比較基準，必須固定不動。
      synth.connect(compressor);
      synthHuman.connect(humanGain);
      humanGain.connect(compressor);
      compressor.connect(masterGain);
      masterGain.connect(audioCtx.destination);

      const res = await fetchWithTimeout(SOUNDFONT_URL);
      if (!res.ok) throw new Error(`SoundFont 失敗 HTTP ${res.status}`);
      const sfBuf = await res.arrayBuffer();
      // addSoundBank 可能把 ArrayBuffer transfer 進 worklet 而 detach 掉，所以先複製一份
      // 給第二個合成器，不能在第一次 add 之後才 slice。
      const sfBufHuman = sfBuf.slice(0);
      await synth.soundBankManager.addSoundBank(sfBuf, 'main');
      await synthHuman.soundBankManager.addSoundBank(sfBufHuman, 'main');
      if (synth.isReady) await synth.isReady;
      if (synthHuman.isReady) await synthHuman.isReady;

      isReady = true;
      return true;
    } catch (err) {
      console.error('❌ MIDI 引擎初始化失敗', err);
      // 這次失敗留下的 AudioContext 一定要收掉：按播放時會重試、每次重試都 new 一個新的，
      // 瀏覽器對同時存在的 AudioContext 數量有上限（Chrome 約 6 個）。
      try { await audioCtx?.close(); } catch (e) { /* 已經關掉或根本沒建起來 */ }
      audioCtx = undefined;
      synth = undefined;
      synthHuman = undefined;
      humanPerformer.setSynths(null, null);
      masterGain = undefined;
      humanGain = undefined;
      isReady = false;
      return false;
    } finally { initPromise = null; }
  })();
  return initPromise;
}

// 換歌／換指派前的清場：收掉排程器與殘響，bank／program 歸零（鼓組 channel 跳過：那裡的
// program 是鼓組編號，不是旋律音色）。
export function flushPreviousSong() {
  humanPerformer.stop();
  isSongLoaded = false;
  for (const s of [synth, synthHuman]) {
    if (!s) continue;
    for (let ch = 0; ch < channelCountOf(s); ch++) {
      if (isDrumChannelIndex(ch)) continue;
      try {
        s.controllerChange(ch, CC_BANK_SELECT_MSB, 0);
        s.controllerChange(ch, CC_BANK_SELECT_LSB, 0);
        s.controllerChange(ch, CC_ALL_SOUND_OFF, 0);
        s.controllerChange(ch, CC_RESET_ALL_CONTROLLERS, 0);
        s.controllerChange(ch, CC_ALL_NOTES_OFF, 0);
      } catch (e) {}
    }
  }
}

// 載入這首歌：確保引擎就緒、清掉上一首的殘留，再把樂譜交給排程器建立聲部（不會發出聲音，
// 播放要另外呼叫 play()）。assignments 是 [partId, 演奏者槽位][] 快照。
export async function load(score, assignments) {
  if (!isReady) {
    const ok = await initEngine();
    if (!ok) throw new Error('音源庫載入失敗');
  }
  flushPreviousSong();
  humanPerformer.load(score, assignments);
  isSongLoaded = true;
}

export async function play() {
  if (isProcessingPlay || !isSongLoaded) return;
  isProcessingPlay = true;
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    humanPerformer.play();
  } finally { isProcessingPlay = false; }
}
export function pause() {
  humanPerformer.pause(); // 收掉所有正在響的音；每個聲部的播放進度都保留，下次播放從原處繼續
}
export function isLoaded() { return isSongLoaded; }
export function isPaused() { return !isSongLoaded || !humanPerformer.isPlaying(); }
export function isFinished() { return isSongLoaded && humanPerformer.isFinished(); }

// humanGain 只是總開關：播放器算好「該不該開」（播放中、沒播完、真的有指派），這裡
// 只負責平滑地切上去／切下來；target 去重，同一個值不重複送。
export function setHumanGate(on) {
  if (!audioCtx || !humanGain) return;
  const target = on ? 1 : 0;
  if (target === lastGateTarget) return;
  lastGateTarget = target;
  try { humanGain.gain.setTargetAtTime(target, audioCtx.currentTime, GATE_RAMP_TC); } catch (e) {}
}
