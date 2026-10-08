// ============================================================
//  scheduler.js — 排程器（純邏輯，無 DOM／CDN）
//
//  時間單位：整份總譜只有一條時間軸，單位是 MIDI tick（SMF 規格唯一的時間單位；秒只是用速度表換算出來的衍生值）。
//  電腦聲部的音符對應到「你的聲部」的 tick，不是第二條時鐘。
//
//  兩種聲部（模仿同事 SmartEnsemble 的「主控／伴奏」，但以這個專案的做法為主）：
//    · driver（kind: 'human'，走 humanSynth）＝被指派的聲部。每個起音要你按一次：parser 的 segment（同一個 startTick 的所有音）
//      裡屬於 driver 的音，一次按鍵（`trigger(slot, nowMs)`，鍵盤或日後的手勢）放行一個 segment，在這次呼叫內立刻 noteOn（0ms）。
//    · follower（kind: 'assist'，走 assistSynth）＝沒被指派的電腦輔助聲部。不用按：它的音依 tick 分屬 driver 起音之間的「段」，
//      按鍵啟動它負責的那一段。
//  沒有任何 driver（沒有指派，或指派的聲部都沒有音符）＝整首自動播放：只有第 0 段，從開頭照原速放完（同一條程式路徑）。
//
//  按鍵啟動它負責的那一段：第 k 次按鍵放行 driver 起音 T_k，同時記下錨點 { T_k, 按下的時刻, 速度 }，並把落在 [T_k, T_{k+1})
//  的 follower 音各自排好發聲時刻：`按下時刻 + (樂譜秒(startTick) − 樂譜秒(T_k)) ÷ playbackRate`（startTick == T_k 的在這次呼叫內
//  同刻發聲）。第 0 段（第一個 driver 起音之前的前奏）在 play() 後用 1× 起算，所以前奏照原速播、停在你的入場點。前奏還沒播完
//  時按鍵不放行（前奏鎖：不然第 1 段重新對時，前奏剩下的音就被跳過），只記預按，播到入場點由 tick() 自動放行第一個起音。
//    · 你按得比預估早：上一段沒放完的 follower 音照自己排好的時刻繼續放完（長度照 MIDI 音符長度，不依速度換算），不跳、不一次
//      放出（不擠）、不丟；它們最多比該有的時間晚「你早按的量」，下一次按鍵重新對時就歸零（不累積）。唯一的修剪是尾巴收尾
//      （見「收音」）：同譜表的新音發聲時，舊音不會比檔案裡的重疊響得更久。
//    · 你按得比預估晚：這一段放完就靜止等你，不會越過你的下一個起音；已經開始的音照 MIDI 音長收完。
//  playbackRate（命名同官方 Sequencer：樂譜秒 ÷ 真實秒）＝最近 8 個按鍵的頭尾比值（pressTiming.js，模擬評估選出來的）。
//  去抖（pressTiming.js）：兩次按鍵太近就忽略第二次（擋手抖、手勢重複觸發）。
//
//  收音：音長就是 MIDI 的音符長度，不依速度換算（電腦音的「起音」才跟著你的速度）。driver 的音到期或下一次按鍵時 endTick ≤ 新錨點的
//  先收掉（先收再放），follower 的音從它發聲的時刻起算原始時值。
//  hold（loop 等你按下一個起音）：音的結尾對齊某個還沒放行的 driver 起音（你的與電腦的一樣，見 _holdIndexOf），原長走完也不收，
//  放行那個起音時才收（max(原長的結尾, 按下的時刻)，見 _releaseHeld）——只延後、不提前，所以你按得比預估早時不會切斷電腦音。
//  是否 hold 看每顆音自己的結尾，不看它屬於哪個 segment：同 tick 你的音短、電腦音長時，短音照原長收、長音等它對齊的起音。
//  尾巴收尾：同一個譜表的新音發聲時，還在響的舊音（起音 tick 比新音早）的收音時刻上限＝新音發聲時刻 ＋ 檔案裡這兩顆音的重疊量
//  （結尾 tick − 新音起音 tick，最少 0，不換算）——舊音不會比檔案裡的重疊多響一截（糊在一起），也不丟音；hold 著的舊音在這裡被截成有限值。
//  同音高重疊的音依發聲順序先進先出收音（hold 著的不算），每個 noteOn 都送出一個 noteOff。
//
//  lookahead：tick(nowMs, audioNow) 有給 AudioContext 時間時，電腦輔助聲部 LOOKAHEAD_MS 以內要發聲／收音的事件提早帶時間戳（eventOptions.time）
//  送進合成器，由 worklet 依取樣時鐘準時放，不受主執行緒卡頓影響；你的聲部永遠立即發聲、不帶時間戳。worklet 沒有取消已排程事件的
//  辦法，所以暫停時「已送出、還沒響」的音要另外送帶時間戳的 noteOff（見 _offOpts）。
//
//  排程器自己的時鐘（`_clockMs`）只在 tick() 前進、暫停時不走，所以暫停的時間不會被當成按鍵間隔，恢復後排好的時刻照剩下的時間放。
//  velocity 一律用樂譜原值；不重播 CC／pitch-bend，每個 staff 的初始狀態（bank／program 與 CC7／10／91／93）只在 load() 時送一次，
//  而且一定在該 channel 的第一個 noteOn 之前。
//
//  聲部單位：parser 把一個 MuseScore 樂器切成 part，part 底下有一個以上的 staff（一個譜表 × 一個樂器 channel，例如鋼琴
//  兩行譜是兩個 staff）。指派以 part 為單位，part 的所有 staff 共用同一個槽位；發聲與輸出 channel 以 staff 為單位。
//  沒有 staves 的 part（手工組的舊資料形狀）自動視為單一 staff。
// ============================================================

import { estimatePlaybackRate, debounceWindowMs, summarizeMs } from './pressTiming.js';

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  drumChannel: 9, // MIDI 規格：第 10 個 channel（索引 9）是打擊
});

// channel 的單一來源（synth.js 也從這裡 import，不再各寫一份）。模仿官方 SpessaSynth Sequencer：一個 port 16 個 channel，
// 依需要的 port 數往上補、只增不減（官方 assignMIDIPort／addNewMIDIPort），每個 port 的 channel 9 是打擊。DEFAULT_PORTS 是
// 合成器開機就補到的 port 數；歌曲需要更多時由 synth.js 的 load() 依 portsNeeded() 補，再用 setPortCount() 告訴排程器。
// 不能讀 synth.midiChannels.length 當 channel 數（lib 的 addNewChannel() 會雙重 push，見 synth.js），所以數字只由這裡與
// synth.js 自己計數。
export const CHANNELS_PER_PORT = 16;
export const DEFAULT_PORTS = 4;

/* ═══════════════════════════════════════════
   應用層常數——不是規格
   ═══════════════════════════════════════════ */
// 「播放頭停在你的下一個起音多久」算停手的門檻：這次間隔不拿來估速。800ms 吸收你按鍵的停頓；你完全停手時電腦聲部放完這一段
// 就靜止，已經開始的音照音長收完（閒置不切音）。
const IDLE_MS = 800;
// 速度還沒學到（歷史裡的間隔不到 IDLE_LEARNED_INTERVALS 個）時，「實際間隔 − 預測間隔」變大可能只是預測太快（你很慢），
// 不是你停手：停格要超過預測間隔的 IDLE_UNLEARNED_FACTOR 倍才算停手，不然慢速演奏者的歷史每一下都被清掉、永遠學不到速度。
const IDLE_LEARNED_INTERVALS = 3;
const IDLE_UNLEARNED_FACTOR = 3;
// 每個 tick 的時間步長上限：分頁被瀏覽器節流（背景分頁的計時器可能隔好幾秒才醒來）後恢復時，時鐘最多只前進這麼多，
// 不會一次把空窗期的音全部放出來或收掉。
const MAX_TICK_DT_MS = 100;
// 排程時刻是一路加法算出來的浮點數，跟時鐘比大小時不能要求逐位元相等。
const EPS_MS = 1e-6;
// lookahead：tick() 把「這麼久以內就要發聲／收音」的電腦音提早帶時間戳（eventOptions.time，AudioContext 時間）送進合成器，
// 由 worklet 依取樣時鐘準時放，主執行緒被影像算繪卡住幾十毫秒也不會晚。取捨：送出去的事件 worklet 沒有取消的辦法
// （spessasynth_core 的 eventQueue 只有 push／shift），所以這段時間內的音「一定會響」。50ms 是蓋過實機量到的主執行緒
// 停頓（攝影機開著，最大約 40ms）的最小值；只用在電腦輔助聲部，你的音永遠立即發聲、不帶時間戳。
const LOOKAHEAD_MS = 50;
// 量測用：電腦音遲到量最多留幾筆（超過就丟最舊的），避免長時間播放無限成長。
const LATE_SAMPLES_MAX = 5000;
// 按鍵記錄最多留幾筆（超過就丟最舊的），避免長時間播放無限成長。
const PRESS_LOG_MAX = 20000;
// hold（loop 等你按下一個起音）的對齊容差：音的結尾比某個 driver 起音早不超過這麼多 tick，就算「結尾接著這個起音」。
// MuseScore 匯出相連音時記譜長度少 1 tick，所以至少要容許 1；再多一點吸收取整誤差。不是規格，是匯出器的慣例。
const HOLD_GAP_TICKS = 2;
// GM 預設的混音值（CC121 不會重設音量、聲像、Program，見 GML-v1 §3.2.5.2；channel 又是跨曲重複使用，所以沒有 init 的 staff
// 也要明確送一次，避免沿用到別的曲子在同一個 channel 上留下的設定）。
const GM_DEFAULT_VOLUME = 100, GM_DEFAULT_PAN = 64, GM_DEFAULT_REVERB = 0, GM_DEFAULT_CHORUS = 0;

/* ═══════════════════════════════════════════
   輸出 channel 分配
   ═══════════════════════════════════════════ */

// 這個合成器上可用的旋律輸出 channel＝跳過每個 port 的打擊槽（ch % 16 === drumChannel）。
function melodicChannelsFor(synth, drumChannel, ports) {
  const total = synth ? ports * CHANNELS_PER_PORT : CHANNELS_PER_PORT;
  const out = [];
  for (let ch = 0; ch < total; ch++) {
    if (ch % CHANNELS_PER_PORT !== drumChannel) out.push(ch);
  }
  return out;
}

// 這個合成器上的打擊輸出 channel＝每個 port 的打擊槽（9／25／41／57）：合成器只有一個 port 時只有 drumChannel 一個。
function drumChannelsFor(synth, drumChannel, ports) {
  const n = synth ? ports : 1;
  return Array.from({ length: n }, (_, p) => p * CHANNELS_PER_PORT + drumChannel);
}

// 幫一組 staff 各自分配一個輸出 channel，避免兩個原本共用同一個原始 channel 的 staff 打架。旋律 staff 依序拿
// melodicChannels 裡的號碼；打擊 staff 依「不同鼓組 program」各佔一個打擊槽（同一個鼓組共用），鼓組種類超過打擊槽數
// 就排不進去；排不進去的 staff 回報給呼叫端，不出聲。
function allocateChannels(staves, melodicChannels, drumChannels) {
  const byStaffId = new Map();
  const unplaced = [];
  const kitChannel = new Map(); // 鼓組 program → 輸出 channel
  let next = 0;
  for (const s of staves) {
    // percussionKit 已經是 GM2 Bank Select（CC0/32）判定過的結果：channel 9 若明確用
    // Bank 79H(121) 切成旋律通道，這裡就不會被誤送進打擊 channel（見 midiParser.js 的
    // collectParts() 說明）。
    if (s.percussionKit) {
      if (!kitChannel.has(s.program) && kitChannel.size < drumChannels.length) kitChannel.set(s.program, drumChannels[kitChannel.size]);
      if (kitChannel.has(s.program)) byStaffId.set(s.id, kitChannel.get(s.program));
      else unplaced.push(s.id);
      continue;
    }
    if (next < melodicChannels.length) byStaffId.set(s.id, melodicChannels[next++]);
    else unplaced.push(s.id);
  }
  return { byStaffId, unplaced };
}

/* ═══════════════════════════════════════════
   譜表（staff）建構
   ═══════════════════════════════════════════ */

// 一個 part 底下的 staff 規格：新資料形狀直接用 part.staves；沒有 staves 的 part（手工組的舊資料形狀）視為單一 staff，
// id 沿用 part.id。
function staffSpecsOf(part) {
  if (part.staves) return part.staves.map((s) => ({ ...s, partId: part.id }));
  return [{ id: part.id, partId: part.id, program: part.program ?? 0, bank: part.bank ?? { msb: 0, lsb: 0 }, percussionKit: !!part.percussionKit, init: null }];
}

// 音符屬於哪個 staff：新資料形狀有 staffId；舊資料形狀的音符沒有，用 partId（跟 staffSpecsOf 的單一 staff id 一致）。
const staffKeyOf = (note) => note.staffId ?? note.partId;

function makeStaff(spec, slot, notes, kind, channel) {
  return {
    id: spec.id, partId: spec.partId, slot, kind, channel, notes,
    program: spec.program ?? 0, bank: spec.bank, init: spec.init ?? null, percussionKit: !!spec.percussionKit,
    baseVolume: spec.init?.volume ?? GM_DEFAULT_VOLUME, // 檔案 tick 0 的 CC7，沒有就是 GM 預設 100；載入時送一次
    sounding: new Map(),    // 音高 → [{ endTick, offMs }]：正在響的音；同音高重疊時依發聲順序排隊，先進先出收音
  };
}

// 這首歌至少需要幾個 port 的 channel（不低於 DEFAULT_PORTS）：旋律 staff 每個 port 有 15 個、打擊 staff 每種鼓組 program 佔一個
// port 的打擊槽，指派與未指派兩個池子（兩個合成器）各自算，取較大的。assignments 同 load()：Map 或 [partId, 槽位][]。
export function portsNeeded(score, assignments) {
  const assignMap = assignments instanceof Map ? assignments : new Map(assignments || []);
  const pools = [{ melodic: 0, kits: new Set() }, { melodic: 0, kits: new Set() }]; // [指派, 未指派]
  for (const part of score?.parts || []) {
    const pool = pools[assignMap.has(part.id) ? 0 : 1];
    for (const spec of staffSpecsOf(part)) {
      if (spec.percussionKit) pool.kits.add(spec.program); else pool.melodic++;
    }
  }
  const melodicPerPort = CHANNELS_PER_PORT - 1; // 每個 port 扣掉打擊槽
  return Math.max(DEFAULT_PORTS, ...pools.map((p) => Math.max(Math.ceil(p.melodic / melodicPerPort), p.kits.size)));
}

// 指派聲部只配 humanSynth 的 channel、未指派聲部只配 assistSynth 的 channel——兩個池子各自獨立，配額用完的 staff 回報在
// unplaced，這一輪不會出聲。
function buildStaves(score, assignments, assistSynth, humanSynth, cfg, ports) {
  const staves = new Map(); // staffId → staff
  const unplaced = [];

  const notesByStaff = new Map(); // score.notes 已依 startTick 排序，照順序分組即可
  for (const n of score.notes) {
    const key = staffKeyOf(n);
    let list = notesByStaff.get(key);
    if (!list) notesByStaff.set(key, (list = []));
    list.push(n);
  }

  const assignedSpecs = [], assistSpecs = [];
  for (const part of score.parts) {
    for (const spec of staffSpecsOf(part)) (assignments.has(part.id) ? assignedSpecs : assistSpecs).push(spec);
  }

  const { byStaffId: humanCh, unplaced: u1 } =
    allocateChannels(assignedSpecs, melodicChannelsFor(humanSynth, cfg.drumChannel, ports), drumChannelsFor(humanSynth, cfg.drumChannel, ports));
  const { byStaffId: assistCh, unplaced: u2 } =
    allocateChannels(assistSpecs, melodicChannelsFor(assistSynth, cfg.drumChannel, ports), drumChannelsFor(assistSynth, cfg.drumChannel, ports));
  unplaced.push(...u1, ...u2);

  for (const spec of assignedSpecs) {
    const channel = humanCh.get(spec.id);
    if (channel === undefined) continue;
    staves.set(spec.id, makeStaff(spec, assignments.get(spec.partId), notesByStaff.get(spec.id) || [], 'human', channel));
  }
  for (const spec of assistSpecs) {
    const channel = assistCh.get(spec.id);
    if (channel === undefined) continue;
    staves.set(spec.id, makeStaff(spec, null, notesByStaff.get(spec.id) || [], 'assist', channel));
  }
  return { staves, unplaced };
}

/* ═══════════════════════════════════════════
   Scheduler
   ═══════════════════════════════════════════ */
export class Scheduler {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.assistSynth = null;   // 電腦輔助聲部（follower）的合成器
    this.humanSynth = null;    // 被指派聲部（driver）的合成器
    this.ports = DEFAULT_PORTS; // 合成器目前有幾個 port（每個 16 個 channel）；synth.js 補 channel 之後用 setPortCount() 更新
    this.playbackRate = 1;     // 你現在的速度（樂譜秒 ÷ 真實秒），命名同官方 Sequencer；依最近 8 個按鍵估（pressTiming.js）
    this.unplacedStaffIds = []; // 輸出 channel 排不進去（旋律 staff 超過 60 個、鼓組超過 4 種）的 staff，這一輪不出聲
    this._score = null;
    this._staves = new Map();  // staffId → staff
    // 載入後不變的計畫
    this._driverSegs = [];     // [{ ticks, items: [{ staff, note }] }]：driver 的 segment，一次按鍵放行一個
    this._driverTicks = [];    // 每個 driver segment 的 tick（二分搜尋「某個 tick 屬於第幾段」用）
    this._followers = [];      // [{ staff, note }]：所有 follower 音，依 startTick 排序
    this._sliceFirst = [];     // _sliceFirst[s]＝第 s 段的第一個 follower 在 _followers 裡的位置（長度 = 段數 + 1）
    this._assignedSlots = new Set(); // 有資格觸發的演奏者槽位（指派了有音符的聲部）；空＝整首自動播放
    this._hasPrelude = false;  // 第一個 driver 起音之前有 follower 的音（別的聲部先進）：前奏鎖要不要生效
    this._totalNotes = 0;      // 所有排得進 channel 的音（isFinished 要全部發過聲才算）
    // 播放狀態（_resetPlayback() 要全部重設）
    this._playing = false;
    this._segIndex = 0;        // 下一個要放行的 driver segment
    this._clockMs = 0;         // 排程器時鐘（只在 tick／trigger 前進，暫停不走）
    this._lastTickMs = null;   // null＝下一次 tick() 的 dt 是 0
    this._anchor = null;       // 目前這一段的錨點 { slice, clockMs, scoreSec, rate }
    this._anchoredSlice = -1;  // 已經被啟動的最大段（第 0 段＝前奏，第 k+1 段由第 k 次按鍵啟動）
    this._pending = [];        // 排好時刻、還沒發聲的 follower 音：[{ dueMs, offMs, staff, note }]，依 dueMs 排序
    this._preludeCredit = false; // 前奏鎖期間有人預按過（布林）：播放頭到入場點時自動放行第一個起音
    this._lateMs = [];         // 量測：tick() 放出的電腦音，比排好的時刻晚了幾毫秒（見 lateStats()）
    this._pressLog = [];       // 量測：每次按鍵嘗試 { slot, clockMs, released }（含被去抖擋掉、前奏預按），給 pressLog() 匯出、離線重放用
    this._audioBase = null;    // 只在 tick() 執行期間有值：{ audio: AudioContext 時間（秒）, clock: 這一刻的排程器時鐘 }，lookahead 換算時間戳用
    this._sounded = new Set(); // 已經發過聲的音（每顆音恰好一次）
    this._history = [];        // 有效按鍵 [{ scoreSec, ms }]，估速用
    this._lastAcceptClock = null;     // 上一次有效按鍵的時鐘（去抖用）
    this._lastAttemptClock = null;    // 上一次按鍵嘗試（含被忽略的）的時鐘
    this._lastAttemptIntervalMs = Infinity; // 前兩次按鍵嘗試之間的間隔（去抖窗口用）
  }

  setSynths(assistSynth, humanSynth) {
    this.assistSynth = assistSynth;
    this.humanSynth = humanSynth;
  }

  setPortCount(ports) {
    this.ports = ports;
  }

  _synthOf(staff) {
    return staff.kind === 'human' ? this.humanSynth : this.assistSynth;
  }

  _secOf(tick) {
    return this._score.midiTicksToSeconds(tick);
  }

  // 某個 tick 屬於第幾段：落在第 k 個 driver 起音（含）到第 k+1 個之前＝第 k+1 段；第一個 driver 起音之前＝第 0 段（前奏）。
  // 二分搜尋「≤ tick 的 driver 起音有幾個」（upper bound）。
  _sliceOfTick(tick) {
    const a = this._driverTicks;
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= tick) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /**
   * 載入這首歌：建立 staff、套初始音色，把全曲的音分成 driver segment 與 follower。
   * @param {import('./midiParser.js').ParsedMidi} score  parseMidi() 的結果（不會被修改）
   * @param {Map<string,number>|[string,number][]} assignments  partId → 演奏者槽位
   */
  load(score, assignments) {
    this.stop();
    this._score = score || null;
    this._staves = new Map();
    this._driverSegs = []; this._driverTicks = []; this._followers = []; this._sliceFirst = [];
    this._assignedSlots = new Set();
    this._hasPrelude = false;
    this._totalNotes = 0;
    this.unplacedStaffIds = [];
    if (score) this._createStaves(score, assignments);
    // 沒有樂譜時 staves 與計畫都是空的：tick() 空轉。
  }

  // 建立 staff、套初始音色、標記每顆音的相連後繼音、建立 driver segment 與 follower 清單。
  _createStaves(score, assignments) {
    const assignMap = assignments instanceof Map ? assignments : new Map(assignments || []);

    const { staves, unplaced } = buildStaves(score, assignMap, this.assistSynth, this.humanSynth, this.cfg, this.ports);
    this._staves = staves;
    this.unplacedStaffIds = unplaced;

    for (const staff of this._staves.values()) this._applyInitialPatch(this._synthOf(staff), staff);

    this._buildPlan();
  }

  // driver segment：沿用 parser 的 segment（同一個 startTick 的所有音），只留 driver staff 的音；整個 segment 沒有 driver 的音
  // 或都排不進 channel 就不收（一次按鍵不該只推進一個不會響的 segment）。follower：所有 follower staff 的音依 startTick 排序
  // （score.notes 本來就排好了），並記下每一段的第一個在哪。
  _buildPlan() {
    for (const staff of this._staves.values()) this._totalNotes += staff.notes.length;
    for (const seg of this._score.segments) {
      const items = [];
      for (const note of seg.notes) {
        const staff = this._staves.get(staffKeyOf(note));
        if (staff && staff.kind === 'human') items.push({ staff, note });
      }
      if (items.length) { this._driverSegs.push({ ticks: seg.ticks, items }); this._driverTicks.push(seg.ticks); }
    }
    // 指派了有音符的 staff 的槽位才有資格觸發；指派了但完全沒有音符（或都排不進 channel）的槽位不算，全都不算就是自動播放。
    for (const staff of this._staves.values()) {
      if (staff.kind === 'human' && staff.notes.length) this._assignedSlots.add(staff.slot);
    }
    for (const note of this._score.notes) {
      const staff = this._staves.get(staffKeyOf(note));
      if (staff && staff.kind === 'assist') this._followers.push({ staff, note });
    }
    // _sliceFirst[s]：第一個屬於第 s 段（含）以後的 follower 位置，第 s 段的 follower ＝ [_sliceFirst[s], _sliceFirst[s+1])。
    // followers 依 startTick 排序，段編號因此遞增：掃一遍，每遇到一個 follower，把還沒設定、編號 ≤ 它的段都設成這個位置。
    const slices = this._driverSegs.length + 1;
    this._sliceFirst = new Array(slices + 1).fill(this._followers.length);
    let s = 0;
    for (let i = 0; i < this._followers.length; i++) {
      const slice = this._sliceOfTick(this._followers[i].note.startTick);
      while (s <= slice) this._sliceFirst[s++] = i;
    }
    // 第 0 段（第一個 driver 起音之前）有 follower 的音就是前奏。純 tick 比較，沒有誤差；沒有 driver 時（整首自動播放）不鎖。
    this._hasPrelude = this._driverSegs.length > 0 && this._sliceFirst[1] > this._sliceFirst[0];
  }

  // staff 的初始狀態：bank／program，再加上混音 CC7／10／91／93（來源 staff.init＝檔案 tick 0 的值；沒有就明確送 GM 預設，
  // 見 GM_DEFAULT_*）。load() 時送一次，比該 channel 的任何 noteOn 都早。
  _applyInitialPatch(synth, staff) {
    if (!synth) return;
    const { channel, bank, init } = staff;
    try {
      synth.controllerChange(channel, 0, bank?.msb || 0);
      synth.controllerChange(channel, 32, bank?.lsb || 0);
      synth.programChange(channel, staff.program || 0);
      synth.controllerChange(channel, 7, staff.baseVolume);
      synth.controllerChange(channel, 10, init?.pan ?? GM_DEFAULT_PAN);
      synth.controllerChange(channel, 91, init?.reverb ?? GM_DEFAULT_REVERB);
      synth.controllerChange(channel, 93, init?.chorus ?? GM_DEFAULT_CHORUS);
    } catch (err) { /* 初始音色設定失敗不致命 */ }
  }

  play() {
    this._playing = true;
    // 第一個 tick 的 dt 是 0；暫停的時間不會算進時鐘（時鐘只在 tick() 前進），所以不用重設任何排好的時刻。
    this._lastTickMs = null;
  }

  // 暫停：收掉還在響的音，時鐘、錨點與排好的 follower 音都保留（下次播放從原處繼續）。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    this._preludeCredit = false; // 預按作廢：續播後要重新按
    this.silence();
  }

  silence() {
    this._noteOffAll();
    for (const staff of this._staves.values()) {
      try { this._synthOf(staff)?.controllerChange(staff.channel, 123, 0); } catch (err) {} // CC123 All Notes Off 當保險
    }
  }

  // 把所有還在響的音收掉：每個 noteOn 各送一個 noteOff。
  _noteOffAll() {
    for (const staff of this._staves.values()) {
      const synth = this._synthOf(staff);
      for (const [pitch, queue] of staff.sounding) {
        for (const entry of queue) {
          try { synth?.noteOff(staff.channel, pitch, this._offOpts(staff, entry)); } catch (err) {}
        }
      }
      staff.sounding.clear();
    }
  }

  // 停止／換歌前的清場：收音＋整個播放狀態退回剛載入的樣子。
  stop() {
    this.pause();
    this._resetPlayback();
  }

  // 從頭重播：收音、退回剛載入的樣子，再接著播放（跟 stop() 共用 _resetPlayback()，只差最後一步）。
  restart() {
    this.pause();
    this._resetPlayback();
    this.play();
  }

  // 把播放狀態整個退回「剛 load() 完」的樣子：stop() 與 restart() 共用這一個函式。之後任何新增的
  // 狀態欄位都要在這裡重設（test/unit/scheduler.test.mjs 有一個整體快照比對，忘了重設會
  // 直接失敗）。呼叫端負責先收音（pause()）與決定要不要接著播放。
  _resetPlayback() {
    this._segIndex = 0;
    this._clockMs = 0;
    this._lastTickMs = null;
    this._anchor = null;
    this._anchoredSlice = -1;
    this._pending = [];
    this._preludeCredit = false;
    this._lateMs = [];
    this._pressLog = [];
    this._sounded.clear();
    this._history = [];
    this._lastAcceptClock = null;
    this._lastAttemptClock = null;
    this._lastAttemptIntervalMs = Infinity;
    this.playbackRate = 1;
  }

  isPlaying() { return this._playing; }

  // 播完：所有音（你的與電腦的）都發過聲而且沒有還在響的音。有指派聲部但還沒按到，driver 的音沒發過，不算播完。
  isFinished() {
    if (!this._score) return false;
    if (this._sounded.size < this._totalNotes) return false;
    for (const staff of this._staves.values()) {
      if (staff.sounding.size > 0) return false;
    }
    return true;
  }

  /**
   * 播放頭目前在第幾個 tick（跟 note 的 startTick／endTick 同一個座標系）：從這一段的錨點起，依速度往前走，最多走到你的
   * 下一個起音（停格等你）。唯讀、無副作用。
   * @returns {number} tick（可為小數），夾在 [0, score.durationTicks]；沒有樂譜、沒有 staff、還沒開始播時 0
   */
  getPositionTicks() {
    const a = this._anchor;
    if (!this._score || this._staves.size === 0 || !a) return 0;
    let sec = a.scoreSec + ((this._clockMs - a.clockMs) * a.rate) / 1000;
    const next = this._driverSegs[this._segIndex];
    if (next) sec = Math.min(sec, this._secOf(next.ticks));
    const ticks = this._score.secondsToMIDITicks(sec);
    const total = this._score.durationTicks;
    return total > 0 ? Math.min(ticks, total) : ticks;
  }

  // 排程器時鐘在 nowMs 這一刻的值：上一個 tick 的時鐘，加上之後經過的真實時間（跟 tick() 一樣有步長上限）。
  _clockAt(nowMs) {
    if (this._lastTickMs == null) return this._clockMs;
    return this._clockMs + Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));
  }

  // 播放頭停在你的下一個起音已經多久（毫秒）：這一段依錨點速度預計走完的時刻之後的時間；沒有下一個起音（最後一段、
  // 整首自動播放）就不會停格。
  _stallMsAt(clockMs) {
    const reach = this._reachClockMs();
    return reach === null ? 0 : Math.max(0, clockMs - reach);
  }

  // 播放頭依這一段的錨點速度走到你的下一個起音的時鐘時刻；沒有錨點或沒有下一個起音（最後一段、整首自動播放）回 null。
  _reachClockMs() {
    const a = this._anchor;
    const next = this._driverSegs[this._segIndex];
    if (!a || !next) return null;
    return a.clockMs + ((this._secOf(next.ticks) - a.scoreSec) * 1000) / a.rate;
  }

  // 第 0 段（前奏）在第一次需要時（第一個 tick 或第一次按鍵）用目前時鐘、1× 起算。
  _ensureAnchored() {
    if (this._anchoredSlice < 0) this._anchorSlice(0, this._clockMs, 0, 1);
  }

  // 啟動第 slice 段：記下錨點，把這一段的 follower 音各自排好發聲時刻（按下時刻 ＋ 樂譜秒差 ÷ 速度）與收音時刻（發聲時刻 ＋
  // 音符原始時值 ÷ 速度），併進排程佇列（依 dueMs 排序）。上一段還沒放完的 follower 音留在佇列裡，照自己的時刻放完。
  _anchorSlice(slice, clockMs, scoreSec, rate) {
    this._anchor = { slice, clockMs, scoreSec, rate };
    this._anchoredSlice = slice;
    const from = this._sliceFirst[slice], to = this._sliceFirst[slice + 1];
    const fresh = [];
    for (let i = from; i < to; i++) {
      const { staff, note } = this._followers[i];
      const startSec = this._secOf(note.startTick);
      const dueMs = clockMs + ((startSec - scoreSec) * 1000) / rate;
      fresh.push({ dueMs, offMs: dueMs + (this._secOf(note.endTick) - startSec) * 1000, staff, note });   // 起音跟著你的速度，音長是檔案寫的長度
    }
    // 兩個都已依 dueMs 排好的清單合併（穩定：同時刻舊的在前）
    const merged = [], old = this._pending;
    let a = 0, b = 0;
    while (a < old.length || b < fresh.length) {
      if (b >= fresh.length || (a < old.length && old[a].dueMs <= fresh[b].dueMs)) merged.push(old[a++]);
      else merged.push(fresh[b++]);
    }
    this._pending = merged;
  }

  /**
   * 觸發一次：放行 driver 的下一個 segment，裡面的音在這次呼叫內立刻 noteOn；同時啟動它負責的那一段 follower。
   * @param {number} slot   演奏者槽位（要有指派聲部才有資格）
   * @param {number} nowMs  performance.now()
   * @returns {boolean} 有沒有放行（沒在播放、槽位沒有指派聲部、整首自動播放中、segment 都放行完了、被去抖忽略都回 false）
   */
  trigger(slot, nowMs) {
    if (!this._playing || !this._assignedSlots.has(slot) || this._segIndex >= this._driverSegs.length) return false;
    this._ensureAnchored();
    const clock = this._clockAt(nowMs);
    const j = this._segIndex, seg = this._driverSegs[j];
    const scoreSec = this._secOf(seg.ticks);

    // 前奏鎖：別的聲部在你的第一個起音之前有音（例如卡農：大提琴先進、你控制後進的小提琴），前奏還沒播到你的入場點時，
    // 按鍵不放行——放行會讓第 1 段用「現在」重新對時，前奏剩下的音就被跳過。這一下只記成「預按」（布林，按幾下都一樣），
    // 播放頭走到入場點的那一刻由 tick() 自動放行第一個起音。不動估速、去抖與錨點。
    if (j === 0 && this._hasPrelude && clock < this._reachClockMs() - EPS_MS) {
      this._logPress(slot, clock, false);
      this._preludeCredit = true;
      return false;
    }

    // 去抖：窗口依「這一步預估的真實長度」與「你上一次的按鍵間隔」；不論這次被接受與否，都算一次按鍵嘗試（只算被接受的，
    // 一開始就比檔案快的人每隔一下的按鍵會一直被擋，速度學不起來）。第一次按鍵沒有前一個 segment 可比，不去抖。
    let blocked = false;
    if (this._lastAcceptClock != null) {
      const expectedMs = ((scoreSec - this._secOf(this._driverSegs[j - 1].ticks)) * 1000) / this.playbackRate;
      blocked = clock - this._lastAcceptClock < debounceWindowMs(expectedMs, this._lastAttemptIntervalMs);
    }
    if (this._lastAttemptClock != null) this._lastAttemptIntervalMs = clock - this._lastAttemptClock;
    this._lastAttemptClock = clock;
    this._logPress(slot, clock, !blocked);   // 被擋掉記 false，放行記 true（放行必定接著 _release()）
    if (blocked) return false;

    // 接受：把按下的時刻納入時鐘（tick 之間的那一小段）
    this._clockMs = clock;
    this._lastTickMs = nowMs;
    this._release(clock);
    return true;
  }

  // 這次按鍵是不是「停手之後」的第一下：播放頭停在你的下一個起音超過門檻。速度已經學到（≥ IDLE_LEARNED_INTERVALS 個間隔）
  // 時門檻是 IDLE_MS；還沒學到時預測不可靠，門檻放寬到預測間隔的 IDLE_UNLEARNED_FACTOR 倍（見常數的說明）。
  _isIdleBreak(clock) {
    if (this._stallMsAt(clock) <= IDLE_MS) return false;
    const learned = this._history.length - 1 >= IDLE_LEARNED_INTERVALS;
    const predictedMs = this._reachClockMs() - this._anchor.clockMs;   // 停格 > 0 表示有下一個起音，錨點一定在
    return learned || this._stallMsAt(clock) > IDLE_UNLEARNED_FACTOR * predictedMs;
  }

  // 放行 _segIndex 這個 driver segment（按鍵 trigger() 與前奏結束時的預按放行共用），時刻 clock（排程器時鐘）。
  _release(clock) {
    const j = this._segIndex, seg = this._driverSegs[j];
    const scoreSec = this._secOf(seg.ticks);
    if (this._isIdleBreak(clock)) this._history = [];      // 停手：這次間隔不拿來估速（速度維持原本的值）
    this._history.push({ scoreSec, ms: clock });
    this.playbackRate = estimatePlaybackRate(this._history, this.playbackRate);
    this._lastAcceptClock = clock;
    this._segIndex = j + 1;

    this._anchorSlice(j + 1, clock, scoreSec, this.playbackRate);   // 先更新錨點與已啟動的段
    this._closeByTick(seg.ticks);                                   // driver 的音 endTick ≤ 這個起音的，先收
    this._releaseHeld(j, clock);                                    // 結尾對齊這個起音（或更早的起音）而 hold 著的音：到原長的結尾與這一刻較晚的那個收
    this._closeDue();
    for (const { staff, note } of seg.items) this._sound(staff, note, clock + (this._secOf(note.endTick) - scoreSec) * 1000, clock);
    this._emitPending();                                            // 同 tick 的 follower 音（dueMs ＝ 這一刻）跟你的音同刻
    this._closeDue();                                               // 零長度的音
  }

  // 讓一顆音發聲：記進 _sounded（每顆音恰好一次），noteOn，記進正在響的佇列（同音高先進先出）。dueMs＝預定發聲的時鐘時刻
  // （你的音就是按下的那一刻），只有 tick() 裡的電腦音（lookahead）才會帶時間戳；onTime 記下那顆 noteOn 的 AudioContext 時間
  // （沒帶時間戳＝undefined）。
  _sound(staff, note, offMs, dueMs) {
    this._sounded.add(note);
    this._capOverlaps(staff, note, dueMs);
    let queue = staff.sounding.get(note.midiNote);
    if (!queue) staff.sounding.set(note.midiNote, (queue = []));
    const opts = this._stamp(staff, dueMs);
    // hold：結尾接著某個還沒放行的 driver 起音的音（你的與電腦的一樣），先不排收音（Infinity），等你按到那個起音才收（_releaseHeld），
    // origOffMs 是原長的結尾；被同譜表的新音截短過的不再 hold（見 _capOverlaps，capped）
    const holdIdx = this._holdIndexOf(note);
    queue.push({ endTick: note.endTick, offMs: holdIdx === null ? offMs : Infinity, origOffMs: offMs, holdIdx, note, onTime: opts?.time, capped: false }); // 先登記再 noteOn：合成器收到 noteOn 時，佇列最後一項就是這顆音
    try { this._synthOf(staff)?.noteOn(staff.channel, note.midiNote, note.velocity, opts); } catch (err) {}
  }

  // 尾巴收尾：同一個譜表的新音在 onsetMs 發聲時，還在響的舊音（起音 tick 比新音早）的收音時刻不能晚於
  // 「onsetMs ＋ 檔案裡這兩顆音的重疊量依目前速度換算」（檔案裡舊音結尾在新音起音之前＝重疊 0，就在新音發聲時收）。
  // 為什麼：舊音是依「上一次按鍵估到的速度」排好結尾的，你這次按得比預估早，舊音就會比檔案裡的重疊多響一截（糊在一起）；
  // 照檔案的 tick 位置收尾，重疊量就跟檔案一樣，也不會丟音、不會擠。只會把收音提早，不會延長（所以你按得晚時不撐）。
  // 同譜表內起音 tick 相同的音（和弦）不算「下一個音」，不互相截。
  _capOverlaps(staff, note, onsetMs) {
    const startSec = this._secOf(note.startTick);
    for (const queue of staff.sounding.values()) {
      for (const entry of queue) {
        if (entry.note.startTick >= note.startTick) continue;
        const capMs = onsetMs + Math.max(0, this._secOf(entry.endTick) - startSec) * 1000;
        // 只有「真的截短」才標成 capped、不再 hold（EPS：capMs 與 offMs 從同一個錨點算出來，相等時只差浮點誤差，不算截短）。
        // 單音旋律的譜表因此不會糊到你下一次按鍵；hold 著的音（offMs＝Infinity）遇到同譜表的新音也在這裡被截成有限值
        if (capMs < entry.offMs - EPS_MS) { entry.offMs = capMs; entry.capped = true; entry.holdIdx = null; }
        // 同音高：新音的收音在先進先出佇列裡排在舊音後面，舊音若還 hold 著，新音的收音會被拖住，所以也不再 hold
        else if (entry.note.midiNote === note.midiNote) { entry.capped = true; entry.holdIdx = null; }
      }
    }
    // 同音高的舊音若因此到期，要在新音 noteOn 之前先收（先收再放：不然同音高的 noteOff 會連新音一起關掉）
    const same = staff.sounding.get(note.midiNote);
    for (let i; same && (i = this._dueIndex(same, onsetMs)) !== -1; ) {
      try { this._synthOf(staff)?.noteOff(staff.channel, note.midiNote, this._offOpts(staff, same[i], same[i].offMs)); } catch (err) {}
      same.splice(i, 1);
    }
    if (same && !same.length) staff.sounding.delete(note.midiNote);
  }

  // 時鐘時刻 ms 對應的 AudioContext 時間，包成 eventOptions。只有 tick() 裡（_audioBase 有值）的電腦輔助聲部才有；
  // 你的聲部（human）與按鍵、暫停裡的呼叫回傳 undefined＝立刻處理。時刻已經過去時 worklet 也是立刻處理。
  _stamp(staff, ms) {
    if (staff.kind === 'human' || !this._audioBase || ms === undefined) return undefined;
    return { time: this._audioBase.audio + (ms - this._audioBase.clock) / 1000 };
  }

  // 收音的 eventOptions：tick() 裡依預定時刻（offMs）帶時間戳；其餘情況（按鍵、暫停）立刻處理。但這顆音的 noteOn
  // 如果是提早送出、還沒響（時間戳在未來），noteOff 一定要排在它後面（發聲後 1ms）：立刻處理的 noteOff 會比它早到，
  // 之後那顆 noteOn 響了就再也收不掉（卡音）；兩個時間戳的換算來自不同的 tick，差幾毫秒的誤差也靠這個下限擋掉。
  _offOpts(staff, entry, offMs) {
    const stamp = this._stamp(staff, offMs);
    if (entry.onTime === undefined) return stamp;
    return { time: Math.max(stamp?.time ?? -Infinity, entry.onTime + 0.001) };
  }

  // 排好時刻已到的 follower 音依序發聲（佇列已依 dueMs 排序）。fromTick＝由 tick() 呼叫：只有這種放出才記遲到量，
  // 按鍵呼叫內同刻放出的音（時鐘就是按下的那一刻）沒有「等 tick」這回事，記進去只會把統計稀釋成 0。
  _emitPending(limitMs = this._clockMs, fromTick = false) {
    let n = 0;
    while (n < this._pending.length && this._pending[n].dueMs <= limitMs + EPS_MS) {
      const p = this._pending[n++];
      if (fromTick) {
        this._lateMs.push(Math.max(0, this._clockMs - p.dueMs));
        if (this._lateMs.length > LATE_SAMPLES_MAX) this._lateMs.shift();
      }
      this._sound(p.staff, p.note, p.offMs, p.dueMs);
    }
    if (n) this._pending.splice(0, n);
  }

  /**
   * 量測：tick() 放出的電腦音比排好的時刻晚了多少（排程器時鐘 − dueMs，毫秒）的統計。這是 tick 間隔（12ms 計時器被主執行緒
   * 的影像算繪／姿勢推論延後）造成的遲到；不含 AudioWorklet 的一個 render quantum（約 2.7ms）與瀏覽器輸出延遲。
   * 重設（stop／restart／換歌）時清空。
   */
  lateStats() { return summarizeMs(this._lateMs); }

  _logPress(slot, clockMs, released) {
    this._pressLog.push({ slot, clockMs, released });
    if (this._pressLog.length > PRESS_LOG_MAX) this._pressLog.shift();
  }

  /**
   * 量測：這一輪每次按鍵嘗試的記錄（複本）。clockMs 是排程器時鐘（暫停不走），跟 test/tools/sim.mjs 的時間座標一樣，
   * 可以直接拿去重放。重設（stop／restart／換歌）時清空。
   */
  pressLog() { return this._pressLog.map((p) => ({ ...p })); }

  /**
   * 由 midiPlayer.js 的排程 tick（~12ms）每次呼叫：推進時鐘、放出到時間的 follower 音、收掉到期的音。
   * driver 的起音永遠不在這裡放出，只來自 trigger()。
   * @param {number} nowMs  performance.now()
   * @param {number} [audioNow]  AudioContext 的目前時間（秒）。有給就啟用 lookahead：LOOKAHEAD_MS 以內要發聲／收音的電腦音
   *        提早帶時間戳送出；沒給（單元測試、AudioContext 還沒就緒）就照到期時刻才發聲、不帶時間戳。
   */
  tick(nowMs, audioNow) {
    if (!this._playing || !this._score) return; // 沒有樂譜（load(null)）時空轉
    this._ensureAnchored();
    const dt = this._lastTickMs == null ? 0 : Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));
    this._lastTickMs = nowMs;
    this._clockMs += dt;
    const timed = Number.isFinite(audioNow);
    this._audioBase = timed ? { audio: audioNow, clock: this._clockMs } : null;  // 只在這個 tick 內有效：按鍵、暫停的呼叫一律立刻處理
    try { this._tickBody(timed ? this._clockMs + LOOKAHEAD_MS : this._clockMs); }
    finally { this._audioBase = null; }
  }

  _tickBody(horizonMs) {
    this._closeDue(horizonMs);     // 先收再放：到期的舊音在同一個 tick 要發聲的新音之前關掉（同音高的相連音才不會被連帶關掉）
    this._emitPending(horizonMs, true);
    this._closeDue(horizonMs);     // 剛發聲就到期的短音
    // 前奏鎖期間有人預按過：播放頭到了入場點就放行第一個起音。放行時刻取「剛好到達」的那一刻（不是這個 tick 的時鐘），
    // 第 1 段的錨點因此接在前奏的 1× 時間軸上；落在這一刻到現在之間的電腦音由 _release() 裡的 _emitPending() 補放。
    if (this._preludeCredit && this._segIndex === 0) {
      const reach = this._reachClockMs();
      if (reach !== null && this._clockMs >= reach - EPS_MS) { this._preludeCredit = false; this._release(reach); }
    }
  }

  // 收掉到期的音（offMs ≤ limitMs）。同音高重疊時先進先出（hold 著的音不算，見 _dueIndex）。limitMs 預設是時鐘；tick()
  // 帶 lookahead 時是時鐘 + LOOKAHEAD_MS，只對電腦輔助聲部生效——你的音永遠在時鐘到了才收。
  _closeDue(limitMs = this._clockMs) {
    for (const staff of this._staves.values()) {
      const synth = this._synthOf(staff);
      const limit = staff.kind === 'human' ? this._clockMs : limitMs;
      for (const [pitch, queue] of staff.sounding) {
        for (let i; (i = this._dueIndex(queue, limit)) !== -1; ) {
          try { synth?.noteOff(staff.channel, pitch, this._offOpts(staff, queue[i], queue[i].offMs)); } catch (err) {}
          queue.splice(i, 1);
        }
        if (!queue.length) staff.sounding.delete(pitch);
      }
    }
  }

  // 同音高佇列裡「下一個該收的音」的位置：先進先出只排沒有 hold 的音——hold 著的音要等你按到它的起音才收，不能擋住排在它後面、
  // 已經到期的音（延遲放出的舊 tick 的電腦音可能比新 tick 的音晚發聲）。第一個沒有 hold 的音到期（offMs ≤ limit）就回傳它的位置，否則 -1。
  _dueIndex(queue, limit) {
    const i = queue.findIndex((e) => e.holdIdx === null);
    return i !== -1 && queue[i].offMs <= limit + EPS_MS ? i : -1;
  }

  // 這顆音要 hold 到第幾個 driver 起音？結尾 tick 等於（或在 HOLD_GAP_TICKS 之內早於）某個 driver 起音、而且那個起音在這顆音起音
  // 之後、還沒放行（編號 >= _segIndex）才 hold，回傳那個 driver segment 的編號；否則 null（照原長收）。
  // 為什麼看每顆音自己的結尾而不是它屬於哪個 segment：同一個 tick 你的音短、電腦音長時，短音（結尾不在起音上）照原長收，
  // 長音只在它結尾對齊的那個起音才收，不會被中間的按鍵切掉，也不會被拉長到不屬於它的起音。整首自動播放沒有 driver 起音，永遠 null。
  _holdIndexOf(note) {
    const a = this._driverTicks;
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < note.endTick) lo = mid + 1; else hi = mid; }   // lower bound：第一個 >= endTick 的起音
    if (lo >= a.length || lo < this._segIndex) return null;
    return a[lo] - note.endTick <= HOLD_GAP_TICKS && a[lo] > note.startTick ? lo : null;
  }

  // 你放行第 j 個 driver segment 時：hold 著、等的是第 j 個（或更早）起音的音，收音時刻＝原長的結尾與這一刻較晚的那個。
  // 只延後、不提前：你按得比預估早，原長還沒走完的音照原長放完（不切斷電腦音）；你晚按，hold 到這一刻才收。
  _releaseHeld(j, clock) {
    for (const staff of this._staves.values()) {
      for (const queue of staff.sounding.values()) {
        for (const entry of queue) {
          if (entry.holdIdx === null || entry.holdIdx === undefined || entry.holdIdx > j) continue;
          entry.offMs = Math.max(entry.origOffMs, clock);
          entry.holdIdx = null;
        }
      }
    }
  }

  // 下一次按鍵時，driver 的音 endTick ≤ 新錨點 tick 的先收掉（你的下一個起音發聲時，之前該結束的音已經結束，不管估到的
  // 速度怎樣）。只收 driver：follower 的音照自己的時刻（MIDI 音符長度）放完，不被你的按鍵切斷。
  _closeByTick(ticks) {
    for (const staff of this._staves.values()) {
      if (staff.kind !== 'human') continue;
      const synth = this._synthOf(staff);
      for (const [pitch, queue] of staff.sounding) {
        while (queue.length && queue[0].endTick <= ticks) {
          try { synth?.noteOff(staff.channel, pitch); } catch (err) {}
          queue.shift();
        }
        if (!queue.length) staff.sounding.delete(pitch);
      }
    }
  }
}
