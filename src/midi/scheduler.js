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
//    · 你按得比預估早（垂直切片）：按下 T_k 的那一刻，樂譜上「T_k 這個垂直 tick 響著什麼」＝ T_k 的 segment ＋ 從更早延續過來、
//      endTick > T_k 的音。上一段還沒輪到的 follower 音因此分兩種：還該響著的追音（現在發聲，長度是 T_k 到它結尾的剩餘長度 ÷ 速度），
//      整顆在你身後的跳過（不發聲）。這一段的錨點就是按下的時刻，同 tick 的電腦音永遠與你同刻（見 _chaseOrSkip 與 chaseStats）。
//      文獻：Antescofo 的 @tight＋@local（位置優先、丟棄已過去的動作）、DAW 的 Chase Events（補發還在響的音）、Dannenberg 1984 §8。
//    · 你按得比預估晚：這一段放完就靜止等你，不會越過你的下一個起音；已經開始的音照音長收完（loop 的音等你按）。
//  playbackRate（命名同官方 Sequencer：樂譜秒 ÷ 真實秒）＝最近 8 個按鍵的頭尾比值（pressTiming.js，模擬評估選出來的）。
//  去抖（pressTiming.js）：兩次按鍵太近就忽略第二次（擋手抖、手勢重複觸發）。
//
//  收音：音長與起音一樣依你的速度等比例縮放（檔案音長 ÷ playbackRate，整份譜用你的 BPM 演奏）。driver 的音到期或下一次按鍵時 endTick ≤
//  新錨點的先收掉（先收再放），follower 的音從它發聲的時刻起算同一個長度。
//  hold（loop 等你按下一個起音）：音的結尾對齊、或橫跨某個還沒放行的 driver 起音（你的與電腦的一樣，見 _holdOf），原長走完也不收，
//  等你按到「結尾之前（含）最後一個起音」才收，收在「該軌的時刻 ＋ 檔案裡那個起音到結尾的長度 ÷ 速度」（見 _releaseHeld；你的音的時刻是
//  你按下的那一刻，電腦音的時刻是電腦走到這個起音的那一刻）。以你的聲部為準：結尾對齊起音（含匯出器統一縮短一點點的相連音）時剩餘長度是 0＝
//  起音那一刻就收，就算原長還沒走完（你比預估快）也收；橫跨起音的音在這個起音之後再響完剩餘長度。
//  是否 hold 看每顆音自己的結尾，不看它屬於哪個 segment：同 tick 你的音短、電腦音長時，短音照自己的長度收、長音等它的那個起音。
//  尾巴收尾：同一個譜表的新音發聲時，還在響的舊音（起音 tick 比新音早）的收音時刻上限＝新音發聲時刻 ＋ 檔案裡這兩顆音的重疊量
//  （結尾 tick − 新音起音 tick，最少 0）÷ 速度——舊音不會比檔案裡的重疊多響一截（糊在一起），也不丟音；hold 著的舊音在檔案沒有重疊時
//  在這裡被截成有限值。例外：檔案裡真的重疊、音高不同、舊音還在 hold（同一行譜的多聲部，重疊是樂譜本意）不修剪，長音繼續 loop。
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

import { estimatePlaybackRate, debounceWindowMs, summarizeMs, rateBoundsFor, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE } from './pressTiming.js';

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
// 鍵盤的演奏者槽位。肢體動作的槽位是數字 1~4（演奏者 ID），鍵盤用字串，兩者不衝突，日後可以並存。
// 單一來源：midiPlayer.js 列在指派下拉的「PC 鍵盤手」、main.js 交給 keyboard.js 的觸發槽位都用它。
export const KEYBOARD_SLOT = 'kb';

/* ═══════════════════════════════════════════
   應用層常數——不是規格
   ═══════════════════════════════════════════ */
// 停手與變速的判斷（_updateRate）：這一下隱含的速度 x ＝ Δ樂譜秒 ÷ Δ真實秒。
//  · x 低於這首歌的速度區間下緣（兩次按鍵隔超過 30 秒對應的長度，見 pressTiming.js 的 rateBoundsFor）＝停手：歷史清掉、速度維持。
//  · 已經學到速度（歷史裡至少 LEARNED_INTERVALS 個間隔）時，x 跟目前估計差超過 SURPRISE_RATIO 倍＝「驚訝」，先不拿來估速；
//    下一下的隱含速度若跟它差在 CONFIRM_RATIO 倍以內就兩下一起接受（你真的變速了，歷史從驚訝那一下重新開始），否則當成停手／失誤。
//  · 還沒學到速度時一律接受：區間內的任何速度都學得到。不用「預測間隔的幾倍」當門檻：預測間隔是用目前速度算的，連按之後只有 0.1 秒，
//    慢下來的人每一下都超過門檻、被當成停手，速度就永遠鎖在連按時的快速。
const LEARNED_INTERVALS = 3;
const SURPRISE_RATIO = 3;
const CONFIRM_RATIO = 1.6;
// 有限的音長（檔案音長 ÷ 速度）上限：極慢（例如 0.015×）時 0.1 秒的短音會被拉成 6 秒，所以被「拉長」的部分最多到 NOTE_MAX_MS；
// 但不會比檔案本身的長度更短（檔案裡 12 秒的長音在 1× 就是 12 秒，整首自動播放與你彈得跟原譜一樣快時都不能被切）。
// 起音位置仍用完整速度排開，hold 著等你按的音照舊響到你按下去。
const NOTE_MAX_MS = 8000;
const scaledMs = (lenSec, rate) => Math.min((lenSec * 1000) / rate, Math.max(NOTE_MAX_MS, lenSec * 1000));
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
// hold（loop 等你按下一個起音）的對齊容差：音的結尾比某個 driver 起音早不超過這麼多，就算「結尾接著這個起音」。
// 容差 ＝ max(HOLD_GAP_TICKS, min(音起音到那個起音的間隔 × HOLD_GAP_RATIO, 上限))，都是匯出器的慣例，不是規格：
//  · 至少 2 tick：MuseScore 匯出相連音時記譜長度少 1 tick，再多一點吸收取整誤差。
//  · 比例 1/8：有些匯出器把每顆音統一縮短一個比例（曲庫量測：54/164 首的主聲部，結尾固定比下一個起音早約 5.4% 的間隔，
//    只容許 2 tick 時這些歌完全不會 hold）。真正的斷奏空隙是間隔的一半左右，遠超過 1/8，不會被誤判成相連。
//  · 上限十六分音符（四分音符的 1/4；沒有四分音符的 SMPTE 用 0.125 秒）：免得長音後面的短休止被填滿。
const HOLD_GAP_TICKS = 2;
const HOLD_GAP_RATIO = 1 / 8;
const HOLD_GAP_MAX_QUARTER = 1 / 4;
const HOLD_GAP_MAX_SECONDS = 0.125;
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

// 這個 staff 被指派給誰（槽位，沒有指派回 undefined）。指派的單位是 part，單聲部的多行譜（例如鋼琴一個 part 兩個 staff）
// 也可以只指派其中一個 staff：staff id 的指派優先於 part id 的。
const slotOfSpec = (assignments, spec) => assignments.get(spec.id) ?? assignments.get(spec.partId);

// 這首歌至少需要幾個 port 的 channel（不低於 DEFAULT_PORTS）：旋律 staff 每個 port 有 15 個、打擊 staff 每種鼓組 program 佔一個
// port 的打擊槽，指派與未指派兩個池子（兩個合成器）各自算，取較大的。assignments 同 load()：Map 或 [partId, 槽位][]。
export function portsNeeded(score, assignments) {
  const assignMap = assignments instanceof Map ? assignments : new Map(assignments || []);
  const pools = [{ melodic: 0, kits: new Set() }, { melodic: 0, kits: new Set() }]; // [指派, 未指派]
  for (const part of score?.parts || []) {
    for (const spec of staffSpecsOf(part)) {
      const pool = pools[slotOfSpec(assignMap, spec) !== undefined ? 0 : 1];
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
    for (const spec of staffSpecsOf(part)) (slotOfSpec(assignments, spec) !== undefined ? assignedSpecs : assistSpecs).push(spec);
  }

  const { byStaffId: humanCh, unplaced: u1 } =
    allocateChannels(assignedSpecs, melodicChannelsFor(humanSynth, cfg.drumChannel, ports), drumChannelsFor(humanSynth, cfg.drumChannel, ports));
  const { byStaffId: assistCh, unplaced: u2 } =
    allocateChannels(assistSpecs, melodicChannelsFor(assistSynth, cfg.drumChannel, ports), drumChannelsFor(assistSynth, cfg.drumChannel, ports));
  unplaced.push(...u1, ...u2);

  for (const spec of assignedSpecs) {
    const channel = humanCh.get(spec.id);
    if (channel === undefined) continue;
    staves.set(spec.id, makeStaff(spec, slotOfSpec(assignments, spec), notesByStaff.get(spec.id) || [], 'human', channel));
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
    this._holdCapTicks = HOLD_GAP_TICKS; // hold 對齊容差的上限（tick），見 HOLD_GAP_*；_buildPlan() 依這首歌的 division 算
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
    this._early = { presses: 0, chased: 0, skipped: 0 }; // 量測：早按時的追音與跳過（見 chaseStats()）
    this._pressLog = [];       // 量測：每次按鍵嘗試 { slot, clockMs, released }（含被去抖擋掉、前奏預按），給 pressLog() 匯出、離線重放用
    this._audioBase = null;    // 只在 tick() 執行期間有值：{ audio: AudioContext 時間（秒）, clock: 這一刻的排程器時鐘 }，lookahead 換算時間戳用
    this._sounded = new Set(); // 已經發過聲的音（每顆音恰好一次）
    this._skipped = new Set(); // 早按時整顆在你身後而跳過的電腦音（沒有發聲；跟 _sounded 合起來才是「處理過」，見 isFinished）
    this._history = [];        // 有效按鍵 [{ scoreSec, ms }]，估速用
    this._lastAcceptClock = null;     // 上一次有效按鍵的時鐘（去抖用）
    this._lastAttemptClock = null;    // 上一次按鍵嘗試（含被忽略的）的時鐘
    this._lastAttemptIntervalMs = Infinity; // 前兩次按鍵嘗試之間的間隔（去抖窗口用）
    this._surprise = null;     // 驚訝的那一下 { x: 隱含速度, press: { scoreSec, ms } }，等下一下確認是變速還是停手（見 _updateRate）
    this._rateBounds = { lo: MIN_PLAYBACK_RATE, hi: MAX_PLAYBACK_RATE }; // 這首歌的速度區間（rateBoundsFor，_buildPlan 依你的聲部起音間隔算）
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
    // 這首歌的速度區間：你的聲部（含多個聲部的聯集）相鄰起音的樂譜間隔取中位數換算，見 pressTiming.js 的 rateBoundsFor()
    const driverSecsList = this._driverTicks.map((t) => this._secOf(t));
    this._rateBounds = rateBoundsFor(driverSecsList.slice(1).map((t, i) => t - driverSecsList[i]));
    // hold 容差的上限：有 ticks per quarter 就是十六分音符；SMPTE（timeDivision 是 null）用固定秒數換成 tick
    const cap = this._score.timeDivision ? this._score.timeDivision * HOLD_GAP_MAX_QUARTER : this._score.secondsToMIDITicks?.(HOLD_GAP_MAX_SECONDS);
    this._holdCapTicks = Number.isFinite(cap) ? Math.max(HOLD_GAP_TICKS, Math.round(cap)) : HOLD_GAP_TICKS;
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

  /**
   * 播放到一半改指派（或整首自動播放 ↔ 有人演奏）：從目前的播放位置接續，不從頭。
   * 做法：量舊計畫的播放頭，算出「界線 boundary」→ 收掉還在響的音 → 依新的指派重建 staff 與計畫（同 load()）→ 起音在界線之前的音算已經過了
   * （不重播、不補放，isFinished 才算得對）→ driver 游標指到第一個 >= 界線的起音 → 以現在的時鐘為界線重新錨定這一段（速度沿用）。
   * 界線：舊計畫停格在你的下一個起音上（播放頭已走到它，還沒按）→ 那個起音的 tick（它的音還沒響）；否則是播放頭所在的 tick（含）
   * ——剛按下一個起音、播放頭還在它上面時，那個 tick 的音已經響過，不能再放一次。
   * 去抖與估速歷史清掉（舊的間隔對不上新的 driver 序列），速度估計保留；前奏鎖依新計畫重算（界線若還在新 driver 的第一個起音之前，
   * 前奏鎖照常生效）。播放／暫停狀態不變。切換的瞬間還在響的音會被收掉、不重播；lookahead 已經提早送出、還沒響的電腦音取消不了，
   * 若它的起音在界線之後，新計畫會再放一次（最多 LOOKAHEAD_MS 內的短暫重複）。
   * @param {Map<string,number|string>|[string,number|string][]} assignments  同 load()
   */
  reassign(assignments) {
    if (!this._score) return;
    const score = this._score;
    const rate = this.playbackRate;
    const pos = this.getPositionTicks();
    const next = this._driverSegs[this._segIndex];
    // 播放頭是浮點數（秒 ↔ tick 換算有誤差）：比大小都留一個微小量，起音 tick 是整數
    const boundary = next && pos >= next.ticks - 1e-6 ? next.ticks : pos + 1e-6;
    this.silence();
    this._staves = new Map();
    this._driverSegs = []; this._driverTicks = []; this._followers = []; this._sliceFirst = [];
    this._assignedSlots = new Set();
    this._hasPrelude = false;
    this._totalNotes = 0;
    this.unplacedStaffIds = [];
    this._createStaves(score, assignments);

    // 起音在界線之前的音都算已經過了（不重播、不補放）。舊佇列裡沒有需要保留的電腦音：tick／trigger 之後佇列裡的音都排在時鐘之後，
    // 起音一定在播放頭之後（界線之後）；你早按時沒輪到的音當場就追音或跳過了（見 _chaseOrSkip），不會留在佇列裡。
    this._sounded.clear();
    for (const staff of this._staves.values()) {
      for (const note of staff.notes) if (note.startTick < boundary) this._sounded.add(note);
    }
    this._segIndex = this._driverTicks.findIndex((t) => t >= boundary);   // 第一個 >= 界線的 driver 起音；都在前面就是放完了
    if (this._segIndex === -1) this._segIndex = this._driverTicks.length;
    this._pending = [];                                                  // _anchorSlice 會排進這一段的電腦音
    this._skipped.clear();                                               // 界線之前的音都已重新記成處理過（上面的 _sounded）
    this._anchor = null;
    this._anchoredSlice = -1;
    this._preludeCredit = false;
    this._history = [];
    this._lastAcceptClock = null;
    this._lastAttemptClock = null;
    this._lastAttemptIntervalMs = Infinity;
    this._surprise = null;
    this._lastTickMs = null;
    // 這一段的編號＝已經放行的 driver 起音數；第 0 段（前奏）一律 1× 起算
    this._anchorSlice(this._segIndex, this._clockMs, this._secOf(Math.max(0, boundary)), this._segIndex === 0 ? 1 : rate, boundary);
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
    this._early = { presses: 0, chased: 0, skipped: 0 };
    this._pressLog = [];
    this._sounded.clear();
    this._skipped.clear();
    this._history = [];
    this._lastAcceptClock = null;
    this._lastAttemptClock = null;
    this._lastAttemptIntervalMs = Infinity;
    this._surprise = null;
    this.playbackRate = 1;
  }

  isPlaying() { return this._playing; }

  // 播完：所有音（你的與電腦的）都發過聲而且沒有還在響的音。有指派聲部但還沒按到，driver 的音沒發過，不算播完。
  isFinished() {
    if (!this._score) return false;
    if (this._sounded.size + this._skipped.size < this._totalNotes) return false;   // 早按跳過的音也算處理過（沒有發聲）
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
    let sec = a.scoreSec + (Math.max(0, this._clockMs - a.clockMs) * a.rate) / 1000;
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

  // 啟動第 slice 段：記下錨點，把這一段的 follower 音各自排好發聲時刻（錨點時刻 ＋ 樂譜秒差 ÷ 速度）與收音時刻（發聲時刻 ＋
  // 音符時值 ÷ 速度；結尾對齊或橫跨你某個起音的音在發聲時另外標 hold，見 _sound），成為排程佇列（依 dueMs 排序）。上一段沒放完的 follower 音在你按下時已經追音或跳過（見 _chaseOrSkip）。
  // fromTick：熱切換指派（reassign）從中間接續時，這一段裡 startTick 在它之前的音已經過了，不排進佇列（不然會一次補放）。
  _anchorSlice(slice, clockMs, scoreSec, rate, fromTick = -Infinity) {
    this._anchor = { slice, clockMs, scoreSec, rate };
    this._anchoredSlice = slice;
    const from = this._sliceFirst[slice], to = this._sliceFirst[slice + 1];
    const fresh = [];
    for (let i = from; i < to; i++) {
      const { staff, note } = this._followers[i];
      if (note.startTick < fromTick) continue;
      const startSec = this._secOf(note.startTick);
      const dueMs = clockMs + ((startSec - scoreSec) * 1000) / rate;
      fresh.push({ dueMs, offMs: dueMs + scaledMs(this._secOf(note.endTick) - startSec, rate), staff, note });   // 起音與音長都依你的速度等比例縮放（整份譜用你的 BPM 演奏）
    }
    this._pending = fresh;   // 啟動新的一段時佇列一定是空的（上一段的電腦音在你按下時已經放完、追音或跳過）；fresh 依樂譜順序，dueMs 單調不減
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

  // 依這一下的按鍵更新 history 與速度估計（停手與變速的判斷見檔頭常數 LEARNED_INTERVALS／SURPRISE_RATIO／CONFIRM_RATIO 的說明）。
  // j＝這一下放行的 driver segment 編號；上一下的樂譜秒取自 driver segment j−1，時鐘取自 _lastAcceptClock。
  _updateRate(j, scoreSec, clock) {
    const B = this._rateBounds, press = { scoreSec, ms: clock };
    if (j === 0 || this._lastAcceptClock == null) { this._history = [press]; return; }   // 第一下（或改指派後的第一下）：沒有間隔可估
    const dS = scoreSec - this._secOf(this._driverSegs[j - 1].ticks), dT = Math.max(1e-3, (clock - this._lastAcceptClock) / 1000);
    const x = dS / dT;                                           // 這一下隱含的速度
    if (x < B.lo) { this._history = [press]; this._surprise = null; return; }   // 空檔超過區間：停手，這次間隔不拿來估速（速度維持原本的值）
    const learned = this._history.length - 1 >= LEARNED_INTERVALS;
    if (learned && Math.abs(Math.log(x / this.playbackRate)) > Math.log(SURPRISE_RATIO)) {
      const s = this._surprise;
      if (s && Math.abs(Math.log(x / s.x)) < Math.log(CONFIRM_RATIO)) {
        this._history = [s.press, press];                        // 連兩下一致：真的變速，歷史從驚訝那一下重新開始
        this._surprise = null;
      } else {
        this._surprise = { x, press };                           // 先不信這一下，等下一下確認
        return;
      }
    } else {
      if (this._surprise) { this._history = [this._surprise.press]; this._surprise = null; }   // 上一下是停手／失誤：歷史從那一下重新開始
      this._history.push(press);
    }
    this.playbackRate = estimatePlaybackRate(this._history, this.playbackRate, B);
  }

  // 放行 _segIndex 這個 driver segment（按鍵 trigger() 與前奏結束時的預按放行共用），時刻 clock（排程器時鐘）。
  _release(clock) {
    const j = this._segIndex, seg = this._driverSegs[j];
    const scoreSec = this._secOf(seg.ticks);
    this._updateRate(j, scoreSec, clock);
    this._lastAcceptClock = clock;
    this._segIndex = j + 1;

    this._closeByTick(seg.ticks);                                   // driver 的音 endTick ≤ 這個起音的，先收
    this._releaseHeld(j, clock);                                    // 結尾對齊這個起音（或更早的起音）而 hold 著的音：你的音與電腦音都在你按下的這一刻收（錨點就是按下的時刻）
    this._closeDue();
    this._emitPending();                                            // 已經到期的電腦音（tick 還沒來得及放的）照常放，要在追音之前：同譜表的新音才截得到它們
    // 早按：上一段還沒輪到的電腦音落在你這個起音的「垂直 tick」之前，不能再照原本的時刻放（會跟你不同步、甚至倒序）。
    // 改成跳到 T_k 的垂直狀態：還該響著的追音、整顆在身後的跳過（見 _chaseOrSkip）。錨點因此永遠是按下的時刻，同 tick 的電腦音 0ms 同刻。
    this._chaseOrSkip(seg.ticks, scoreSec, clock);
    this._anchorSlice(j + 1, clock, scoreSec, this.playbackRate);   // 這一段的錨點與電腦音（佇列此時是空的）
    for (const { staff, note } of seg.items) this._sound(staff, note, clock + scaledMs(this._secOf(note.endTick) - scoreSec, this.playbackRate), clock);
    this._emitPending();                                            // 同 tick 的 follower 音（dueMs ＝ 這一刻）跟你的音同刻
    this._closeDue();                                               // 零長度的音
  }

  // 早按時的垂直切片（Antescofo 的 @tight＋@local、DAW 的 Chase Events）：你按下 driver 起音 T_k 的這一刻，樂譜上「T_k 這個垂直
  // tick 響著什麼」＝ T_k 的 segment ＋ 從更早的 segment 延續過來、endTick > T_k 的音。佇列裡還沒輪到（dueMs 在按下之後）、
  // 起音在 T_k 之前的電腦音，因此分兩種：
  //  · endTick > T_k：追音——現在發聲，長度是檔案裡 T_k 到它結尾的剩餘長度 ÷ 速度（hold 規則照舊，見 _sound）。它在 T_k 本來就是和聲的一部分。
  //  · endTick ≤ T_k：整顆在你身後，跳過（記進 _skipped，isFinished 才算得對）。
  // 為什麼不照原時刻放完或加速追趕：前者樂譜前面的音會比同 tick 的音晚響（倒序）、後者讓同 tick 的電腦音晚到（你的音與電腦音不同步）。
  // 佇列依 dueMs 排序，同一個 tick 的音 dueMs 相同、排在一起，所以追音的順序就是樂譜順序。
  _chaseOrSkip(ticks, scoreSec, clock) {
    const left = this._pending;
    if (!left.length) return;
    this._pending = [];
    this._early.presses++;
    for (const p of left) {
      if (p.note.endTick > ticks) {
        this._early.chased++;
        this._sound(p.staff, p.note, clock + scaledMs(this._secOf(p.note.endTick) - scoreSec, this.playbackRate), clock);
      } else {
        this._early.skipped++;
        this._skipped.add(p.note);
      }
    }
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
    // hold：結尾接著、或橫跨某個還沒放行的 driver 起音的音（你的與電腦的一樣），先不排收音（Infinity），等你按到那個起音才收
    // （_releaseHeld）；tailSec 是檔案裡那個起音到這顆音結尾的樂譜秒數。被同譜表的新音截短過的不再 hold（見 _capOverlaps，capped）
    const hold = this._holdOf(note);
    queue.push({ endTick: note.endTick, offMs: hold ? Infinity : offMs, holdIdx: hold ? hold.idx : null, tailSec: hold ? hold.tailSec : 0, note, onTime: opts?.time, capped: false }); // 先登記再 noteOn：合成器收到 noteOn 時，佇列最後一項就是這顆音
    try { this._synthOf(staff)?.noteOn(staff.channel, note.midiNote, note.velocity, opts); } catch (err) {}
  }

  // 尾巴收尾：同一個譜表的新音在 onsetMs 發聲時，還在響的舊音（起音 tick 比新音早）的收音時刻不能晚於
  // 「onsetMs ＋ 檔案裡這兩顆音的重疊量依目前速度換算」（檔案裡舊音結尾在新音起音之前＝重疊 0，就在新音發聲時收）。
  // 為什麼：舊音的結尾是依發聲當時估到的速度排好的，速度之後變快、或舊音還在 hold（結尾是無限大）時，舊音就會比檔案裡的重疊多響一截
  // （糊在一起）；照檔案的 tick 位置收尾，重疊量就跟檔案一樣，也不會丟音、不會擠。只會把收音提早，不會延長（所以你按得晚時不撐）。
  // 同譜表內起音 tick 相同的音（和弦）不算「下一個音」，不互相截。
  _capOverlaps(staff, note, onsetMs) {
    const startSec = this._secOf(note.startTick);
    for (const queue of staff.sounding.values()) {
      for (const entry of queue) {
        if (entry.note.startTick >= note.startTick) continue;
        // 例外：檔案裡這兩顆音真的重疊、音高不同（同一行譜的多聲部，長音底下另有音在動），舊音又還在 hold：保留 loop 到它的結尾起音，
        // 不修剪——修剪只用來擋「檔案沒寫的」多疊（你早按造成的），檔案寫了的重疊是樂譜本意。同音高不適用（同一個 key 不能同時有兩個音）
        if (entry.holdIdx !== null && entry.note.midiNote !== note.midiNote && entry.endTick > note.startTick) continue;
        const capMs = onsetMs + scaledMs(Math.max(0, this._secOf(entry.endTick) - startSec), this.playbackRate);
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

  /**
   * 量測：你早按時（按下那一刻上一段還有電腦音沒輪到）的處理結果：presses＝有這種情況的按鍵數、chased＝追音（T_k 還該響著、
   * 按下時補發）的顆數、skipped＝跳過（整顆在你身後）的顆數。重設（stop／restart／換歌）時清空。
   */
  chaseStats() { return { ...this._early }; }

  /** 量測：這首歌目前的速度區間 { lo, hi }（rateBoundsFor 依你的聲部起音間隔算出的複本）。 */
  rateBounds() { return { ...this._rateBounds }; }

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

  // 這顆音要 hold 到第幾個 driver 起音、那個起音之後還要再響多久？回傳 { idx, tailSec }（樂譜秒），不 hold 回傳 null（照原長收）。
  // 挑「結尾（加上容差）之前最後一個、在這顆音起音之後、還沒放行（編號 >= _segIndex）的 driver 起音」：
  //  · 起音比結尾早或相等（橫跨、或剛好對齊）：tailSec ＝ 檔案裡那個起音到結尾的長度（對齊時 0），你按下那個起音之後再響完它（÷ 速度）；
  //  · 起音比結尾晚、差距在容差內（結尾接著它，含匯出器統一縮短的相連音，容差見 HOLD_GAP_*）：tailSec ＝ 0，按下去就收。
  //    差距超過容差的更晚起音不算（那是休止或斷奏，照原長收），改看再前一個起音。
  // 為什麼看每顆音自己的結尾而不是它屬於哪個 segment：同一個 tick 你的音短、電腦音長時，短音（結尾與起音之間沒有任何 driver 起音）
  // 照原長收，長音一路等到它結尾所在的那個起音，不被中間的按鍵切掉，也不會被拉長到不屬於它的起音。
  // 為什麼橫跨的音也要等：照原長在真實時間收，你比預估慢時，音會在你按到它該響著的那個起音之前就停了，檔案裡它明明還在響。
  // 整首自動播放沒有 driver 起音，永遠 null。零長度、結尾早於起音等怪音符：沒有任何起音落在（起音，結尾＋容差]，自然 null。
  _holdOf(note) {
    const a = this._driverTicks;
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= note.endTick + this._holdCapTicks) lo = mid + 1; else hi = mid; }   // upper bound：第一個超過「結尾＋容差上限」的起音
    for (let c = lo - 1; c >= this._segIndex && a[c] > note.startTick; c--) {
      const gap = a[c] - note.endTick;          // > 0：音比這個起音早收
      if (gap <= 0) return { idx: c, tailSec: this._secOf(note.endTick) - this._secOf(a[c]) };
      // 上限（this._holdCapTicks）已經由上面的搜尋視窗保證：候選起音最多比結尾晚這麼多
      if (gap <= Math.max(HOLD_GAP_TICKS, (a[c] - note.startTick) * HOLD_GAP_RATIO)) return { idx: c, tailSec: 0 };
    }
    return null;
  }

  // 第 j 個 driver segment 放行時：hold 著、等的是第 j 個（或更早）起音的音，收音時刻＝你按下的那一刻 ＋ 檔案裡那個起音到結尾的
  // 長度 ÷ 速度（你的音與電腦音一樣：電腦聲部每次按下都在你按下的那一刻對齊，早按時也不會落後）。
  // 以你的聲部為準：對齊起音的音（剩 0）在起音那一刻就收，就算它依速度換算的原長還沒走完（你比預估快）也收；你慢就一直響到你按下去。
  _releaseHeld(j, clock) {
    for (const staff of this._staves.values()) {
      for (const queue of staff.sounding.values()) {
        for (const entry of queue) {
          if (entry.holdIdx === null || entry.holdIdx === undefined || entry.holdIdx > j) continue;
          entry.offMs = clock + scaledMs(entry.tailSec, this.playbackRate);
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
