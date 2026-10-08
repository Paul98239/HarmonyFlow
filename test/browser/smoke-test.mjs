// ============================================================
//  smoke-test.mjs — 開發用瀏覽器自動化測試（Task 0）
//
//  比照 Antigravity 這類 agent IDE「直接開真的 Chrome 做內部測試」的做法：用 Playwright 啟動
//  Chromium，帶假攝影機輸入（見下），開啟 app、選人數、載入本地樣本 MIDI、指派一個聲部、按
//  播放，監聽 console／pageerror，跑一段時間後斷言沒有非預期的錯誤或警告。這支腳本只服務
//  開發／測試，不是 app 本身的一部分，也不會被 push 進 GitHub Pages（app 仍然零建置、直接從
//  CDN 匯入相依套件，見 package.json 的說明）。
//
//  假攝影機用 Chrome 專屬的三個啟動旗標（Safari 不支援、Firefox 不能指定檔案）：
//  --use-fake-ui-for-media-stream（跳過權限詢問對話框）、--use-fake-device-for-media-stream
//  （讓 getUserMedia() 吃假輸入）、--use-file-for-fake-video-capture=<path>.y4m（指定一個
//  .y4m 檔當輸入內容；不指定就是 Chrome 內建的合成測試圖案）。
//
//  MediaPipe 姿勢偵測需要畫面裡真的有人形才會產生 landmark，合成測試圖案偵測不到任何姿勢——
//  沒有 --video 參數時，這支腳本能驗證「選人數／載入樂譜／指派聲部／按播放」整條流程沒有拋出
//  非預期的錯誤，但測不到姿勢偵測的實際行為（觸發來源目前是鍵盤，手勢也沒有接進播放器）。要測姿勢偵測，
//  需要一段真人比出拋物線手勢的 .y4m 影片，用 --video <path> 帶進來。
//
//  用法：node test/browser/smoke-test.mjs [--video <path-to.y4m>] [--duration <ms，預設 8000>]
// ============================================================

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// HF_ROOT：變異檢查（test/tools/mutation-check.mjs）把被故意破壞的 src 複本當網站根目錄來跑同一支測試。
const REPO_ROOT = process.env.HF_ROOT ? resolve(process.env.HF_ROOT) : fileURLToPath(new URL('../../', import.meta.url));
const PORT = 5599; // 刻意跟 VS Code Live Server 常用的 5500 錯開，兩者可以同時開著不互相干擾
const SAMPLE_MIDI = join(REPO_ROOT, 'src/assets/canon-violin-cello.mid');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm', // CLAUDE.md 明講：其他靜態伺服器要對 .wasm 回這個 type
};

// Chromium／驅動層本身的雜訊（不是這個 app 自己 console.warn／error 出來的東西），跟 CLAUDE.md
// 「console 只在真的出問題時輸出」講的是 app 自己的 console 紀律，這幾種不算違反那條規則：
const BENIGN_PATTERNS = [
  /\.cc:\d+\]/,                          // MediaPipe／ANGLE 原生 C++ 診斷訊息固定格式「檔名.cc:行號]」，
                                          // app 自己的 JS console.warn／error 不會長這樣，用格式辨識
                                          // 比列舉每一種訊息內容更不容易漏
  /GL Driver Message/i,                  // 軟體／虛擬 GPU 算繪管線常見的效能提示，非 app 邏輯錯誤
  /was preloaded using link preload but not used/i, // headcount 還沒選之前 pose 模型本來就不會被用到
];
const isBenign = (text) => BENIGN_PATTERNS.some((re) => re.test(text));

// 「預期會出現的 console 訊息」：錯誤路徑測試（壞檔、官方解析失敗）本來就該留下 console.warn，不算問題；
// 但同時要證明它真的有留下。expectConsole 在 fn 執行期間把符合的訊息從 problems 排除並計次，回傳每個
// pattern 的命中次數（呼叫端斷言該出現的有出現）。
const tolerated = { patterns: [], hits: new Map() };
async function expectConsole(patterns, fn) {
  tolerated.patterns = patterns;
  tolerated.hits = new Map(patterns.map((re) => [re, 0]));
  try { await fn(); } finally { tolerated.patterns = []; }
  return tolerated.hits;
}

function parseArgs(argv) {
  const args = { duration: 8000, video: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--video') args.video = argv[++i];
    else if (argv[i] === '--duration') args.duration = Number(argv[++i]) || args.duration;
  }
  return args;
}

// 極簡靜態檔案伺服器：只服務這個 repo 底下的檔案，不做任何快取／壓縮邏輯（開發用，夠用就好）。
function startStaticServer(root, port) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const rel = urlPath === '/' ? '/index.html' : urlPath;
      const filePath = normalize(join(root, rel));
      if (!filePath.startsWith(normalize(root))) { res.writeHead(403); res.end(); return; }
      const info = await stat(filePath);
      if (!info.isFile()) { res.writeHead(404); res.end(); return; }
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// 播放列四顆鈕（▶ 播放／❚❚ 暫停／↻ 重播／♪ 試聽）的狀態，對照 CLAUDE.md 的狀態表：能按＝沒有
// disabled，current＝目前狀態的鈕（accent 黃底；試聽中 ♪ 也是），empty＝pill 的 is-empty（沒歌可播，
// 淡化條件靠它）。名稱開頭是 preview 的列＝試聽中（狀態表下半），busy＝載入／續播／重播處理中。
const TRANSPORT_STATES = {
  idle:     { play: false, pause: false, replay: false, preview: false, current: [], empty: true },
  loading:  { play: false, pause: false, replay: false, preview: false, current: [], empty: true },
  ready:    { play: true,  pause: false, replay: false, preview: true,  current: [], empty: false },
  playing:  { play: false, pause: true,  replay: false, preview: false, current: ['btnPause'], empty: false },
  paused:   { play: true,  pause: false, replay: true,  preview: true,  current: [], empty: false },
  finished: { play: true,  pause: false, replay: true,  preview: true,  current: [], empty: false },
  busy:     { play: false, pause: false, replay: false, preview: false, current: [], empty: false },
  previewPlaying:  { play: false, pause: true,  replay: false, preview: true, current: ['btnPause', 'btnPreview'], empty: false },
  previewPaused:   { play: true,  pause: false, replay: true,  preview: true, current: ['btnPreview'], empty: false },
  previewFinished: { play: true,  pause: false, replay: true,  preview: true, current: ['btnPreview'], empty: false },
};
async function expectTransport(page, name, problems) {
  const got = await page.evaluate(() => ({
    play: !document.getElementById('btnPlay').disabled,
    pause: !document.getElementById('btnPause').disabled,
    replay: !document.getElementById('btnReplay').disabled,
    preview: !document.getElementById('btnPreview').disabled,
    current: [...document.querySelectorAll('#transport-group .is-current')].map((el) => el.id),
    empty: document.getElementById('toolbar-playback').classList.contains('is-empty'),
  }));
  const ok = JSON.stringify(got) === JSON.stringify(TRANSPORT_STATES[name]);
  console.log(`  ${ok ? '✓' : '✗'} 按鈕狀態「${name}」`);
  if (!ok) problems.push(`按鈕狀態「${name}」不符：預期 ${JSON.stringify(TRANSPORT_STATES[name])}，實際 ${JSON.stringify(got)}`);
}
// 動態 import 同一個 module 實例（同 URL），直接讀寫 store／排程器。「載入中」「播完」很難在 8 秒內自然
// 走到，直接改 store 驗證畫面照狀態表；播放位置則讀排程器的真實值（tick 播放頭，用 score 的速度表換算成原譜秒數）。
const setStore = (page, patch) => page.evaluate(async (p) => {
  (await import('/src/midi/midiPlayer.js')).playerStore.set(p);
}, patch).then(() => page.waitForTimeout(80));
const positionSeconds = (page) => page.evaluate(async () => {
  const { scheduler } = await import('/src/midi/synth.js');
  return scheduler._score ? scheduler._score.midiTicksToSeconds(scheduler.getPositionTicks()) : 0;
});
// 演奏有指派聲部時，播放頭只在觸發時往前（每放行一個 segment 就跳到它的 tick）：這裡按觸發鍵（PC 鍵盤手，真實的鍵盤路徑）一下一下
// 把進度推到超過 seconds 才回傳（逾時或按了 400 下就回傳目前的值，讓後面的斷言報出實際數字）。
async function waitForPositionAbove(page, seconds, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  await page.evaluate(() => document.activeElement?.blur()); // 焦點在按鈕上時字元鍵一樣觸發，但先清掉焦點比較單純
  for (let i = 0; i < 400; i++) {
    const pos = await positionSeconds(page);
    if (pos > seconds || Date.now() > deadline) return pos;
    await page.keyboard.press('KeyF');
  }
  return positionSeconds(page);
}
// 在頁面內同一個 JS task 裡按下按鈕並立刻讀排程器位置：click 事件與排程器的重設都是同步做的，讀到的
// 就是「剛重設」的值，不受 Playwright 往返延遲影響（無頭瀏覽器同時跑 MediaPipe 時，往返動輒一秒，
// 進度在讀取前又走了一段）。
const clickAndReadPosition = (page, buttonId) => page.evaluate(async (id) => {
  const { scheduler } = await import('/src/midi/synth.js');
  document.getElementById(id).click();
  return scheduler._score ? scheduler._score.midiTicksToSeconds(scheduler.getPositionTicks()) : 0;
}, buttonId);

// ── 試聽（官方 Sequencer）相關的小工具 ──
// waitForFunction 的判斷式必須是「同步」函式：async 函式回傳的 Promise 本身永遠是 truthy，Playwright 會當成
// 條件立刻成立，等於沒等。所以把 store 與 synth 模組掛到測試頁面的 window.__hf（只在測試頁面上，app 不知道），
// 判斷式就能同步讀。
const exposeModules = (page) => page.evaluate(async () => {
  window.__hf = {
    store: (await import('/src/midi/midiPlayer.js')).playerStore,
    synth: await import('/src/midi/synth.js'),
  };
});
const previewTime = (page) => page.evaluate(async () => (await import('/src/midi/synth.js')).previewTime());
const storeState = (page) => page.evaluate(async () => {
  const s = (await import('/src/midi/midiPlayer.js')).playerStore.state;
  return { mode: s.mode, transport: s.transport, started: s.started, finished: s.finished, busy: s.busy, notice: s.notice, previewDuration: s.previewDuration };
});
// 輪詢到試聽時間超過 seconds（官方 Sequencer 在 AudioWorklet 裡跑，時間靠 AudioContext 往前走；
// context 沒恢復或沒在播時時間不會動）。逾時回傳目前的值讓斷言報出實際數字。
async function waitForPreviewTimeAbove(page, seconds, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await previewTime(page);
    if (t > seconds || Date.now() > deadline) return t;
    await page.waitForTimeout(100);
  }
}
const check = (ok, label, problems, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) problems.push(`${label}${detail ? `：${detail}` : ''}`);
};

// 一個只有一個音（4 拍＝2 秒）的最小合法 SMF，試聽「播完」與「換歌」用。不放進 repo：現場組出來比附檔案直接。
function makeTinyMidi() {
  const track = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,   // 速度 500000 μs／四分音符＝120 BPM
    0x00, 0xc0, 0x00,                            // program 0
    0x00, 0x90, 0x3c, 0x64,                      // 中央 C note-on
    0x8f, 0x00, 0x80, 0x3c, 0x40,                // 1920 tick（4 拍）後 note-off（delta 0x8F 0x00 ＝ 1920）
    0x00, 0xff, 0x2f, 0x00,                      // end of track
  ];
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]; // format 0、1 軌、480 tpq
  const len = track.length;
  return Buffer.from([...header, 0x4d, 0x54, 0x72, 0x6b, 0, 0, (len >> 8) & 0xff, len & 0xff, ...track]);
}
const TINY_MIDI = { name: 'tiny.mid', mimeType: 'audio/midi', buffer: makeTinyMidi() };

// 在頁面內重新載入一份本地檔案並等到 ready：換來源一律走真的 change 事件（同使用者選檔）。
async function loadLocalFile(page, file) {
  await page.setInputFiles('#localMidiInput', file);
  await page.waitForFunction((name) => {
    const s = window.__hf.store.state;
    return s.transport === 'paused' && !s.busy && s.source?.name === name;
  }, file.name, { timeout: 15000 });
}

// MuseScore 匯出器形狀的 MIDI（跟 test/unit/playability.test.mjs 同一份佈局）：鋼琴兩行譜（上行譜有初始化區塊，音量 90）、
// 弓弦兩個 channel 有音（normal 與 pizzicato，pizzicato 的混音值不是預設）、打擊（channel 9）。約 4 秒。
function makeMuseScoreShapedMidi() {
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const vlq = (n) => { const b = [n & 0x7f]; n >>>= 7; while (n > 0) { b.unshift((n & 0x7f) | 0x80); n >>>= 7; } return b; };
  const track = (events) => {
    const body = events.flatMap((e) => [...vlq(e.d), ...e.b]).concat([...vlq(0), 0xff, 0x2f, 0x00]);
    return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
  };
  const enc = new TextEncoder();
  const nameEv = (s) => { const b = [...enc.encode(s)]; return { d: 0, b: [0xff, 0x03, b.length, ...b] }; };
  const cc = (c, n, v) => ({ d: 0, b: [0xb0 | c, n, v] });
  const init = (c, program, { vol = 100, pan = 64, rev = 0, cho = 0 } = {}) =>
    [cc(c, 121, 0), { d: 0, b: [0xc0 | c, program] }, cc(c, 7, vol), cc(c, 10, pan), cc(c, 91, rev), cc(c, 93, cho)];
  const notes = (c, pitches, { start = 0, dur = 479 } = {}) => pitches.flatMap((p, i) => [
    { d: i === 0 ? start : 1, b: [0x90 | c, p, 90 + i] }, { d: dur, b: [0x80 | c, p, 0] }]);
  const tracks = [
    track([nameEv('Piano'), { d: 0, b: [0xff, 0x51, 3, 0x07, 0xa1, 0x20] }, ...init(0, 0, { vol: 90 }), ...notes(0, [72, 74, 76, 77, 79, 81, 83, 84])]),
    track([nameEv('Piano'), ...notes(0, [48, 50, 52, 53, 55, 57, 59, 60])]),
    track([nameEv('Violin'), ...init(1, 40), ...init(2, 45, { vol: 80, pan: 30, rev: 20, cho: 10 }), ...init(3, 44),
      ...notes(1, [67, 69, 71, 72]), ...notes(2, [60, 62, 64, 65], { start: 2400 })]),
    track([nameEv('Drumset'), ...init(9, 0), ...notes(9, [36, 38, 36, 38, 36, 38, 36, 38], { dur: 100 })]),
  ];
  return Buffer.from([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, 0, tracks.length, 0x01, 0xe0, ...tracks.flat()]);
}
const MUSESCORE_MIDI = { name: 'musescore-shaped.mid', mimeType: 'audio/midi', buffer: makeMuseScoreShapedMidi() };

// worklet 回讀：真的把檔案載入、整首自動播放，同時監聽 worklet 回報的事件（合成器處理過的 programChange／controllerChange／
// noteOn，不是我們自己記的值），逐個 staff 檢查：它的輸出 channel 在第一個 noteOn 之前，worklet 真的收到了該 staff 的
// program 與 CC7／10／91／93（值等於 parser 解出來、排程器送出去的），打擊 staff 真的在打擊 channel 出聲，而且各 channel 的
// 打擊配置在載入前後都是 GM 的樣子。冒煙測試看不到 worklet 內部，光「沒有報錯」不算通過。
async function checkWorkletReadback(page, problems) {
  console.log('▶ worklet 回讀：載入 MuseScore 形狀的譜、整首自動播放，檢查 worklet 收到的初始狀態…');
  await loadLocalFile(page, MUSESCORE_MIDI);
  await page.evaluate(async () => {
    const { scheduler } = await import('/src/midi/synth.js');
    window.__echo = [];
    for (const [label, syn] of [['assist', scheduler.assistSynth], ['human', scheduler.humanSynth]]) {
      syn.eventHandler.addEvent('programChange', 'smoke-echo', (e) => window.__echo.push({ label, t: 'pc', ch: e.channel, program: e.program, msb: e.bankMSB, lsb: e.bankLSB }));
      syn.eventHandler.addEvent('controllerChange', 'smoke-echo', (e) => window.__echo.push({ label, t: 'cc', ch: e.channel, cc: e.controller, value: e.value }));
      syn.eventHandler.addEvent('noteOn', 'smoke-echo', (e) => window.__echo.push({ label, t: 'on', ch: e.channel, key: e.midiNote }));
    }
  });
  await page.click('#btnPlay');
  // headless 同時跑姿勢推論，排程 tick 常被主執行緒卡住（每個 tick 最多前進 100ms），進度只有真實時間的三成左右：等待上限要寬。
  await page.waitForFunction(() => window.__hf.synth.scheduler.isFinished(), null, { timeout: 90000 });
  await page.waitForTimeout(600); // worklet 的事件回報是非同步的，等最後幾個到齊
  const got = await page.evaluate(async () => {
    const { scheduler } = await import('/src/midi/synth.js');
    const staves = [...scheduler._staves.values()].map((v) => ({
      id: v.id, kind: v.kind, channel: v.channel, program: v.program, percussionKit: v.percussionKit,
      baseVolume: v.baseVolume, init: v.init, noteCount: v.notes.length,
    }));
    const drums = (syn) => Array.from({ length: 64 }, (_, i) => (syn.midiChannels[i]?.patch?.isDrum ? i : -1)).filter((i) => i >= 0);
    return { staves, echo: window.__echo, drums: drums(scheduler.assistSynth) };
  });
  check(got.staves.length === 5, '載入後有 5 個 staff（鋼琴 2、弓弦 2、打擊 1）', problems, JSON.stringify(got.staves.map((v) => v.id)));
  for (const v of got.staves) {
    const mine = got.echo.filter((e) => e.label === 'assist' && e.ch === v.channel);
    const firstOn = mine.findIndex((e) => e.t === 'on');
    const before = firstOn < 0 ? [] : mine.slice(0, firstOn);
    const lastCc = (n) => before.filter((e) => e.t === 'cc' && e.cc === n).at(-1)?.value;
    const lastProgram = before.filter((e) => e.t === 'pc').at(-1)?.program;
    const want = { volume: v.baseVolume, pan: v.init?.pan ?? 64, reverb: v.init?.reverb ?? 0, chorus: v.init?.chorus ?? 0 };
    const ok = firstOn >= 0 && lastProgram === v.program && lastCc(7) === want.volume && lastCc(10) === want.pan && lastCc(91) === want.reverb && lastCc(93) === want.chorus;
    check(ok, `worklet 在 ${v.id}（輸出 ch${v.channel}）第一個 noteOn 之前收到 program ${v.program} 與 CC7／10／91／93＝${want.volume}／${want.pan}／${want.reverb}／${want.chorus}`, problems,
      JSON.stringify({ 第一個noteOn位置: firstOn, program: lastProgram, cc7: lastCc(7), cc10: lastCc(10), cc91: lastCc(91), cc93: lastCc(93) }));
    const ons = mine.filter((e) => e.t === 'on').length;
    check(ons === v.noteCount, `${v.id} 的 noteOn 在 worklet 端都發聲了（${v.noteCount} 顆）`, problems, `實際 ${ons}`);
  }
  const drumStaff = got.staves.find((v) => v.percussionKit);
  check(drumStaff?.channel === 9 && JSON.stringify(got.drums) === '[9,25,41,57]', '打擊 staff 在 channel 9，且載入後 worklet 的打擊配置仍是 GM（9／25／41／57）', problems, JSON.stringify({ channel: drumStaff?.channel, drums: got.drums }));
}

// 時間戳（lookahead 的前提）：WorkletSynthesizer 的 eventOptions.time 跟 AudioContext.currentTime 是同一條時鐘——時間戳在未來的事件
// worklet 排隊、到時才處理，已經過去的立刻處理。用 worklet 回報的 noteOn 抵達時間驗證（回報是非同步的，所以容許幾百毫秒的誤差）。
// 時鐘對不上時（例如差了一個時間原點）未來的事件會馬上響或永遠不響，整個 lookahead 就沒有意義，單元測試看不到這一點。
// __stats() 的音訊輸出延遲（AudioContext 回報的 baseLatency／outputLatency／getOutputTimestamp）：這個測試跑在 Chromium，
// 欄位都該有值；實際數字看跑的機器（無頭模式用軟體輸出），所以只驗結構與換算，不驗大小。
async function checkAudioLatencyStats(page, problems) {
  console.log('▶ 音訊輸出延遲量測：__stats() 回報 AudioContext 的延遲欄位、並串成「估計按下到出聲」…');
  const s = await page.evaluate(() => window.__stats());
  const a = s.音訊輸出, est = s.估計按下到出聲ms;
  check(a && a.狀態 === 'running', 'AudioContext 在跑時 __stats().音訊輸出 有值', problems, JSON.stringify(a));
  if (!a) return;
  const num = (x) => Number.isFinite(x) && x >= 0;
  check(num(a.內部延遲ms) && num(a.輸出延遲ms), 'baseLatency／outputLatency 都有數字（Chromium 提供）', problems, JSON.stringify(a));
  check(Math.abs(a.渲染區塊ms - (128 / a.取樣率Hz) * 1000) < 0.1, '渲染區塊 ＝ 128 個取樣的長度', problems, `${a.渲染區塊ms}ms @ ${a.取樣率Hz}Hz`);
  check(num(a.輸出時間戳落後ms), 'getOutputTimestamp 換算出的落差有數字', problems, JSON.stringify(a));
  const fixed = a.渲染區塊ms / 2 + a.內部延遲ms + a.輸出延遲ms;
  check(est && Math.abs(est.固定音訊段ms - fixed) < 0.2, '估計的固定音訊段 ＝ 半個渲染區塊 ＋ 內部延遲 ＋ 輸出延遲', problems, JSON.stringify(est));
  check(est && est.count === s.按鍵事件等待ms.count, '估計用的樣本就是按鍵事件等待的那一批', problems, `${est?.count} vs ${s.按鍵事件等待ms.count}`);
}

async function checkTimedEvents(page, problems) {
  console.log('▶ 時間戳：worklet 依 AudioContext 時間排隊（未來的事件到時才響、過去的立刻響）…');
  const r = await page.evaluate(async () => {
    const { scheduler, audioNow } = await import('/src/midi/synth.js');
    const syn = scheduler.assistSynth, arrived = {};
    syn.eventHandler.addEvent('noteOn', 'smoke-timed', (e) => { arrived[e.midiNote] ??= performance.now(); });
    const ctxNow = audioNow();
    if (ctxNow === undefined) return { running: false };
    const t0 = performance.now();
    syn.noteOn(0, 70, 100, { time: ctxNow + 0.8 });      // 未來 800ms
    syn.noteOn(0, 71, 100, { time: ctxNow - 1 });        // 過去：立刻處理
    await new Promise((resolve) => setTimeout(resolve, 2000));
    syn.noteOff(0, 70); syn.noteOff(0, 71);
    syn.eventHandler.removeEvent('noteOn', 'smoke-timed');
    return { running: true, future: arrived[70] - t0, past: arrived[71] - t0 };
  });
  check(r.running, 'AudioContext 在跑（audioNow() 有值）', problems, JSON.stringify(r));
  if (!r.running) return;
  check(Number.isFinite(r.future) && r.future >= 650 && r.future <= 1500, '時間戳在未來 800ms 的 noteOn：約 800ms 後才被 worklet 處理（不是馬上、也不是永遠不響）', problems, `實際 ${r.future}ms`);
  check(Number.isFinite(r.past) && r.past <= 500, '時間戳已經過去的 noteOn：立刻處理', problems, `實際 ${r.past}ms`);
}

// 試聽基本操作（選好範例、演奏還沒播過的 ready 狀態開始）：♪ 進入試聽 → 時間真的往前走 → ❚❚ 暫停
// （時間停住）→ ▶ 續播（從暫停處繼續，不是從頭）→ 再暫停 → ↻ 重播（回到第一個音附近）→ ♪ 離開，
// 回到演奏「已載入、還沒播過」。這也是第一次在 AudioContext 還沒恢復時用到官方 Sequencer：時間會動
// 就證明 ♪ 的點擊有把 context resume 起來。
async function drivePreviewControls(page, problems) {
  console.log('▶ 試聽：按 ♪ 進入試聽（官方 Sequencer 自己解析、自己播）…');
  await page.click('#btnPreview');
  await page.waitForSelector('#btnPreview.is-current', { timeout: 15000 });
  await expectTransport(page, 'previewPlaying', problems);
  const t0 = await previewTime(page);
  const t1 = await waitForPreviewTimeAbove(page, t0 + 2.5);
  check(t1 > t0 + 2.5, '試聽的時間往前走（AudioContext 已恢復、官方 Sequencer 真的在播）', problems, `${t0.toFixed(2)}s → ${t1.toFixed(2)}s`);
  const bar = await page.evaluate(() => {
    const el = document.getElementById('topProgressBar');
    return { hidden: el.hidden, value: el.value };
  });
  const st = await storeState(page);
  check(!bar.hidden && bar.value > 0 && st.previewDuration > 0, '試聽時頂端進度條顯示官方 currentTime／duration', problems, JSON.stringify({ bar, previewDuration: st.previewDuration }));

  console.log('▶ 試聽：暫停 → 續播 → 暫停 → 重播…');
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 5000 });
  await expectTransport(page, 'previewPaused', problems);
  // 「暫停後時間停住」＝在合理時間內穩定下來，不是暫停那一刻的值不再變：官方的暫停是送訊息給 worklet 處理，這裡同時在跑
  // MediaPipe，主執行緒／音訊執行緒忙的時候實測會晚到好幾百毫秒，worklet 每秒送一次的 sync 又會把顯示時間校正過去。
  // 連續兩次讀值（相隔 500ms）差距 < 0.05s 就算穩定；真的沒停的話永遠穩定不下來。
  let tp = await previewTime(page), stable = false;
  for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
    await page.waitForTimeout(500);
    const now = await previewTime(page);
    if (Math.abs(now - tp) < 0.05) { stable = true; tp = now; break; }
    tp = now;
  }
  check(stable, '暫停後試聽時間停住（暫停與 sync 校正幾秒內塵埃落定）', problems, `最後讀到 ${tp.toFixed(2)}s`);
  await page.click('#btnPlay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 5000 });
  const t3 = await waitForPreviewTimeAbove(page, tp + 0.4);
  check(t3 > tp + 0.4 && t3 < tp + 5, '續播從暫停處繼續（不是從頭）', problems, `暫停在 ${tp.toFixed(2)}s、續播後 ${t3.toFixed(2)}s`);
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 5000 });
  await page.click('#btnReplay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 5000 });
  // 重播＝回到第一個音：時間要掉回開頭附近（官方 skipToFirstNoteOn，第一個音之前的空白不播）
  let tr = Infinity;
  for (const deadline = Date.now() + 5000; Date.now() < deadline && !(tr < t0 + 1.5); await page.waitForTimeout(100)) tr = await previewTime(page);
  check(tr < t0 + 1.5, '重播回到開頭（第一個音附近）', problems, `重播前 ${t3.toFixed(2)}s、重播後 ${tr.toFixed(2)}s、第一次開始時 ${t0.toFixed(2)}s`);

  console.log('▶ 試聽：再按 ♪ 離開，回到演奏…');
  await page.click('#btnPreview');
  await page.waitForFunction(() => !document.getElementById('btnPreview').classList.contains('is-current'), null, { timeout: 5000 });
  await expectTransport(page, 'ready', problems);
  const after = await storeState(page);
  check(after.mode === 'perform' && !after.started && !after.finished, '離開試聽：演奏回到「已載入、還沒播過」', problems, JSON.stringify(after));
  check((await previewTime(page)) === 0, '離開試聽：官方 Sequencer 已停（試聽時間歸零）', problems);
  await page.waitForTimeout(300); // 讓 uiTick（200ms）把進度寫回
  const barAfter = await page.evaluate(() => document.getElementById('topProgressBar').value);
  check(barAfter < 0.001, '離開試聽：進度條歸零', problems, String(barAfter));
}

// worklet 回讀：開機後兩個合成器各 64 個 channel 的打擊配置。主執行緒的 synth.midiChannels[i].patch 是 worklet 回報的
// 狀態（programChange 事件），不是我們自己記的值——只有每個 port 的 channel 9（9／25／41／57）該是打擊，其餘都是旋律。
// spessasynth_core 對動態新增的 channel 預設會設成打擊 channel，沒有明確改回來的話，channel 16 以上的旋律聲部會用鼓組
// 發聲（旋律聲部超過 15 個的歌，例如國旗歌的 24 個）。冒煙測試看不到 worklet 內部，光「沒有報錯」不算通過。
async function checkChannelLayout(page, problems) {
  await page.waitForTimeout(800); // worklet 的狀態回報是非同步的，等它們都到
  const drums = await page.evaluate(async () => {
    const { scheduler } = await import('/src/midi/synth.js');
    const drumsOf = (syn) => Array.from({ length: 64 }, (_, i) => (syn.midiChannels[i]?.patch?.isDrum ? i : -1)).filter((i) => i >= 0);
    return { assist: drumsOf(scheduler.assistSynth), human: drumsOf(scheduler.humanSynth) };
  });
  for (const label of ['assist', 'human']) {
    check(JSON.stringify(drums[label]) === '[9,25,41,57]', `開機後 ${label} 合成器只有每個 port 的 channel 9 是打擊（9／25／41／57）`, problems, `實際打擊 channel：${drums[label]}`);
  }
}

// 歌曲需要的 port 比開機補的多（62 個旋律 staff 要 5 個 port）：載入時 synth.js 依需要補 channel 並重設，worklet 的打擊配置
// 要變成 5 個 port 的 channel 9（9／25／41／57／73），其餘（含新補的 64～79）是旋律；62 個 staff 全部分得到輸出 channel。
async function checkChannelGrowth(page, problems) {
  console.log('▶ 歌曲需要更多 port：載入 62 個旋律 staff 的樂譜，檢查 channel 依需要補、打擊配置…');
  const got = await page.evaluate(async () => {
    const { scheduler, load } = await import('/src/midi/synth.js');
    const parts = Array.from({ length: 62 }, (_, i) => ({ id: `p${i}`, trackIndex: i, channel: i % 16, program: 0, bank: { msb: 121, lsb: 0 }, percussionKit: false, init: null, noteCount: 1,
      staves: [{ id: `v${i}`, program: 0, bank: { msb: 121, lsb: 0 }, percussionKit: false, init: null, noteCount: 1 }] }));
    const notes = parts.map((p, i) => ({ partId: p.id, staffId: `v${i}`, trackIndex: i, channel: i % 16, midiNote: 60, velocity: 90, startTick: 0, endTick: 480, startSeconds: 0, endSeconds: 0.5, durationSeconds: 0.5 }));
    const score = { parts, notes, segments: [{ ticks: 0, notes }], timeDivision: 480, durationTicks: 1920, durationSeconds: 2, midiTicksToSeconds: (t) => t / 960, secondsToMIDITicks: (sec) => sec * 960,
      timeSignatures: [{ ticks: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }] };
    await load(score, []);
    await new Promise((r) => setTimeout(r, 800)); // worklet 的狀態回報是非同步的
    const drumsOf = (syn) => Array.from({ length: 80 }, (_, i) => (syn.midiChannels[i]?.patch?.isDrum ? i : -1)).filter((i) => i >= 0);
    const channels = [...scheduler._staves.values()].map((v) => v.channel);
    return { assist: drumsOf(scheduler.assistSynth), human: drumsOf(scheduler.humanSynth), staves: channels.length, maxChannel: Math.max(...channels), unplaced: scheduler.unplacedStaffIds.length };
  });
  check(got.staves === 62 && got.unplaced === 0, '62 個旋律 staff 全部分得到輸出 channel（不再有 60 個的上限）', problems, JSON.stringify(got));
  check(got.maxChannel >= 64 && got.maxChannel < 80, '有 staff 落在新補的 channel 64～79', problems, `最大 channel ${got.maxChannel}`);
  for (const label of ['assist', 'human']) {
    check(JSON.stringify(got[label]) === '[9,25,41,57,73]', `補 channel 之後 ${label} 合成器只有每個 port 的 channel 9 是打擊（9／25／41／57／73）`, problems, `實際打擊 channel：${got[label]}`);
  }
}

// 選人數 → 開選歌面板 → 上傳本地樣本 MIDI → 等分譜列出來 → （試聽基本操作）→ 把第一個聲部指派給 PC 鍵盤手
// → 按播放 → 暫停 → 重播，沿途逐一斷言四顆鈕的狀態。跟真實使用者操作路徑一致（見 index.html 的
// data-field／data-action），不繞過 UI 直接呼叫內部函式（只有「載入中」「播完」兩種難以自然走到的狀態例外）。
async function driveAppToPlaying(page, problems) {
  await expectTransport(page, 'idle', problems);
  await checkChannelLayout(page, problems);
  await checkChannelGrowth(page, problems);

  console.log('▶ 選現場人數＝1…');
  await page.selectOption('#poseCountSelect', '1');

  console.log('▶ 開啟選歌面板、上傳本地樣本 MIDI…');
  await page.click('#song-toggle');
  await page.setInputFiles('#localMidiInput', SAMPLE_MIDI);

  console.log('▶ 等待分譜列出來…');
  await page.waitForSelector('.score-part-id', { timeout: 10000 });
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 10000 });
  await expectTransport(page, 'ready', problems);

  await drivePreviewControls(page, problems);
  await checkWorkletReadback(page, problems);
  await checkTimedEvents(page, problems);
  await checkAudioLatencyStats(page, problems);
  await loadLocalFile(page, { name: 'canon-violin-cello.mid', mimeType: 'audio/midi', buffer: readFileSync(SAMPLE_MIDI) }); // 換回範例樂譜，後面的流程照舊

  console.log('▶ 把第一個聲部指派給 PC 鍵盤手…');
  await page.locator('.score-part-id').first().selectOption('kb');   // PC 鍵盤手不依賴現場人數（不必等姿勢模型）

  console.log('▶ 按下播放…');
  await page.click('#btnPlay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 10000 });
  await expectTransport(page, 'playing', problems);

  const before = await waitForPositionAbove(page, 1); // 按觸發鍵把播放頭推進到 1 秒以上

  console.log('▶ 暫停、再按重播…');
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 5000 });
  await expectTransport(page, 'paused', problems);
  const after = await clickAndReadPosition(page, 'btnReplay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 10000 });
  const posOk = before > 1 && after < 0.1;
  console.log(`  ${posOk ? '✓' : '✗'} 重播後進度回到開頭（重播前 ${before.toFixed(2)}s → 重播後 ${after.toFixed(2)}s）`);
  if (!posOk) problems.push(`重播後進度沒有回到開頭：重播前 ${before.toFixed(2)}s、重播後 ${after.toFixed(2)}s`);

  console.log('▶ 驗證「載入中」「播完」兩種狀態的畫面…');
  await setStore(page, { transport: 'loading' });
  await expectTransport(page, 'loading', problems);
  await setStore(page, { transport: 'paused', finished: true });
  await expectTransport(page, 'finished', problems);
  const beforeFinishedPlay = await waitForPositionAbove(page, 1);
  const afterFinishedPlay = await clickAndReadPosition(page, 'btnPlay'); // 播完後按 ▶＝從頭播
  await page.waitForSelector('#btnPause.is-current', { timeout: 10000 });
  const finOk = beforeFinishedPlay > 1 && afterFinishedPlay < 0.1;
  console.log(`  ${finOk ? '✓' : '✗'} 播完後按 ▶ 從頭播（${beforeFinishedPlay.toFixed(2)}s → ${afterFinishedPlay.toFixed(2)}s）`);
  if (!finOk) problems.push(`播完後按 ▶ 沒有從頭播：${beforeFinishedPlay.toFixed(2)}s → ${afterFinishedPlay.toFixed(2)}s`);
}

// 鍵盤觸發（接在 driveAppToPlaying 後面，此時演奏播放中、第一個聲部指派給 PC 鍵盤手）：觀察點是排程器的 driver segment 游標
// （segIndex＝已放行的 driver segment 數）。trigger() 在 keydown 事件裡同步執行，按鍵送出之後游標立刻就變了，不用等排程 tick——
// 所以讀取前不需要任何等待。但兩次有效按鍵之間要隔過去抖窗口（最長 500ms，見 pressTiming.js），預期「被放行」的按鍵前先
// waitDebounce()，不然會被當成手抖忽略。等的是「排程器時鐘」走過窗口，不是真實時間：headless 同時跑姿勢推論時排程器時鐘只有真實時間的三成左右。
const waitDebounce = (page) => page.waitForFunction(() => {
  const sch = window.__hf.synth.scheduler;
  return sch._lastAcceptClock == null || sch._clockMs - sch._lastAcceptClock >= 600;
}, null, { timeout: 120000 });
async function driveKeyboardTrigger(page, problems) {
  console.log('▶ 鍵盤觸發：四排字元鍵＝PC 鍵盤手放行全曲的下一個 segment，防呆（repeat／組合鍵／打字／下拉 type-ahead）…');
  const slot = () => page.evaluate(() => {
    const sch = window.__hf.synth.scheduler;
    const sounding = [...sch._staves.values()].some((v) => v.sounding.size > 0);
    const humanSounding = [...sch._staves.values()].some((v) => v.kind === 'human' && v.sounding.size > 0);
    return { seg: sch._segIndex, sounding, humanSounding, credit: sch._preludeCredit };
  });
  await page.evaluate(() => document.activeElement?.blur());

  // 前奏鎖：範例樂譜是卡農，第一個聲部（小提琴，目前指派給 PC 鍵盤手）要等大提琴先進的前奏播完（約 14 秒）才入場，
  // ▶ 之後馬上按不能放行（放行就會跳過大提琴的前奏）；只記成預按。
  let s = await slot();
  check(s.seg === 0, '按鍵之前：還沒有任何 driver segment 被放行', problems, JSON.stringify(s));
  await page.keyboard.press('KeyF');
  let t = await slot();
  check(t.seg === 0 && !t.humanSounding && t.credit === true, '前奏鎖：小提琴入場之前（大提琴前奏中）按鍵不放行、只記預按', problems, JSON.stringify(t));

  // 後面的鍵盤檢查要「按一下就放行」，所以改指派給沒有前奏的大提琴（第二個聲部，tick 0 起音），暫停後重播讓新指派生效。
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 5000 });
  await page.locator('.score-part-id').nth(0).selectOption('');
  await page.locator('.score-part-id').nth(1).selectOption('kb');
  await page.click('#btnReplay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 15000 });
  await page.evaluate(() => document.activeElement?.blur());

  s = await slot();
  check(s.seg === 0 && s.credit === false, '換成大提琴重播之後：游標歸零、預按已作廢', problems, JSON.stringify(s));
  await page.keyboard.press('KeyF');
  t = await slot();
  check(t.seg === 1 && t.sounding, '按一下 F：放行第一個 driver segment、音當下就在響', problems, JSON.stringify(t));

  s = t;
  await waitDebounce(page);
  await page.keyboard.down('KeyG');
  await waitDebounce(page); // 隔過去抖窗口再送重複事件：不然就算 event.repeat 的防呆壞了，重複的 keydown 也會被去抖擋掉，測不到
  await page.keyboard.down('KeyG'); // 第二次 down 沒有 up＝瀏覽器的自動重複（event.repeat）
  await page.keyboard.up('KeyG');
  t = await slot();
  check(t.seg === s.seg + 1, '按住不放的自動重複只算一次', problems, `${s.seg} → ${t.seg}`);

  // 去抖：同一個 JS task 內連按兩下（間隔 0ms），第二下被當成手抖忽略，只放行一個 segment。
  await waitDebounce(page);
  const burst = await page.evaluate(() => {
    const sch = window.__hf.synth.scheduler;
    const before = sch._segIndex;
    for (let i = 0; i < 2; i++) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }));
    return { before, after: sch._segIndex };
  });
  check(burst.after === burst.before + 1, '去抖：同一刻連按兩下只放行一個 segment', problems, `${burst.before} → ${burst.after}`);
  t = await slot();

  s = t;
  await page.keyboard.press('Control+KeyJ');
  await page.keyboard.press('Alt+KeyJ');
  t = await slot();
  check(t.seg === s.seg, 'Ctrl／Alt 組合鍵不觸發', problems, `${s.seg} → ${t.seg}`);

  s = t;
  await page.keyboard.press('Space');
  await page.keyboard.press('F5').catch(() => {});
  t = await slot();
  check(t.seg === s.seg, '不在四排裡的鍵（Space、F5）不觸發', problems, `${s.seg} → ${t.seg}`);

  s = t;
  await page.click('#midiSongQuery');
  await page.keyboard.type('abc');
  t = await slot();
  const typed = await page.inputValue('#midiSongQuery');
  check(t.seg === s.seg && typed === 'abc', '焦點在搜尋欄：打字不觸發、字照常打進欄位', problems, `${s.seg} → ${t.seg}，欄位內容「${typed}」`);
  await page.fill('#midiSongQuery', '');
  await page.evaluate(() => document.activeElement?.blur());

  // 焦點在下拉時，字母鍵預設會做 type-ahead 跳選項（選歌下拉一跳就換歌）；用一個臨時的下拉驗證預設行為被擋掉、而且照樣觸發。
  s = t;
  const selectedAfter = await page.evaluate(() => {
    const sel = document.createElement('select');
    sel.id = 'kbTestSelect';
    sel.append(new Option('apple'), new Option('banana'));
    document.body.append(sel);
    sel.focus();
    return sel.selectedIndex;
  });
  await waitDebounce(page);
  await page.keyboard.press('KeyB');
  t = await slot();
  const idx = await page.evaluate(() => { const el = document.getElementById('kbTestSelect'); const i = el.selectedIndex; el.remove(); return i; });
  check(selectedAfter === 0 && idx === 0 && t.seg === s.seg + 1, '焦點在下拉：type-ahead 被擋掉（選項不跳）、仍放行一個 segment', problems, `選項 ${selectedAfter} → ${idx}，游標 ${s.seg} → ${t.seg}`);

  // 暫停中按鍵不放行（排程器沒在播放）。
  s = t;
  await page.evaluate(() => document.activeElement?.blur());
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 5000 });
  await page.keyboard.press('KeyH');
  t = await slot();
  check(t.seg === s.seg, '暫停中按鍵不放行', problems, `${s.seg} → ${t.seg}`);
  await page.click('#btnPlay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 10000 });
  await page.evaluate(() => document.activeElement?.blur());
  s = t;
  await waitDebounce(page);
  await page.keyboard.press('KeyH');
  t = await slot();
  check(t.seg === s.seg + 1, '恢復播放後按鍵照常放行', problems, `${s.seg} → ${t.seg}`);

  // 量測：window.__stats() 讀得到鍵盤事件等待時間（前面按了好幾次）與電腦音遲到量
  const stats = await page.evaluate(() => window.__stats());
  check(stats.按鍵事件等待ms.count > 0 && stats.按鍵事件等待ms.max >= 0 && typeof stats.電腦音遲到ms.count === 'number', 'window.__stats()：鍵盤事件等待時間有記錄、電腦音遲到量可讀', problems, JSON.stringify(stats));

  // 換回原本的指派（第一個聲部給 PC 鍵盤手），後面的測試照舊
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 5000 });
  await page.locator('.score-part-id').nth(1).selectOption('');
  await page.locator('.score-part-id').nth(0).selectOption('kb');
  await page.click('#btnReplay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 15000 });
}

// 試聽 vs 演奏（接在 driveAppToPlaying 後面，此時演奏正在播放）：播放中 ♪ 是灰的、暫停後按 ♪ 會
// 結束演奏進度；試聽中的觸發鍵被忽略、改指派不影響試聽；離開試聽後 ▶ 重新載入、演奏從頭開始。
async function drivePreviewVsPerformance(page, problems) {
  console.log('▶ 試聽 vs 演奏：演奏播放中 ♪ 是灰的，暫停後按 ♪ 結束演奏進度…');
  check(await page.evaluate(() => document.getElementById('btnPreview').disabled), '演奏播放中 ♪ 是灰的（要先暫停）', problems);
  await waitForPositionAbove(page, 0.3); // 演奏進度要先走一小段，後面才看得出「歸零」
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 5000 });
  const perfPos = await positionSeconds(page);
  await page.click('#btnPreview');
  await page.waitForSelector('#btnPreview.is-current', { timeout: 15000 });
  const posAfter = await positionSeconds(page);
  check(perfPos > 0.3 && posAfter === 0, '進入試聽＝演奏進度歸零（排程器已停）', problems, `${perfPos.toFixed(2)}s → ${posAfter.toFixed(2)}s`);

  console.log('▶ 試聽中按觸發鍵、改指派…');
  // 此時 PC 鍵盤手還指派著第一個聲部：若按鍵沒被忽略，排程器會放行音（試聽中排程器已停，不該有任何反應）
  await page.keyboard.press('KeyF');
  const tA = await previewTime(page);
  await page.waitForTimeout(500);
  const perf = await page.evaluate(async () => {
    const { scheduler } = await import('/src/midi/synth.js');
    return { playing: scheduler.isPlaying(), pos: scheduler.getPositionTicks() };
  });
  const slotCursor = await page.evaluate(() => window.__hf.synth.scheduler._segIndex);
  check(!perf.playing && perf.pos === 0 && slotCursor === 0, '試聽中的觸發鍵被忽略（排程器沒有被啟動、沒放行任何 segment）', problems, JSON.stringify({ ...perf, slotCursor }));
  await page.locator('.score-part-id').first().selectOption('');
  await page.waitForTimeout(300);
  const tB = await previewTime(page);
  check(tB > tA + 0.4 && (await storeState(page)).mode === 'preview', '試聽中改指派：不影響試聽（時間照走、仍在試聽中）', problems, `${tA.toFixed(2)}s → ${tB.toFixed(2)}s`);

  console.log('▶ 離開試聽、▶ 重新載入演奏…');
  await page.click('#btnPreview');
  await page.waitForFunction(() => !document.getElementById('btnPreview').classList.contains('is-current'), null, { timeout: 5000 });
  await expectTransport(page, 'ready', problems);
  await page.click('#btnPlay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 10000 });
  const pos = await waitForPositionAbove(page, 0.3);
  check(pos > 0.3, '離開試聽後 ▶ 重新載入，演奏從頭開始往前走', problems, `${pos.toFixed(2)}s`);
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 5000 });
}

// 單聲部、兩個譜表的 MIDI（鋼琴兩行譜：同名兩條軌、上行譜有初始化區塊，MuseScore 的佈局）：parser 切成 1 個 part、2 個 staff。
function makePianoTwoStaffMidi() {
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const vlq = (n) => { const b = [n & 0x7f]; n >>>= 7; while (n > 0) { b.unshift((n & 0x7f) | 0x80); n >>>= 7; } return b; };
  const track = (events) => {
    const body = events.flatMap((e) => [...vlq(e.d), ...e.b]).concat([...vlq(0), 0xff, 0x2f, 0x00]);
    return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
  };
  const enc = new TextEncoder();
  const nameEv = (s) => { const b = [...enc.encode(s)]; return { d: 0, b: [0xff, 0x03, b.length, ...b] }; };
  const cc = (c, n, v) => ({ d: 0, b: [0xb0 | c, n, v] });
  const init = [cc(0, 121, 0), { d: 0, b: [0xc0, 0] }, cc(0, 7, 100), cc(0, 10, 64), cc(0, 91, 0), cc(0, 93, 0)];
  const notes = (pitches) => pitches.flatMap((p, i) => [{ d: i === 0 ? 0 : 1, b: [0x90, p, 90] }, { d: 479, b: [0x80, p, 0] }]);
  const tracks = [
    track([nameEv('Piano'), { d: 0, b: [0xff, 0x51, 3, 0x07, 0xa1, 0x20] }, ...init, ...notes([72, 74, 76, 77, 79, 81, 83, 84])]),
    track([nameEv('Piano'), ...notes([48, 50, 52, 53, 55, 57, 59, 60])]),
  ];
  return Buffer.from([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, 0, tracks.length, 0x01, 0xe0, ...tracks.flat()]);
}
const PIANO_MIDI = { name: 'piano-two-staves.mid', mimeType: 'audio/midi', buffer: makePianoTwoStaffMidi() };

// 指派：單聲部也能指派（下拉有「PC 鍵盤手」）、單聲部多行譜改列譜表、指派到譜表、播放中（含改成別的聲部）從目前位置接續而不是從頭。
const partRows = (page) => page.evaluate(() => ({
  hidden: document.getElementById('scorePartSection').hidden,
  rows: [...document.querySelectorAll('#scorePartList .score-part-row')].map((r) => ({
    name: r.querySelector('.score-part-name').textContent,
    options: [...r.querySelectorAll('option')].map((o) => o.textContent),
  })),
}));
async function driveAssignmentUnits(page, problems) {
  console.log('▶ 指派單位：單聲部也能指派；單聲部多行譜列出譜表；播放中改指派從目前位置接續…');
  await page.evaluate(() => document.activeElement?.blur());

  // 「演奏者 1」要等姿勢模型（landmarker，懶惰載入，慢的機器上要 40 秒以上）建好、現場人數生效才列出來
  await page.waitForFunction(() => window.__hf.store.state.playerCount === 1, null, { timeout: 120000 });
  await loadLocalFile(page, TINY_MIDI);
  let r = await partRows(page);
  check(!r.hidden && r.rows.length === 1 && r.rows[0].options.join() === '無,PC 鍵盤手,演奏者 1', '單聲部的歌也列出指派下拉（無／PC 鍵盤手／演奏者 1）', problems, JSON.stringify(r));

  await loadLocalFile(page, PIANO_MIDI);
  r = await partRows(page);
  check(r.rows.length === 2 && r.rows[0].name.endsWith('譜表 1') && r.rows[1].name.endsWith('譜表 2'), '單聲部的多行譜（鋼琴兩行）改列兩個譜表', problems, JSON.stringify(r));
  await page.locator('.score-part-id').nth(0).selectOption('kb');   // 不用先選現場人數也列得出「PC 鍵盤手」
  await page.click('#btnPlay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 10000 });
  await page.keyboard.press('KeyF');
  const staffKinds = await page.evaluate(() => [...window.__hf.synth.scheduler._staves.values()].map((v) => `${v.id}:${v.kind}`).sort().join());
  const seg = await page.evaluate(() => window.__hf.synth.scheduler._segIndex);
  check(seg === 1 && /:human/.test(staffKinds) && /:assist/.test(staffKinds), '只指派上行譜：它走真人軌、下行譜走電腦輔助，按鍵放行一個 segment', problems, `${staffKinds} seg ${seg}`);
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 5000 });

  // 播放中改指派：canon 指派大提琴（沒有前奏）→ 推進 → 改成不指派 → 改成指派小提琴；每次都不重新載入、不從頭
  await loadLocalFile(page, { name: 'canon-violin-cello.mid', mimeType: 'audio/midi', buffer: readFileSync(SAMPLE_MIDI) });
  await page.locator('.score-part-id').nth(1).selectOption('kb');
  await page.click('#btnPlay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 10000 });
  const before = await waitForPositionAbove(page, 1);
  await page.locator('.score-part-id').nth(1).selectOption('');
  await page.waitForTimeout(100);
  let st = await page.evaluate(() => ({ pos: window.__hf.synth.scheduler.getPositionTicks(), playing: window.__hf.synth.scheduler.isPlaying(), slots: window.__hf.synth.scheduler._assignedSlots.size, busy: window.__hf.store.state.busy, transport: window.__hf.store.state.transport }));
  const sec = (ticks) => page.evaluate((t) => window.__hf.synth.scheduler._score.midiTicksToSeconds(t), ticks);
  let after = await sec(st.pos);
  check(st.playing && st.transport === 'playing' && st.slots === 0 && after >= before - 0.3 && after < before + 3, '播放中把大提琴改成「無」：沒有重新載入、從目前位置（約 ' + before.toFixed(1) + 's）接續自動播放', problems, JSON.stringify({ ...st, before, after }));
  await page.locator('.score-part-id').nth(0).selectOption('kb');
  await page.waitForTimeout(100);
  st = await page.evaluate(() => ({ pos: window.__hf.synth.scheduler.getPositionTicks(), playing: window.__hf.synth.scheduler.isPlaying(), slots: [...window.__hf.synth.scheduler._assignedSlots].join(), transport: window.__hf.store.state.transport }));
  after = await sec(st.pos);
  check(st.playing && st.transport === 'playing' && st.slots === 'kb' && after >= before - 0.3, '播放中再把小提琴改成「PC 鍵盤手」：仍在播放、位置沒有回到開頭', problems, JSON.stringify({ ...st, before, after }));
  await page.locator('.score-part-id').nth(0).selectOption('');
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 5000 });
}

// 不先選現場人數、不碰攝影機：另開頁面，載入單聲部的歌，下拉只有「無／PC 鍵盤手」，指派給 PC 鍵盤手後 ▶ 、按鍵就放行。
async function driveKeyboardWithoutPoseCount(browser, problems) {
  console.log('▶ 沒選現場人數：單聲部的歌指派給 PC 鍵盤手，▶ 後按鍵放行（另開頁面）…');
  const page = await browser.newPage();
  const stray = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (isBenign(text)) return;
    if (msg.type() === 'error' || msg.type() === 'warning') stray.push(`console.${msg.type()}: ${text}`);
  });
  page.on('pageerror', (err) => stray.push(`pageerror: ${err.message}`));
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('app-shell')?.inert, { timeout: 30000 });
    await exposeModules(page);
    await page.click('#song-toggle');   // 選歌面板預設是收起來的
    await page.setInputFiles('#localMidiInput', TINY_MIDI);
    await page.waitForSelector('.score-part-id', { timeout: 10000 });
    const r = await partRows(page);
    check(!r.hidden && r.rows.length === 1 && r.rows[0].options.join() === '無,PC 鍵盤手', '還沒選現場人數：下拉只有「無／PC 鍵盤手」', problems, JSON.stringify(r));
    await page.locator('.score-part-id').first().selectOption('kb');
    await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 10000 });
    await page.click('#btnPlay');
    await page.waitForSelector('#btnPause.is-current', { timeout: 10000 });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('KeyF');
    const seg = await page.evaluate(() => window.__hf.synth.scheduler._segIndex);
    check(seg === 1, '不必先選現場人數：PC 鍵盤手按鍵放行唯一的 driver segment', problems, `seg ${seg}`);
  } finally {
    await page.close();
  }
  check(stray.length === 0, '沒選現場人數的頁面沒有預期之外的 console error／warning／pageerror', problems, stray.join('；'));
}

// 試聽播完：載入最小 MIDI（單音 2 秒）→ ♪ → 官方回報播完、uiTick 偵測到 → 「播完」狀態（▶ 從頭、↻ 可按、
// ♪ 黃底）→ ▶ 從頭播（又播完）→ ↻ 重播（又播完）→ ♪ 離開。
async function drivePreviewEndOfSong(page, problems) {
  console.log('▶ 試聽播完：載入最小 MIDI（單音 2 秒）→ ♪ → 等官方回報播完…');
  await loadLocalFile(page, TINY_MIDI);
  await expectTransport(page, 'ready', problems);
  const waitFinished = () => page.waitForFunction(() => window.__hf.store.state.finished === true, null, { timeout: 15000 });
  const waitNotFinished = () => page.waitForFunction(() => window.__hf.store.state.finished === false, null, { timeout: 5000 });
  await page.click('#btnPreview');
  await waitFinished();
  await page.waitForTimeout(150);
  await expectTransport(page, 'previewFinished', problems);

  console.log('▶ 試聽播完後：▶ 從頭播、↻ 重播…');
  await page.click('#btnPlay');
  await waitNotFinished();
  await expectTransport(page, 'previewPlaying', problems); // 2 秒的歌，播放中這一刻一定看得到
  await waitFinished();
  await page.waitForTimeout(150);
  await expectTransport(page, 'previewFinished', problems);
  await page.click('#btnReplay');
  await waitNotFinished();
  await expectTransport(page, 'previewPlaying', problems);
  await waitFinished();
  await page.waitForTimeout(150);
  await expectTransport(page, 'previewFinished', problems);
  check(true, '播完後 ▶ 與 ↻ 都能再播一次、再播完', problems);

  await page.click('#btnPreview');
  await page.waitForFunction(() => !document.getElementById('btnPreview').classList.contains('is-current'), null, { timeout: 5000 });
  await expectTransport(page, 'ready', problems);
}

// 試聽載入中換歌的 race：同一個 JS task 裡按 ♪，delayMs 之後（程式直接設 input.files＋change 事件，不經 Playwright
// 往返，時間才準）換成另一個檔案。delay 掃過「還在讀位元組」「官方載入中」「剛開始播」各種時機，不論落在
// 哪一種，最後都要：回到演奏、不在試聽、官方 Sequencer 已停、新來源是 ready。
async function drivePreviewRaces(page, problems) {
  console.log('▶ 試聽載入中換歌（race）：♪ 之後 0／15／60／150／400ms 換來源…');
  const tinyBytes = [...TINY_MIDI.buffer];
  for (const delayMs of [0, 15, 60, 150, 400]) {
    await loadLocalFile(page, TINY_MIDI);
    await page.evaluate(async ({ delay, bytes }) => {
      document.getElementById('btnPreview').click();
      await new Promise((r) => setTimeout(r, delay));
      const input = document.getElementById('localMidiInput');
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], `other-${delay}.mid`, { type: 'audio/midi' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { delay: delayMs, bytes: tinyBytes });
    await page.waitForFunction(() => {
      const s = window.__hf.store.state;
      return s.transport === 'paused' && !s.busy && s.source?.name.startsWith('other-');
    }, null, { timeout: 15000 });
    await page.waitForTimeout(250);
    const st = await storeState(page);
    const t = await previewTime(page);
    const cur = await page.evaluate(() => document.getElementById('btnPreview').classList.contains('is-current'));
    check(st.mode === 'perform' && !cur && t === 0 && !st.busy && st.notice === null && !st.started && !st.finished,
      `♪ 後 ${delayMs}ms 換歌：回到演奏、試聽已停、新來源 ready`, problems, JSON.stringify({ ...st, previewTime: t, accent: cur }));
  }
  // 試聽中換歌（已經在播）：換到另一個檔案會立刻停掉試聽
  await loadLocalFile(page, TINY_MIDI);
  await page.click('#btnPreview');
  await page.waitForSelector('#btnPreview.is-current', { timeout: 15000 });
  await loadLocalFile(page, { ...TINY_MIDI, name: 'other-while-playing.mid' });
  const st = await storeState(page);
  check(st.mode === 'perform' && (await previewTime(page)) === 0, '試聽播放中換歌：立刻停掉試聽、回到演奏', problems, JSON.stringify(st));
}

// 試聽錯誤路徑：餵官方解析器壞掉的位元組 → 頂端提示、回到演奏「已載入、還沒播過」（♪ 仍可按）。
async function drivePreviewBadBytes(page, problems) {
  console.log('▶ 試聽錯誤路徑：餵壞掉的位元組（不是 MIDI）…');
  const hits = await expectConsole([/分譜解析失敗/, /官方播放器無法解析/, /Invalid|MThd|not a|midi/i], async () => {
    await loadLocalFile(page, { name: 'bad.mid', mimeType: 'audio/midi', buffer: Buffer.from('this is definitely not a standard midi file') });
    await expectTransport(page, 'ready', problems);
    await page.click('#btnPreview');
    await page.waitForFunction(() => document.getElementById('midiStatusText').textContent === '官方播放器無法解析這首 MIDI', null, { timeout: 15000 });
    await page.waitForTimeout(300);
  });
  await expectTransport(page, 'ready', problems);
  const st = await storeState(page);
  check(st.mode === 'perform' && !st.busy, '官方解析失敗：留在演奏、不卡在載入中', problems, JSON.stringify(st));
  check([...hits.values()][1] > 0, '官方解析失敗有留下 console.warn 方便追查', problems, JSON.stringify([...hits]));
}

// 播放列狀態表窮舉：直接改 store，2（模式）× 4（transport）× 2（started）× 2（finished）× 2（busy）＝64 種組合，
// 每一種都對照「獨立寫的期望」比對四顆鈕的灰亮、黃底與 pill 的 is-empty；而且每顆灰掉的鈕，直接呼叫它的 action
// 都必須什麼都不做（防呆不只靠 disabled 一道擋）。期望表照 CLAUDE.md 的狀態表逐列寫成資料，不重用被測的函式。
async function driveTransportTable(page, problems) {
  console.log('▶ 播放列狀態表窮舉（64 種 store 組合 × 4 顆鈕灰亮／黃底／action 防呆）…');
  const bad = await page.evaluate(async () => {
    const { playerStore, actions } = await import('/src/midi/midiPlayer.js');
    // 期望表：[▶, ❚❚, ↻, ♪] 能不能按；accent＝黃底的鈕；empty＝pill 的 is-empty。
    const ROW = {
      none:           { can: [0, 0, 0, 0], accent: [], empty: true },                    // 沒有歌／載入中
      busy:           { can: [0, 0, 0, 0], accent: [], empty: false },                   // 載入／續播／重播處理中
      performReady:   { can: [1, 0, 0, 1], accent: [], empty: false },                   // 演奏：已載入、還沒播
      performPlaying: { can: [0, 1, 0, 0], accent: ['btnPause'], empty: false },         // 演奏：播放中（♪ 灰）
      performPaused:  { can: [1, 0, 1, 1], accent: [], empty: false },                   // 演奏：暫停／播完
      previewPlaying: { can: [0, 1, 0, 1], accent: ['btnPause', 'btnPreview'], empty: false },
      previewPaused:  { can: [1, 0, 1, 1], accent: ['btnPreview'], empty: false },       // 試聽：暫停／播完
    };
    const expectedRow = (s) => {
      if (s.transport === 'idle' || s.transport === 'loading') return ROW.none;
      if (s.busy) return ROW.busy;
      if (s.mode === 'preview') return s.transport === 'playing' ? ROW.previewPlaying : ROW.previewPaused;
      if (s.transport === 'playing') return ROW.performPlaying;
      return (s.started || s.finished) ? ROW.performPaused : ROW.performReady;
    };
    const ids = ['btnPlay', 'btnPause', 'btnReplay', 'btnPreview'];
    const names = ['play', 'pause', 'replay', 'preview'];
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const snapshot = () => JSON.stringify(['mode', 'transport', 'started', 'finished', 'busy', 'notice'].map((k) => playerStore.state[k]));
    const bad = [];
    for (const mode of ['perform', 'preview'])
      for (const transport of ['idle', 'loading', 'paused', 'playing'])
        for (const started of [false, true])
          for (const finished of [false, true])
            for (const busy of [false, true]) {
              const s = { mode, transport, started, finished, busy };
              playerStore.set(s);
              await frames();
              const want = expectedRow(s);
              const label = JSON.stringify(s);
              ids.forEach((id, i) => {
                const el = document.getElementById(id);
                if (!el.disabled !== Boolean(want.can[i])) bad.push(`${label}：${id} 預期${want.can[i] ? '可按' : '灰'}`);
                if (el.classList.contains('is-current') !== want.accent.includes(id)) bad.push(`${label}：${id} 黃底預期 ${want.accent.includes(id)}`);
              });
              if (document.getElementById('toolbar-playback').classList.contains('is-empty') !== want.empty) bad.push(`${label}：is-empty 預期 ${want.empty}`);
              // 灰掉的鈕：action 被直接呼叫也必須是 no-op
              const before = snapshot();
              names.forEach((name, i) => { if (!want.can[i]) actions[name](); });
              if (snapshot() !== before) bad.push(`${label}：灰掉的鈕被 action 直接呼叫後 store 變了 ${before} → ${snapshot()}`);
            }
    playerStore.set({ mode: 'perform', transport: 'paused', started: false, finished: false, busy: false });
    return bad;
  });
  check(bad.length === 0, '64 種狀態組合的按鈕灰亮／黃底／action 防呆都符合狀態表', problems, bad.slice(0, 5).join('；'));
}

// 引擎壞掉時按 ♪：另開一個頁面把 spessasynth 的 CDN 網址擋掉，開機的暖機失敗（app 照常可用），選好歌按
// ♪ → 頂端提示「音源引擎載入失敗」、回到演奏「已載入、還沒播過」，♪ 仍可按（再按會重試）。
async function drivePreviewEngineFailure(browser, problems) {
  console.log('▶ 試聽錯誤路徑：音源引擎載入失敗時按 ♪（另開頁面、擋掉 spessasynth CDN）…');
  const page = await browser.newPage();
  const stray = [];
  const EXPECTED = [/MIDI 引擎初始化失敗/, /Failed to load resource/, /net::ERR/, /Failed to fetch dynamically imported module/];
  page.on('console', (msg) => {
    const text = msg.text();
    if (isBenign(text) || EXPECTED.some((re) => re.test(text))) return;
    if (msg.type() === 'error' || msg.type() === 'warning') stray.push(`console.${msg.type()}: ${text}`);
  });
  page.on('pageerror', (err) => stray.push(`pageerror: ${err.message}`));
  try {
    await page.route('**/spessasynth_lib@latest/**', (route) => route.abort());
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('app-shell')?.inert, { timeout: 30000 });
    await page.setInputFiles('#localMidiInput', SAMPLE_MIDI);
    await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 10000 });
    await page.click('#btnPreview');
    await page.waitForFunction(() => document.getElementById('midiStatusText').textContent === '⚠️ 音源引擎載入失敗', null, { timeout: 15000 });
    await page.waitForTimeout(200);
    await expectTransport(page, 'ready', problems);
    const st = await storeState(page);
    check(st.mode === 'perform' && !st.busy, '引擎壞了按 ♪：留在演奏、不卡在載入中、♪ 仍可按（再按會重試）', problems, JSON.stringify(st));
  } finally {
    await page.close();
  }
  check(stray.length === 0, '引擎載入失敗的頁面沒有預期之外的 console error／warning／pageerror', problems, stray.join('；'));
}

// 差異測試（test/unit/oracle.test.mjs）用的是 devDependency 釘住版本的 spessasynth_core；app 走 CDN 的
// @latest，兩邊版本可能漂移。這裡只印出來、版本不同就提醒，不算測試失敗。
async function reportOfficialVersions() {
  try {
    const installed = JSON.parse(await readFile(join(REPO_ROOT, 'node_modules/spessasynth_core/package.json'), 'utf8')).version;
    const cdn = async (pkg) => (await fetch(`https://cdn.jsdelivr.net/npm/${pkg}@latest/package.json`)).json();
    const [lib, core] = await Promise.all([cdn('spessasynth_lib'), cdn('spessasynth_core')]);
    const drift = core.version !== installed;
    console.log(`${drift ? '⚠️' : '▶'} 官方套件版本：CDN 上 spessasynth_lib ${lib.version}、spessasynth_core ${core.version}；差異測試用的 devDependency 是 spessasynth_core ${installed}${drift ? '（已經不同，差異測試的標尺可能落後於 app 實際載入的版本）' : ''}`);
  } catch (err) {
    console.log(`▶ 無法取得官方套件版本（${err.message}），略過版本比對`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await reportOfficialVersions();
  console.log(`▶ 啟動靜態伺服器 http://127.0.0.1:${PORT}/ （根目錄：${REPO_ROOT}）`);
  const server = await startStaticServer(REPO_ROOT, PORT);

  const launchArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  if (args.video) {
    launchArgs.push(`--use-file-for-fake-video-capture=${args.video}`);
    console.log(`▶ 使用真實手勢影片：${args.video}`);
  } else {
    console.log('▶ 沒有指定 --video，攝影機輸入是 Chrome 內建的合成圖案（測不到姿勢／手勢，只做流程 smoke test）');
  }

  const browser = await chromium.launch({ args: launchArgs });
  const page = await browser.newPage();

  const problems = [];
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (isBenign(text)) return; // 不印、不計入——瀏覽器/驅動層雜訊，不是這個 app 的訊號
    console.log(`  [console.${type}] ${text}`);
    const expected = tolerated.patterns.find((re) => re.test(text));
    if (expected) { tolerated.hits.set(expected, tolerated.hits.get(expected) + 1); return; } // 錯誤路徑測試預期的訊息
    if (type === 'error' || type === 'warning') problems.push(`console.${type}: ${text}`);
  });
  page.on('pageerror', (err) => {
    console.log(`  [pageerror] ${err.message}`);
    problems.push(`pageerror: ${err.message}`);
  });

  try {
    console.log('▶ 開啟頁面…');
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

    // 開機流程會先跑載入畫面（見 src/main.js 的 dismissLoading()），等 #app-shell 解除 inert
    // 代表視覺與音源兩條軌道都就緒——用這個當「app 已經可互動」的訊號，比固定 sleep 精確。
    console.log('▶ 等待載入完成（#app-shell 解除 inert）…');
    await page.waitForFunction(() => !document.getElementById('app-shell')?.inert, { timeout: 20000 });
    console.log('▶ 載入完成，app 已可互動');
    await exposeModules(page);

    await driveAppToPlaying(page, problems);
    await driveKeyboardTrigger(page, problems);
    await drivePreviewVsPerformance(page, problems);
    await drivePreviewEndOfSong(page, problems);
    await drivePreviewRaces(page, problems);
    await drivePreviewBadBytes(page, problems);
    await driveTransportTable(page, problems);
    await driveAssignmentUnits(page, problems);
    await drivePreviewEngineFailure(browser, problems);
    await driveKeyboardWithoutPoseCount(browser, problems);

    console.log(`▶ 靜置觀察 ${args.duration}ms，收集 console 訊息…`);
    await page.waitForTimeout(args.duration);
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n=== 結果 ===');
  if (problems.length === 0) {
    console.log('✅ 沒有非預期的 console error／warning／pageerror');
    process.exit(0);
  } else {
    console.log(`❌ 發現 ${problems.length} 筆問題：`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ 測試腳本本身出錯：', err);
  process.exit(1);
});
