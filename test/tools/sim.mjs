// ============================================================
//  sim.mjs — 排程器的模擬演奏者與量測（給 library-scan.mjs 用；純 Node，不載音色庫、不出聲）
//
//  假合成器記下每顆音實際發聲／收音的假時間；模擬演奏者依「按鍵時間表」逐個 driver segment 按鍵（每位演奏者一張，單位 ms，
//  每一個時間點＝按一下鍵＝放行被指派聲部的下一個起音，並啟動它負責的那一段電腦聲部）。假時間以 12ms 為一個 tick，跟
//  midiPlayer.js 的排程 tick 一致；按鍵在 tick 之間直接呼叫 trigger()，跟鍵盤事件一樣同步。被去抖擋掉的按鍵，40ms 後再按一次
//  （就像你發現沒聲音會再按）。「成對」的意思是以音為單位：每個 noteOn 都要有一個 noteOff（原檔的結束是 Note Off 還是
//  velocity 0 的 Note On 不影響，parser 都配成同一顆音），而且絕不送 velocity 0 的 noteOn（合成器會把它當成 note-off）。
// ============================================================

import { Scheduler } from '../../src/midi/scheduler.js';
import { pressLoad } from '../../src/midi/pressTiming.js';

export const TICK_MS = 12;
const ORIGIN_MS = 12;        // 樂譜時間 0 對應的假時間：跟第一次按鍵／第一個有 dt 的 tick 同一個原點
const RETRY_MS = 40;         // 被去抖擋掉之後多久再按
const BURST_REPEAT = 5;      // 連按：每個 driver 起音按幾下（每 24ms 一下，會被去抖擋掉大部分，直到按上為止）

// mulberry32：固定種子的亂數，同一個種子永遠重現同一場模擬。
export function makeRng(seed) {
  let s = seed;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// 假合成器。排程器先把音登記進 staff.sounding 再 noteOn，所以 noteOn 當下佇列最後一項的 note 就是剛發聲的那一顆；
// noteOff 依「同 staff 同音高先進先出」配回去（跟官方合成器對 note-off 的解讀一致）。
function makeRecorder(getPerformer, clock) {
  const records = [];                 // 每顆發聲的音：{ label, partId, staffId, note, onMs, offMs }
  const pending = new Map();          // `${staffId}/${音高}` → 還沒收的 records（先進先出；一個 part 底下的 staff 各有各的輸出 channel）
  const stats = { strayOff: 0, badVelocity: 0 };
  const recorded = new WeakSet();     // 已經記過的音（打擊 staff 共用同一個 channel 時，用它分辨是哪個 staff 的音）
  let byChannel = null;
  const candidates = (ch, label) => {
    byChannel ??= new Map();
    if (!byChannel.size) for (const v of getPerformer()._staves.values()) {
      const k = `${v.kind}/${v.channel}`;
      if (!byChannel.has(k)) byChannel.set(k, []);
      byChannel.get(k).push(v);
    }
    return byChannel.get(`${label}/${ch}`);
  };
  const make = (label) => ({
    controllerChange() {}, programChange() {},
    noteOn: (ch, key, vel) => {
      const list = candidates(ch, label);
      const v = list.find((x) => { const e = x.sounding.get(key)?.at(-1); return e && !recorded.has(e.note); }) || list[0];
      const note = v.sounding.get(key).at(-1).note;
      recorded.add(note);
      if (!(vel >= 1)) stats.badVelocity++;
      const rec = { label, partId: v.partId, staffId: v.id, note, onMs: clock.ms, offMs: null };
      records.push(rec);
      const k = `${v.id}/${key}`;
      if (!pending.has(k)) pending.set(k, []);
      pending.get(k).push(rec);
    },
    noteOff: (ch, key) => {
      const list = candidates(ch, label), v = list.find((x) => pending.get(`${x.id}/${key}`)?.length) || list[0];
      const rec = pending.get(`${v.id}/${key}`)?.shift();
      if (rec) rec.offMs = clock.ms; else stats.strayOff++;
    },
  });
  return { assist: make('assist'), human: make('human'), records, stats };
}

/**
 * 跑一場模擬。players：[{ partIds: [...], presses: [ms, ...] }]，第 i 位演奏者的槽位是 i+1，任何一位按一下都放行被指派聲部
 * 的下一個起音；players 是空陣列＝沒有人被指派（整首自動播放）。跑到播完（而且所有按鍵都送完）或超過上限。
 * players[i].keepGoing＝true：按鍵排完、曲子還沒按完（有的按鍵被去抖擋掉）時，每 RETRY_MS 繼續按，直到曲子結束。
 * players[i].retryBlocked＝true：每一個被去抖擋掉的按鍵（前奏預按除外）過 RETRY_MS 再按一次，直到按上（時間表不會因為被擋而錯位）。
 * players[i].waitEndMs：presses 只排第一下，之後每一下都等這位演奏者自己的音全部收完、再過 waitEndMs 才按（聽完整音符才按的人）。
 * pressLog：每次按鍵嘗試的 { slot, ms, released }（released＝trigger() 的回傳值；被去抖擋掉的是 false）。
 */
export function simulate(score, players, { tailMs = 8000, tickMs = TICK_MS } = {}) {
  const clock = { ms: 0 };
  let hp;
  const rec = makeRecorder(() => hp, clock);
  hp = new Scheduler();
  hp.setSynths(rec.assist, rec.human);
  const slotOf = new Map();
  players.forEach((p, i) => p.partIds.forEach((id) => slotOf.set(id, i + 1)));
  hp.load(score, slotOf);
  hp.play();
  const attempts = [];                // 還沒按的按鍵 { ms, slot }，依時間排序
  const remaining = {};               // slot → 這位演奏者還排著幾次按鍵
  players.forEach((p, i) => {
    const list = p.presses.filter(Number.isFinite);
    remaining[i + 1] = list.length;
    list.forEach((ms) => attempts.push({ ms, slot: i + 1 }));
  });
  attempts.sort((a, b) => a.ms - b.ms);
  const pressLog = [];
  const lastPress = Math.max(0, ...attempts.map((a) => a.ms));
  // 電腦聲部在最後一次按鍵之後照估到的速度放完剩下的（速度可能只有 1/3），所以上限抓寬一點；waitEndMs 的演奏者每個起音再多等一次
  const waitMs = players.reduce((a, p) => a + (p.waitEndMs ?? 0), 0) * hp._driverSegs.length;
  const endMs = Math.max(lastPress + score.durationSeconds * 4000, score.durationSeconds * 1000) + waitMs + tailMs;
  hp.tick(0);
  while (clock.ms < endMs) {
    clock.ms += tickMs;
    const tickNow = clock.ms;
    // 落在這個 tick 之前的按鍵：照時間順序、在它自己的時刻呼叫（跟鍵盤事件一樣在 tick 之間），不早於上一個 tick
    while (attempts.length && attempts[0].ms <= tickNow) {
      const a = attempts.shift();
      clock.ms = Math.max(a.ms, tickNow - tickMs);
      const released = hp.trigger(a.slot, clock.ms);
      pressLog.push({ slot: a.slot, ms: clock.ms, released });
      remaining[a.slot]--;
      // retryBlocked：被去抖擋掉的按鍵（前奏預按不算）過 RETRY_MS 再按，直到按上——真人發現沒聲音會再按。不重按的話，這位演奏者
      // 之後的時間表整個錯位一個起音，越到後面越多按鍵被擋、最後變成連按（速度倍率被夾到上限，落音統計被稀釋）
      if (!released && players[a.slot - 1].retryBlocked && !hp._preludeCredit && hp._playing && hp._segIndex < hp._driverSegs.length) {
        remaining[a.slot]++;
        attempts.push({ ms: clock.ms + RETRY_MS, slot: a.slot });
        attempts.sort((x, y) => x.ms - y.ms);
      }
      // 按鍵排完了、曲子還沒按完（有的按鍵被去抖擋掉就少了一下）：「應該按完整首」的演奏者會繼續按，每 RETRY_MS 一下，直到曲子
      // 結束——就像你發現沒聲音或曲子還沒完，會再按。只有排好一串按鍵、不再重複的（中途停手那種）不會。
      if (players[a.slot - 1].keepGoing && remaining[a.slot] === 0 && hp._playing && hp._assignedSlots.has(a.slot) && hp._segIndex < hp._driverSegs.length) {
        remaining[a.slot]++;
        attempts.push({ ms: clock.ms + RETRY_MS, slot: a.slot });  // 排在最後（這個時刻比佇列裡所有的都晚，因為這位演奏者已經沒有後續按鍵）
        attempts.sort((x, y) => x.ms - y.ms);
      }
    }
    clock.ms = tickNow;
    hp.tick(tickNow);
    // waitEndMs：這位演奏者沒有排著的按鍵、自己的音都收完了，就排下一下（前奏預按還沒放行時不重按，等入場音響完）
    players.forEach((p, i) => {
      const slot = i + 1;
      if (p.waitEndMs == null || remaining[slot] > 0 || hp._preludeCredit || !hp._playing || hp._segIndex >= hp._driverSegs.length) return;
      if ([...hp._staves.values()].some((v) => v.slot === slot && v.sounding.size)) return;
      remaining[slot]++;
      attempts.push({ ms: tickNow + p.waitEndMs, slot });
      attempts.sort((x, y) => x.ms - y.ms);
    });
    if (hp.isFinished() && !attempts.length) break;
  }
  return { hp, records: rec.records, stats: rec.stats, clock, players, pressLog };
}

/* ═══════════════════════════════════════════
   按鍵時間表
   ═══════════════════════════════════════════ */

// 非打擊聲部（part 底下至少有一個旋律 staff），依音符數由多到少。
export function rankedParts(score) {
  const count = new Map();
  for (const n of score.notes) count.set(n.partId, (count.get(n.partId) || 0) + 1);
  return score.parts.filter((p) => !p.staves.every((v) => v.percussionKit) && count.get(p.id)).sort((a, b) => count.get(b.id) - count.get(a.id));
}

// 這些聲部（part id，或單聲部多行譜時的 staff id）的起音（每個不同的 startTick 一次＝一個 driver segment）的樂譜秒數，由早到晚：按鍵時間表照這張排。
export function driverSecs(score, partIds) {
  const ticks = new Set();
  for (const n of score.notes) if (partIds.includes(n.partId) || partIds.includes(n.staffId)) ticks.add(n.startTick);
  return [...ticks].sort((a, b) => a - b).map((t) => score.midiTicksToSeconds(t));
}

// 按鍵負擔（要按幾下、平均每秒、最忙 1 秒）：照原速彈需要的頻率，見 pressTiming.js 的 pressLoad()。
export function driverPressLoad(score, partIds) {
  return pressLoad(driverSecs(score, partIds));
}

/**
 * 逐個 driver 起音按鍵的時間表：第一個起音落在樂譜時間（leadMs 可以提早或延後），之後每個起音的按鍵落在「前一個按鍵
 * ＋樂譜間隔 × factor × (1 ± jitter)」。factor＝按鍵間隔是樂譜間隔的幾倍（<1 快、>1 慢）。
 * skipFrom／skipCount：從第 skipFrom 個起音起連續 skipCount 個不按（停手後回來，之後照原本的時間表繼續）；
 * pause[index, ms]：按完第 index 個之後停 ms 毫秒（Infinity＝從此不按）；fromIndex：從這個起音才開始按（晚進場）；
 * reading：看譜起伏的強度（0＝沒有；0.25＝中等；每個間隔乘 exp(常態 × reading)）；
 * offsetMs：整張時間表平移；burst＝true：每 24ms 連按一下、每個起音按 BURST_REPEAT 下（比樂譜快很多，會被去抖擋掉，直到按上）。
 */
export function onsetPresses(secs, { factor = 1, jitter = 0, rnd = Math.random, leadMs = 0, offsetMs = 0, skipFrom = -1, skipCount = 0,
  pause = null, fromIndex = 0, burst = false, reading = 0 } = {}) {
  if (burst) return Array.from({ length: secs.length * BURST_REPEAT }, (_, k) => ORIGIN_MS + offsetMs + k * 24);
  const presses = [];
  let t = ORIGIN_MS + Math.max(0, secs[0] * 1000 + leadMs) + offsetMs;
  for (let k = 0; k < secs.length; k++) {
    if (k >= fromIndex && !(k >= skipFrom && k < skipFrom + skipCount)) presses.push(t);
    // reading：看譜起伏——每個間隔再乘一個對數常態的隨機倍率（三個均勻亂數相加近似常態，強度 ≈ reading），真人看譜時快時慢
    if (k + 1 < secs.length) t += (secs[k + 1] - secs[k]) * 1000 * factor * (1 + jitter * (rnd() * 2 - 1)) * (reading ? Math.exp((rnd() + rnd() + rnd() - 1.5) * 2 * reading) : 1);
    if (pause && k === pause[0]) { if (!Number.isFinite(pause[1])) break; t += pause[1]; }
  }
  return presses;
}

/* ═══════════════════════════════════════════
   量測
   ═══════════════════════════════════════════ */

/**
 * 不變量（任何按鍵速度、任何人數都該成立）：
 *   releasedMissing＝0：該放行的音都發聲了（你的音：它所屬的 segment 已放行；電腦的音：它那一段已被按鍵啟動）；
 *   unpaired／strayOff／badVelocity＝0：每個 noteOn 一個 noteOff、不送 velocity 0（hold 著、等你按下一個起音的音不算沒收，見 held）；
 *   offTrigger＝0：你的每顆音都在某一次成功按鍵的那一刻發聲（0ms）；例外是前奏鎖：前奏中預按的第一個起音，在前奏播完那一刻放行；
 *   syncMax＝0：同一個 tick 的音（你的與電腦的）同刻發聲，沒有任何放寬——你早按時也一樣（早按的處理是追音或跳過，不讓這一段晚起算）；
 *   reversed＝0：電腦音依樂譜順序發聲，不倒序（倒序＝電腦聲部往前跳；模擬沒有 lookahead，所以早按也沒有殘留的倒序）。
 *   skipped／chased 只是資訊：你早按時整顆在你身後而跳過的電腦音、與 T_k 還該響著而追音的顆數（見 scheduler.js 的 _chaseOrSkip）。
 * notReleased：曲末還沒被放行／啟動的音（按得不夠多、中途停手）——不是違規，由情境決定要不要求完整放行。
 * held：曲末還 hold 著、等你按到它結尾對齊的起音才會收的音（你中途停手時才會有；按完整首之後一定是 0）。
 */
export function measure(sim) {
  const { hp, records, stats, pressLog } = sim;
  const sounded = new Set(records.map((r) => r.note));
  const segOf = new Map();                                       // 你的音 → 它屬於第幾個 driver segment
  hp._driverSegs.forEach((seg, i) => seg.items.forEach((it) => segOf.set(it.note, i)));
  let notReleased = 0, releasedMissing = 0, total = 0;
  for (const v of hp._staves.values()) {
    for (const n of v.notes) {
      total++;
      if (sounded.has(n) || hp._skipped.has(n)) continue;       // 早按跳過的音沒有發聲，但算處理過
      const released = v.kind === 'human' ? segOf.get(n) < hp._segIndex : hp._sliceOfTick(n.startTick) <= hp._anchoredSlice;
      if (released) releasedMissing++; else notReleased++;
    }
  }
  const byStart = new Map();                                     // 同一個 startTick 的音，實際發聲的時間差
  for (const r of records) {
    if (!byStart.has(r.note.startTick)) byStart.set(r.note.startTick, []);
    byStart.get(r.note.startTick).push(r.onMs);
  }
  // 同刻：同一個 startTick 的音一律嚴格 0ms（早按的追音也是一整組在按下的那一刻發聲，沒有任何容許量）
  let syncMax = 0;
  for (const list of byStart.values()) {
    if (list.length < 2) continue;
    syncMax = Math.max(syncMax, Math.max(...list) - Math.min(...list));
  }
  // 電腦音不倒序：電腦音依 startTick 排，發聲時刻不能比前面（startTick 較小）的任何一顆更早——倒序就是電腦聲部往前跳
  const assistRecs = records.filter((r) => r.label === 'assist').sort((a, b) => a.note.startTick - b.note.startTick);
  let reversed = 0, maxOn = -Infinity;
  for (let i = 0; i < assistRecs.length; ) {
    let k = i;                                                   // 同 startTick 的一組（彼此不比）
    while (k < assistRecs.length && assistRecs[k].note.startTick === assistRecs[i].note.startTick) k++;
    for (let m = i; m < k; m++) if (assistRecs[m].onMs < maxOn) reversed++;
    for (let m = i; m < k; m++) maxOn = Math.max(maxOn, assistRecs[m].onMs);
    i = k;
  }
  const pressedMs = new Set(pressLog.filter((p) => p.released).map((p) => p.ms));
  // 唯一的例外：前奏鎖期間被擋下的預按（released＝false），播放頭到入場點時由 tick() 自動放行第一個起音（第 0 個 driver segment）
  const prePressRelease = (r) => segOf.get(r.note) === 0 && pressLog.some((p) => !p.released && p.ms <= r.onMs);
  const offTrigger = pressLog.length ? records.filter((r) => r.label === 'human' && !pressedMs.has(r.onMs) && !prePressRelease(r)).length : 0;
  let held = 0;
  for (const v of hp._staves.values()) for (const queue of v.sounding.values()) for (const e of queue) if (e.holdIdx !== null && e.holdIdx !== undefined) held++;
  return {
    total, sounded: records.length, releasedMissing, notReleased, held,
    unpaired: records.filter((r) => r.offMs == null).length - held, strayOff: stats.strayOff, badVelocity: stats.badVelocity,
    syncMax: Math.round(syncMax), reversed, skipped: hp._skipped.size, chased: hp.chaseStats().chased, offTrigger,
    pressCount: pressLog.length, released: pressLog.filter((p) => p.released).length, blocked: pressLog.filter((p) => !p.released).length,
    finished: hp.isFinished(),
  };
}

// 整首自動播放（沒有人被指派）對檔案編碼的忠實度：每顆音都發聲、每個 noteOn 一個 noteOff、起訖時間誤差。
export function autoPlayStats(score) {
  const sim = simulate(score, []);
  const { hp, records, stats } = sim;
  let onErr = 0, offErr = 0;
  for (const r of records) {
    onErr = Math.max(onErr, Math.abs(r.onMs - r.note.startSeconds * 1000));
    if (r.offMs != null) offErr = Math.max(offErr, Math.abs(r.offMs - r.note.endSeconds * 1000));
  }
  const total = [...hp._staves.values()].reduce((a, v) => a + v.notes.length, 0);
  return {
    finished: hp.isFinished(), total, sounded: records.length, unpaired: records.filter((r) => r.offMs == null).length,
    strayOff: stats.strayOff, badVelocity: stats.badVelocity, onErr, offErr, unplaced: hp.unplacedStaffIds.length,
  };
}
