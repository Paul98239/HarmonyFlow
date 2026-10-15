// keyboard.js — 鍵盤觸發：每次有效按下、放開包成輸入事件交給呼叫端，按下後的事（發聲、時值）都在排程器。不 import 其他模組。

// 用 event.code（實體鍵位）而非 event.key：不受輸入法、鍵盤配置與修飾鍵影響。只含美式鍵盤的字元鍵與空白鍵，
// 刻意不含 Enter／Tab（會按下焦點按鈕、移動焦點）、數字鍵盤、方向鍵、功能鍵。
const TRIGGER_CODES = new Set([
  'Backquote', ...'1234567890'.split('').map((d) => `Digit${d}`), 'Minus', 'Equal',
  ...'QWERTYUIOP'.split('').map((c) => `Key${c}`), 'BracketLeft', 'BracketRight', 'Backslash',
  ...'ASDFGHJKL'.split('').map((c) => `Key${c}`), 'Semicolon', 'Quote',
  ...'ZXCVBNM'.split('').map((c) => `Key${c}`), 'Comma', 'Period', 'Slash',
  'Space',
]);

// 事件在主執行緒佇列裡等了多久（ms）：handler 晚了音就晚了。只留最近一批。
const INPUT_DELAY_MAX = 5000;
const inputDelays = [];
export const getInputDelays = () => inputDelays;

// 焦點在這些元素時，鍵盤是拿來打字的，不是觸發。
const isTyping = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA'
  || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'file', 'range'].includes(el.type)));

/**
 * 掛上 keydown／keyup 監聽；有效按鍵在 keydown 內同步呼叫 onInput（不經計時器，發聲才不會晚），之後那個鍵放開時呼叫 onLift。
 * eventTimeMs＝event.timeStamp、receivedMs＝handler 開始時的 performance.now()，同一時間原點，相減＝佇列等待。
 * key＝event.code（兩個回呼配對用）。slot 由呼叫端交進來，這個模組才不必 import 其他模組。
 * @param {(input: { slot: number|string, source: string, key: string, eventTimeMs: number, receivedMs: number }) => void} onInput
 * @param {number|string} slot  這個鍵盤代表的演奏者槽位
 * @param {(input: { slot: number|string, source: string, key: string, eventTimeMs: number, receivedMs: number }) => void} [onLift]  鍵放開（或視窗失焦、分頁隱藏時補送）
 */
export function startKeyboardTrigger(onInput, slot, onLift) {
  const down = new Set();   // keydown 有效送出、還沒放開的鍵（event.code）：keyup 只處理這些，已經按下的鍵一定要能放開
  const lift = (key, eventTimeMs) => {
    if (!down.delete(key)) return;
    onLift?.({ slot, source: 'keyboard', key, eventTimeMs, receivedMs: performance.now() });
  };
  // Alt+Tab 切走、分頁隱藏時 keyup 不會送到頁面，不補送放開的話音會一直卡著
  const liftAll = (e) => { for (const key of [...down]) lift(key, e.timeStamp); };
  window.addEventListener('blur', liftAll);
  document.addEventListener('visibilitychange', (e) => { if (document.visibilityState === 'hidden') liftAll(e); });

  window.addEventListener('keydown', (e) => {
    if (!TRIGGER_CODES.has(e.code)) return;
    if (e.repeat) return;                                // 按住不放的自動重複：一次按下只算一次
    if (e.ctrlKey || e.altKey || e.metaKey) return;      // 組合鍵是瀏覽器／系統快捷鍵（Ctrl+R 等），不攔
    if (isTyping(document.activeElement)) return;        // 搜尋欄打字不觸發
    // 擋預設行為：焦點在 <select> 時字母鍵會觸發 type-ahead 換歌，空白鍵會連帶按下有焦點的按鈕
    e.preventDefault();
    const receivedMs = performance.now();
    inputDelays.push(receivedMs - e.timeStamp);
    if (inputDelays.length > INPUT_DELAY_MAX) inputDelays.shift();
    down.add(e.code);
    onInput({ slot, source: 'keyboard', key: e.code, eventTimeMs: e.timeStamp, receivedMs });
  });

  // Firefox 在空白鍵 keyup 才按下焦點按鈕，只擋 keydown 不夠
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey && !isTyping(document.activeElement)) e.preventDefault();
    lift(e.code, e.timeStamp);
  });
}
