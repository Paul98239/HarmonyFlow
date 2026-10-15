// ui.js — UI 外殼：Store／rafThrottle 基礎設施，加上把各功能的畫面接到 index.html 既有 markup 的事件代理與 render 排程。
// HTML-first：靜態 UI 都在 index.html，這裡不產生 markup。區塊模組形狀 { actions?, fields?, inputs?, mount?, render? }。
// 本檔不 import 播放器（由 main.js 經 initUi(player) 交進來），播放器才能反過來從這裡拿 Store 而不形成循環。

import {
  hardReset, setPoseCount, getPoseCount,
  startCamera, stopCamera, getCameraState, setCameraStateListener,
} from './vision/vision.js';

// ── state → render 基礎設施：Store ＋ rafThrottle ──
// Store：EventTarget 當基底，set(patch) 淺合併並立即替換 state，通知用 microtask 合併（同一個事件處理器連續 set 只通知一次）。
// 巢狀物件（Map、library 物件）改動時要換新參照，render 才能用參照比對決定要不要重建清單。
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

// 每幀最多執行一次：resize 拖曳時每秒觸發數十次，而寫 CSS 變數或量測版面都會強制重算樣式
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

// 跑馬燈欄位（.mq，原理見 styles.css「跑馬燈」）寫入文字：.mq-main 放原文（CSS 量它的寬度判斷有沒有超出，讀屏也讀它）；
// .mq-track 的 data-text 是首尾相連 loop 用的複本（CSS ::before／::after 各畫一份），data-len 是字寬權重（全形 1、其餘 0.55），CSS 用它換算動畫時間讓捲動速度大致固定；
// data-phase 每次換字翻轉，CSS 靠它換動畫名稱讓 loop 從頭開始；title 讓滑鼠停著時看到完整名稱；只在文字變了才寫 DOM。
const WIDE_CHAR = /[\u2E80-\uFFEF]/;
export function setMarqueeText(el, text, title = text) {
  const main = el.querySelector('.mq-main');
  if (main.textContent === text) return;
  const track = el.querySelector('.mq-track');
  main.textContent = text;
  track.dataset.text = text;
  track.dataset.phase = track.dataset.phase === 'b' ? 'a' : 'b';
  track.dataset.len = String(Math.round([...text].reduce((sum, ch) => sum + (WIDE_CHAR.test(ch) ? 1 : 0.55), 0) * 10) / 10);
  el.title = title;
}

// ── 外殼自己的 UI 狀態 ──
const uiStore = new Store({
  openPanel: null,        // 'song' | null：控制列彈出面板
  systemNote: null,       // { text, isError } | null：系統控制 bar 下方的狀態提示（鏡頭錯誤／人數切換失敗）
});

// ── 載入／錯誤遮罩與 #app-shell 的 inert ──
// #app-shell 開頁時帶 inert，還沒掛 handler 的按鈕就不可能被操作；dismissLoading() 才解除，啟動失敗（showError）維持惰性。
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

// ── 浮動 UI 的大小：綁視窗實際像素、與瀏覽器縮放脫鉤 ──
// --ui-fs 讓 Ctrl +/− 縮放瀏覽器時 UI 視覺大小不變（縮放是為了看清攝影機）。CSS 沒有不受縮放影響的單位，所以量 devicePixelRatio
// 相對開頁當下的倍率再除掉（Chromium／Firefox 有效；Safari 桌面整頁縮放不動 DPR，會退回跟著縮放，可接受）。
// 直接寫 documentElement.style 是「JS 不寫 style」的明文例外（連續量）。
const UI_FS_MIN = 15; // 小視窗的下限
const UI_FS_MAX = 19; // 大螢幕的上限：再大就吃掉攝影機空間
const UI_FS_BASELINE_DPR = window.devicePixelRatio || 1;

function applyUiFontSize() {
  const dpr = window.devicePixelRatio || 1;
  // 夾範圍，擋掉拖到不同 DPI 螢幕時 DPR 跳動的離譜值
  const zoom = Math.min(3, Math.max(0.5, dpr / UI_FS_BASELINE_DPR));
  // innerWidth 受縮放影響，乘回 zoom 還原成實際像素寬
  const realWidth = window.innerWidth * zoom;
  // 除數 90：約 1440px 實際寬時 ≈ 16px，1920 觸 19 上限、~1350 觸 15 下限。
  const preferred = Math.min(UI_FS_MAX, Math.max(UI_FS_MIN, realWidth / 90));
  // 除以 zoom：瀏覽器接著會再乘回 zoom，實際渲染大小只由 realWidth 決定。
  document.documentElement.style.setProperty('--ui-fs', `${preferred / zoom}px`);
}

// 選歌面板高度上限＝#camera-frame 底邊減 .control-row 底邊，面板不會超出攝影機外框，不管視窗比例或全螢幕都準；
// 空間小到誇張時退回下限，不讓面板消失。
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

// ── 區塊 1：系統控制列（鏡頭開關／現場人數／重置骨架 ID）──
// markup 在 index.html 的 #panel-system，畫面由 renderSystemBar(snapshot) 依 vision 狀態與 uiStore 畫出。
// 現場人數沒有預設值，選之前 vision.js 不推論。選人數通常要等 1~2 秒模型重建，期間 vision.js 用舊實例照常推論，
// 所以下拉不鎖，靠 POSE_COUNT_DEBOUNCE_MS 防抖與 runPoseCountSwitch() 單飛擋快速連續切換；真的生效那一刻等於重置骨架 ID。
const cameraBtn = document.getElementById('btn-camera-toggle');
const poseCountSelect = document.getElementById('poseCountSelect');
const resetBtn = document.getElementById('btn-reset-pose');
const note = document.getElementById('system-note');

const systemBarActions = {
  'camera-toggle': () => {
    // 失敗原因由狀態機的 message 帶回來（render 顯示在 note），這裡只留 console 紀錄
    (getCameraState().on ? stopCamera() : startCamera()).catch((err) => console.error('❌ 鏡頭開關失敗', err));
  },
  // 一次性動畫不是狀態，直接切 class；先移除再強制 reflow 才 add，快速連點才會重播（時長與退場在 CSS 的 reset-flash）
  'reset-pose': () => {
    hardReset();
    resetBtn.classList.remove('just-reset');
    void resetBtn.offsetWidth;
    resetBtn.classList.add('just-reset');
  },
};

const POSE_COUNT_DEBOUNCE_MS = 300; // 停在同一個值這麼久才真的觸發模型重建

let poseCountTimer = 0;
let poseCountWanted = 0;    // 使用者最後停留的值
let poseCountRunning = false;

const systemBarFields = {
  'pose-count': (el) => {
    const n = Number(el.value);
    if (!n) return; // Number('') 是 0，setPoseCount(0) 會拋錯
    poseCountWanted = n;
    clearTimeout(poseCountTimer);
    poseCountTimer = setTimeout(runPoseCountSwitch, POSE_COUNT_DEBOUNCE_MS);
  },
};

// 單飛：同時只有一個 setPoseCount 在跑；跑完若使用者最後要的值不一致就再跑一輪（切換途中改主意），guard 擋無限重試
async function runPoseCountSwitch() {
  if (poseCountRunning) return;
  poseCountRunning = true;
  try {
    for (let guard = 0; guard < 3 && poseCountWanted && poseCountWanted !== getPoseCount(); guard++) {
      try {
        await setPoseCount(poseCountWanted);
        console.log(`現場人數已切換為 ${poseCountWanted}`);
        uiStore.set({ systemNote: null }); // 蓋掉上一次可能留著的失敗訊息
      } catch (err) {
        // 建置失敗時 vision.js 什麼都沒動，render 讀 getPoseCount() 會讓下拉退回原值
        console.error('❌ 現場人數切換失敗', err);
        uiStore.set({ systemNote: { text: `現場人數切換失敗：${err?.message || err}`, isError: true } });
        poseCountWanted = getPoseCount(); // 不無限重試
        break;
      }
    }
  } finally {
    poseCountRunning = false;
  }
}

function mountSystemBar() {
  // message 是關閉原因或開啟失敗的文字（""＝使用者自己關的）；按鈕顏色與 disabled 在 render 裡讀 getCameraState()
  setCameraStateListener(({ message }) => {
    uiStore.set({ systemNote: message ? { text: message, isError: true } : null });
  });
}

function renderSystemBar({ ui, camera, poseCount }) {
  const label = camera.on ? '關閉鏡頭' : '開啟鏡頭';
  // 只寫 aria-label，滑鼠提示由 styles.css 的 .tl-text-btn::after 讀它
  if (cameraBtn.getAttribute('aria-label') !== label) cameraBtn.setAttribute('aria-label', label);
  cameraBtn.classList.toggle('is-on', camera.on);
  cameraBtn.disabled = camera.busy;

  // 下拉刻意不鎖（鎖 1~2 秒等於選錯不能改），靠防抖＋單飛；切換成功與否都由 getPoseCount() 校正畫面上的值
  const value = poseCount ? String(poseCount) : ''; // 0（還沒選）對不到任何 option
  if (poseCountSelect.value !== value) poseCountSelect.value = value;

  const text = ui.systemNote?.text || '';
  if (note.textContent !== text) note.textContent = text;
  note.classList.toggle('is-error', !!ui.systemNote?.isError);
  note.hidden = !text;
}

const systemBar = { actions: systemBarActions, fields: systemBarFields, mount: mountSystemBar, render: renderSystemBar };

// ── 區塊 2：控制列彈出面板（選歌）的開合 ──
// 狀態只有 uiStore.openPanel，畫面由 render 依它畫，不看 DOM。
// 刻意沒有「點面板外部就關閉」：面板裡有多個原生 <select> 與分譜控制項，誤觸關閉很干擾；只能用 ✕（close-panel）或再按觸發鈕（toggle-panel）。
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

// ── 事件代理與 render 排程 ──
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

/** 一鍵初始化（main.js 呼叫），同步完成不等網路。player＝midi/midiPlayer.js 的模組命名空間（帶 playerStore 與區塊模組形狀）。 */
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
