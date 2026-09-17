// ============================================================
//  midiPlayer.js — MIDI 播放器：狀態 store ＋ 動作 ＋ 三個區塊的畫面（頂端 pill／選歌面板／曲庫）
//
//  上半部是狀態與動作（無 DOM）：playerStore（Store）是唯一的真相，動作函式改它；合成器在 synth.js。
//  下半部是畫面：每個區塊一段，各自的 DOM 參照、handler（經 layout.js 的委派表：actions／fields／inputs）
//  與 render(snapshot)——render 只在值不同時寫 DOM。檔尾把三段合成一個區塊模組
//  { actions, fields, inputs, mount, render } 給 layout.js。
//
//  對外（main.js）：startPlayer()、warmUpMidiEngine()、setGesturePerformanceState()、setPlayerCount()；
//  （layout.js）：playerStore 與檔尾的區塊模組。
//
//  選歌＝載入，播放鍵才是播放：選取本地檔案或雲端曲目之後，會立刻解析＋更新狀態
//  （歌名／分譜清單），但不會啟動音源引擎；使用者按下播放鍵才會真的發出聲音。
//  分譜的互動是「指派演奏者」：每個聲部一個下拉，選「演奏者 1~N」＝那個聲部交給那個追蹤 ID
//  的真人，其餘沒指派的聲部電腦伴奏。改下拉只更新指派、不觸發任何播放——它會改動
//  selectionSignature，下一次按頂端播放鍵時 playCurrentSource() 才用新的指派重新載入。
//  指派是持久設定，不隨追蹤雜訊變動：下拉列「無／演奏者 1~N」，N ＝ 系統控制 bar 選的「現場人數」
//  （playerCount，還沒選是 0 → 只有「無」），不因當下偵測到幾人而增減。
//  指派聲部的實際演奏＝逐步觸發（見 humanPerformer.js）：每做一次有效拋物線手勢就前進一步，
//  沒有時間快慢限制、沒有代打——沒人觸發，這個聲部就停在原地，不會自己往下走。
// ============================================================

import { Store, rafThrottle } from '../ui.js';
import * as synth from './synth.js';
import { parseMidi } from './midiParser.js';
import { downloadMidiFile, fetchCategories, searchSongs } from './midiApi.js';

/* ═══════════════════════════════════════════
   🕒 共用小工具
   ═══════════════════════════════════════════ */
// 秒數 → m:ss；NaN／負數一律 0:00（分譜資訊列用）。
function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/* ═══════════════════════════════════════════
   常數
   ═══════════════════════════════════════════ */
const PLAYER_COUNT = 4;      // 可指派的演奏者 ID 數上限（對齊 vision.js 的 CONFIG.maxUsers）；
                             // 實際列幾個由系統控制 bar 的「現場人數」決定（見 setPlayerCount）

// 真人聲部的排程 tick 週期（humanPerformer.js 逐步觸發排程器的驅動頻率）。
const SCHEDULER_TICK_MS = 12;
// 播完偵測／humanGate 補算的 UI tick 週期。
const UI_TICK_MS = 200;
const GATE_STALE_MS = 250;   // 超過這麼久沒有新的手勢狀態 → 視為斷訊，在場名單清空（vision.js 的心跳 EMIT_HEARTBEAT_MS 必須明顯小於它）
const LOADING_INDICATOR_DELAY_MS = 120; // 按播放後延遲這麼久才顯示 ⋯（本地檔幾乎瞬間就好）

/* ═══════════════════════════════════════════
   狀態
   ═══════════════════════════════════════════ */
/**
 * @typedef {object} PlayerState
 * @property {null | { kind: 'local', file: File, name: string } | { kind: 'cloud', id: string, blob: Blob, name: string }} source
 * @property {string} songTitle          來源名；空字串時頂端顯示「等待選擇歌曲...」
 * @property {string | null} notice      覆蓋歌名的訊息（暖機失敗／播放失敗／雲端下載失敗／檔案格式不支援）
 * @property {'idle' | 'loading' | 'paused' | 'playing'} transport
 * @property {object | null} score       parseMidi() 的結果；null ＝ 沒有分譜資訊（單軌或解析失敗）
 * @property {object[]} parts            score.parts；長度 > 1 才顯示分譜區塊
 * @property {Map<string, number>} assignments partId → 演奏者 ID；改動時換新 Map
 * @property {number} playerCount        系統控制 bar 選的「現場人數」；0 ＝ 還沒選
 * @property {{ items: object[], categories: string[], query: string, category: string, status: 'idle' | 'searching' | 'ready' | 'empty' | 'error', selectedId: string }} library
 */
export const playerStore = new Store(/** @type {PlayerState} */ ({
  source: null,
  songTitle: '',
  notice: null,
  transport: 'idle',
  score: null,
  parts: [],
  assignments: new Map(),
  playerCount: 0,
  library: { items: [], categories: [], query: '', category: '', status: 'idle', selectedId: '' },
}));

// 不進 store 的狀態：只影響聲音（畫面本來就不顯示）或只是防護旗標。
let arcTriggerSeqBySlot = {};      // vision 給的 { 1..playerCount → 拋物線觸發的累加計數 }
let presentSlots = [];             // vision 給的「這一幀在場的演奏者 ID」
let lastPlayedSignature = null;    // 引擎裡目前播的「來源＋分譜」簽章，見 buildPlaybackSignature()
// 選歌的請求代號：本地與雲端兩個動作都會 ++，每個 await 之後比對，不是最新那次選歌就整段作廢。
// 兩個來源共用同一個代號：雲端下載中改點「選擇檔案」時，晚回來的雲端回應不能把 source 蓋回去。
let sourceLoadToken = 0;
let isSongLoading = false;         // 按播放後到引擎載入完成之間的重入防護（立即生效，不等 120ms）
let endHandled = false;            // 歌曲播完的收尾只做一次
let gestureStaleTimer = null;

/* ═══════════════════════════════════════════
   純函式
   ═══════════════════════════════════════════ */
// 播放來源的身分：本地檔案用「檔名＋大小＋修改時間」，雲端曲目用它的 id。
function sourceIdentity(source) {
  return source.kind === 'local'
    ? `local:${source.file.name}:${source.file.size}:${source.file.lastModified}`
    : `cloud:${source.id}`;
}

// 分譜狀態的簽章：沒有分譜資訊、或沒有任何指派 → 固定值 'ALL'（整份當伴奏自動播放）；
// 有指派就用排序後的「聲部=演奏者ID」對組成簽章，任一項不同都要重新 synth.load()。
function selectionSignature(score, assignments) {
  if (!score || score.parts.length <= 1 || assignments.size === 0) return 'ALL';
  return 'assign:' + [...assignments.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([p, id]) => `${p}=${id}`).join(',');
}

const allPartIds = () => playerStore.state.parts.map((p) => p.id);
// 目前確實存在於 score 又被指派出去的聲部 id。
const assignedPartIds = () => allPartIds().filter((id) => playerStore.state.assignments.has(id));
// humanPerformer.tick() 每個 tick 問一次：這個聲部指派的演奏者 ID 現在的手勢狀態
// （在場與否、拋物線觸發的累加計數）。
const gestureFor = (partId) => {
  const slot = playerStore.state.assignments.get(partId);
  if (!slot) return { present: false, triggerSeq: 0 };
  return {
    present: presentSlots.includes(slot),
    triggerSeq: arcTriggerSeqBySlot[slot] ?? 0,
  };
};

/* ═══════════════════════════════════════════
   手勢狀態與 humanGate
   ═══════════════════════════════════════════ */
// humanGain 總開關該不該開：播放中、沒播完、且真的有指派。
const updateHumanGate = () => {
  const armed = synth.isLoaded() && !synth.isPaused() && !endHandled && assignedPartIds().length > 0;
  synth.setHumanGate(armed);
};

// vision.js（經 main.js）每幀呼叫：
//   state = { arcTriggerSeqBySlot: {1..playerCount → 拋物線觸發的累加計數}, presentSlots: [在場的 ID] }
// gestureStaleTimer 是斷訊看門狗：若對方不再送值（分頁切走、rAF 停），GATE_STALE_MS 後把在場
// 名單清空——triggerSeq 刻意不動（斷訊不代表「剛觸發了一次谷底」）。
export function setGesturePerformanceState(state) {
  arcTriggerSeqBySlot = (state && state.arcTriggerSeqBySlot) || {};
  presentSlots = (state && state.presentSlots) || [];

  clearTimeout(gestureStaleTimer);
  if (presentSlots.length > 0) {
    gestureStaleTimer = setTimeout(() => { presentSlots = []; }, GATE_STALE_MS);
  }
}

/* ═══════════════════════════════════════════
   分譜載入
   ═══════════════════════════════════════════ */
function clearScore() {
  playerStore.set({ score: null, parts: [], assignments: new Map() });
}

// 選歌之後的「載入」步驟：解析＋更新分譜清單，不啟動音源引擎。
function loadScore(arrayBuffer, label) {
  clearScore();
  try {
    const score = parseMidi(arrayBuffer);
    if (score.warnings.length) {
      console.warn(`⚠️ ${label} 有 ${score.warnings.length} 則解析警告：`, score.warnings);
    }
    playerStore.set({ score, parts: score.parts });
  } catch (err) {
    // 自己的解析器讀不懂的檔案，spessasynth 不一定也讀不懂——分譜解析失敗不擋播放。
    console.warn(`⚠️ ${label} 分譜解析失敗，將以整份播放`, err);
  }
}

/* ═══════════════════════════════════════════
   選歌（本地／雲端）
   ═══════════════════════════════════════════ */
// 每次換來源的共同前置：停掉引擎、清殘響、簽章失效，並發新的請求代號。
function beginSourceChange() {
  synth.flushPreviousSong();
  lastPlayedSignature = null;
  playerStore.set({ transport: 'idle', notice: null });
  return ++sourceLoadToken;
}
const isStale = (token) => token !== sourceLoadToken;

function setNoSource() {
  playerStore.set({ source: null, songTitle: '' });
  clearScore();
}

// 本地檔案：選取＝載入（解析＋更新狀態），不自動播放。file 為 null ＝ 取消選檔。
async function selectLocalFile(file) {
  const token = beginSourceChange();
  if (!file) { setNoSource(); return; }
  if (!/\.(mid|midi)$/i.test(file.name)) {
    setNoSource();
    playerStore.set({ notice: `檔案格式不支援：${file.name}` });
    return;
  }
  playerStore.set({ source: { kind: 'local', file, name: file.name }, songTitle: file.name });
  const buf = await file.arrayBuffer();
  if (isStale(token)) return; // 這期間又選了別的來源，這次的結果整份作廢
  loadScore(buf, file.name);
  playerStore.set({ transport: 'paused' });
}

// 雲端曲庫：選取即下載＋載入，不自動播放。source 刻意等下載完成才寫：過期的回應一路上都不許碰共用狀態。
async function selectCloudSong(id, name) {
  const token = beginSourceChange();
  playerStore.set({ source: null, songTitle: name, transport: 'loading' });
  clearScore();
  try {
    const blob = await downloadMidiFile(id);
    if (isStale(token)) return;
    const buf = await blob.arrayBuffer();
    if (isStale(token)) return;
    playerStore.set({ source: { kind: 'cloud', id, blob, name } });
    loadScore(buf, name);
    playerStore.set({ transport: 'paused' });
  } catch (err) {
    console.error('❌ 雲端曲目下載失敗', err);
    if (isStale(token)) return; // 舊請求的失敗訊息不該蓋掉新選擇的歌名
    playerStore.set({ transport: 'idle', notice: '雲端下載失敗' });
  }
}

// 曲庫下拉退回「請選擇歌曲」。
function clearSource() {
  beginSourceChange();
  setNoSource();
}

/* ═══════════════════════════════════════════
   播放（本地／雲端共用同一套邏輯）
   ═══════════════════════════════════════════ */
// 「目前引擎裡在播的到底是什麼」的簽章：來源身分 + 分譜／指派狀態。兩者都相同才能直接續播，
// 任一項不同都要重新交給 humanPerformer.load() 重建逐步觸發用的資料。
const buildPlaybackSignature = (source) =>
  `${sourceIdentity(source)}::${selectionSignature(playerStore.state.score, playerStore.state.assignments)}`;

// 頂端 pill 的播放鈕走到這裡（本地／雲端共用）。
async function playCurrentSource() {
  const s = playerStore.state;
  if (!s.source) return;
  // 重入防護：transport 是延遲 120ms 才切成 'loading' 的，在那之前連按第二下會再跑一次這裡，
  // 簽章就會記錄一份根本沒進引擎的組合。
  if (isSongLoading) return;
  // 重播一首已經播完的歌時 endHandled 還停在 true，不先清掉真人聲部第一顆音會沒聲。
  endHandled = false;

  const signature = buildPlaybackSignature(s.source);
  if (signature === lastPlayedSignature) {
    await synth.play();
    playerStore.set({ transport: 'playing', notice: null });
    updateHumanGate();
    return;
  }

  // 「處理中」只由切換鈕的 ⋯ 表達，不改寫歌名。本地檔案幾乎瞬間就好，延遲 120ms 再顯示 ⋯。
  isSongLoading = true;
  const loadingIndicatorTimer = setTimeout(() => playerStore.set({ transport: 'loading' }), LOADING_INDICATOR_DELAY_MS);
  try {
    await synth.load(s.score, assignedPartIds());
    if (synth.humanPerformer.unplacedPartIds.length) {
      console.warn('⚠️ 分譜聲部超過合成器可用的輸出 channel，以下聲部這一輪不會出聲：',
        synth.humanPerformer.unplacedPartIds.join('、'));
    }
    await synth.play();
    lastPlayedSignature = signature;
    playerStore.set({ transport: 'playing', notice: null });
    updateHumanGate();
  } catch (err) {
    console.error(err);
    playerStore.set({ transport: 'paused', notice: `播放失敗：${s.source.name}` });
  } finally {
    clearTimeout(loadingIndicatorTimer);
    isSongLoading = false;
  }
}

// 單一切換鈕：播放中→按了就暫停；其餘（可播放／已暫停）→按了就播放／續播。
function togglePlayPause() {
  const { transport } = playerStore.state;
  if (transport === 'idle' || transport === 'loading') return;
  if (transport === 'playing') {
    synth.pause();
    playerStore.set({ transport: 'paused', notice: null });
    updateHumanGate();
  } else {
    playCurrentSource();
  }
}

/* ═══════════════════════════════════════════
   指派／人數
   ═══════════════════════════════════════════ */
// 指派演奏者下拉：更新 assignments，不觸發播放。新的指派會在下一次按頂端播放鍵時經簽章比對重新載入；
// 播放中改指派則維持舊組合，暫停再播放即換成新組合。
function assignPart(partId, slot) {
  const n = Number(slot);
  const assignments = new Map(playerStore.state.assignments);
  if (n >= 1 && n <= playerStore.state.playerCount) assignments.set(partId, n);
  else assignments.delete(partId);
  playerStore.set({ assignments });
  updateHumanGate(); // 指派全清時 humanGain 立即收掉
}

// 系統控制 bar 「現場人數」切換成功後（main.js 經 vision 的 setPoseCountListener 接上）：下拉改列 1~n，
// 超出範圍的指派剪掉。跟改指派一樣不觸發播放——下次按頂端播放鍵才重載。
export function setPlayerCount(n) {
  const next = Math.max(0, Math.min(PLAYER_COUNT, Number(n) || 0));
  const s = playerStore.state;
  if (next === s.playerCount) return;
  const assignments = new Map([...s.assignments].filter(([, id]) => id <= next));
  playerStore.set({ playerCount: next, assignments });
  updateHumanGate();
}

/* ═══════════════════════════════════════════
   開場暖機、兩個 tick
   ═══════════════════════════════════════════ */
// MIDI 引擎掛掉不擋整個 app（攝影機、骨架都還能用），但一定要讓使用者看得到：寫在頂端狀態列。
export async function warmUpMidiEngine() {
  const ok = await synth.initEngine();
  if (!ok) playerStore.set({ notice: '⚠️ 音源引擎載入失敗，按下播放時會自動重試' });
  return ok;
}

// 200ms 的 UI tick：播完偵測、humanGate 定期補算。
function uiTick() {
  if (!isSongLoading && synth.isLoaded() && !endHandled && synth.isFinished()) {
    endHandled = true;
    synth.pause();
    playerStore.set({ transport: 'paused' });
  }
  // humanGain 總開關的定期補算：讓「播放→暫停／播完」這類狀態轉變即使當下
  // 沒有新的手勢狀態進來，也會在 200ms 內把 humanGain 收到正確位置（synth.js 那邊 target 去重）。
  updateHumanGate();
}

// 真人聲部的排程 tick：把每個指派聲部目前的手勢狀態（在場／觸發計數）交給
// humanPerformer.tick()，由它決定要不要前進一步、順便反應式排程伴奏（見 humanPerformer.js）。
function schedulerTick() {
  if (synth.isLoaded() && !synth.isPaused()) synth.humanPerformer.tick(performance.now(), gestureFor);
}

// main.js 呼叫一次；不靠 import 副作用啟動。
export function startPlayer() {
  setInterval(uiTick, UI_TICK_MS);
  setInterval(schedulerTick, SCHEDULER_TICK_MS);
}

/* ═══════════════════════════════════════════
   🎛️ 畫面 1／3：頂端播放 pill（播放／暫停切換鈕 ＋ 歌名）
   ═══════════════════════════════════════════ */
// 切換鈕的狀態只靠 class（顏色）＋圖示表達，來源是 player.transport：
//   'idle' —— 還沒有可播放的來源（鈕 disabled、灰）；'loading' —— 解碼／下載中（鈕 disabled、顯示 ⋯）；
//   'paused' —— 有來源、可按下播放（深灰底、▶）；'playing' —— 正在播（accent 黃底、❚❚）。
// 歌名只放歌名（notice 覆蓋時例外），不寫「解析中／下載中」；優先單行，超長才縮小字級。
const pill = document.getElementById('toolbar-playback');
const btn = document.getElementById('btnPlayPause');
const statusText = document.getElementById('midiStatusText');

const IDLE_TITLE = '等待選擇歌曲...';

// ── 歌名優先單行，超長才縮小字級（見 src/styles.css 的 .player-status-bar 註解）──
// 量測邏輯：scrollWidth 是文字實際想要的寬度（不受目前有沒有被壓縮影響），跟 pill 扣掉
// 播放鈕與 gap 之後能分給文字的寬度比較，超出就縮小 --song-title-scale；縮到下限
// MIN_SONG_TITLE_SCALE 還是放不下，才加 .allow-wrap 退回換行。
const MIN_SONG_TITLE_SCALE = 0.6;
function fitSongTitle() {
  statusText.classList.remove('allow-wrap');
  statusText.style.setProperty('--song-title-scale', '1');
  const gapPx = parseFloat(getComputedStyle(pill).columnGap) || 0;
  const available = pill.clientWidth - btn.offsetWidth - gapPx;
  const natural = statusText.scrollWidth;
  if (available <= 0 || natural <= available) return;
  const scale = Math.max(MIN_SONG_TITLE_SCALE, available / natural);
  statusText.style.setProperty('--song-title-scale', scale.toFixed(3));
  if (scale <= MIN_SONG_TITLE_SCALE && statusText.scrollWidth > available) {
    statusText.classList.add('allow-wrap');
  }
}

const transportActions = {
  'play-pause': () => togglePlayPause(),
};

function mountTransportPill() {
  // 視窗尺寸改變會動到 pill 的 max-width（跟著 #camera-frame 走）與 --ui-fs，兩者都影響能分給歌名的寬度。
  window.addEventListener('resize', rafThrottle(fitSongTitle));
  fitSongTitle(); // 開場的「等待選擇歌曲...」字樣也套用同一套單行縮放邏輯
}

function renderTransportPill({ player }) {
  btn.classList.toggle('is-playing', player.transport === 'playing');
  btn.classList.toggle('is-loading', player.transport === 'loading');
  btn.disabled = player.transport === 'idle' || player.transport === 'loading';

  // 只在文字真的不同時才寫——相同字串也會觸發 pill（width:max-content）重新量寬＋重新置中，看起來在抽動。
  const text = player.notice ?? (player.songTitle || IDLE_TITLE);
  if (statusText.textContent !== text) {
    statusText.textContent = text;
    fitSongTitle();
  }
}

/* ═══════════════════════════════════════════
   ☁️ 畫面 2／3：選歌面板裡的雲端曲庫（分類下拉／關鍵字搜尋／歌曲下拉）
   ═══════════════════════════════════════════ */
// 資料來自 midiApi.js（純資料）；搜尋狀態放在 playerStore.library，兩個下拉的 option 只在 items／categories
// 的參照變了才重建。分類集合跨搜尋累積（曲庫的分類端點可能失敗，搜尋結果裡的分類也要收）。
// 選到一首就下載＋解析（selectCloudSong），不啟動播放；退回「請選擇歌曲」就清掉來源。
const SEARCH_DEBOUNCE_MS = 300;

const categoryEl = document.getElementById('midiCategory');
const queryEl = document.getElementById('midiSongQuery');
const songSelectEl = document.getElementById('midiSongSelect');

const categorySet = new Set();
let requestToken = 0;     // 搜尋的請求代號：晚回來的舊結果不能蓋掉新的
let lastQueryStr = null;  // 上一次真的送出去的「關鍵字_分類」，一樣就不重打
let debounceTimer = null;

const library = () => playerStore.state.library;
const setLibrary = (patch) => playerStore.set({ library: { ...library(), ...patch } });

function mergeCategories(categories) {
  for (const category of categories) categorySet.add(category);
  setLibrary({ categories: [...categorySet].sort((a, b) => a.localeCompare(b, 'zh-Hant')) });
}

async function search() {
  const query = library().query.trim();
  const category = library().category.trim();
  const queryStr = `${query}_${category}`;
  if (lastQueryStr === queryStr) return;
  lastQueryStr = queryStr;
  const token = ++requestToken;

  setLibrary({ status: 'searching', items: [] });
  try {
    const { items, categories } = await searchSongs({ query, category });
    if (token !== requestToken) return;
    mergeCategories(categories);
    setLibrary({ items, status: items.length ? 'ready' : 'empty' });
  } catch (error) {
    if (token !== requestToken) return;
    // 還原查詢快取，否則重打一模一樣的關鍵字會被 lastQueryStr 判定為「跟上次一樣」而無法重試。
    lastQueryStr = null;
    setLibrary({ items: [], status: 'error' });
    console.error('❌ [搜尋 MIDI 歌曲清單失敗]', error);
  }
}

function scheduleSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(search, SEARCH_DEBOUNCE_MS);
}

const libraryFields = {
  'category': (el) => {
    // 換分類時關鍵字清空（跟原本的行為一致），直接重搜不等去抖。
    setLibrary({ category: el.value, query: '' });
    lastQueryStr = null;
    search();
  },
  'song': (el) => {
    if (el.selectedIndex <= 0) {
      setLibrary({ selectedId: '' });
      clearSource();
      return;
    }
    const id = el.value;
    const name = el.options[el.selectedIndex].text;
    setLibrary({ selectedId: id });
    selectCloudSong(id, name);
  },
};

const libraryInputs = {
  'song-query': (el) => {
    setLibrary({ query: el.value });
    scheduleSearch();
  },
};

// 本地選檔時呼叫：關鍵字／分類清空、下拉回 placeholder，並重新搜尋（跟原本 resetMidiSearchUI 一樣走去抖）。
function resetLibraryPicker() {
  setLibrary({ query: '', category: '', selectedId: '' });
  scheduleSearch();
}

function mountLibraryPicker() {
  // 這裡不碰播放鈕的 disabled：那是 transport 狀態的事，只有 playerState 決定。
  fetchCategories().then(mergeCategories).finally(search);
}

const PLACEHOLDER = {
  idle: '請選擇歌曲',
  searching: '搜尋中...',
  ready: '請選擇歌曲',
  empty: '找不到符合條件的歌曲',
  error: 'API 讀取失敗',
};
function songLabel(item) {
  const composer = item.composer ? ` - ${item.composer}` : '';
  return `${item.title || '未命名歌曲'}${composer}`;
}

let renderedCategories = null;
let renderedItems = null;
let renderedStatus = null;
function renderLibraryPicker({ player }) {
  const lib = player.library;
  if (lib.categories !== renderedCategories) {
    renderedCategories = lib.categories;
    categoryEl.replaceChildren(new Option('全部類別', ''), ...lib.categories.map((c) => new Option(c, c)));
  }
  if (categoryEl.value !== lib.category) categoryEl.value = lib.category;
  if (queryEl.value !== lib.query) queryEl.value = lib.query;

  if (lib.items !== renderedItems || lib.status !== renderedStatus) {
    renderedItems = lib.items;
    renderedStatus = lib.status;
    songSelectEl.replaceChildren(
      new Option(PLACEHOLDER[lib.status], ''),
      ...lib.items.map((item) => new Option(songLabel(item), String(item.id))),
    );
  }
  songSelectEl.disabled = lib.status !== 'ready';
  if (songSelectEl.value !== lib.selectedId) songSelectEl.value = lib.selectedId;
}

/* ═══════════════════════════════════════════
   🎼 畫面 3／3：選歌面板的本地檔案／分譜清單（指派演奏者 ID）
   ═══════════════════════════════════════════ */
// 分譜清單每一列就是「聲部名（GM 音色的繁體中文名）＋一個下拉（無／演奏者 1~N）」，由 index.html 的
// <template id="tpl-part-row"> clone，聲部名用 textContent 填（來自檔案內容，不當 HTML）。列只在 parts 參照或
// playerCount 變了才重建，每次 render 都校正各下拉的值與 is-mine。ID 只是槽位編號的顯示提示，畫面上不額外
// 標示在不在場——不在場的處理交給 humanPerformer.js 的手勢／代打雙模式，指派本身留著。
const localInput = document.getElementById('localMidiInput');
const localFileName = document.getElementById('localMidiFileName');
const scorePartSection = document.getElementById('scorePartSection');
const scoreInfoText = document.getElementById('scoreInfoText');
const scorePartList = document.getElementById('scorePartList');
const partRowTemplate = document.getElementById('tpl-part-row');

const songPanelFields = {
  // 本地檔案：選取＝載入，不自動播放；曲庫的搜尋與下拉同時歸零。
  'local-file': (el) => {
    resetLibraryPicker();
    selectLocalFile(el.files[0] || null);
  },
  'part-assign': (el) => assignPart(el.dataset.partId, el.value),
};

function buildPartRow(part, playerCount) {
  const row = partRowTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.partId = part.id;
  const name = row.querySelector('.score-part-name');
  name.textContent = part.name;
  name.title = part.name;
  const select = row.querySelector('.score-part-id');
  select.dataset.partId = part.id;
  select.append(new Option('無', ''));
  for (let n = 1; n <= playerCount; n++) select.append(new Option(`演奏者 ${n}`, String(n)));
  return row;
}

function infoText({ score }) {
  if (!score) return '';
  return `${score.parts.length} 個聲部・${formatTime(score.durationSeconds)}・${Math.round(score.tempoMap[0].bpm)} BPM`;
}

let renderedParts = null;
let renderedPlayerCount = -1;
function renderSongPanel({ player }) {
  const isLocal = player.source?.kind === 'local';
  const name = isLocal ? player.source.name : '';
  const shown = name || '未選擇檔案';
  if (localFileName.textContent !== shown) {
    localFileName.textContent = shown;
    localFileName.title = name;
  }
  // 來源不是本地檔案（雲端曲目、取消、格式不支援）就把檔案輸入清掉，同一個檔案才能再次觸發 change。
  if (!isLocal && localInput.value) localInput.value = '';

  scorePartSection.hidden = player.parts.length <= 1;
  const text = infoText(player);
  if (scoreInfoText.textContent !== text) scoreInfoText.textContent = text;

  if (player.parts !== renderedParts || player.playerCount !== renderedPlayerCount) {
    renderedParts = player.parts;
    renderedPlayerCount = player.playerCount;
    scorePartList.replaceChildren(...player.parts.map((part) => buildPartRow(part, player.playerCount)));
  }
  for (const sel of scorePartList.querySelectorAll('.score-part-id')) {
    const assigned = player.assignments.get(sel.dataset.partId) || 0;
    const value = assigned ? String(assigned) : '';
    if (sel.value !== value) sel.value = value;
    sel.closest('.score-part-row').classList.toggle('is-mine', assigned > 0);
  }
}

/* ═══════════════════════════════════════════
   🧩 合成一個區塊模組給 layout.js（{ actions, fields, inputs, mount, render }）
   ═══════════════════════════════════════════ */
export const actions = { ...transportActions };
export const fields = { ...songPanelFields, ...libraryFields };
export const inputs = { ...libraryInputs };
export function mount() {
  mountTransportPill();
  mountLibraryPicker();
}
export function render(snapshot) {
  renderTransportPill(snapshot);
  renderSongPanel(snapshot);
  renderLibraryPicker(snapshot);
}
