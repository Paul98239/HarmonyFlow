// ============================================================
//  press-timing.test.mjs — src/midi/pressTiming.js（估速與去抖）的回歸測試（純 Node）
//
//  沒有測試框架，跟其他 test/unit 同一套風格：run()／assert()。用法：node test/unit/press-timing.test.mjs
// ============================================================

import {
  estimatePlaybackRate, rateBoundsFor, debounceWindowMs, pressLoad, summarizeMs,
  RATE_WINDOW_INTERVALS, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE, PRESS_PERIOD_MIN_S, PRESS_PERIOD_MAX_S, DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS,
} from '../../src/midi/pressTiming.js';

function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// 一串按鍵：scoreSec 是樂譜秒、ms 是真實毫秒；每個間隔 stepScore 樂譜秒、stepMs 真實毫秒
const presses = (n, stepScore, stepMs, start = { scoreSec: 0, ms: 0 }) =>
  Array.from({ length: n }, (_, i) => ({ scoreSec: start.scoreSec + i * stepScore, ms: start.ms + i * stepMs }));

/* ═══════════════════════════════════════════
   estimatePlaybackRate：最近 N 個間隔的「樂譜秒差 ÷ 真實秒差」
   ═══════════════════════════════════════════ */

run('少於 2 個按鍵沒有間隔可估：回傳 fallback（預設 1）', () => {
  assert(estimatePlaybackRate([]) === 1 && estimatePlaybackRate([{ scoreSec: 3, ms: 100 }]) === 1, '0 或 1 個按鍵回 1');
  assert(estimatePlaybackRate([], 1.7) === 1.7, '可以指定 fallback（維持原本的速度）');
});

run('照檔案速度彈＝1；快一倍＝2；慢一倍＝0.5', () => {
  assert(near(estimatePlaybackRate(presses(5, 0.5, 500)), 1), '樂譜 0.5s 的間隔、真實 500ms');
  assert(near(estimatePlaybackRate(presses(5, 0.5, 250)), 2), '真實只花 250ms＝快一倍');
  assert(near(estimatePlaybackRate(presses(5, 0.5, 1000)), 0.5), '真實花 1000ms＝慢一半');
});

run('視窗只看最近 8 個間隔（9 個按鍵）：更早的速度不影響現在', () => {
  assert(RATE_WINDOW_INTERVALS === 8, `視窗是 8 個間隔（模擬評估的結果），實際 ${RATE_WINDOW_INTERVALS}`);
  const slow = presses(10, 0.5, 1000);                                   // 前面 10 個按鍵很慢（0.5×）
  const fast = presses(9, 0.5, 250, { scoreSec: slow.at(-1).scoreSec + 0.5, ms: slow.at(-1).ms + 250 }); // 之後 9 個按鍵很快（2×）
  const rate = estimatePlaybackRate([...slow, ...fast]);
  assert(near(rate, 2, 1e-6), `最近 8 個間隔都是 2×，應為 2，實際 ${rate}`);
});

run('視窗內的手抖互相抵銷：用頭尾比值而不是逐個間隔平均（頭尾誤差不累積）', () => {
  // 理想 500ms 一下，每個按鍵時刻加 ±40ms 誤差：只看最近一個間隔會落在 0.67～1.6，視窗法的頭尾比值更貼近 1
  const noise = [0, 38, -35, 40, -30, 36, -40, 33, -38];
  const hist = noise.map((e, i) => ({ scoreSec: i * 0.5, ms: i * 500 + e }));
  const last = (hist.at(-1).scoreSec - hist.at(-2).scoreSec) / ((hist.at(-1).ms - hist.at(-2).ms) / 1000);
  const win = estimatePlaybackRate(hist);
  assert(Math.abs(win - 1) < Math.abs(last - 1) && Math.abs(win - 1) < 0.03, `視窗法 ${win.toFixed(3)} 應比單一間隔 ${last.toFixed(3)} 更接近 1（誤差 < 3%）`);
});

run('夾在絕對保險範圍 [1/256, 64]：同一毫秒連按不會除以 0、隔幾分鐘也不會趨近 0', () => {
  assert(MIN_PLAYBACK_RATE === 1 / 256 && MAX_PLAYBACK_RATE === 64, '絕對保險範圍是 [1/256, 64]');
  assert(estimatePlaybackRate([{ scoreSec: 0, ms: 5 }, { scoreSec: 0.5, ms: 5 }]) === 64, '同一毫秒 → 上限 64（不是 Infinity）');
  assert(estimatePlaybackRate([{ scoreSec: 0, ms: 0 }, { scoreSec: 0.5, ms: 6000000 }]) === 1 / 256, '隔 100 分鐘 → 下限 1/256');
});

run('rateBoundsFor：每首歌的速度區間 ＝ [g ÷ 30 秒, g ÷ 0.06 秒]（g＝典型起音間隔的中位數），中心依這首歌平移、對數寬度固定', () => {
  assert(PRESS_PERIOD_MIN_S === 0.06 && PRESS_PERIOD_MAX_S === 30, '按鍵真實間隔區間 [0.06, 30] 秒');
  const canon = rateBoundsFor([0.444, 0.444, 0.888, 0.444, 0.444]);                     // 卡農大提琴 g ≈ 0.444
  assert(Math.abs(canon.lo - 0.444 / 30) < 1e-9 && Math.abs(canon.hi - 0.444 / 0.06) < 1e-9, `卡農區間 [0.0148, 7.4]，實際 ${JSON.stringify(canon)}`);
  assert(canon.hi >= 4 && canon.lo <= 0.044, '涵蓋舊上限 4×（連按 7～10 下/秒）與每下 10 秒的 0.044×');
  const dense = rateBoundsFor([0.2, 0.2, 0.2]), sparse = rateBoundsFor([2, 2, 2]);
  assert(dense.hi < sparse.hi && dense.lo < sparse.lo, '密集的歌區間整體比稀疏的歌慢');
  assert(Math.abs(Math.log(dense.hi / dense.lo) - Math.log(sparse.hi / sparse.lo)) < 1e-9, '對數寬度（ln 500）相同：只是平移');
  const chord = rateBoundsFor([0.002, 0.003, 0.5, 0.5, 0.5]);
  assert(Math.abs(chord.hi - 0.5 / 0.06) < 1e-9, '和弦錯位的小間隔（< 20ms）不算典型間隔');
  const none = rateBoundsFor([]);
  assert(none.lo === MIN_PLAYBACK_RATE && none.hi === MAX_PLAYBACK_RATE, '沒有間隔（單一起音）：絕對保險範圍');
  const tiny = rateBoundsFor([0.02, 0.02]);
  assert(tiny.lo < tiny.hi && tiny.lo >= MIN_PLAYBACK_RATE, `極端密集也是有效區間（lo < hi），實際 ${JSON.stringify(tiny)}`);
});

run('estimatePlaybackRate 帶區間：快過區間上緣、慢過下緣的估計夾在區間邊界', () => {
  const B = { lo: 0.0148, hi: 7.4 };
  assert(estimatePlaybackRate([{ scoreSec: 0, ms: 0 }, { scoreSec: 0.444, ms: 40 }], 1, B) === 7.4, '極快夾在上緣');
  assert(estimatePlaybackRate([{ scoreSec: 0, ms: 0 }, { scoreSec: 0.444, ms: 60000 }], 1, B) === 0.0148, '極慢夾在下緣');
  assert(Math.abs(estimatePlaybackRate([{ scoreSec: 0, ms: 0 }, { scoreSec: 0.444, ms: 10000 }], 1, B) - 0.0444) < 1e-9, '每下 10 秒＝0.0444，在區間內不被夾');
});

/* ═══════════════════════════════════════════
   debounceWindowMs：0.6 × min(預估這一步的真實長度, 上一次有效間隔)，夾在 [50, 500]ms
   ═══════════════════════════════════════════ */

run('窗口＝這一步預估真實長度的 60%', () => {
  assert(near(debounceWindowMs(400), 240), '400ms 的一步 → 240ms');
  assert(near(debounceWindowMs(200), 120), '200ms 的一步 → 120ms');
});

run('取「預估長度」與「你上一次的按鍵間隔」較小者：你加速時窗口跟著縮小，不擋合理的快速按鍵', () => {
  assert(near(debounceWindowMs(400, 150), 90), '上一次只隔 150ms → 0.6×150＝90ms（不是 240）');
  assert(near(debounceWindowMs(400, 5000), 240), '上一次間隔很長（停手回來）→ 仍用預估長度');
  assert(near(debounceWindowMs(400, Infinity), 240) && near(debounceWindowMs(400, undefined), 240), '還沒有上一次按鍵間隔（第一下之後的第一個間隔）→ 用預估長度');
});

run('下限 50ms、上限 500ms', () => {
  assert(DEBOUNCE_MIN_MS === 50 && DEBOUNCE_MAX_MS === 500, '常數是 50／500');
  assert(debounceWindowMs(10) === 50, '很短的一步（10ms）→ 夾在下限 50ms');
  assert(debounceWindowMs(0) === 50, '預估長度 0（同 tick）→ 下限 50ms');
  assert(debounceWindowMs(60000) === 500, '很長的一步 → 夾在上限 500ms');
});

/* ═══════════════════════════════════════════
   pressLoad：照原速彈需要的按鍵頻率（平均每秒、最忙 1 秒）
   ═══════════════════════════════════════════ */

run('pressLoad：每 0.5 秒一個起音＝平均每秒 2 下、最忙 1 秒 3 下（視窗含頭尾，寬度 ≤ 1 秒）', () => {
  const secs = Array.from({ length: 21 }, (_, i) => i * 0.5);             // 0, 0.5, …, 10
  const r = pressLoad(secs);
  assert(r.presses === 21 && near(r.perSecAvg, 21 / 10) && r.perSecPeak === 3, `實際 ${JSON.stringify(r)}`);
});

run('pressLoad：同一個秒數（和弦、多聲部同 tick）只算一次；不必先排序；最忙的那 1 秒要抓得到', () => {
  const r = pressLoad([5, 0, 0, 5, 5.2, 5.4, 5.6, 5.8, 10]);                // 5～5.8 擠了 5 個，其餘零散
  assert(r.presses === 7 && near(r.perSecAvg, 0.7) && r.perSecPeak === 5, `重複的秒數合併（0、5、5.2、5.4、5.6、5.8、10 共 7 個）、不排序也行，最忙 1 秒 5 下，實際 ${JSON.stringify(r)}`);
});

run('pressLoad：空陣列與只有一個起音不會除以 0', () => {
  assert(JSON.stringify(pressLoad([])) === JSON.stringify({ presses: 0, perSecAvg: 0, perSecPeak: 0 }), '空陣列全是 0');
  assert(JSON.stringify(pressLoad([3])) === JSON.stringify({ presses: 1, perSecAvg: 0, perSecPeak: 1 }), '只有一個起音：平均 0（沒有時間跨度）、最忙 1');
});

run('summarizeMs：個數、平均、p50、p99（最近排名法）、最大、超過 30ms 的個數；空陣列全是 0', () => {
  const r = summarizeMs(Array.from({ length: 100 }, (_, i) => i + 1));          // 1..100
  assert(r.count === 100 && r.avg === 50.5 && r.p50 === 50 && r.p99 === 99 && r.max === 100 && r.over30 === 70, `1..100 的統計，實際 ${JSON.stringify(r)}`);
  assert(JSON.stringify(summarizeMs([])) === JSON.stringify({ count: 0, avg: 0, p50: 0, p99: 0, max: 0, over30: 0 }), '空陣列全是 0');
  assert(summarizeMs([12.34, 0.04]).max === 12.3 && summarizeMs([12.34, 0.04]).avg === 6.2, '數字進位到 0.1ms');
});

console.log('\n全部測試跑完。');
