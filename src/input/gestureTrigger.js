// gestureTrigger.js — 揮手觸發：vision 每幀送來各槽位的拋物線累加計數，變動＝一次有效揮手，包成輸入事件交給呼叫端。
// 揮手只有「發生」沒有「放開」，輸入事件不帶 key：排程器走非 keyup 模式，你的音 loop 到下一次揮手。

/**
 * 回傳給 vision.js 的 setPerformanceStateListener 註冊的監聽；有效揮手在 vision 的幀回呼內同步呼叫 onInput（不經計時器）。
 * receivedMs＝呼叫當下的 performance.now()（跟鍵盤同一個時間原點）；手勢沒有可靠的事件發生時刻，eventTimeMs 給 null。
 * @param {(input: { slot: number, source: string, eventTimeMs: null, receivedMs: number }) => void} onInput
 * @returns {(state: { arcTriggerSeqBySlot: Object<string, number> }) => void}
 */
export function createGestureTrigger(onInput) {
  const lastSeq = new Map();   // 槽位 → 上次看到的累加計數；它永不歸零，所以第一次看到的值只當基準，不是事件
  return ({ arcTriggerSeqBySlot }) => {
    // 這份狀態沒帶的槽位（鏡頭關閉、改人數、重置 ID 都會送空的）清掉基準，之後再出現的第一個值也只當基準
    for (const slot of lastSeq.keys()) if (!(slot in arcTriggerSeqBySlot)) lastSeq.delete(slot);
    for (const [key, seq] of Object.entries(arcTriggerSeqBySlot)) {
      const slot = Number(key), prev = lastSeq.get(slot);   // 物件的鍵是字串，播放器的指派用數字槽位
      lastSeq.set(slot, seq);
      if (prev !== undefined && seq !== prev) onInput({ slot, source: 'gesture', eventTimeMs: null, receivedMs: performance.now() });
    }
  };
}
