// midiPlayer.js — 播放器：playerStore（唯一的真相）＋動作＋三個畫面區塊（頂端播放 pill／選歌面板的分譜與本地檔／雲端曲庫）；合成器在 synth.js。
// 每個畫面區塊各自有 DOM 參照、handler（經 ui.js 的委派表）與 render(snapshot)（只在值不同時寫 DOM）；檔尾合成一個區塊模組 { actions, fields, inputs, mount, render } 給 ui.js。
// 選歌＝載入，播放鍵才是播放：選了本地檔或雲端曲目只解析並更新狀態（歌名／分譜清單），不啟動音源引擎。
// 分譜的互動是「指派演奏者」：每個指派單位一個下拉（無／PC 鍵盤手／演奏者 1~N），選了＝那個聲部交給那個人，其餘由電腦輔助播放；
// 指派單位通常是 part（一個樂器），只有一個 part 而它有多個譜表（鋼琴兩行譜）時改列 staff。指派是持久設定，不隨追蹤雜訊變動。
// 改下拉不重新載入：還沒播過就只更新指派，下次 ▶ 依 selectionSignature 重新載入；播放中（含暫停）則從目前位置接續（synth.reassign()）。
// 試聽（♪）用官方 Sequencer 播同一份 MIDI 對照聽感（見 synth.js），跟演奏互斥（共用同一個合成器的 channel）：進入試聽會結束目前的演奏進度，離開後回到「已載入、還沒播過」。
// store 的 mode：'perform'＝播放列作用在演奏，'preview'＝▶ ❚❚ ↻ 作用在試聽；哪顆鈕能按照同一張狀態表（transportButtonState）。

import { Store, rafThrottle, setMarqueeText } from '../ui.js';
import * as synth from './synth.js';
import { parseMidi, midiNoteName } from './midiParser.js';
import { downloadMidiFile, fetchCategories, searchSongs } from './midiApi.js';
import { KEYBOARD_SLOT } from './scheduler.js';

export { KEYBOARD_SLOT };   // main.js 交給 keyboard.js 的觸發槽位

// 秒數 → m:ss；NaN／負數一律 0:00（分譜資訊列用）。
function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const PLAYER_COUNT = 4;      // 可指派的演奏者 ID 數上限（對齊 vision.js 的 CONFIG.maxUsers）；
                             // 實際列幾個由系統控制 bar 的「現場人數」決定（見 setPlayerCount）

// 排程 tick 週期（scheduler.js 的播放頭推進與到期收音的驅動頻率；有指派時起音不經過它，見 triggerInput）。
const SCHEDULER_TICK_MS = 12;
// 播完偵測／humanGate 補算的 UI tick 週期。
const UI_TICK_MS = 200;
const LOADING_INDICATOR_DELAY_MS = 120; // 按播放後延遲這麼久才顯示 ⋯（本地檔幾乎瞬間就好）

/**
 * @typedef {object} PlayerState
 * @property {null | { kind: 'local', file: File, name: string } | { kind: 'cloud', id: string, blob: Blob, name: string }} source
 * @property {string} songTitle          來源名；空字串時頂端顯示「等待選擇歌曲...」
 * @property {string | null} notice      覆蓋歌名的訊息（暖機失敗／播放失敗／雲端下載失敗／檔案格式不支援）
 * @property {'perform' | 'preview'} mode  播放列目前作用在演奏還是試聽（官方 Sequencer）
 * @property {'idle' | 'loading' | 'paused' | 'playing'} transport  目前作用對象（mode 指的那一邊）的播放狀態
 * @property {boolean} started           這首載入後播過了沒（播放列的狀態表用：還沒播過時不能重播）
 * @property {boolean} finished          播完了（演奏：＝模組變數 endHandled 的鏡射；試聽：官方回報 isFinished）；此時 ▶ 從頭播
 * @property {boolean} busy              載入／續播／重播／進入試聽處理中（＝isSongLoading；播放列按鈕立刻全灰）
 * @property {object | null} score       parseMidi() 的結果；null ＝ 沒有分譜資訊（單軌或解析失敗）
 * @property {object[]} parts            score.parts；沒有聲部（長度 0）才不顯示分譜區塊
 * @property {Map<string, number|string>} assignments 指派單位 id（part id，或單聲部多行譜時的 staff id）→ 演奏者槽位（1~4 或 KEYBOARD_SLOT）；改動時換新 Map
 * @property {number} playerCount        系統控制 bar 選的「現場人數」；0 ＝ 還沒選
 * @property {number} positionSeconds    目前播放位置（演奏：樂譜原始秒數，同 note.startSeconds 座標系；試聽：官方 currentTime）；
 *                                       頂端進度條唯讀顯示用，沒有任何 seek 路徑會寫它
 * @property {number} previewDuration    試聽中這首的長度（秒，官方 duration）；進度條在試聽時拿它當分母，不在試聽是 0
 * @property {{ items: object[], categories: string[], query: string, category: string, status: 'idle' | 'searching' | 'ready' | 'empty' | 'error', selectedId: string }} library
 */
export const playerStore = new Store(/** @type {PlayerState} */ ({
  source: null,
  songTitle: '',
  notice: null,
  mode: 'perform',
  transport: 'idle',
  started: false,
  finished: false,
  busy: false,
  score: null,
  parts: [],
  assignments: new Map(),
  playerCount: 0,
  positionSeconds: 0,
  previewDuration: 0,
  library: { items: [], categories: [], query: '', category: '', status: 'idle', selectedId: '' },
}));

// 不進 store 的狀態：只影響聲音（畫面本來就不顯示）或只是防護旗標。
let lastPlayedSignature = null;    // 引擎裡目前播的「來源＋分譜」簽章，見 buildPlaybackSignature()
// 選歌的請求代號：本地與雲端共用、每次選歌 ++，每個 await 之後比對，不是最新那次就整段作廢（雲端下載中改點「選擇檔案」時，晚回來的雲端回應不能把 source 蓋回去）。
let sourceLoadToken = 0;
let isSongLoading = false;         // 按播放後到引擎載入完成之間的重入防護（立即生效，不等 120ms）
let endHandled = false;            // 歌曲播完的收尾只做一次

// 播放來源的身分：本地檔案用「檔名＋大小＋修改時間」，雲端曲目用它的 id。
function sourceIdentity(source) {
  return source.kind === 'local'
    ? `local:${source.file.name}:${source.file.size}:${source.file.lastModified}`
    : `cloud:${source.id}`;
}

// 分譜狀態的簽章：沒有分譜資訊、或沒有任何指派 → 固定值 'ALL'（整份當電腦輔助聲部自動播放）；
// 有指派就用排序後的「指派單位=演奏者」對組成簽章，任一項不同都要重新 synth.load()。
function selectionSignature(score, assignments) {
  if (!score || assignments.size === 0) return 'ALL';
  return 'assign:' + [...assignments.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([p, id]) => `${p}=${id}`).join(',');
}

// 指派單位：通常一個 part 一個；只有一個 part 而它有 ≥ 2 個 staff（鋼琴兩行譜）時改成一個 staff 一個，讓你只彈其中一個譜表。id 是 part id（p…）或 staff id（t…c…），scheduler 兩種都認（staff 優先）。
// 譜表名稱附上音域與音數（如「大鋼琴・譜表 1（A3–E6，339 音）」）：MIDI 沒有譜號與旋律／伴奏資訊，這兩個數字是從音符量出的事實，讓你選之前分得出哪個譜表是哪個；打擊譜表只附音數。
export function assignmentUnits(parts) {
  if (parts.length === 1 && parts[0].staves?.length >= 2) {
    return parts[0].staves.map((staff, i) => {
      const facts = [];
      if (!staff.percussionKit && Number.isInteger(staff.minPitch) && staff.minPitch <= staff.maxPitch) {
        facts.push(`${midiNoteName(staff.minPitch)}–${midiNoteName(staff.maxPitch)}`);
      }
      if (Number.isInteger(staff.noteCount)) facts.push(`${staff.noteCount} 音`);
      return { id: staff.id, name: `${parts[0].name}・譜表 ${i + 1}${facts.length ? `（${facts.join('，')}）` : ''}` };
    });
  }
  return parts.map((part) => ({ id: part.id, name: part.name }));
}
const allUnitIds = () => assignmentUnits(playerStore.state.parts).map((u) => u.id);
// 目前確實存在於 score 又被指派出去的單位 id。
const assignedUnitIds = () => allUnitIds().filter((id) => playerStore.state.assignments.has(id));

// humanGain 總開關該不該開：播放中、沒播完、且真的有指派。
const updateHumanGate = () => {
  const armed = synth.isLoaded() && !synth.isPaused() && !endHandled && assignedUnitIds().length > 0;
  synth.setHumanGate(armed);
};

// 觸發一次（main.js 把鍵盤與揮手接到這裡）：輸入事件（keyboard.js、gestureTrigger.js 的 { slot, source, eventTimeMs, receivedMs }）放行這個槽位的下一個 segment。
// 同步呼叫排程器，這個 segment 的所有音在這次呼叫內就送進合成器（不經計時器）。試聽中、暫停中、還沒載入時排程器沒在播放，trigger() 自己會忽略。
export function triggerInput(input) {
  synth.scheduler.trigger(input);
}

// 放開一個鍵（main.js 把鍵盤的 keyup 接到這裡）：輸入事件帶 key（keyboard.js 的 { slot, source, key, eventTimeMs, receivedMs }），收掉登記這個鍵的你的音（keyup 模式，見 scheduler.js 的 lift()）。
export function liftInput(input) {
  synth.scheduler.lift(input);
}

// 量測（main.js 的 window.__stats 用）：電腦音比排好的時刻晚多少，見 scheduler.js 的 lateStats()。
export function lateStats() {
  return synth.scheduler.lateStats();
}

// 量測（同上）：你早按時的追音與跳過顆數，見 scheduler.js 的 chaseStats()。
export function chaseStats() {
  return synth.scheduler.chaseStats();
}

// 量測（同上）：這首歌目前的速度區間 { lo, hi }，見 scheduler.js 的 rateBounds()。
export function rateBounds() {
  return synth.scheduler.rateBounds();
}

// 量測（同上）：你現在的速度估計（樂譜秒 ÷ 真實秒，見 scheduler.js 的 playbackRate）。<1 ＝ 比檔案慢，音長是檔案音長 ÷ 這個值。
export function playbackRate() {
  return synth.scheduler.playbackRate;
}

// 量測（同上）：AudioContext 回報的音訊輸出延遲，見 synth.js 的 audioLatencyInfo()。
export function audioLatency() {
  return synth.audioLatencyInfo();
}

// 量測（同上）：錄音 v3，給 main.js 的 __pressLog 匯出做離線分析：歌、指派（Map 展開成 [partId, 槽位][] 才能轉 JSON）、每次按鍵嘗試（鍵、事件發生與程式收到的時刻、排程器時鐘、有沒有放行）、每次放開（lifts：鍵、時鐘、收了幾顆音）、
// 事件串流（錨點、速度、每顆音實際發聲的時刻…）與匯出時刻。
export function pressLog() {
  const { source, songTitle, assignments } = playerStore.state;
  return {
    version: 3,
    song: { title: songTitle, source: source && { kind: source.kind, name: source.name, id: source.id ?? null } },
    assignments: [...assignments],
    presses: synth.scheduler.pressLog(),
    lifts: synth.scheduler.liftLog(),
    events: synth.scheduler.eventLog(),
    recordedAt: new Date().toISOString(),
  };
}

function clearScore() {
  playerStore.set({ score: null, parts: [], assignments: new Map(), positionSeconds: 0 });
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
    // score 保持 clearScore() 設的 null／[]：scheduler.load(null, ...) 直接回傳、不建立聲部——分譜解析失敗不擋「播放」這個動作，但結果是靜音（演奏不走官方 Sequencer，沒有退路）
    console.warn(`⚠️ ${label} 分譜解析失敗，無法播放`, err);
  }
}

// 每次換來源的共同前置：停掉引擎（演奏與試聽都停，載入中的試聽也中斷）、清殘響、簽章失效，並發新的請求代號。
function beginSourceChange() {
  synth.flushPreviousSong();
  lastPlayedSignature = null;
  playerStore.set({ mode: 'perform', transport: 'idle', notice: null, started: false, finished: false, previewDuration: 0 });
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

// 「目前引擎裡在播的到底是什麼」的簽章：來源身分 + 分譜／指派狀態。兩者都相同才能直接續播，
// 任一項不同都要重新交給 scheduler.load() 重建 staff 與全曲的 segment。
const buildPlaybackSignature = (source) =>
  `${sourceIdentity(source)}::${selectionSignature(playerStore.state.score, playerStore.state.assignments)}`;

// 頂端 pill 的 ▶／↻ 走到這裡（本地／雲端共用）。fromStart＝重播鍵：不管播到哪都從頭來。
async function playCurrentSource({ fromStart = false } = {}) {
  const s = playerStore.state;
  if (!s.source) return;
  // 重入防護：transport 是延遲 120ms 才切成 'loading'，在那之前連按第二下會再跑一次這裡，簽章就會記錄一份根本沒進引擎的組合；
  // 續播／重播（AudioContext.resume）也是 async，一樣要擋；busy 讓播放列按鈕立刻全灰。
  if (isSongLoading) return;
  // 重播一首已經播完的歌時 endHandled 還停在 true，不先清掉真人聲部第一顆音會沒聲。
  endHandled = false;
  isSongLoading = true;
  playerStore.set({ busy: true });

  let loadingIndicatorTimer = null;
  try {
    const signature = buildPlaybackSignature(s.source);
    if (signature === lastPlayedSignature) {
      // 引擎裡就是這份組合：重播鍵、或播完後按 ▶ 從頭來（scheduler.js 的 restart()），其餘只是續播
      await (fromStart || s.finished ? synth.restart() : synth.play());
    } else {
      // 簽章不同（換歌或改過指派）：完整重新載入，本來就從頭播。「處理中」只由 ▶ 的 ⋯ 表達、不改寫歌名；本地檔幾乎瞬間就好，所以延遲 120ms 才顯示 ⋯
      loadingIndicatorTimer = setTimeout(() => playerStore.set({ transport: 'loading' }), LOADING_INDICATOR_DELAY_MS);
      // 傳快照（[單位 id, 槽位][]）不傳活的 Map：演奏計畫靠它決定哪些聲部走真人合成器、哪些槽位有資格觸發
      await synth.load(s.score, [...s.assignments]);
      if (synth.scheduler.unplacedStaffIds.length) {
        console.warn('⚠️ 分譜的 staff 超過合成器可用的輸出 channel（每個 port 旋律 15 個、鼓組各佔一個，載入時已依歌曲需要補 port），以下 staff 這一輪不會出聲：',
          synth.scheduler.unplacedStaffIds.join('、'));
      }
      await synth.play();
      lastPlayedSignature = signature;
    }
    playerStore.set({ transport: 'playing', notice: null, started: true, finished: false });
    updateHumanGate();
  } catch (err) {
    console.error(err);
    playerStore.set({ transport: 'paused', notice: `播放失敗：${s.source.name}` });
  } finally {
    clearTimeout(loadingIndicatorTimer);
    isSongLoading = false;
    playerStore.set({ busy: false });
  }
}

// 頂端 pill 的 ❚❚：只有播放中才能暫停（防呆，不靠 disabled 一道擋）。試聽中暫停的是官方 Sequencer。
function pauseCurrentSource() {
  if (playerStore.state.transport !== 'playing') return;
  if (playerStore.state.mode === 'preview') synth.pausePreview();
  else synth.pause();
  playerStore.set({ transport: 'paused', notice: null });
  updateHumanGate();
}

// 官方解析器要的是原始位元組：本地檔案與雲端 blob 都有 arrayBuffer()，每次讀都是新的一份。
const sourceBytes = (source) => (source.kind === 'local' ? source.file : source.blob).arrayBuffer();

// 試聽失敗時頂端提示的字：engine＝音源引擎壞了、parse／timeout＝官方解析器拒絕或沒有回應（也是 parser 差異的訊號）。
const PREVIEW_NOTICE = {
  engine: '⚠️ 音源引擎載入失敗',
  parse: '官方播放器無法解析這首 MIDI',
  timeout: '官方播放器無法解析這首 MIDI',
};

// ♪（演奏 → 試聽）：載入完成就從第一個音開始播。進入試聽＝結束目前演奏進度（共用合成器的 channel），所以簽章先作廢，離開後的 ▶ 一律整個重新載入。
// 載入期間 busy（按鈕全灰）；任何失敗都回到演奏「已載入、還沒播過」並在頂端提示，來源在這期間被換掉（token 過期）則整段靜默作廢。
async function enterPreview() {
  const { source } = playerStore.state;
  if (!source || isSongLoading) return;
  isSongLoading = true;
  playerStore.set({ busy: true });
  const token = sourceLoadToken;
  try {
    const bytes = await sourceBytes(source);
    if (isStale(token)) return;
    lastPlayedSignature = null;
    endHandled = false;
    await synth.startPreview(bytes);
    // 載入／恢復 AudioContext 期間換了來源：這次剛開始的試聽是孤兒，收掉。
    if (isStale(token)) { synth.flushPreviousSong(); return; }
    playerStore.set({
      mode: 'preview', transport: 'playing', started: true, finished: false, notice: null,
      previewDuration: synth.previewDuration(), positionSeconds: 0,
    });
    updateHumanGate();
  } catch (err) {
    if (isStale(token) || err.kind === 'aborted') return;
    if (err.kind === 'parse' || err.kind === 'timeout') console.warn(`⚠️ 官方播放器無法解析 ${source.name}`, err);
    else if (err.kind !== 'engine') console.error(err);
    synth.flushPreviousSong(); // 失敗的載入可能已動過合成器，清乾淨
    playerStore.set({
      mode: 'perform', transport: 'paused', started: false, finished: false, previewDuration: 0,
      notice: PREVIEW_NOTICE[err.kind] ?? `試聽失敗：${source.name}`,
    });
  } finally {
    isSongLoading = false;
    playerStore.set({ busy: false });
  }
}

// ♪（試聽 → 演奏）：停掉試聽、合成器清乾淨，演奏回到「已載入、還沒播過」，進度條歸零。
function leavePreview() {
  synth.flushPreviousSong();
  lastPlayedSignature = null;
  endHandled = false;
  playerStore.set({
    mode: 'perform', transport: 'paused', started: false, finished: false,
    notice: null, previewDuration: 0, positionSeconds: 0,
  });
  updateHumanGate();
}

// 試聽中的 ▶（續播；播完則從頭）與 ↻：跟 playCurrentSource() 一樣先 busy 全灰、await AudioContext 恢復。
async function playPreview({ fromStart = false } = {}) {
  if (isSongLoading) return;
  isSongLoading = true;
  playerStore.set({ busy: true });
  try {
    await (fromStart ? synth.restartPreview() : synth.resumePreview());
    // await 期間換了來源或離開試聽：PreviewPlayer 已經停了，不要把「播放中」寫回去。
    if (playerStore.state.mode !== 'preview') return;
    playerStore.set({ transport: 'playing', finished: false, notice: null });
  } catch (err) {
    console.error(err);
    if (playerStore.state.mode === 'preview') playerStore.set({ transport: 'paused', notice: `試聽失敗：${playerStore.state.source?.name ?? ''}` });
  } finally {
    isSongLoading = false;
    playerStore.set({ busy: false });
  }
}

// 下拉的值 → 槽位：'kb' 是 PC 鍵盤手（不看現場人數）；數字要在 1~現場人數 之內；空字串／不合法＝沒有指派（null）。
function slotOfOption(value) {
  if (value === KEYBOARD_SLOT) return KEYBOARD_SLOT;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= playerStore.state.playerCount ? n : null;
}

// 播放中（含暫停）改指派：不重新載入、不從頭，從目前位置接續。還沒播過、播完、試聽中、處理中，或沒有引擎裡的歌，就維持
// 「下一次按頂端播放鍵時依簽章重新載入」。
function reassignInPlace() {
  const s = playerStore.state;
  if (lastPlayedSignature === null || s.mode !== 'perform' || isSongLoading || endHandled || !s.source || !s.score) return;
  synth.reassign(s.score, [...s.assignments]);   // 傳快照（[單位 id, 槽位][]），跟 synth.load() 一樣
  lastPlayedSignature = buildPlaybackSignature(s.source);
}

// 指派演奏者下拉：更新 assignments。順序不拘——什麼時候改都即時處理（播放中從目前位置接續，否則下次 ▶ 重新載入）。
function assignPart(unitId, value) {
  const slot = slotOfOption(value);
  const assignments = new Map(playerStore.state.assignments);
  if (slot !== null) assignments.set(unitId, slot);
  else assignments.delete(unitId);
  playerStore.set({ assignments });
  reassignInPlace();
  updateHumanGate(); // 指派全清時 humanGain 立即收掉
}

// 系統控制 bar 「現場人數」切換成功後（main.js 經 vision 的 setPoseCountListener 接上）：下拉改列 1~n，
// 超出範圍的演奏者指派剪掉（PC 鍵盤手不受影響）。被剪掉的指派跟改指派一樣即時處理。
export function setPlayerCount(n) {
  const next = Math.max(0, Math.min(PLAYER_COUNT, Number(n) || 0));
  const s = playerStore.state;
  if (next === s.playerCount) return;
  const kept = [...s.assignments].filter(([, id]) => id === KEYBOARD_SLOT || id <= next);
  const assignments = new Map(kept);
  playerStore.set({ playerCount: next, assignments });
  if (kept.length !== s.assignments.size) reassignInPlace();
  updateHumanGate();
}

// MIDI 引擎掛掉不擋整個 app（攝影機、骨架都還能用），但一定要讓使用者看得到：寫在頂端狀態列。
export async function warmUpMidiEngine() {
  const ok = await synth.initEngine();
  if (!ok) playerStore.set({ notice: '⚠️ 音源引擎載入失敗，按下播放時會自動重試' });
  return ok;
}

// 200ms 的 UI tick：播完偵測、humanGate 定期補算、頂端進度條同步。
function uiTick() {
  const inPreview = playerStore.state.mode === 'preview';
  if (inPreview) {
    // 試聽播完：官方 Sequencer 自己會停（收掉所有音），這裡只負責把畫面切成「播完」。
    if (!isSongLoading && !playerStore.state.finished && synth.isPreviewFinished()) {
      playerStore.set({ transport: 'paused', finished: true });
    }
  } else if (!isSongLoading && synth.isLoaded() && !endHandled && synth.isFinished()) {
    endHandled = true;
    synth.pause();
    playerStore.set({ transport: 'paused', finished: true });
  }
  // humanGain 總開關的定期補算：播放→暫停／播完這類轉變即使當下沒有新的觸發，也會在 200ms 內把 humanGain 收到正確位置
  updateHumanGate();

  // 唯讀進度：演奏時位置來自 scheduler 的 tick 播放頭，用 score 的速度表換算成原譜秒數，跟聲音同一條時間軸（不是真實經過時間，沒人觸發就停住）；試聽時是官方 Sequencer 的 currentTime。
  // 用「跟 store 值的差距夠不夠大」節流（小於 0.05s 畫面上幾乎看不出來就不寫），避免每 200ms 都排一輪全區塊 render
  const score = playerStore.state.score;
  const pos = inPreview ? synth.previewTime()
    : synth.isLoaded() && score ? score.midiTicksToSeconds(synth.scheduler.getPositionTicks()) : 0;
  if (Math.abs(pos - playerStore.state.positionSeconds) > 0.05) {
    playerStore.set({ positionSeconds: pos });
  }
}

// 排程 tick：交給 scheduler.tick()，由它推進播放頭、收掉到期的音（沒有指派時整首自動播放，也由它放出走到的 segment；見 scheduler.js）。
function schedulerTick() {
  if (synth.isLoaded() && !synth.isPaused()) synth.scheduler.tick(performance.now(), synth.audioNow());
}

// main.js 呼叫一次；不靠 import 副作用啟動。
export function startPlayer() {
  synth.scheduler.enableEventLog();   // 錄音 v3 的事件串流（pressLog()）：app 一律記，彈完隨時可以匯出
  setInterval(uiTick, UI_TICK_MS);
  setInterval(schedulerTick, SCHEDULER_TICK_MS);
}

// 四顆獨立按鈕（▶ 播放／❚❚ 暫停／↻ 重播／♪ 試聽）互相防呆：哪顆能按、哪顆是「目前狀態」（accent 黃底）由 transportButtonState() 依 store 推導，
// 畫面照表寫 DOM（規格文件有同一張表）。
//   沒歌（idle）／載入中（loading）／處理中（busy） → 全灰（載入中 ▶ 顯示 ⋯）
//   剛載入、還沒播過 → ▶ 與 ♪ 能按（已經在開頭，沒有東西可重播）
//   播放中           → 只有 ❚❚ 能按（黃底）；播放中誤按重播會打斷演奏，所以 ▶／↻ 都灰；♪ 也灰（要先暫停，免得打斷演奏）
//   暫停／播完       → ▶（續播；播完則從頭播）、↻、♪ 能按
//   試聽中（mode＝preview）→ 同樣的規則作用在試聽，♪ 恆黃底（再按結束試聽），試聽播放中 ♪ 也能按
// 歌名只放歌名（notice 覆蓋時例外），不寫「解析中／下載中」；優先單行，超長才縮小字級。
const pill = document.getElementById('toolbar-playback');
const transportGroup = document.getElementById('transport-group');
const btnPlay = document.getElementById('btnPlay');
const btnPause = document.getElementById('btnPause');
const btnReplay = document.getElementById('btnReplay');
const btnPreview = document.getElementById('btnPreview');
const statusText = document.getElementById('midiStatusText');
// 頂端進度條獨立於 pill 之外（見 index.html），不影響 fitSongTitle() 量的寬度
const topProgressBar = document.getElementById('topProgressBar');

const IDLE_TITLE = '等待選擇歌曲...';

// 歌名優先單行，超長才縮小字級（見 src/styles.css 的 .player-status-bar）：scrollWidth 是文字實際想要的寬度（不受目前有沒有被壓縮影響），跟 pill 扣掉按鈕組與 gap 後能分給文字的寬度比較，超出就縮小 --song-title-scale；
// 縮到下限 MIN_SONG_TITLE_SCALE 還放不下，才加 .allow-wrap 退回換行。
const MIN_SONG_TITLE_SCALE = 0.6;
function fitSongTitle() {
  statusText.classList.remove('allow-wrap');
  statusText.style.setProperty('--song-title-scale', '1');
  const gapPx = parseFloat(getComputedStyle(pill).columnGap) || 0;
  const available = pill.clientWidth - transportGroup.offsetWidth - gapPx;
  const natural = statusText.scrollWidth;
  if (available <= 0 || natural <= available) return;
  const scale = Math.max(MIN_SONG_TITLE_SCALE, available / natural);
  statusText.style.setProperty('--song-title-scale', scale.toFixed(3));
  if (scale <= MIN_SONG_TITLE_SCALE && statusText.scrollWidth > available) {
    statusText.classList.add('allow-wrap');
  }
}

// 四顆鈕的狀態表（見上方說明）。純函式：只看 store，回傳能不能按、哪些鈕是目前狀態（current 是鈕名陣列）、pill 是不是 is-empty（idle／載入中，控制列的淡化條件靠它）；
// busy 期間 is-empty 維持 false，免得續播／重播那一瞬間控制列的透明度跳一下。
function transportButtonState({ mode, transport, started, finished, busy }) {
  const grey = { play: false, pause: false, replay: false, preview: false, current: [] };
  if (transport === 'idle' || transport === 'loading') return { ...grey, empty: true };
  if (busy) return { ...grey, empty: false };
  const inPreview = mode === 'preview';
  if (transport === 'playing') {
    return {
      play: false, pause: true, replay: false,
      preview: inPreview, // 演奏播放中 ♪ 灰；試聽播放中 ♪ 是「結束試聽」，可按
      current: inPreview ? ['pause', 'preview'] : ['pause'], empty: false,
    };
  }
  // transport === 'paused'：演奏還沒播過（已在開頭）不能重播，播到一半或播完都可以；試聽一律是播過才會在這裡，
  // 重播恆可按。
  return { play: true, pause: false, replay: inPreview || started || finished, preview: true, current: inPreview ? ['preview'] : [], empty: false };
}

// action 進來再對一次狀態表（防呆不只靠 disabled 一道擋：連按、程式呼叫都不會繞過去）。
const whenAllowed = (button, fn) => () => { if (transportButtonState(playerStore.state)[button]) fn(); };
const transportActions = {
  'play': whenAllowed('play', () => (playerStore.state.mode === 'preview' ? playPreview() : playCurrentSource())),
  'pause': whenAllowed('pause', () => pauseCurrentSource()),
  'replay': whenAllowed('replay', () => (playerStore.state.mode === 'preview' ? playPreview({ fromStart: true }) : playCurrentSource({ fromStart: true }))),
  'preview': whenAllowed('preview', () => (playerStore.state.mode === 'preview' ? leavePreview() : enterPreview())),
};

function mountTransportPill() {
  // 視窗尺寸改變會動到 pill 的 max-width（跟著 #camera-frame 走）與 --ui-fs，兩者都影響能分給歌名的寬度。
  window.addEventListener('resize', rafThrottle(fitSongTitle));
  fitSongTitle(); // 開場的「等待選擇歌曲...」字樣也套用同一套單行縮放邏輯
}

function renderTransportPill({ player }) {
  const state = transportButtonState(player);
  btnPlay.disabled = !state.play;
  btnPause.disabled = !state.pause;
  btnReplay.disabled = !state.replay;
  btnPreview.disabled = !state.preview;
  btnPause.classList.toggle('is-current', state.current.includes('pause'));
  btnPreview.classList.toggle('is-current', state.current.includes('preview'));
  btnPreview.setAttribute('aria-label', player.mode === 'preview' ? '關閉試聽' : '開啟試聽'); // 跟鏡頭開關同一個「開啟／關閉」格式
  btnPlay.classList.toggle('is-loading', player.transport === 'loading');
  pill.classList.toggle('is-empty', state.empty);

  // 只在文字真的不同時才寫——相同字串也會觸發 pill（width:max-content）重新量寬＋重新置中，看起來在抽動。
  const text = player.notice ?? (player.songTitle || IDLE_TITLE);
  if (statusText.textContent !== text) {
    statusText.textContent = text;
    fitSongTitle();
  }
}

// 頂端進度條：跟 renderTransportPill 平行、互不依賴。第一次有分譜資訊（score 非 null 且 durationSeconds > 0）之前整條收起來；顯示過一次之後不再因為換歌時 score 短暫變 null
// （loadScore() 開頭的 clearScore()）而收起，免得每次換歌都閃一次——value 在空窗期暫時停在舊值，「沒人觸發時停住不動」的原則不變。
let hasShownProgress = false;
function renderTopProgress({ player }) {
  // 試聽時分母是官方 duration（我們的 parser 即使解析失敗，試聽仍可用）。
  const total = player.mode === 'preview' ? player.previewDuration : (player.score?.durationSeconds || 0);
  if (total > 0) hasShownProgress = true;
  topProgressBar.hidden = !hasShownProgress;
  if (total > 0) {
    const ratio = Math.min(1, player.positionSeconds / total);
    if (topProgressBar.value !== ratio) topProgressBar.value = ratio;
  }
}

// 雲端曲庫（分類下拉／關鍵字搜尋／歌曲下拉）：資料來自 midiApi.js；搜尋狀態放 playerStore.library，兩個下拉的 option 只在 items／categories 參照變了才重建。分類集合跨搜尋累積（曲庫的分類端點可能失敗，搜尋結果裡的分類也要收）。
// 選到一首就下載＋解析（selectCloudSong），不啟動播放；退回「請選擇歌曲」就清掉來源。
const SEARCH_DEBOUNCE_MS = 300;

const categoryEl = document.getElementById('midiCategory');
const queryEl = document.getElementById('midiSongQuery');
const songSelectEl = document.getElementById('midiSongSelect');
const songMirrorEl = document.getElementById('midiSongMirror');

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
    // 換分類時關鍵字與已選歌曲都清空，直接重搜不等去抖。selectedId 一定要在這裡歸零：留著舊值的話，renderLibraryPicker() 寫回 songSelectEl.value 時新清單沒有這個 value，
    // 瀏覽器會把下拉判成沒有任何選項被選取（selectedIndex = -1、框顯示空白，不會退回 placeholder）；切回原類別時舊值又重新出現而悄悄復原成上次的歌。
    setLibrary({ category: el.value, query: '', selectedId: '' });
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

// 本地選檔時呼叫：關鍵字／分類清空、下拉回 placeholder，並重新搜尋（走去抖）
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
  // 鏡像文字＝下拉目前顯示的那一項（placeholder 也算）：原生下拉關著時會把超出的歌名截斷，改由上面這層跑馬燈顯示
  const shown = songSelectEl.selectedOptions[0]?.text ?? '';
  setMarqueeText(songMirrorEl, shown, songSelectEl.selectedIndex > 0 ? shown : '');
}

// 分譜清單每一列＝「聲部名（GM 音色的繁體中文名；單聲部多行譜是「聲部名・譜表 N」）＋一個下拉（無／PC 鍵盤手／演奏者 1~N）」，由 index.html 的 <template id="tpl-part-row"> clone，
// 聲部名用 textContent 填（來自檔案內容，不當 HTML）。列只在 parts 參照或 playerCount 變了才重建，每次 render 都校正各下拉的值與 is-mine。畫面不標示指派的人在不在場：指派本身留著，不隨追蹤雜訊變動。
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

function buildPartRow(unit, playerCount) {
  const row = partRowTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.partId = unit.id;
  setMarqueeText(row.querySelector('.score-part-name'), unit.name);
  const select = row.querySelector('.score-part-id');
  select.dataset.partId = unit.id;
  select.append(new Option('無', ''), new Option('PC 鍵盤手', KEYBOARD_SLOT));
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
  setMarqueeText(localFileName, shown, name);
  // 來源不是本地檔案（雲端曲目、取消、格式不支援）就把檔案輸入清掉，同一個檔案才能再次觸發 change。
  if (!isLocal && localInput.value) localInput.value = '';

  scorePartSection.hidden = player.parts.length === 0;
  const text = infoText(player);
  if (scoreInfoText.textContent !== text) scoreInfoText.textContent = text;

  if (player.parts !== renderedParts || player.playerCount !== renderedPlayerCount) {
    renderedParts = player.parts;
    renderedPlayerCount = player.playerCount;
    scorePartList.replaceChildren(...assignmentUnits(player.parts).map((unit) => buildPartRow(unit, player.playerCount)));
  }
  for (const sel of scorePartList.querySelectorAll('.score-part-id')) {
    const assigned = player.assignments.get(sel.dataset.partId);   // 1~4、KEYBOARD_SLOT 或 undefined
    const value = assigned === undefined ? '' : String(assigned);
    if (sel.value !== value) sel.value = value;
    sel.closest('.score-part-row').classList.toggle('is-mine', assigned !== undefined);
  }
}

export const actions = { ...transportActions };
export const fields = { ...songPanelFields, ...libraryFields };
export const inputs = { ...libraryInputs };
export function mount() {
  mountTransportPill();
  mountLibraryPicker();
}
export function render(snapshot) {
  renderTransportPill(snapshot);
  renderTopProgress(snapshot);
  renderSongPanel(snapshot);
  renderLibraryPicker(snapshot);
}
