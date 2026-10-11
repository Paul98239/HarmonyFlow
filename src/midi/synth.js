// ============================================================
//  synth.js — spessasynth 合成器：兩個合成器（電腦輔助聲部 synth／真人聲部 synthHuman）、humanGain
//  閘門＋音量凸顯。純引擎：不知道「分譜」「指派」是什麼，也不碰 DOM。
//
//  演奏不用 Sequencer：兩個合成器都只接收 scheduler.js（排程器）送來的個別
//  noteOn／noteOff／初始 program 設定，見 scheduler.js 檔頭說明。試聽才用官方 Sequencer
//  （previewPlayer.js 包裝，走電腦輔助那個合成器 synth），跟演奏互斥：兩者共用 synth 的 channel，
//  任何一邊開始之前都先 flushPreviousSong() 把另一邊停掉。
//
//  兩軌（bus）模型：被指派聲部固定走 synthHuman，velocity 一律用樂譜原值；指派只決定走哪個合成器與誰有資格
//  觸發（見 scheduler.js 的說明）。沒被指派的聲部固定走 synth，跟你的聲部在同一個 segment 一起發聲。
//  humanGain 開啟時的目標值刻意設在 1.0 以上
//  （`HUMAN_EMPHASIS_GAIN`），讓使用者控制的聲部整體比電腦輔助的聲部更突出；電腦輔助那一軌
//  固定不掛額外 gain，是這個音量對比的基準，不會跟著被調小聲。
// ============================================================

import { Scheduler, CHANNELS_PER_PORT, DEFAULT_PORTS, portsNeeded } from './scheduler.js';
import { PreviewPlayer } from './previewPlayer.js';

/* ═══════════════════════════════════════════
   常數
   ═══════════════════════════════════════════ */
// 音色庫：CDN 的 2.0.3 為主、本地的 2.0.1 為備用（依序試，任何一步失敗就換下一個）。CDN 網址釘在 SpessaSynth 官方 repo 的 commit
// （6f75050 ＝「Update GeneralUser GS to 2.0.3」），不可變，不會無預警換內容。兩版的 preset 清單（bank／program／名稱）逐筆相同。
// 不用逾時當備援條件：GitHub Pages 載 10.6MB 實測要 200 秒以上，慢不等於壞；只有網路錯誤、HTTP 錯誤、下載到一半斷線、
// 檔案壞了載不進合成器才會換來源。
const SOUNDFONT_URLS = [
  'https://cdn.jsdelivr.net/gh/spessasus/SpessaSynth@6f75050/soundfonts/GeneralUserGS.sf3',
  './src/assets/GeneralUserGS.sf3',
];

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
const DRUM_CHANNEL_OFFSET = 9;
// WorkletSynthesizer 預設只建 16 個 channel（1 個 MIDI port）；總譜聲部數超過這個數字時，
// 多出來的聲部會完全分不到輸出 channel、整段靜音（已用國旗歌 24 個旋律聲部實測重現）。
// spessasynth_lib 支援用 addNewChannel() 動態加開，對應 MIDI 多 port 的慣例。模仿官方 Sequencer：開機先補到
// DEFAULT_PORTS 個 port（scheduler.js 的單一來源），歌曲需要更多時在 load() 依 portsNeeded() 補，只增不減。

const GATE_RAMP_TC = 0.03;   // humanGain on/off 的 setTargetAtTime 時間常數（防 click）
const HUMAN_EMPHASIS_GAIN = 1.2; // humanGain 開啟時的目標值（電腦輔助軌固定是 1.0 基準，沒有額外
                                  // gain）：使用者控制的聲部整體調大聲，凸顯真人正在演奏的部分；
                                  // 1.4 時真人實測高音太突出、蓋過電腦的低音，所以降到 1.2（約 +1.6 dB）。

/* ═══════════════════════════════════════════
   引擎狀態
   ═══════════════════════════════════════════ */
let audioCtx, synth, masterGain;
// 真人聲部：獨立的第二個合成器 synthHuman，經一顆 humanGain（總開關，播放器決定開關、這裡只負責
// 平滑切換）接到同一個 compressor。
let synthHuman, humanGain;
let isReady = false;
let initPromise = null;
// 兩個合成器目前各有幾個 port 的 channel（兩個永遠一樣多）。自己計數，不讀 midiChannels.length（見 channelCountOf()）。
let portCount = DEFAULT_PORTS;
let isSongLoaded = false;
let isProcessingPlay = false;
let lastGateTarget = -1;
// 試聽：官方 Sequencer 類別在 initEngine() 跟 WorkletSynthesizer 一起從同一個套件取得（缺少只讓試聽
// 不能用，不拖累演奏）；PreviewPlayer 第一次試聽才建立。previewUsed＝官方 Sequencer 動過合成器的
// 狀態，下一次 flushPreviousSong() 要多做一次完整重設。
let SequencerClass, previewPlayer = null, previewUsed = false;

// 排程器（scheduler.js）：驅動 synth（未指派聲部，跟著指派聲部的位置走）與 synthHuman（指派聲部，觸發才發聲）；
// 播放器呼叫 trigger()（觸發當下發聲）並用 12ms 排程 tick 呼叫 tick()（輔助聲部與到期收音）。
export const scheduler = new Scheduler();

/* ═══════════════════════════════════════════
   MIDI 引擎核心
   ═══════════════════════════════════════════ */
// 不能讀 s.midiChannels.length 決定實際 channel 數：已查證 spessasynth_lib 原始碼
// （GitHub spessasus/spessasynth_lib 的 basic_synthesizer.ts）確認 addNewChannel() 會
// 同時（1）在主執行緒本地立刻 push 一筆到這個陣列，（2）worklet 端真的建好 channel 後，又
// 透過內部的 channelAdded 事件非同步回呼同一段程式碼、再 push 一次——每呼叫一次
// addNewChannel()，這個陣列的 length 最終會多算成兩筆，跟 worklet 端真正建立的 channel 數
// 對不上（實測：呼叫 48 次後 length 變成 112，不是 64；對只存在 64 個的 worklet 端送出
// channel ≥64 的 controllerChange 會讓 worklet 丟出 Uncaught TypeError，因為它自己的
// channel 陣列裡那個索引是 undefined）。所以 channel 數只能自己計數（portCount），不必也不能信任
// s.midiChannels.length。
function channelCountOf(s) {
  return s ? portCount * CHANNELS_PER_PORT : CHANNELS_PER_PORT;
}

// 補 channel 到至少 ports 個 port（只增不減，跟官方 Sequencer 的 addNewMIDIPort 一樣），補完整個合成器重設一次
// （原因見 initEngine() 的註解：動態新增的 channel 預設是打擊）。呼叫者要在送任何初始 patch 之前呼叫。
function ensurePorts(ports) {
  if (!synth || !synthHuman || ports <= portCount) return;
  for (const s of [synth, synthHuman]) {
    for (let i = portCount * CHANNELS_PER_PORT; i < ports * CHANNELS_PER_PORT; i++) s.addNewChannel();
    s.reset();
  }
  portCount = ports;
  scheduler.setPortCount(portCount);
}
function isDrumChannelIndex(ch) {
  return ch % CHANNELS_PER_PORT === DRUM_CHANNEL_OFFSET;
}

export async function initEngine() {
  if (isReady) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const { WorkletSynthesizer, Sequencer } = await import(/* @vite-ignore */ LIB_ESM_URL);
      if (!WorkletSynthesizer) throw new Error('缺少必要匯出');
      SequencerClass = Sequencer;

      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      await audioCtx.audioWorklet.addModule(WORKLET_URL);

      // 建構子第二個參數可傳 SynthConfig（oneOutput／audioNodeCreators／eventsEnabled），
      // 刻意不傳：兩個合成器都用標準 Web Audio API 節點（沒用 standardized-audio-context
      // 之類的包裝），也沒有監聽 spessasynth 內建的事件系統，全部吃函式庫預設值即可。
      synth = new WorkletSynthesizer(audioCtx);
      // 真人聲部的第二個合成器。走 humanGain（預設靜音，開啟時刻意比電腦輔助軌大聲，見
      // HUMAN_EMPHASIS_GAIN）→ 同一個 compressor，跟電腦輔助軌共用同一段動態處理。
      synthHuman = new WorkletSynthesizer(audioCtx);
      scheduler.setSynths(synth, synthHuman);
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
      // 電腦輔助的那一軌不掛額外的 gain：它是「我的聲部」音量的比較基準，必須固定不動。
      synth.connect(compressor);
      synthHuman.connect(humanGain);
      humanGain.connect(compressor);
      compressor.connect(masterGain);
      masterGain.connect(audioCtx.destination);

      // 依序試每個來源。同一個 id 'main' 重複加入會取代前一個（spessasynth_core 的 addSoundBank：「新增或取代同 ID 的音色庫」），
      // 所以第一個來源只裝進一個合成器就失敗時，換下一個來源不會留下混版本的狀態。
      let lastErr;
      for (const url of SOUNDFONT_URLS) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const sfBuf = await res.arrayBuffer();
          // addSoundBank 可能把 ArrayBuffer transfer 進 worklet 而 detach 掉，所以先複製一份
          // 給第二個合成器，不能在第一次 add 之後才 slice。
          const sfBufHuman = sfBuf.slice(0);
          await synth.soundBankManager.addSoundBank(sfBuf, 'main');
          await synthHuman.soundBankManager.addSoundBank(sfBufHuman, 'main');
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`SoundFont 載入失敗（${url}）`, err);
        }
      }
      if (lastErr) throw new Error(`SoundFont 所有來源都失敗：${lastErr.message}`);
      if (synth.isReady) await synth.isReady;
      if (synthHuman.isReady) await synthHuman.isReady;

      // 兩個合成器都補到 DEFAULT_PORTS 個 port，見上方常數註解＋channelCountOf() 的註解（呼叫過
      // addNewChannel() 之後，s.midiChannels.length 已查證不可信任，所以這裡固定呼叫
      // (DEFAULT_PORTS - 1) × CHANNELS_PER_PORT 次，不去讀那個 length）。刻意放在 soundBank 載入
      // 完成之後才呼叫：spessasynth_core 對每個動態新增的 channel 會自動先設成打擊 channel
      // 並立刻查一次預設音色（見 createMIDIChannel() 原始碼），這個查詢在 soundBank 還沒
      // 載入時一定查不到，會在 console 噴「No preset found for DRUM:0! Did you forget to
      // add a sound bank?」的警告——已查證 spessasynth_core 原始碼（GitHub
      // spessasus/spessasynth_core 的 src/synthesizer/processor.ts）確認這正是這串警告字面
      // 唯一的來源：找不到音色時呼叫的預設 onMissingPreset handler，只要 program change 當下
      // 還沒有任何 soundBank 就一定會觸發。這則警告本身不影響功能（每個聲部實際的音色仍然是
      // _applyInitialPatch() 之後另外送的 bank／program 決定），純粹是時機問題，把
      // addNewChannel() 挪到 soundBank 載入完成之後即可避開。
      portCount = DEFAULT_PORTS;
      scheduler.setPortCount(portCount);
      for (const s of [synth, synthHuman]) {
        for (let i = CHANNELS_PER_PORT; i < portCount * CHANNELS_PER_PORT; i++) s.addNewChannel();
        // spessasynth_core 的 createMIDIChannel() 會把動態新增的 channel 預設設成打擊 channel（已用 worklet 回讀實測：
        // channel 16～63 全是打擊），旋律聲部超過 15 個的歌，channel 16 以上的聲部就會用鼓組發聲。整個合成器重設一次
        // 會把每個 channel 設回 GM 配置（只有每個 port 的 channel 9 是打擊）。訊息有順序，這個 reset 一定排在上面
        // 那些 addNewChannel 之後才被 worklet 處理。
        s.reset();
      }

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
      scheduler.setSynths(null, null);
      masterGain = undefined;
      humanGain = undefined;
      isReady = false;
      return false;
    } finally { initPromise = null; }
  })();
  return initPromise;
}

// 換歌／換指派／進出試聽前的清場：收掉排程器、試聽與殘響，bank／program 歸零（鼓組 channel 跳過：
// 那裡的 program 是鼓組編號，不是旋律音色）。
export function flushPreviousSong() {
  scheduler.stop();
  previewPlayer?.stop();
  isSongLoaded = false;
  // 官方 Sequencer 載入與跳時間時會自己重設合成器、依那首歌改各 channel 的音色／音量／聲像；
  // 離開試聽時整個重設回預設，之後的演奏才不會繼承那首歌的設定。
  if (previewUsed && synth) { synth.reset(); previewUsed = false; }
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
  ensurePorts(portsNeeded(score, assignments)); // 聲部多到 4 個 port 放不下的歌才會補；補完一定在送初始 patch 之前
  scheduler.load(score, assignments);
  isSongLoaded = true;
}

// 播放中（含暫停）改指派：不重新載入、不從頭，從目前位置接續（排程器的 reassign()）。歌曲需要的 port 變多就先補，補完 reset 過的
// channel 由 reassign() 重送初始狀態。沒載入歌曲時不做事。
export function reassign(score, assignments) {
  if (!isSongLoaded) return;
  ensurePorts(portsNeeded(score, assignments));
  scheduler.reassign(assignments);
}

export async function play() {
  if (isProcessingPlay || !isSongLoaded) return;
  isProcessingPlay = true;
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    scheduler.play();
  } finally { isProcessingPlay = false; }
}
// 從頭重播（重播鍵、播完後按 ▶）：跟 play() 一樣先確保 AudioContext 已恢復（使用者手勢），
// 再交給排程器重設並接著播——重設的內容見 scheduler.js 的 _resetPlayback()。
export async function restart() {
  if (isProcessingPlay || !isSongLoaded) return;
  isProcessingPlay = true;
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    scheduler.restart();
  } finally { isProcessingPlay = false; }
}
export function pause() {
  scheduler.pause(); // 收掉所有正在響的音；每個聲部的播放進度都保留，下次播放從原處繼續
}
// AudioContext 的目前時間（秒），給排程器的 lookahead 換算時間戳用（WorkletSynthesizer 的 eventOptions.time 就是這條時鐘）。
// AudioContext 還沒建起來或沒在跑（被瀏覽器暫停）時回傳 undefined，排程器就不提早送、不帶時間戳。
export function audioNow() { return audioCtx?.state === 'running' ? audioCtx.currentTime : undefined; }
// 量測（main.js 的 window.__stats 用）：AudioContext 自己回報的音訊延遲，跟「按鍵事件等待」「電腦音遲到」並列，
// 看「按下去到聽到聲音」這條路上音訊這一段佔多少。這些是瀏覽器／驅動的估計值，不是實際量到的聲學延遲
// （藍牙耳機等裝置常回報得不準）；瀏覽器沒提供的欄位（例如 Safari 沒有 outputLatency）是 null。AudioContext 還沒建起來回傳 null。
export function audioLatencyInfo() {
  if (!audioCtx) return null;
  // 秒 → 毫秒（留一位小數）；undefined／NaN 轉成 null，免得後面的加總變 NaN
  const toMs = (sec) => (Number.isFinite(sec) ? Math.round(sec * 10000) / 10 : null);
  const ts = audioCtx.getOutputTimestamp?.();
  return {
    狀態: audioCtx.state,
    取樣率Hz: audioCtx.sampleRate,
    // worklet 一次處理 128 個取樣（render quantum）：事件送進去後要等到下一個區塊才被處理，平均半個、最多一個
    渲染區塊ms: toMs(128 / audioCtx.sampleRate),
    內部延遲ms: toMs(audioCtx.baseLatency),     // baseLatency：音訊圖內部處理與緩衝
    輸出延遲ms: toMs(audioCtx.outputLatency),   // outputLatency：從音訊系統送出到實際出聲（作業系統＋硬體）
    // getOutputTimestamp().contextTime＝此刻正從喇叭輸出的那一小段在音訊時鐘上的時間；currentTime（正在渲染的）比它
    // 大多少，就是「渲染到輸出」的落差，拿來跟 outputLatency 互相對照。沒在跑的時候 contextTime 沒有意義，不回報。
    輸出時間戳落後ms: audioCtx.state === 'running' && ts ? toMs(audioCtx.currentTime - ts.contextTime) : null,
  };
}
export function isLoaded() { return isSongLoaded; }
export function isPaused() { return !isSongLoaded || !scheduler.isPlaying(); }
export function isFinished() { return isSongLoaded && scheduler.isFinished(); }

/* ═══════════════════════════════════════════
   試聽（官方 Sequencer，見 previewPlayer.js）
   ═══════════════════════════════════════════ */
// 開始試聽：bytes 是 MIDI 檔的原始位元組，官方自己解析，不經過 midiParser.js。先清場（演奏與上一次
// 試聽都結束），載入完成就從第一個音開始播；失敗丟帶 kind 的 Error：engine＝引擎沒就緒，parse／
// timeout／aborted 見 previewPlayer.js。resolve 時已經在播。
const engineError = (message) => Object.assign(new Error(message), { kind: 'engine' });
export async function startPreview(bytes) {
  if (!isReady && !(await initEngine())) throw engineError('音源引擎載入失敗');
  if (!SequencerClass) throw engineError('音源引擎缺少 Sequencer');
  flushPreviousSong();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  previewPlayer ??= new PreviewPlayer(() => new SequencerClass(synth));
  previewUsed = true;
  await previewPlayer.start(bytes);
}
export function pausePreview() { previewPlayer?.pause(); }
// 續播／從頭跟 play()／restart() 一樣先確保 AudioContext 已恢復；await 期間若換歌（試聽已被 stop），
// PreviewPlayer 自己會忽略這次續播。
export async function resumePreview() {
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
  previewPlayer?.resume();
}
export async function restartPreview() {
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
  previewPlayer?.restart();
}
export function previewTime() { return previewPlayer?.time ?? 0; }
export function previewDuration() { return previewPlayer?.duration ?? 0; }
export function isPreviewFinished() { return previewPlayer?.finished ?? false; }

// humanGain 是總開關兼音量凸顯：播放器算好「該不該開」（播放中、沒播完、真的有指派），這裡
// 只負責平滑地切上去（到 HUMAN_EMPHASIS_GAIN，比電腦輔助軌的固定基準大聲）／切下來（到 0）；
// target 去重，同一個值不重複送。
export function setHumanGate(on) {
  if (!audioCtx || !humanGain) return;
  const target = on ? HUMAN_EMPHASIS_GAIN : 0;
  if (target === lastGateTarget) return;
  lastGateTarget = target;
  try { humanGain.gain.setTargetAtTime(target, audioCtx.currentTime, GATE_RAMP_TC); } catch (e) {}
}
