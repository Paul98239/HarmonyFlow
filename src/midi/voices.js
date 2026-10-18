// voices.js — 輸出路由與發聲帳本。OutputRouter：輸出 channel 的分配與 port 數、每個 staff 的初始音色、lookahead 的時間戳，以及排程器裡唯一呼叫合成器方法的地方
// （電腦輔助 assist、真人 human 兩個合成器由 synth.js 注入）；每次呼叫都包 try／catch，音源掛掉不能拖垮排程。VoiceLedger：正在響的音、hold、尾巴收尾。
// 控制器 shadow：每個合成器 × 輸出 channel 一份（每個 CC、program、pitch bend、channel pressure 最後送出的值）；狀態類的補送（載入、早按的 chase、重播、改指派）
// 只送跟 shadow 不同的值，暫停時放開延音踏板、彎音歸中央，續播再恢復。同一個輸出 channel 的控制器依送出順序生效（_ordered()），shadow 才會等於合成器最後的狀態。

import { CC, RESET_CC, PARAMETER_CC, GM_DEFAULT_MIXER, PITCH_BEND_CENTER } from './midiParser.js';

// channel 的單一來源（synth.js 經 scheduler.js 轉出 import）。模仿官方 SpessaSynth Sequencer：一個 port 16 個 channel，依需要的 port 數往上補、只增不減，每個 port 的 channel 9 是打擊。
// DEFAULT_PORTS 是合成器開機就補到的 port 數；歌曲需要更多時由 synth.js 的 load() 依 portsNeeded() 補，再用 setPortCount() 告訴排程器。
// 不能讀 synth.midiChannels.length 當 channel 數（addNewChannel() 會雙重 push，見 synth.js），數字只由這裡與 synth.js 自己計數。
export const CHANNELS_PER_PORT = 16;
export const DEFAULT_PORTS = 4;
// GM 預設值（官方 SpessaSynth 的 DEFAULT_MIDI_CONTROLLERS；沒列的是 0）：重設 channel 時，中途改過、CC121 不管的控制器送回這個值。
const CC_DEFAULTS = new Map([[7, 100], [8, 64], [10, 64], [11, 127], [71, 64], [72, 64], [73, 64], [74, 64], [75, 64], [76, 64], [77, 64], [78, 64], [81, 64], [83, 64]]);
// 重設 channel 時不送回預設值的 CC：bank 與初始音色的混音 CC7／10／91／93（之後一定重送）、RPN／NRPN（chase 照順序重播）、
// channel mode 訊息 120～127（瞬間指令，不是狀態）。
const RESEND_LATER = new Set([0, 32, 7, 10, 91, 93]);
const notState = (cc) => RESEND_LATER.has(cc) || PARAMETER_CC.has(cc) || cc >= 120;
const ccEvent = (cc, value) => ({ type: 'controlChange', data1: cc, data2: value, value });
const bendEvent = (value) => ({ type: 'pitchBend', data1: value & 0x7f, data2: value >> 7, value });

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
    // percussionKit 已是 GM2 Bank Select（CC0/32）判定過的結果：channel 9 明確用 Bank 121 切成旋律通道時不會被誤送進打擊 channel（見 parts.js 的 buildPart()）
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

// 一組 staff 至少需要幾個 port（不低於 DEFAULT_PORTS）：旋律 staff 每個 port 有 15 個 channel（扣掉打擊槽）、打擊 staff 每種
// 鼓組 program 佔一個 port 的打擊槽。pools＝每個合成器的池子 [{ melodic: 旋律 staff 數, kits: Set<鼓組 program> }]，取需要最多的。
export function portsFor(pools) {
  const melodicPerPort = CHANNELS_PER_PORT - 1; // 每個 port 扣掉打擊槽
  return Math.max(DEFAULT_PORTS, ...pools.map((p) => Math.max(Math.ceil(p.melodic / melodicPerPort), p.kits.size)));
}

export class OutputRouter {
  constructor(drumChannel) {
    this.drumChannel = drumChannel;
    this.assistSynth = null;   // 電腦輔助聲部（follower）的合成器
    this.humanSynth = null;    // 被指派聲部（driver）的合成器
    this.ports = DEFAULT_PORTS; // 合成器目前有幾個 port（每個 16 個 channel）；synth.js 補 channel 之後用 setPortCount() 更新
    this._audioBase = null;    // 只在排程器的 tick() 執行期間有值：{ audio: AudioContext 時間（秒）, clock: 這一刻的排程器時鐘 }，lookahead 換算時間戳用
    this._shadow = new Map();  // 'assist:輸出 channel'／'human:輸出 channel' → { cc: Map<編號, 值>, program, pitchBend, channelPressure, paused }
    this._floor = new Map();   // 同上的鍵（與 'sysex'）→ 這個輸出 channel 最後一個控制器的時間戳（AudioContext 秒）：之後送的不早於它（見 _ordered()）
    this._warned = new Set();  // 已經 warn 過的合成器呼叫種類（見 _warnOnce()）
    this._sysexSent = false;   // 送過整體參數的 SysEx（重播、換歌前要整個重設合成器，見 resetIfSysexSent()）
  }

  setSynths(assistSynth, humanSynth) {
    this.assistSynth = assistSynth;
    this.humanSynth = humanSynth;
    this._floor.clear();       // 新的合成器（新的 AudioContext，時間從頭算）：舊的時間戳沒有意義
  }

  setPortCount(ports) {
    this.ports = ports;
  }

  synthOf(staff) {
    return staff.kind === 'human' ? this.humanSynth : this.assistSynth;
  }

  // 指派聲部只配 humanSynth 的 channel、未指派只配 assistSynth 的：兩個池子各自獨立，配額用完的 staff 回報在 unplaced（指派的在前），這一輪不出聲
  allocate(assignedSpecs, assistSpecs) {
    const { byStaffId: humanCh, unplaced: u1 } =
      allocateChannels(assignedSpecs, melodicChannelsFor(this.humanSynth, this.drumChannel, this.ports), drumChannelsFor(this.humanSynth, this.drumChannel, this.ports));
    const { byStaffId: assistCh, unplaced: u2 } =
      allocateChannels(assistSpecs, melodicChannelsFor(this.assistSynth, this.drumChannel, this.ports), drumChannelsFor(this.assistSynth, this.drumChannel, this.ports));
    return { humanCh, assistCh, unplaced: [...u1, ...u2] };
  }

  // staff 的初始狀態：bank／program，加上混音 CC7／10／91／93（來源 staff.init＝檔案 tick 0 的值，沒有就明確送 GM 預設），比該 channel 的任何 noteOn 都早。
  // 只送跟 shadow 不同的：載入、改指派前 shadow 已清空（全送），重播時只補播放中途改過的；送出的值記進 shadow，之後 tick 0 的 chase 裡同樣的值也不重送。
  applyInitialPatch(staff) {
    const { bank, init } = staff;
    this.sendStateDiff(staff, [
      ccEvent(0, bank?.msb || 0), ccEvent(32, bank?.lsb || 0), { type: 'programChange', data1: staff.program || 0, data2: 0, value: staff.program || 0 },
      ccEvent(7, staff.baseVolume), ccEvent(10, init?.pan ?? GM_DEFAULT_MIXER.pan), ccEvent(91, init?.reverb ?? GM_DEFAULT_MIXER.reverb), ccEvent(93, init?.chorus ?? GM_DEFAULT_MIXER.chorus),
    ]);
  }

  // 輸出 channel 的鍵（shadow 與時間戳下限共用）：哪個合成器＋哪個 channel
  _keyOf(staff) { return `${staff.kind === 'human' ? 'human' : 'assist'}:${staff.channel}`; }

  // 這個輸出 channel 已經送出的狀態（每個合成器各一份；第一次用到時建一份空的＝不知道合成器現在的值）
  _shadowOf(staff) {
    const key = this._keyOf(staff);
    let sh = this._shadow.get(key);
    if (!sh) this._shadow.set(key, (sh = { cc: new Map(), program: null, pitchBend: null, channelPressure: null, mode: null, paused: null }));
    return sh;
  }

  /** 合成器剛被清場（換歌載入）：不知道它現在的狀態，之後的狀態補送全部重送。 */
  clearShadow() { this._shadow.clear(); }

  /**
   * 送一個 channel 事件（控制器軌事件形狀：type、data1、data2、value）到這個 staff 的輸出 channel，並記進 shadow。opts＝lookahead 的時間戳（eventOptions），沒有就立刻處理。
   * poly pressure 是每個音的，channel mode 訊息（120～127）是瞬間指令，都不記 shadow；其中 CC121 會重設一批控制器，shadow 跟著改成重設後的值。
   */
  sendChannelEvent(staff, ev, opts) {
    if (!this.synthOf(staff)) return;
    const sh = this._shadowOf(staff);
    switch (ev.type) {
      case 'controlChange':
        if (ev.data1 === CC.RESET_ALL) this._markReset(sh);
        else if (ev.data1 === CC.MONO || ev.data1 === CC.POLY) sh.mode = ev.data1;
        else if (ev.data1 < 120) sh.cc.set(ev.data1, ev.value);
        break;
      case 'programChange': sh.program = ev.value; break;
      case 'pitchBend': sh.pitchBend = ev.value; break;
      case 'channelAftertouch': sh.channelPressure = ev.value; break;
    }
    this._send(staff, ev, opts);
  }

  // CC121 之後合成器的狀態（RP-015）：重設的控制器記成預設值；暫停前記下的值也作廢（channel 已重設，續播不該恢復）
  _markReset(sh) {
    for (const [cc, value] of RESET_CC) sh.cc.set(cc, value);
    sh.pitchBend = PITCH_BEND_CENTER;
    sh.channelPressure = 0;
    sh.paused = null;
  }

  // 呼叫合成器（不碰 shadow）
  _send(staff, ev, opts) {
    const synth = this.synthOf(staff);
    if (!synth) return;
    const ch = staff.channel;
    opts = this._ordered(this._keyOf(staff), opts);
    try {
      switch (ev.type) {
        case 'controlChange': synth.controllerChange(ch, ev.data1, ev.value, opts); break;
        case 'programChange': synth.programChange(ch, ev.value, opts); break;
        case 'pitchBend': synth.pitchWheel(ch, ev.value, opts); break;
        case 'channelAftertouch': synth.channelPressure(ch, ev.value, opts); break;
        case 'polyAftertouch': synth.polyPressure(ch, ev.data1, ev.value, opts); break;
      }
    } catch (err) { this._warnOnce(ev.type, err); }
  }

  // 合成器呼叫失敗不能拖垮排程，但要讓人看得到：每種呼叫只 warn 一次，不然每顆音一則會洗版
  _warnOnce(kind, err) {
    if (this._warned.has(kind)) return;
    this._warned.add(kind);
    console.warn(`合成器呼叫「${kind}」失敗（已略過、不影響排程，同種失敗不再提示）：`, err);
  }

  // 同一個輸出 channel 的控制器依送出順序生效：lookahead 帶時間戳送出、可能還沒生效的控制器（worklet 取消不了），之後送的（含立刻送的狀態補送、暫停放開踏板）
  // 時間戳不早於它，不然它晚一步生效、舊值蓋掉新值（踏板卡住、shadow 跟合成器對不上）。已過去的時間戳 worklet 一律立刻處理，所以不會讓立刻送的事件變晚；
  // 同一個時間戳依送出順序處理（worklet 佇列是穩定排序）。你的合成器從不帶時間戳，不受影響。key：輸出 channel（_keyOf），或 'sysex'。
  _ordered(key, opts) {
    const floor = this._floor.get(key), time = opts?.time;
    if (floor === undefined) {
      if (time !== undefined) this._floor.set(key, time);
      return opts;
    }
    const t = time !== undefined && time > floor ? time : floor;
    this._floor.set(key, t);
    return { time: t };
  }

  /**
   * 重設這個輸出 channel 的控制器（載入、重播、改指派時，送初始音色與這首歌的狀態之前）：CC121（踏板放開、彎音回中央、表情 127…，RP-015），
   * 再把 shadow 裡中途改過、CC121 不管的控制器（音色亮度、CC2 等）送回 GM 預設，不然會留到重播或下一首。bank、混音 CC7／10／91／93 不送（初始音色馬上重送）。
   */
  resetChannel(staff) {
    if (!this.synthOf(staff)) return;
    this.sendChannelEvent(staff, ccEvent(CC.RESET_ALL, 0));
    const sh = this._shadowOf(staff);
    for (const [cc, value] of sh.cc) {
      const def = CC_DEFAULTS.get(cc) ?? 0;
      if (!notState(cc) && value !== def) this.sendChannelEvent(staff, ccEvent(cc, def));
    }
  }

  // 狀態類的補送（載入時 tick 0 的狀態、早按的 chase、重播、改指派）：只送跟 shadow 不同的值、不帶時間戳（立刻處理）。例外：RPN／NRPN
  // 的選參數與 data entry 照順序全送；bank select 變了，後面的 program change 就算值一樣也要送（新 bank 在 program change 時才生效，GM2 §3.3.1）。
  sendStateDiff(staff, events) {
    const sh = this._shadowOf(staff);
    let bankChanged = false;
    for (const ev of events) {
      if (ev.type === 'controlChange') {
        // CC126／127 合成器會先停掉整個 channel 的音再切模式（CC121 不動它），所以模式沒變就不能重送
        if (ev.data1 === CC.MONO || ev.data1 === CC.POLY) { if (sh.mode === ev.data1) continue; }
        else if (!PARAMETER_CC.has(ev.data1) && sh.cc.get(ev.data1) === ev.value) continue;
        if (ev.data1 === 0 || ev.data1 === 32) bankChanged = true;
      } else if (ev.type === 'programChange') {
        if (sh.program === ev.value && !bankChanged) continue;
        bankChanged = false;
      } else if (ev.type === 'pitchBend') {
        if (sh.pitchBend === ev.value) continue;
      } else if (ev.type === 'channelAftertouch') {
        if (sh.channelPressure === ev.value) continue;
      }
      this.sendChannelEvent(staff, ev);
    }
  }

  // 暫停：踩著的延音類踏板（CC64 hold、CC66 sostenuto）放開、彎音歸中央，記住原值給續播恢復（只送跟 shadow 不同的）。MIDI 1.0：踏板踩著時 Note Off 與
  // All Notes Off 要等踏板放開才生效（不先放開就卡音）；sequencer 停止時不在初始位置的控制器應該歸位。沒踩踏板、沒彎音就什麼都不送也不記（再暫停一次不會蓋掉記下的值）。
  releaseForPause(staff) {
    const sh = this._shadow.get(this._keyOf(staff));
    if (!sh || sh.paused) return;                                  // 沒送過東西／已經放開過、還沒續播
    const saved = { hold: sh.cc.get(CC.HOLD), sostenuto: sh.cc.get(CC.SOSTENUTO), pitchBend: sh.pitchBend };
    const bent = saved.pitchBend !== null && saved.pitchBend !== PITCH_BEND_CENTER;
    if (!(saved.hold > 0) && !(saved.sostenuto > 0) && !bent) return;
    sh.paused = saved;
    if (saved.hold > 0) this.sendChannelEvent(staff, ccEvent(CC.HOLD, 0));
    if (saved.sostenuto > 0) this.sendChannelEvent(staff, ccEvent(CC.SOSTENUTO, 0));
    if (bent) this.sendChannelEvent(staff, bendEvent(PITCH_BEND_CENTER));
  }

  // 續播：恢復暫停前的踏板與彎音（只恢復一次）
  restoreAfterPause(staff) {
    const sh = this._shadow.get(this._keyOf(staff)), saved = sh?.paused;
    if (!saved) return;
    sh.paused = null;
    if (saved.hold > 0) this.sendChannelEvent(staff, ccEvent(CC.HOLD, saved.hold));
    if (saved.sostenuto > 0) this.sendChannelEvent(staff, ccEvent(CC.SOSTENUTO, saved.sostenuto));
    if (saved.pitchBend !== null && saved.pitchBend !== PITCH_BEND_CENTER) this.sendChannelEvent(staff, bendEvent(saved.pitchBend));
  }

  // 暫停中改指派：舊的「暫停前的值」對不上新的分配，丟掉（排程器重送 chase 之後再依新的狀態放開一次）
  forgetPauseSaves() {
    for (const sh of this._shadow.values()) sh.paused = null;
  }

  // SysEx 的整體參數（主音量、殘響、合唱…）兩個合成器都送、同一個時間：你和電腦的音量平衡不變（規則見 performancePlan.js）。
  // data＝F0 之後的位元組（含結尾的 F7），跟官方 systemExclusive() 的參數一樣。整體參數之間也依送出的順序生效（_ordered）。
  sendSysex(data, opts) {
    opts = this._ordered('sysex', opts);
    this._sysexSent = true;
    for (const synth of [this.assistSynth, this.humanSynth]) {
      try { synth?.systemExclusive(data, 0, opts); } catch (err) { this._warnOnce('systemExclusive', err); }
    }
  }

  /**
   * 送過整體參數的 SysEx（主音量、殘響…）之後，重播與換歌前把兩個合成器整個重設（官方 reset()），不然它們會留到重播與下一首（channel 的 CC121 管不到整體參數）。
   * 重設過的合成器是預設狀態，shadow 清掉。回傳有沒有重設。
   */
  resetIfSysexSent() {
    if (!this._sysexSent) return false;
    this._sysexSent = false;
    for (const synth of [this.assistSynth, this.humanSynth]) {
      try { synth?.reset(); } catch (err) { this._warnOnce('reset', err); }
    }
    this.clearShadow();
    return true;
  }

  // 排程器的 tick() 開始時設、結束時清（null）：只有這段期間的電腦輔助聲部會帶時間戳。
  setAudioBase(base) {
    this._audioBase = base;
  }

  // 時鐘時刻 ms 對應的 AudioContext 時間，包成 eventOptions。只有 tick() 裡（_audioBase 有值）的電腦輔助聲部才有；
  // 你的聲部（human）與按鍵、暫停裡的呼叫回傳 undefined＝立刻處理。時刻已經過去時 worklet 也是立刻處理。
  stamp(staff, ms) {
    if (staff.kind === 'human' || !this._audioBase || ms === undefined) return undefined;
    return this.stampTime(ms);
  }

  // 時鐘時刻 ms 對應的 eventOptions，不分你的或電腦的：整體參數的 SysEx 兩個合成器用同一個時間（只在 tick() 裡有）。
  stampTime(ms) {
    if (!this._audioBase || ms === undefined) return undefined;
    return { time: this._audioBase.audio + (ms - this._audioBase.clock) / 1000 };
  }

  // 收音的 eventOptions：tick() 裡依預定時刻（offMs）帶時間戳；其餘情況（按鍵、暫停）立刻處理。但這顆音的 noteOn
  // 如果是提早送出、還沒響（時間戳在未來），noteOff 一定要排在它後面（發聲後 1ms）：立刻處理的 noteOff 會比它早到，
  // 之後那顆 noteOn 響了就再也收不掉（卡音）；兩個時間戳的換算來自不同的 tick，差幾毫秒的誤差也靠這個下限擋掉。
  offOpts(staff, entry, offMs) {
    const stamp = this.stamp(staff, offMs);
    if (entry.onTime === undefined) return stamp;
    return { time: Math.max(stamp?.time ?? -Infinity, entry.onTime + 0.001) };
  }

  noteOn(staff, pitch, velocity, opts) {
    try { this.synthOf(staff)?.noteOn(staff.channel, pitch, velocity, opts); } catch (err) { this._warnOnce('noteOn', err); }
  }

  noteOff(staff, pitch, opts) {
    try { this.synthOf(staff)?.noteOff(staff.channel, pitch, opts); } catch (err) { this._warnOnce('noteOff', err); }
  }

  // CC123 All Notes Off：暫停、停止時的保險
  allNotesOff(staff) {
    try { this.synthOf(staff)?.controllerChange(staff.channel, CC.ALL_NOTES_OFF, 0); } catch (err) { this._warnOnce('allNotesOff', err); }
  }
}

// VoiceLedger：發聲帳本。每個譜表正在響的音（staff.sounding：音高 → 依發聲順序排隊的佇列）、同音高先進先出收音、hold（loop 等你按下一個起音，N10）的判定與放行、
// 尾巴收尾（同譜表新音發聲時截短舊音，N3）、你的下一次按鍵時依 tick 先收、暫停時全部收音。合成器指令都經 OutputRouter，收發音事件排進對外事件（scheduler.js）。
// 帳本只管「正在響的音」：時鐘、driver 游標、速度這些「目前」的值由排程器呼叫時傳進來；driver 起音 tick、hold 容差、tick → 樂譜秒的換算在載入／改指派時綁定（bind()）。

// 應用層常數（不是規格）：有限的音長（檔案音長 ÷ 速度）上限：極慢（如 0.015×）時 0.1 秒的短音會被拉成 6 秒，所以被「拉長」的部分最多到 NOTE_MAX_MS；但不會比檔案本身的長度更短
// （檔案裡 12 秒的長音在 1× 就是 12 秒，整首自動播放與你彈得跟原譜一樣快時都不能被切）。起音位置仍用完整速度排開，hold 著等你按的音照舊響到你按下去。排程器排電腦音的長度也用它，所以 export。
const NOTE_MAX_MS = 8000;
export const scaledMs = (lenSec, rate) => Math.min((lenSec * 1000) / rate, Math.max(NOTE_MAX_MS, lenSec * 1000));
// 排程時刻是一路加法算出來的浮點數，跟時鐘比大小時不能要求逐位元相等（排程器比時刻也用它）。
export const EPS_MS = 1e-6;
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

// hold 容差的上限（tick）：有 ticks per quarter 就是十六分音符；SMPTE（timeDivision 是 null）用固定秒數換成 tick
export function holdCapTicksFor(score) {
  const cap = score.timeDivision ? score.timeDivision * HOLD_GAP_MAX_QUARTER : score.secondsToMIDITicks?.(HOLD_GAP_MAX_SECONDS);
  return Number.isFinite(cap) ? Math.max(HOLD_GAP_TICKS, Math.round(cap)) : HOLD_GAP_TICKS;
}

// 同音高佇列裡「下一個該收的音」的位置：先進先出只排沒有 hold、也沒有在等鍵（waitKey，keyup 模式）的音——hold 著的音要等你按到它的起音才收、等鍵的音要等它的鍵放開，
// 都不能擋住排在它後面、已經到期的音（延遲放出的舊 tick 的電腦音可能比新 tick 的音晚發聲）。第一個這樣的音到期（offMs ≤ limit）就回傳它的位置，否則 -1。
export function dueIndex(queue, limit) {
  const i = queue.findIndex((e) => e.holdIdx === null && e.waitKey == null);
  return i !== -1 && queue[i].offMs <= limit + EPS_MS ? i : -1;
}

// 這顆音要 hold 到第幾個 driver 起音、那個起音之後還要再響多久？回傳 { idx, tailSec }（樂譜秒），不 hold 回傳 null（照原長收）。
// driverTicks＝driver 起音 tick（遞增）、fromIndex＝driver 游標、holdCapTicks＝容差上限、secOf＝tick → 樂譜秒。挑「結尾（加容差）之前最後一個、在這顆音起音之後、
// 還沒放行（編號 >= fromIndex）的 driver 起音」：
//  · 起音比結尾早或相等（橫跨、或剛好對齊）：tailSec＝檔案裡那個起音到結尾的長度（對齊時 0），你按下那個起音之後再響完它（÷ 速度）；
//  · 起音比結尾晚、差距在容差內（結尾接著它，含匯出器統一縮短的相連音）：tailSec＝0，按下去就收；差距超過容差的更晚起音不算（休止或斷奏，照原長收），改看再前一個。
// 為什麼看每顆音自己的結尾而不是它屬於哪個 segment：同 tick 你的音短、電腦音長時，短音照原長收，長音一路等到它結尾所在的起音，不被中間的按鍵切掉，也不會被拉長到不屬於它的起音。
// 為什麼橫跨的音也要等：照原長在真實時間收，你比預估慢時音會在你按到它該響著的起音之前就停了，檔案裡它明明還在響。
// 整首自動播放沒有 driver 起音，永遠 null；零長度、結尾早於起音等怪音符沒有起音落在（起音，結尾＋容差]，自然 null。
export function holdOf(note, driverTicks, fromIndex, holdCapTicks, secOf) {
  const a = driverTicks;
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= note.endTick + holdCapTicks) lo = mid + 1; else hi = mid; }   // upper bound：第一個超過「結尾＋容差上限」的起音
  for (let c = lo - 1; c >= fromIndex && a[c] > note.startTick; c--) {
    const gap = a[c] - note.endTick;          // > 0：音比這個起音早收
    if (gap <= 0) return { idx: c, tailSec: secOf(note.endTick) - secOf(a[c]) };
    // 上限（holdCapTicks）已經由上面的搜尋視窗保證：候選起音最多比結尾晚這麼多
    if (gap <= Math.max(HOLD_GAP_TICKS, (a[c] - note.startTick) * HOLD_GAP_RATIO)) return { idx: c, tailSec: 0 };
  }
  return null;
}

export class VoiceLedger {
  constructor(router, events) {
    this._router = router;      // 所有合成器呼叫都經過它（voices.js）
    this._events = events;      // 收發音的事件排進這裡（scheduler.js；排程器在每次呼叫結束時才發出去）
    this._staves = new Map();   // staffId → staff（排程器建的；帳本操作每個 staff 的 sounding）
    this._driverTicks = [];     // driver 起音的 tick（hold 判定用）
    this._holdCapTicks = 0;     // hold 對齊容差的上限（tick），見 holdCapTicksFor()
    this._secOf = null;         // tick → 樂譜秒
  }

  // 載入、改指派時綁定這一輪的譜表與計畫（排程器建好 staff 與 driver 起音之後呼叫）。
  bind({ staves, driverTicks, holdCapTicks, secOf }) {
    this._staves = staves;
    this._driverTicks = driverTicks;
    this._holdCapTicks = holdCapTicks;
    this._secOf = secOf;
  }

  // 以 driver 游標 cursor 判斷這顆音要不要 hold（唯讀查詢）。呼叫的 holdOf(...) 是模組層級的同名函式，類別方法名稱不會變成可直接呼叫的變數名
  holdOf(note, cursor) { return holdOf(note, this._driverTicks, cursor, this._holdCapTicks, this._secOf); }

  // 讓一顆音發聲：noteOn，記進正在響的佇列（同音高先進先出）。dueMs＝預定發聲的時鐘時刻（你的音就是按下的那一刻），只有 tick() 裡的電腦音（lookahead）與被併入組裡的你的音（timed）才帶時間戳；
  // onTime 記下那顆 noteOn 的 AudioContext 時間（沒帶＝undefined）。cursor＝driver 游標（hold 判定）、rate＝目前速度、fromTick＝由 tick() 放出（遲到統計只算這種，見 scheduler.js）、
  // clockMs＝排程器時鐘、timed＝你的合成器也照 lookahead 帶時間戳（近距起音分組被併入的音）。
  // keyup 模式（mode 不是 null，見 scheduler.js 的 keyupOf()）：你的音不做 hold；mode.key 有值的音（組頭）不排收音（Infinity），等這個鍵放開（releaseKey），mode.key 是 null 的照 offMs 收。
  sound(staff, note, offMs, dueMs, { cursor, rate, fromTick, clockMs, timed = false, mode = null }) {
    const opts = timed ? this._router.stampTime(dueMs) : this._router.stamp(staff, dueMs);
    this._capOverlaps(staff, note, dueMs, rate, clockMs, opts?.time);
    let queue = staff.sounding.get(note.midiNote);
    if (!queue) staff.sounding.set(note.midiNote, (queue = []));
    // hold：結尾接著、或橫跨某個還沒放行的 driver 起音的音（你的與電腦的一樣），先不排收音（Infinity），等你按到那個起音才收（releaseHeld）；
    // tailSec＝檔案裡那個起音到結尾的樂譜秒數。被同譜表新音截短過的不再 hold（見 _capOverlaps）
    const hold = mode ? null : this.holdOf(note, cursor);
    const waitKey = mode?.key ?? null;
    queue.push({ endTick: note.endTick, offMs: hold || waitKey !== null ? Infinity : offMs, holdIdx: hold ? hold.idx : null, tailSec: hold ? hold.tailSec : 0, waitKey, note, onTime: opts?.time, capped: false }); // 先登記再 noteOn：合成器收到 noteOn 時，佇列最後一項就是這顆音
    this._router.noteOn(staff, note.midiNote, note.velocity, opts);
    this._events.queue('noteOn', {
      note, noteId: note.id ?? null, staffId: staff.id, kind: staff.kind, dueMs, clockMs,
      timed: opts !== undefined, fromTick, lateMs: Math.max(0, clockMs - dueMs),
    });
  }

  // 尾巴收尾：同譜表的新音在 onsetMs 發聲時，還在響的舊音（起音 tick 比新音早）的收音時刻不能晚於「onsetMs ＋ 檔案裡這兩顆音的重疊量依目前速度 rate 換算」
  // （檔案裡舊音結尾在新音起音之前＝重疊 0，就在新音發聲時收）。為什麼：舊音結尾是依發聲當時估到的速度排好的，速度之後變快、或舊音還在 hold（結尾無限大）時，
  // 舊音會比檔案裡的重疊多響一截（糊在一起）；照檔案 tick 位置收尾，重疊量就跟檔案一樣，不丟音、不擠。只會提早收、不會延長（你按得晚時不撐）。
  // 同譜表內起音 tick 相同的音（和弦）不算「下一個音」，不互相截。onTime＝新音 noteOn 的時間戳（有帶的話）。
  _capOverlaps(staff, note, onsetMs, rate, clockMs, onTime) {
    const startSec = this._secOf(note.startTick);
    for (const queue of staff.sounding.values()) {
      for (const entry of queue) {
        if (entry.note.startTick >= note.startTick) continue;
        // 例外：檔案裡這兩顆音真的重疊、音高不同（同一行譜的多聲部，長音底下另有音在動），舊音又還在 hold：保留 loop 到它的結尾起音、不修剪——
        // 修剪只擋「檔案沒寫的」多疊（你早按造成的），檔案寫了的重疊是樂譜本意；同音高不適用（同一個 key 不能同時有兩個音）
        if ((entry.holdIdx !== null || entry.waitKey != null) && entry.note.midiNote !== note.midiNote && entry.endTick > note.startTick) continue;
        const capMs = onsetMs + scaledMs(Math.max(0, this._secOf(entry.endTick) - startSec), rate);
        // 只有「真的截短」才標成 capped、不再 hold（EPS：capMs 與 offMs 從同一個錨點算出來，相等時只差浮點誤差，不算截短）；
        // 單音旋律的譜表因此不會糊到你下一次按鍵，hold 著的音（offMs＝Infinity）遇到同譜表新音也在這裡被截成有限值
        if (capMs < entry.offMs - EPS_MS) { entry.offMs = capMs; entry.capped = true; entry.holdIdx = null; entry.waitKey = null; }
        // 同音高：新音的收音在先進先出佇列裡排在舊音後面，舊音若還 hold 著，新音的收音會被拖住，所以也不再 hold
        else if (entry.note.midiNote === note.midiNote) { entry.capped = true; entry.holdIdx = null; entry.waitKey = null; }
      }
    }
    // 同音高的舊音若因此到期，要在新音 noteOn 之前先收（先收再放，不然同音高的 noteOff 會連新音一起關掉）。你的合成器收音平常不帶時間戳，但新音提早帶時間戳送出時
    // （被併入組裡的音），舊音要收在新音的時間戳：立刻收會把舊音切短，等時鐘到了才收又會晚於新音、把新音一起關掉。
    const same = staff.sounding.get(note.midiNote);
    for (let i; same && (i = dueIndex(same, onsetMs)) !== -1; ) {
      const opts = staff.kind === 'human' && onTime !== undefined
        ? { time: Math.max(onTime, (same[i].onTime ?? -Infinity) + 0.001) }
        : this._router.offOpts(staff, same[i], same[i].offMs);
      this._off(staff, note.midiNote, same[i], opts, clockMs);
      same.splice(i, 1);
    }
    if (same && !same.length) staff.sounding.delete(note.midiNote);
  }

  // 收掉到期的音（offMs ≤ limitMs）。同音高重疊時先進先出（hold 著的音不算，見 dueIndex）。limitMs 預設是時鐘 clockMs；tick()
  // 帶 lookahead 時是時鐘 + LOOKAHEAD_MS，只對電腦輔助聲部生效——你的音永遠在時鐘到了才收。
  closeDue(clockMs, limitMs = clockMs) {
    for (const staff of this._staves.values()) {
      const limit = staff.kind === 'human' ? clockMs : limitMs;
      for (const [pitch, queue] of staff.sounding) {
        for (let i; (i = dueIndex(queue, limit)) !== -1; ) {
          this._off(staff, pitch, queue[i], this._router.offOpts(staff, queue[i], queue[i].offMs), clockMs);
          queue.splice(i, 1);
        }
        if (!queue.length) staff.sounding.delete(pitch);
      }
    }
  }

  // 第 j 個 driver segment 在時鐘 clock 放行時：hold 著、等的是第 j 個（或更早）起音的音，收音時刻＝你按下的那一刻 ＋ 檔案裡那個起音到結尾的長度 ÷ 速度 rate
  // （你的音與電腦音一樣，電腦聲部每次按下都在你按下的那一刻對齊，早按時也不會落後）。以你的聲部為準：對齊起音的音（剩 0）在起音那一刻就收，即使依速度換算的原長還沒走完；你慢就一直響到你按下去。
  releaseHeld(j, clock, rate) {
    for (const staff of this._staves.values()) {
      for (const queue of staff.sounding.values()) {
        for (const entry of queue) {
          if (entry.holdIdx === null || entry.holdIdx === undefined || entry.holdIdx > j) continue;
          entry.offMs = clock + scaledMs(entry.tailSec, rate);
          entry.holdIdx = null;
        }
      }
    }
  }

  // keyup 模式：鍵 key 放開時，收掉登記這個鍵的音（收在 clock；呼叫端接著 closeDue()）。只收 waitKey === key 的音：A 的 keyup 晚於 B 的 keydown 時不會收掉 B 的音。回傳收了幾顆。
  releaseKey(key, clock) {
    let n = 0;
    for (const staff of this._staves.values()) {
      for (const queue of staff.sounding.values()) {
        for (const entry of queue) {
          if (entry.waitKey !== key) continue;
          entry.offMs = clock;
          entry.waitKey = null;
          n++;
        }
      }
    }
    return n;
  }

  // 下一次按鍵時（或組裡的起音自動放行時），driver 的音 endTick ≤ 新錨點 tick 的先收掉（你的下一個起音發聲時，之前該結束的音已結束，不管估到的速度怎樣）。
  // 只收 driver：follower 的音照自己的時刻放完，不被你的按鍵切斷。立刻處理；但組裡被併入、提早帶時間戳送出還沒響的音，收音要排在它的 noteOn 之後（offOpts），不然先到的 noteOff 收不到它、它響了就卡住。
  closeByTick(ticks, clockMs) {
    for (const staff of this._staves.values()) {
      if (staff.kind !== 'human') continue;
      for (const [pitch, queue] of staff.sounding) {
        while (queue.length && queue[0].endTick <= ticks) {
          this._off(staff, pitch, queue[0], this._router.offOpts(staff, queue[0]), clockMs);
          queue.shift();
        }
        if (!queue.length) staff.sounding.delete(pitch);
      }
    }
  }

  // 把所有還在響的音收掉：每個 noteOn 各送一個 noteOff。
  noteOffAll(clockMs) {
    for (const staff of this._staves.values()) {
      for (const [pitch, queue] of staff.sounding) {
        for (const entry of queue) {
          this._off(staff, pitch, entry, this._router.offOpts(staff, entry), clockMs);
        }
      }
      staff.sounding.clear();
    }
  }

  // 沒有任何音在響（排程器的 isFinished() 用）。
  isSilent() {
    for (const staff of this._staves.values()) {
      if (staff.sounding.size > 0) return false;
    }
    return true;
  }

  // 收一顆音：送出 noteOff（opts＝時間戳，見 voices.js 的 offOpts()），並排一個 noteOff 事件。
  _off(staff, pitch, entry, opts, clockMs) {
    this._router.noteOff(staff, pitch, opts);
    this._queueNoteOff(staff, entry, opts !== undefined, clockMs);
  }

  _queueNoteOff(staff, entry, timed, clockMs) {
    this._events.queue('noteOff', {
      note: entry.note, noteId: entry.note.id ?? null, staffId: staff.id, kind: staff.kind, offMs: entry.offMs, clockMs, timed,
    });
  }
}
