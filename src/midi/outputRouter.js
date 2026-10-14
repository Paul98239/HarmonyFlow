// ============================================================
//  outputRouter.js — 輸出路由：輸出 channel 的分配與 port 數、每個 staff 的初始音色、lookahead 的時間戳，以及排程器裡唯一會
//  呼叫合成器方法的地方（兩個合成器：電腦輔助 assist、真人 human）。純邏輯，合成器由呼叫端注入（synth.js；測試用假物件）。
//  每一次合成器呼叫都包 try／catch：音源掛掉不能拖垮排程（排程器自己的記錄照常往下走）。
//  控制器（子專案 E）：每個合成器 × 輸出 channel 一份 shadow（每個 CC、program、pitch bend、channel pressure 最後送出的值）；
//  狀態類的補送（載入、早按的 chase、重播、改指派）只送跟 shadow 不同的值，暫停時放開延音踏板、彎音歸中央，續播再恢復。
//  同一個輸出 channel 的控制器依送出的順序生效（見 _ordered()），shadow 才會等於合成器最後的狀態。
// ============================================================

// channel 的單一來源（synth.js 經 scheduler.js 轉出 import，不再各寫一份）。模仿官方 SpessaSynth Sequencer：一個 port 16 個 channel，
// 依需要的 port 數往上補、只增不減（官方 assignMIDIPort／addNewMIDIPort），每個 port 的 channel 9 是打擊。DEFAULT_PORTS 是
// 合成器開機就補到的 port 數；歌曲需要更多時由 synth.js 的 load() 依 portsNeeded() 補，再用 setPortCount() 告訴排程器。
// 不能讀 synth.midiChannels.length 當 channel 數（lib 的 addNewChannel() 會雙重 push，見 synth.js），所以數字只由這裡與
// synth.js 自己計數。
export const CHANNELS_PER_PORT = 16;
export const DEFAULT_PORTS = 4;
// GM 預設的混音值（CC121 不會重設音量、聲像、Program，見 GM2 §3.5.2；channel 又是跨曲重複使用，所以沒有 init 的 staff
// 也要明確送一次，避免沿用到別的曲子在同一個 channel 上留下的設定）。
export const GM_DEFAULT_VOLUME = 100, GM_DEFAULT_PAN = 64, GM_DEFAULT_REVERB = 0, GM_DEFAULT_CHORUS = 0;
// RPN／NRPN 的選參數與 data entry：接收端的 data entry 套在「當下選的參數」上，要照順序成組送，不能用「跟上次一樣就不送」過濾。
const PARAMETER_CCS = new Set([6, 38, 96, 97, 98, 99, 100, 101]);
const CC_HOLD = 64, CC_SOSTENUTO = 66, CC_RESET_ALL = 121, BEND_CENTER = 8192;
// CC121 Reset All Controllers 重設的控制器與值（RP-015／GM2 §3.5.2，官方 resetRP15 同一張表）；另外 pitch bend 回中央、channel pressure 回 0。
const RP15_RESET = [[1, 0], [11, 127], [64, 0], [65, 0], [66, 0], [67, 0]];
// GM 預設值（官方 SpessaSynth 的 DEFAULT_MIDI_CONTROLLERS；沒列的是 0）：重設 channel 時，中途改過、CC121 不管的控制器送回這個值。
const CC_DEFAULTS = new Map([[7, 100], [8, 64], [10, 64], [11, 127], [71, 64], [72, 64], [73, 64], [74, 64], [75, 64], [76, 64], [77, 64], [78, 64], [81, 64], [83, 64]]);
// 重設 channel 時不送回預設值的 CC：bank 與初始音色的混音 CC7／10／91／93（之後一定重送）、RPN／NRPN（chase 照順序重播）、
// channel mode 訊息 120～127（瞬間指令，不是狀態）。
const RESEND_LATER = new Set([0, 32, 7, 10, 91, 93]);
const notState = (cc) => RESEND_LATER.has(cc) || PARAMETER_CCS.has(cc) || cc >= 120;
const ccEvent = (cc, value) => ({ type: 'controlChange', data1: cc, data2: value, value });
const bendEvent = (value) => ({ type: 'pitchBend', data1: value & 0x7f, data2: value >> 7, value });

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
    // Bank 79H(121) 切成旋律通道，這裡就不會被誤送進打擊 channel（見 instruments.js 的
    // buildPart() 說明）。
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

/* ═══════════════════════════════════════════
   OutputRouter
   ═══════════════════════════════════════════ */
export class OutputRouter {
  constructor(drumChannel) {
    this.drumChannel = drumChannel;
    this.assistSynth = null;   // 電腦輔助聲部（follower）的合成器
    this.humanSynth = null;    // 被指派聲部（driver）的合成器
    this.ports = DEFAULT_PORTS; // 合成器目前有幾個 port（每個 16 個 channel）；synth.js 補 channel 之後用 setPortCount() 更新
    this._audioBase = null;    // 只在排程器的 tick() 執行期間有值：{ audio: AudioContext 時間（秒）, clock: 這一刻的排程器時鐘 }，lookahead 換算時間戳用
    this._shadow = new Map();  // 'assist:輸出 channel'／'human:輸出 channel' → { cc: Map<編號, 值>, program, pitchBend, channelPressure, paused }
    this._floor = new Map();   // 同上的鍵（與 'sysex'）→ 這個輸出 channel 最後一個控制器的時間戳（AudioContext 秒）：之後送的不早於它（見 _ordered()）
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

  // 指派聲部只配 humanSynth 的 channel、未指派聲部只配 assistSynth 的 channel——兩個池子各自獨立，配額用完的 staff 回報在
  // unplaced（指派的在前），這一輪不會出聲。
  allocate(assignedSpecs, assistSpecs) {
    const { byStaffId: humanCh, unplaced: u1 } =
      allocateChannels(assignedSpecs, melodicChannelsFor(this.humanSynth, this.drumChannel, this.ports), drumChannelsFor(this.humanSynth, this.drumChannel, this.ports));
    const { byStaffId: assistCh, unplaced: u2 } =
      allocateChannels(assistSpecs, melodicChannelsFor(this.assistSynth, this.drumChannel, this.ports), drumChannelsFor(this.assistSynth, this.drumChannel, this.ports));
    return { humanCh, assistCh, unplaced: [...u1, ...u2] };
  }

  // staff 的初始狀態：bank／program，再加上混音 CC7／10／91／93（來源 staff.init＝檔案 tick 0 的值；沒有就明確送 GM 預設，
  // 見 GM_DEFAULT_*）。比該 channel 的任何 noteOn 都早。只送跟 shadow 不同的：載入、改指派前 shadow 已經清空（全部送），重播時只補
  // 播放中途改過的（沒改過的 CC7 等不重送）；送出的值記進 shadow，之後 tick 0 的 chase 裡同樣的值也不重送。
  applyInitialPatch(staff) {
    const { bank, init } = staff;
    this.sendStateDiff(staff, [
      ccEvent(0, bank?.msb || 0), ccEvent(32, bank?.lsb || 0), { type: 'programChange', data1: staff.program || 0, data2: 0, value: staff.program || 0 },
      ccEvent(7, staff.baseVolume), ccEvent(10, init?.pan ?? GM_DEFAULT_PAN), ccEvent(91, init?.reverb ?? GM_DEFAULT_REVERB), ccEvent(93, init?.chorus ?? GM_DEFAULT_CHORUS),
    ]);
  }

  /* ── 控制器（子專案 E）── */

  // 輸出 channel 的鍵（shadow 與時間戳下限共用）：哪個合成器＋哪個 channel
  _keyOf(staff) { return `${staff.kind === 'human' ? 'human' : 'assist'}:${staff.channel}`; }

  // 這個輸出 channel 已經送出的狀態（每個合成器各一份；第一次用到時建一份空的＝不知道合成器現在的值）
  _shadowOf(staff) {
    const key = this._keyOf(staff);
    let sh = this._shadow.get(key);
    if (!sh) this._shadow.set(key, (sh = { cc: new Map(), program: null, pitchBend: null, channelPressure: null, paused: null }));
    return sh;
  }

  /** 合成器剛被清場（換歌載入）：不知道它現在的狀態，之後的狀態補送全部重送。 */
  clearShadow() { this._shadow.clear(); }

  /**
   * 送一個 channel 事件（B 的控制器軌事件形狀：type、data1、data2、value）到這個 staff 的輸出 channel，並記進 shadow。
   * opts：lookahead 的時間戳（eventOptions），沒有就立刻處理。poly pressure 是每個音的，不記 shadow；channel mode 訊息（120～127）
   * 是瞬間指令不記，其中 CC121 會重設一批控制器，shadow 跟著改成重設後的值。
   */
  sendChannelEvent(staff, ev, opts) {
    if (!this.synthOf(staff)) return;
    const sh = this._shadowOf(staff);
    switch (ev.type) {
      case 'controlChange':
        if (ev.data1 === CC_RESET_ALL) this._markReset(sh);
        else if (ev.data1 < 120) sh.cc.set(ev.data1, ev.value);
        break;
      case 'programChange': sh.program = ev.value; break;
      case 'pitchBend': sh.pitchBend = ev.value; break;
      case 'channelAftertouch': sh.channelPressure = ev.value; break;
    }
    this._send(staff, ev, opts);
  }

  // CC121 之後合成器的狀態（RP-015）：重設的控制器記成預設值。暫停前記下的值也作廢（channel 已經重設，續播不該恢復）。
  _markReset(sh) {
    for (const [cc, value] of RP15_RESET) sh.cc.set(cc, value);
    sh.pitchBend = BEND_CENTER;
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
    } catch (err) {}
  }

  // 同一個輸出 channel 的控制器依送出的順序生效：lookahead 帶時間戳送出、可能還沒生效的控制器（worklet 取消不了），之後送的
  // （包括立刻送的狀態補送、暫停放開踏板）時間戳不早於它，不然它晚一步生效，舊值把新值蓋掉（踏板卡住、shadow 跟合成器對不上）。
  // 時間戳已經過去的事件 worklet 一律立刻處理（spessasynth_core 的 processMessage），所以這不會讓立刻送的事件變晚；同一個時間戳
  // 的事件依送出的順序處理（worklet 的佇列是穩定排序）。你的合成器從不帶時間戳，不受影響。key：輸出 channel（_keyOf），或 'sysex'。
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
   * 重設這個輸出 channel 的控制器（載入、重播、改指派時，送初始音色與這首歌的狀態之前）：CC121（踏板放開、彎音回中央、表情 127…，
   * RP-015），再把 shadow 裡中途改過、CC121 不管的控制器（音色亮度、CC2 等）送回 GM 預設——不然它們會留到重播或下一首。bank、
   * 混音 CC7／10／91／93 不送（初始音色馬上重送）。
   */
  resetChannel(staff) {
    if (!this.synthOf(staff)) return;
    this.sendChannelEvent(staff, ccEvent(CC_RESET_ALL, 0));
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
        if (!PARAMETER_CCS.has(ev.data1) && sh.cc.get(ev.data1) === ev.value) continue;
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

  // 暫停：踩著的延音類踏板（CC64 hold、CC66 sostenuto）放開、彎音歸中央，記住原本的值給續播恢復（只送跟 shadow 不同的）。MIDI 1.0
  // 詳細規格：踏板踩著時 Note Off 與 All Notes Off 要等踏板放開才生效（不先放開就卡音）；sequencer 停止時，不在初始位置的控制器應該歸位。
  // 沒有踩著的踏板、沒有彎音就什麼都不送也不記（再暫停一次時已經放開了，所以也不會蓋掉記下的值）。
  releaseForPause(staff) {
    const sh = this._shadow.get(this._keyOf(staff));
    if (!sh || sh.paused) return;                                  // 沒送過東西／已經放開過、還沒續播
    const saved = { hold: sh.cc.get(CC_HOLD), sostenuto: sh.cc.get(CC_SOSTENUTO), pitchBend: sh.pitchBend };
    const bent = saved.pitchBend !== null && saved.pitchBend !== BEND_CENTER;
    if (!(saved.hold > 0) && !(saved.sostenuto > 0) && !bent) return;
    sh.paused = saved;
    if (saved.hold > 0) this.sendChannelEvent(staff, ccEvent(CC_HOLD, 0));
    if (saved.sostenuto > 0) this.sendChannelEvent(staff, ccEvent(CC_SOSTENUTO, 0));
    if (bent) this.sendChannelEvent(staff, bendEvent(BEND_CENTER));
  }

  // 續播：恢復暫停前的踏板與彎音（只恢復一次）
  restoreAfterPause(staff) {
    const sh = this._shadow.get(this._keyOf(staff)), saved = sh?.paused;
    if (!saved) return;
    sh.paused = null;
    if (saved.hold > 0) this.sendChannelEvent(staff, ccEvent(CC_HOLD, saved.hold));
    if (saved.sostenuto > 0) this.sendChannelEvent(staff, ccEvent(CC_SOSTENUTO, saved.sostenuto));
    if (saved.pitchBend !== null && saved.pitchBend !== BEND_CENTER) this.sendChannelEvent(staff, bendEvent(saved.pitchBend));
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
      try { synth?.systemExclusive(data, 0, opts); } catch (err) {}
    }
  }

  /**
   * 送過整體參數的 SysEx（主音量、殘響…）之後，重播與換歌前把兩個合成器整個重設（官方 reset()：整體參數與每個 channel 都回預設），
   * 不然它們會留到重播與下一首（channel 的 CC121 管不到整體參數）。重設過的合成器狀態是預設值，shadow 清掉。回傳有沒有重設。
   */
  resetIfSysexSent() {
    if (!this._sysexSent) return false;
    this._sysexSent = false;
    for (const synth of [this.assistSynth, this.humanSynth]) {
      try { synth?.reset(); } catch (err) {}
    }
    this.clearShadow();
    return true;
  }

  /* ── lookahead 的時間戳 ── */

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

  /* ── 合成器呼叫（每一個都包 try／catch）── */

  noteOn(staff, pitch, velocity, opts) {
    try { this.synthOf(staff)?.noteOn(staff.channel, pitch, velocity, opts); } catch (err) {}
  }

  noteOff(staff, pitch, opts) {
    try { this.synthOf(staff)?.noteOff(staff.channel, pitch, opts); } catch (err) {}
  }

  // CC123 All Notes Off：暫停、停止時的保險
  allNotesOff(staff) {
    try { this.synthOf(staff)?.controllerChange(staff.channel, 123, 0); } catch (err) {}
  }
}
