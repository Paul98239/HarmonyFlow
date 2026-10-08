// ============================================================
//  keyboard.js — 鍵盤觸發：電腦鍵盤的四排字元鍵，每按一下＝「PC 鍵盤手」的一次觸發（放行全曲的下一個 segment，見 scheduler.js 的 trigger()）
//
//  這裡只負責「哪些按鍵算觸發」與防呆，按下去之後的事（發聲、時值）全在排程器。不 import 任何其他模組。
// ============================================================

// 用 event.code（實體鍵位）不用 event.key：換輸入法或鍵盤配置（注音、Dvorak）時，同一個位置的鍵仍然是同一個鍵。
// 一排：` 1~0 - =；二排：Q~P [ ] \；三排：A~L ; '；四排：Z~M , . /。
// 刻意不含 Space／Enter／Tab（焦點在按鈕上時會「按下」播放列的按鈕或移動焦點）、數字鍵盤、功能鍵。
const TRIGGER_CODES = new Set([
  'Backquote', ...'1234567890'.split('').map((d) => `Digit${d}`), 'Minus', 'Equal',
  ...'QWERTYUIOP'.split('').map((c) => `Key${c}`), 'BracketLeft', 'BracketRight', 'Backslash',
  ...'ASDFGHJKL'.split('').map((c) => `Key${c}`), 'Semicolon', 'Quote',
  ...'ZXCVBNM'.split('').map((c) => `Key${c}`), 'Comma', 'Period', 'Slash',
]);

// 量測：鍵盤事件從瀏覽器產生，到我們的 handler 開始跑，在主執行緒佇列裡等了多久（毫秒）。主執行緒被影像算繪／姿勢推論
// 卡住時這個值會變大——你的音雖然在 handler 內同步發聲，但 handler 本身晚了就等於音晚了。只留最近一批，避免無限成長。
const INPUT_DELAY_MAX = 5000;
const inputDelays = [];
export const getInputDelays = () => inputDelays;

// 焦點在這些元素時，鍵盤是拿來打字的，不是觸發。
const isTyping = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA'
  || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'file', 'range'].includes(el.type)));

/**
 * 掛上 keydown 監聽。每次有效按鍵在 keydown 事件裡同步呼叫 onTrigger(slot)（不經過計時器，發聲才不會晚）。
 * slot 由呼叫端交進來（main.js 傳 scheduler.js 的 KEYBOARD_SLOT）：這個模組不 import 其他模組。一個人可以被指派多個聲部。
 * @param {(slot: number|string) => void} onTrigger
 * @param {number|string} slot  這個鍵盤代表的演奏者槽位
 */
export function startKeyboardTrigger(onTrigger, slot) {
  window.addEventListener('keydown', (e) => {
    if (!TRIGGER_CODES.has(e.code)) return;
    if (e.repeat) return;                                // 按住不放的自動重複：一次按下只算一次
    if (e.ctrlKey || e.altKey || e.metaKey) return;      // 組合鍵是瀏覽器／系統快捷鍵（Ctrl+R 等），不攔
    if (isTyping(document.activeElement)) return;        // 搜尋欄打字不觸發
    // 焦點停在 <select>（選歌、分譜指派）時，字母鍵會觸發瀏覽器的 type-ahead 跳選項，選歌下拉一跳就換歌，所以擋掉預設行為
    e.preventDefault();
    inputDelays.push(performance.now() - e.timeStamp); // e.timeStamp 跟 performance.now() 同一個時間原點（事件產生的時刻）
    if (inputDelays.length > INPUT_DELAY_MAX) inputDelays.shift();
    onTrigger(slot);
  });
}
