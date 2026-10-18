// synth.js — spessasynth 合成器：兩個合成器（電腦輔助聲部 synth／真人聲部 synthHuman）、humanGain 閘門＋音量凸顯、試聽（官方 Sequencer 的薄包裝 PreviewPlayer）。
// 演奏不用 Sequencer：兩個合成器只接收 scheduler.js 送來的個別 noteOn／noteOff／初始 program；試聽才用官方 Sequencer（走 synth），
// 跟演奏互斥（共用 synth 的 channel），任何一邊開始前都先 flushPreviousSong() 把另一邊停掉。
// 被指派的聲部固定走 synthHuman（velocity 用樂譜原值），沒被指派的走 synth；HUMAN_EMPHASIS_GAIN 刻意大於 1.0 讓真人聲部突出，電腦輔助軌不掛額外 gain，是音量對比的基準。

import { Scheduler, CHANNELS_PER_PORT, DEFAULT_PORTS, portsNeeded } from './scheduler.js';
import { CC, DRUM_CHANNEL } from './midiParser.js';

// 試聽（PreviewPlayer）：位元組原樣交給官方 Sequencer 自己解析、自己排程（整個在 AudioWorklet 裡，不走 scheduler.js 的主執行緒 tick），
// 所以我們的 parser 解析失敗時試聽仍可用，聽感也能跟演奏對照。這裡只做：等官方非同步載入的結果（songChange／midiError／逾時／被中斷）、
// 播放列需要的最小控制與狀態、關掉官方預設的循環播放；Sequencer 由 initEngine() 注入。

const LOAD_TIMEOUT_MS = 8000;
const EVENT_ID = 'harmonyflow-preview';

// 失敗一律帶 kind 供呼叫端分流：'parse'＝官方解析器拒絕、'timeout'＝官方沒回應、'aborted'＝被 stop()／下一次 start() 中斷（通常靜默處理）
const fail = (kind, message) => Object.assign(new Error(message), { kind });

export class PreviewPlayer {
  /**
   * @param {() => object} createSequencer  回傳一個新的官方 Sequencer（第一次 start() 才呼叫）
   * @param {{ loadTimeoutMs?: number }} [options]
   */
  constructor(createSequencer, { loadTimeoutMs = LOAD_TIMEOUT_MS } = {}) {
    this._create = createSequencer;
    this._timeoutMs = loadTimeoutMs;
    this._seq = null;
    this._loadCount = 0;
    this._abort = null;     // 正在等的那次載入的中斷函式；沒有在等就是 null
    this._active = false;   // 已載入並開始播放、還沒 stop()
  }

  get active() { return this._active; }
  get time() { return this._active ? this._seq.currentTime : 0; }
  get duration() { return this._active ? this._seq.duration : 0; }
  get finished() { return this._active && this._seq.isFinished; }

  // 載入並從頭播放。resolve 時已經開始播；失敗丟 kind＝parse／timeout／aborted 的 Error。
  async start(bytes) {
    this.stop(); // 上一次試聽（包含還在等的載入）先結束
    const seq = (this._seq ??= this._createSequencer());
    // 每次載入用不同檔名當識別：官方 songChange 事件帶檔名，晚到的舊事件靠它擋掉（midiError 沒檔名可比，但解析失敗幾毫秒內就回來）
    const name = `preview-${++this._loadCount}`;
    // 先掛監聽、再送出載入：官方的結果事件可能一送出就回來。
    const loaded = this._waitLoaded(seq, name);
    try {
      seq.loadNewSongList([{ binary: bytes, fileName: name }]);
    } catch (err) {
      this._abort(fail('parse', err.message)); // 連送出都失敗（位元組不能被複製等），當成解析失敗
    }
    await loaded;
    seq.play();
    this._active = true;
  }

  pause() { if (this._active) this._seq.pause(); }

  // 播完之後續播＝從頭（官方 Sequencer 自己也會這樣，這裡明講不依賴它）。
  resume() {
    if (!this._active) return;
    if (this._seq.isFinished) this.restart();
    else this._seq.play();
  }

  // 先設時間再 play：不論現在是暫停或播放中，官方都從第一個音（skipToFirstNoteOn）重新開始。
  restart() {
    if (!this._active) return;
    this._seq.currentTime = 0;
    this._seq.play();
  }

  // 停止：中斷還在等的載入、讓官方播放器暫停（它會把所有發聲中的音收掉）。可重複呼叫。
  stop() {
    this._abort?.(fail('aborted', '試聽被中斷'));
    this._seq?.pause();
    this._active = false;
  }

  _createSequencer() {
    const seq = this._create();
    seq.loopCount = 0; // 官方預設循環播放（-1），試聽播完就該停
    return seq;
  }

  _waitLoaded(seq, name) {
    return new Promise((resolve, reject) => {
      let timer = null;
      // 結束這次等待：只會有一個結果（promise 本身只認第一次 resolve／reject），並把監聽與計時器清掉。
      const settle = (err) => {
        clearTimeout(timer);
        seq.eventHandler.removeEvent('songChange', EVENT_ID);
        seq.eventHandler.removeEvent('midiError', EVENT_ID);
        if (this._abort === settle) this._abort = null;
        if (err) reject(err); else resolve();
      };
      seq.eventHandler.addEvent('songChange', EVENT_ID, (song) => { if (song?.fileName === name) settle(); });
      seq.eventHandler.addEvent('midiError', EVENT_ID, (err) => settle(fail('parse', err?.message || '官方解析器拒絕這首 MIDI')));
      // 官方對「長度 0 秒」的 MIDI 既不回 songChange 也不回 midiError，沒有逾時會永遠卡在載入中。
      timer = setTimeout(() => settle(fail('timeout', '官方播放器沒有回應')), this._timeoutMs);
      this._abort = settle;
    });
  }
}

// 音色庫：CDN 的 2.0.3 為主、本地 2.0.1 為備（依序試，任何一步失敗就換下一個）。CDN 網址釘在 SpessaSynth 官方 repo 的 commit（6f75050），不可變；兩版 preset 清單逐筆相同。
// 不用逾時當備援條件：GitHub Pages 載 10.6MB 實測要 200 秒以上，慢不等於壞。
const SOUNDFONT_URLS = [
  'https://cdn.jsdelivr.net/gh/spessasus/SpessaSynth@6f75050/soundfonts/GeneralUserGS.sf3',
  './src/assets/GeneralUserGS.sf3',
];

// spessasynth_lib 直接從 CDN 匯入（不經 import map）：jsDelivr 的 +esm 端點把 CJS/UMD 轉成瀏覽器能 import 的 ESM；AudioWorklet 處理器跟入口在同一個套件目錄，
// 直接拼路徑（+esm 不是真實目錄，import.meta.resolve 推不出位置）。版本刻意綁 @latest：不手動維護版本號，代價是 jsDelivr 對 @latest 有快取
// （瀏覽器端 7 天／邊緣節點 12 小時），版本可能無預警改變；它依賴的 spessasynth_core 本來就是 latest，兩層都是刻意浮動。
const LIB_ESM_URL = `https://cdn.jsdelivr.net/npm/spessasynth_lib@latest/+esm`;
const WORKLET_URL = `https://cdn.jsdelivr.net/npm/spessasynth_lib@latest/dist/spessasynth_processor.min.js`;

// WorkletSynthesizer 預設只建 16 個 channel（1 個 port）；聲部數超過時多出來的聲部分不到輸出 channel、整段靜音（國旗歌 24 個旋律聲部實測重現）。
// 用 addNewChannel() 動態加開：模仿官方 Sequencer，開機先補到 DEFAULT_PORTS 個 port，歌曲需要更多時在 load() 依 portsNeeded() 補，只增不減。

const GATE_RAMP_TC = 0.03;   // humanGain on/off 的 setTargetAtTime 時間常數（防 click）
const HUMAN_EMPHASIS_GAIN = 1.2; // humanGain 開啟時的目標值；1.4 時真人實測高音太突出、蓋過電腦的低音，所以降到 1.2（約 +1.6 dB）

let audioCtx, synth, masterGain;
// 真人聲部是獨立的第二個合成器 synthHuman，經 humanGain（總開關，播放器決定開關、這裡只平滑切換）接到同一個 compressor
let synthHuman, humanGain;
let isReady = false;
let initPromise = null;
// 兩個合成器目前各有幾個 port 的 channel（兩個永遠一樣多）。自己計數，不讀 midiChannels.length（見 channelCountOf()）。
let portCount = DEFAULT_PORTS;
let isSongLoaded = false;
let isProcessingPlay = false;
let lastGateTarget = -1;
// 試聽：官方 Sequencer 類別在 initEngine() 跟 WorkletSynthesizer 一起取得（缺少只讓試聽不能用，不拖累演奏）；PreviewPlayer 第一次試聽才建立。
// previewUsed＝官方 Sequencer 動過合成器的狀態，下一次 flushPreviousSong() 要多做一次完整重設。
let SequencerClass, previewPlayer = null, previewUsed = false;

// 排程器（scheduler.js）驅動兩個合成器；播放器呼叫 trigger()（觸發當下發聲）並用排程 tick 呼叫 tick()（輔助聲部與到期收音）。
export const scheduler = new Scheduler();

// 不能讀 s.midiChannels.length 當實際 channel 數：已查證 spessasynth_lib 原始碼（basic_synthesizer.ts），addNewChannel() 在主執行緒本地 push 一筆，
// worklet 建好 channel 後又經 channelAdded 事件回呼再 push 一次，length 最終多算成兩倍（實測呼叫 48 次後是 112 不是 64）；
// 對只有 64 個的 worklet 送 channel ≥64 的 controllerChange 會讓它丟 Uncaught TypeError。所以 channel 數只能自己計數（portCount）。
function channelCountOf(s) {
  return s ? portCount * CHANNELS_PER_PORT : CHANNELS_PER_PORT;
}

// 補 channel 到至少 ports 個 port（只增不減，同官方 Sequencer 的 addNewMIDIPort），補完整個合成器重設一次（理由見 initEngine()）。要在送任何初始 patch 之前呼叫
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
  return ch % CHANNELS_PER_PORT === DRUM_CHANNEL;
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

      // 建構子第二個參數（SynthConfig）刻意不傳：用標準 Web Audio 節點、沒有監聽 spessasynth 內建事件系統，全吃函式庫預設值
      synth = new WorkletSynthesizer(audioCtx);
      // 真人聲部的第二個合成器：經 humanGain（預設靜音，開啟時比電腦輔助軌大聲）→ 同一個 compressor，與電腦輔助軌共用動態處理
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
      // 電腦輔助軌不掛額外 gain：它是真人聲部音量的比較基準，必須固定不動
      synth.connect(compressor);
      synthHuman.connect(humanGain);
      humanGain.connect(compressor);
      compressor.connect(masterGain);
      masterGain.connect(audioCtx.destination);

      // 依序試每個來源。同一個 id 'main' 重複加入會取代前一個（addSoundBank 新增或取代同 ID 的音色庫），所以第一個來源只裝進一個合成器就失敗時，換下一個不會留下混版本的狀態
      let lastErr;
      for (const url of SOUNDFONT_URLS) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const sfBuf = await res.arrayBuffer();
          // addSoundBank 可能把 ArrayBuffer transfer 進 worklet 而 detach，所以先複製一份給第二個合成器
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

      // 兩個合成器補到 DEFAULT_PORTS 個 port（不讀 midiChannels.length，見 channelCountOf()），刻意放在 soundBank 載入完成之後：
      // spessasynth_core 對每個動態新增的 channel 會先設成打擊 channel 並立刻查預設音色（createMIDIChannel()），soundBank 還沒載入時查不到，
      // console 會噴「No preset found for DRUM:0!」（已查證是 processor.ts 預設 onMissingPreset handler 唯一的來源）。警告不影響功能，純粹是時機問題。
      portCount = DEFAULT_PORTS;
      scheduler.setPortCount(portCount);
      for (const s of [synth, synthHuman]) {
        for (let i = CHANNELS_PER_PORT; i < portCount * CHANNELS_PER_PORT; i++) s.addNewChannel();
        // 動態新增的 channel 預設是打擊 channel（worklet 回讀實測 channel 16～63 全是打擊），旋律聲部超過 15 個的歌，channel 16 以上會用鼓組發聲。
        // 整個合成器重設一次把每個 channel 設回 GM 配置（只有每個 port 的 channel 9 是打擊）；訊息有順序，reset 一定排在上面的 addNewChannel 之後才被 worklet 處理
        s.reset();
      }

      isReady = true;
      return true;
    } catch (err) {
      console.error('❌ MIDI 引擎初始化失敗', err);
      // 這次失敗留下的 AudioContext 一定要收掉：按播放會重試，每次都 new 一個新的，瀏覽器對同時存在的數量有上限（Chrome 約 6 個）
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
  // 官方 Sequencer 載入與跳時間時會自己重設合成器、依那首歌改各 channel 的音色／音量／聲像；離開試聽時整個重設回預設，之後的演奏才不會繼承
  if (previewUsed && synth) { synth.reset(); previewUsed = false; }
  for (const s of [synth, synthHuman]) {
    if (!s) continue;
    for (let ch = 0; ch < channelCountOf(s); ch++) {
      if (isDrumChannelIndex(ch)) continue;
      try {
        s.controllerChange(ch, CC.BANK_MSB, 0);
        s.controllerChange(ch, CC.BANK_LSB, 0);
        s.controllerChange(ch, CC.ALL_SOUND_OFF, 0);
        s.controllerChange(ch, CC.RESET_ALL, 0);
        s.controllerChange(ch, CC.ALL_NOTES_OFF, 0);
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
// 從頭重播（重播鍵、播完後按 ▶）：同 play() 先確保 AudioContext 已恢復（使用者手勢），重設的內容見 scheduler.js 的 _resetPlayback()
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
// 量測（main.js 的 __stats 用）：AudioContext 回報的音訊延遲，看「按下去到聽到聲音」這條路上音訊這一段佔多少。都是瀏覽器／驅動的估計值（藍牙耳機常不準），
// 瀏覽器沒提供的欄位是 null；AudioContext 還沒建起來回傳 null。
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
    // getOutputTimestamp().contextTime＝此刻正從喇叭輸出的音訊時鐘時間，currentTime 比它大多少就是「渲染到輸出」的落差，拿來對照 outputLatency；沒在跑時沒有意義，不回報
    輸出時間戳落後ms: audioCtx.state === 'running' && ts ? toMs(audioCtx.currentTime - ts.contextTime) : null,
  };
}
export function isLoaded() { return isSongLoaded; }
export function isPaused() { return !isSongLoaded || !scheduler.isPlaying(); }
export function isFinished() { return isSongLoaded && scheduler.isFinished(); }

// 開始試聽：bytes 是 MIDI 原始位元組，官方自己解析、不經 midiParser.js。先清場，載入完成就從第一個音播；
// 失敗丟帶 kind 的 Error（engine＝引擎沒就緒，其餘見 PreviewPlayer），resolve 時已在播。
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
// 續播／從頭同 play()／restart() 先確保 AudioContext 已恢復；await 期間若換歌（試聽已 stop），PreviewPlayer 自己會忽略這次續播
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

// humanGain 是總開關兼音量凸顯：播放器算好該不該開（播放中、沒播完、真的有指派），這裡只負責平滑切上去（HUMAN_EMPHASIS_GAIN）／切下來（0），target 去重
export function setHumanGate(on) {
  if (!audioCtx || !humanGain) return;
  const target = on ? HUMAN_EMPHASIS_GAIN : 0;
  if (target === lastGateTarget) return;
  lastGateTarget = target;
  try { humanGain.gain.setTargetAtTime(target, audioCtx.currentTime, GATE_RAMP_TC); } catch (e) {}
}
