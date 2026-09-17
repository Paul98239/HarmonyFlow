// ============================================================
//  ui.js —— UI 外殼：state → render 的基礎設施（Store）＋ 把各功能的畫面接到 index.html 已寫好的 markup 上
//
//  index.html 是 HTML-first：所有靜態 UI 都在那裡，這裡不產生 markup。本檔負責：
//    0. Store（EventTarget 狀態容器）與 rafThrottle：外殼與播放器（midi/midiPlayer.js）共用的 UI 基礎設施。
//    1. uiStore：外殼自己的狀態（面板開合／人數切換中／系統提示）。
//    2. 載入／錯誤遮罩（唯一擁有者）與 #app-shell 的 inert。
//    3. 浮動 UI 的大小：--ui-fs 綁「視窗實際像素」並除掉瀏覽器縮放倍率；--popup-max-height 綁
//       #camera-frame 的實際框線。
//    4. 系統控制列（鏡頭／人數／重置）與彈出面板（選歌）開合這兩個外殼區塊的畫面。
//    5. 事件代理：#top-center-stack 上各掛一個 click／change／input，依 data-action／data-field 分派給
//       各區塊的 actions／fields／inputs；handler 不閉包任何元素參照，清單重畫也不用重綁。
//    6. render 排程：訂閱兩個 store 的 'change'，microtask 合併後跑一次 render(snapshot)，各區塊的
//       render 只在值不同時寫 DOM。DOM 不是真相，真相在 store 與 vision 的 getter 裡。
//  區塊模組統一形狀：{ actions?, fields?, inputs?, mount?, render? }；播放器那一整組在 midi/midiPlayer.js，
//  由 main.js 經 initUi(player) 交進來——本檔不 import 播放器，播放器才能反過來從這裡拿 Store 而不形成循環。
//
//  對外：Store／rafThrottle（midiPlayer.js）、initUi(player)（main.js）、setLoadingStatus／dismissLoading／showError（main.js 與 vision 的回呼）。
// ============================================================

import {
  hardReset, setPoseCount, getPoseCount,
  startCamera, stopCamera, getCameraState, setCameraStateListener,
} from './vision/vision.js';

/* ═══════════════════════════════════════════
   🧱 state → render 的基礎設施：Store ＋ rafThrottle
   ═══════════════════════════════════════════ */
// Store：EventTarget 當基底，訂閱就是瀏覽器內建的 addEventListener('change', fn)。set(patch) 淺合併並
// 立即替換 state（同步 get 就是新值），通知用 queueMicrotask 合併：同一個事件處理器裡連續 set 幾次，
// 訂閱者只會被叫一次。巢狀物件（Map、library 物件）改動時要換新參照，render 才能用參照比對決定要不要重建清單。
export class Store extends EventTarget {
  #state;
  #notifyQueued = false;

  constructor(initialState) {
    super();
    this.#state = initialState;
  }

  get state() { return this.#state; }

  set(patch) {
    this.#state = { ...this.#state, ...patch };
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      this.dispatchEvent(new Event('change'));
    });
  }
}

// 回傳一個「每幀最多執行一次」的包裝：resize 拖曳時每秒可觸發數十次，而寫 CSS 變數或量測版面
// 都會強制重算樣式；用 rAF 合併成每幀最多一次。
export function rafThrottle(fn) {
  let frameId = 0;
  return () => {
    if (frameId) return;
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      fn();
    });
  };
}

/* ═══════════════════════════════════════════
   🗂️ 外殼自己的 UI 狀態
   ═══════════════════════════════════════════ */
const uiStore = new Store({
  openPanel: null,        // 'song' | null：控制列彈出面板
  poseSwitching: false,   // 現場人數切換中（模型重建 1~2 秒）：下拉停用，避免 UI 與 vision 對不上
  systemNote: null,       // { text, isError } | null：系統控制 bar 下方的狀態提示（鏡頭錯誤／人數切換失敗）
});

/* ═══════════════════════════════════════════
   🕶️ 載入／錯誤遮罩（唯一擁有者）與 #app-shell 的 inert
   ═══════════════════════════════════════════ */
// 開頁時 #app-shell 帶著 inert（index.html）：整個 app 收不到點擊、Tab 也進不去，還沒掛 handler 的
// 按鈕就不可能被操作到；兩條啟動軌道都就緒、dismissLoading() 收起載入畫面時才解除。
// 啟動失敗（showError）維持惰性：錯誤畫面底下的 UI 本來就不該能操作。
// main.js 與 vision.js（經 startVision 的回呼）都經由這裡寫遮罩，不各自抓 DOM。
const appShell = document.getElementById('app-shell');
const loadingEl = document.getElementById('loading-overlay');
const loadingStatus = document.getElementById('loading-status');
const errorOverlay = document.getElementById('error-overlay');
const errorMessage = document.getElementById('error-message');
const errorDetail = document.getElementById('error-detail');

export function setLoadingStatus(text) {
  loadingStatus.textContent = text;
}

export function dismissLoading() {
  loadingEl.classList.add('is-dismissed');
  appShell.inert = false;
}

export function showError(message, detail = '') {
  loadingEl.classList.add('is-dismissed');
  errorOverlay.classList.add('is-visible');
  errorMessage.textContent = message;
  errorDetail.textContent = detail;
}

/* ═══════════════════════════════════════════
   📐 浮動 UI 的大小：綁「視窗實際像素」、與瀏覽器縮放脫鉤
   ═══════════════════════════════════════════ */
// 頂端疊層（播放 pill／控制列）的基準字級 --ui-fs 由這裡動態設定：按 Ctrl +/− 縮放瀏覽器時
// 這些 UI 的視覺大小不變（縮放是為了看清攝影機），只有視窗本身變大變小才等比微調。
// CSS 沒有不受瀏覽器縮放影響的單位，所以靠 JS 量出縮放倍率再除掉：Chromium／Firefox 的
// Ctrl +/− 會等比改變 devicePixelRatio，以開頁當下為基準推算倍率（Safari 桌面版整頁縮放不動
// DPR，會退回跟著縮放，可接受）。
// 直接寫 documentElement.style 是「JS 不寫 style」慣例的明文例外（連續量）。
const UI_FS_MIN = 15; // 小視窗的下限
const UI_FS_MAX = 19; // 大螢幕的上限：再大就吃掉攝影機空間
const UI_FS_BASELINE_DPR = window.devicePixelRatio || 1;

function applyUiFontSize() {
  const dpr = window.devicePixelRatio || 1;
  // 相對開頁當下的縮放倍率，夾在合理範圍，擋掉拖到不同 DPI 螢幕時 DPR 跳動造成的離譜值。
  const zoom = Math.min(3, Math.max(0.5, dpr / UI_FS_BASELINE_DPR));
  // innerWidth 已被縮放影響，乘回 zoom 還原成「實際像素寬」。
  const realWidth = window.innerWidth * zoom;
  // 除數 90：約 1440px 實際寬時 ≈ 16px，1920 觸 19 上限、~1350 觸 15 下限。
  const preferred = Math.min(UI_FS_MAX, Math.max(UI_FS_MIN, realWidth / 90));
  // 除以 zoom：瀏覽器接著會再乘回 zoom，實際渲染大小只由 realWidth 決定。
  document.documentElement.style.setProperty('--ui-fs', `${preferred / zoom}px`);
}

// 選歌彈出面板的高度上限：量 #camera-frame 實際底邊減去 .control-row 實際底邊，
// 面板永遠不會超出攝影機外框——跟猜 vh 不同，不管視窗長寬比或全螢幕與否都準確，因為
// #camera-frame 的實際框線本來就同時看視窗寬跟高（見 styles.css 的 #camera-frame 註解）。
// 算出來空間小到誇張時退回下限，不讓面板整個消失看不到。
const POPUP_BOTTOM_MARGIN_PX = 8;
const POPUP_MAX_HEIGHT_FLOOR_PX = 120;
const cameraFrame = document.getElementById('camera-frame');
const controlRow = document.getElementById('control-row');
function applyPopupMaxHeight() {
  const available = cameraFrame.getBoundingClientRect().bottom - controlRow.getBoundingClientRect().bottom - POPUP_BOTTOM_MARGIN_PX;
  document.documentElement.style.setProperty('--popup-max-height', `${Math.max(POPUP_MAX_HEIGHT_FLOOR_PX, available)}px`);
}

function mountUiScale() {
  applyUiFontSize();
  applyPopupMaxHeight();
  window.addEventListener('resize', rafThrottle(() => { // 縮放與拖動視窗都會觸發
    applyUiFontSize();
    applyPopupMaxHeight();
  }));
}

/* ═══════════════════════════════════════════
   🎚️ 區塊 1：系統控制列（鏡頭開關／現場人數／重置骨架 ID）
   ═══════════════════════════════════════════ */
// markup 在 index.html 的 #panel-system。畫面由 renderSystemBar(snapshot) 依 vision 的狀態
// （getCameraState()／getPoseCount()）與 uiStore 畫出來。
// 「攝影機開關」：vision.js 的 startCamera()／stopCamera()，按鈕文字與顏色跟著攝影機狀態走
// （被拔除／被搶走時 vision.js 經 setCameraStateListener 通知，按一下即重連）。
// 「現場人數」：MediaPipe 的 numPoses 與追蹤 ID 的上限（1~4）。沒有預設值——還沒選之前
// vision.js 不推論；分譜的「指派演奏者」下拉也只列到這個人數（vision.js 的 setPoseCountListener，
// 由 main.js 接到播放器）。vision.js 開頁就在背景把 1~4 人的模型都預建好，選人數通常是秒切換；
// 只有背景還沒建完那極少數情況才會等 1~2 秒模型重建。切換人數等於重置骨架 ID。
// 「重置骨架 ID」：vision.js 的 hardReset()，只有按鈕這一條觸發路徑（沒有鍵盤快捷鍵）。
const cameraBtn = document.getElementById('btn-camera-toggle');
const poseCountSelect = document.getElementById('poseCountSelect');
const resetBtn = document.getElementById('btn-reset-pose');
const note = document.getElementById('system-note');

const systemBarActions = {
  'camera-toggle': () => {
    // 失敗的原因由狀態機的 message 帶回來（render 會顯示在 note），這裡只留 console 紀錄
    (getCameraState().on ? stopCamera() : startCamera()).catch((err) => console.error('❌ 鏡頭開關失敗', err));
  },
  // 點一下閃黃色代表「剛重置過」：時長與退場都交給 CSS 的 reset-flash 動畫。一次性動畫不是狀態，
  // 這裡直接切 class：先移除再強制 reflow 才 add，快速連點時才會重新播放。
  'reset-pose': () => {
    hardReset();
    resetBtn.classList.remove('just-reset');
    void resetBtn.offsetWidth;
    resetBtn.classList.add('just-reset');
  },
};

const systemBarFields = {
  'pose-count': async (el) => {
    const n = Number(el.value);
    if (!n) return; // Number('') 是 0，setPoseCount(0) 會拋錯
    // 切換中鎖住下拉：模型重建要 1~2 秒，期間再改值會讓 UI 與 vision 對不上。
    uiStore.set({ poseSwitching: true });
    try {
      await setPoseCount(n);
      uiStore.set({ systemNote: null });
    } catch (err) {
      // 模型重建失敗時 vision.js 已經把原本的設定載回來，render 讀 getPoseCount() 就會讓下拉跟著回去
      console.error('❌ 現場人數切換失敗', err);
      uiStore.set({ systemNote: { text: `現場人數切換失敗：${err?.message || err}`, isError: true } });
    } finally {
      uiStore.set({ poseSwitching: false });
    }
  },
};

function mountSystemBar() {
  // 攝影機狀態一變就寫 note（message 是關閉原因或開啟失敗的文字，"" ＝ 使用者自己關的），
  // uiStore 的 change 事件會帶動一次 render，按鈕顏色與 disabled 在 render 裡讀 getCameraState() 畫。
  setCameraStateListener(({ message }) => {
    uiStore.set({ systemNote: message ? { text: message, isError: true } : null });
  });
}

function renderSystemBar({ ui, camera, poseCount }) {
  const label = camera.on ? '關閉鏡頭' : '開啟鏡頭';
  if (cameraBtn.title !== label) {
    cameraBtn.title = label;
    cameraBtn.setAttribute('aria-label', label);
  }
  cameraBtn.classList.toggle('is-on', camera.on);
  cameraBtn.disabled = camera.busy;

  // 0（還沒選）對不到任何 option；設成 '' 會選回那個 disabled 的 placeholder。
  const value = poseCount ? String(poseCount) : '';
  if (poseCountSelect.value !== value) poseCountSelect.value = value;
  poseCountSelect.disabled = ui.poseSwitching;

  const text = ui.systemNote?.text || '';
  if (note.textContent !== text) note.textContent = text;
  note.classList.toggle('is-error', !!ui.systemNote?.isError);
  note.hidden = !text;
}

const systemBar = { actions: systemBarActions, fields: systemBarFields, mount: mountSystemBar, render: renderSystemBar };

/* ═══════════════════════════════════════════
   🪟 區塊 2：控制列彈出面板（選歌）的開合
   ═══════════════════════════════════════════ */
// 狀態只有一個：uiStore.openPanel（'song' | null），畫面由 render 依它畫；
// 面板開著沒不再看 DOM。彈出面板釘在整排控制列正下方置中（見 styles.css 的 .tl-popup）。
// 刻意沒有「點面板外部就關閉」：面板裡有多個原生 <select> 與分譜控制項，使用者會在裡面操作
// 一段時間，誤觸關閉很干擾。全專案沒有任何鍵盤快捷鍵，只能用畫面上的按鈕操作：右上角的 ✕
// （data-action="close-panel"）、或再按一次觸發鈕（data-action="toggle-panel"）。
const PANELS = {
  song: { trigger: document.getElementById('song-toggle'), panel: document.getElementById('panel-song') },
};

const popupActions = {
  'toggle-panel': (el) => {
    const name = el.dataset.panel;
    uiStore.set({ openPanel: uiStore.state.openPanel === name ? null : name });
  },
  'close-panel': () => uiStore.set({ openPanel: null }),
};

function renderPopupPanels({ ui }) {
  for (const [name, { trigger, panel }] of Object.entries(PANELS)) {
    const open = ui.openPanel === name;
    panel.hidden = !open;
    trigger.classList.toggle('is-open', open);
  }
}

const popupPanels = { actions: popupActions, render: renderPopupPanels };

/* ═══════════════════════════════════════════
   🧩 事件代理與 render 排程
   ═══════════════════════════════════════════ */
let regions = [systemBar, popupPanels]; // initUi(player) 時補上播放器

const stack = document.getElementById('top-center-stack');

// 三張分派表：鍵是 data-action／data-field 的值，各區塊自己宣告自己的那幾個。
function mountDelegation() {
  const actions = Object.assign({}, ...regions.map((r) => r.actions || {}));
  const fields = Object.assign({}, ...regions.map((r) => r.fields || {}));
  const inputs = Object.assign({}, ...regions.map((r) => r.inputs || {}));
  const dispatch = (table, attr) => (e) => {
    const el = e.target.closest(`[${attr}]`);
    const handler = el && table[el.getAttribute(attr)];
    if (handler) handler(el, e);
  };
  stack.addEventListener('click', dispatch(actions, 'data-action'));
  stack.addEventListener('change', dispatch(fields, 'data-field'));
  stack.addEventListener('input', dispatch(inputs, 'data-field'));
}

let playerModule = null;
function render() {
  const snapshot = {
    player: playerModule.playerStore.state,
    ui: uiStore.state,
    camera: getCameraState(),
    poseCount: getPoseCount(),
  };
  for (const r of regions) r.render?.(snapshot);
}

// store 自己已經用 microtask 合併通知；這裡再合併一次是因為同一個 tick 內可能有多個 store 同時通知。
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render();
  });
}

/**
 * 一鍵初始化（main.js 呼叫）：同步完成，不等任何網路資源。
 * player ＝ midi/midiPlayer.js 的模組命名空間（帶 playerStore 與區塊模組形狀）。
 */
export function initUi(player) {
  playerModule = player;
  regions = [...regions, player];
  mountUiScale();
  for (const r of regions) r.mount?.();
  mountDelegation();
  uiStore.addEventListener('change', scheduleRender);
  player.playerStore.addEventListener('change', scheduleRender);
  render();
}
