// ============================================================
//  outputRouter.js — 輸出路由：輸出 channel 的分配與 port 數、每個 staff 的初始音色、lookahead 的時間戳，以及排程器裡唯一會
//  呼叫合成器方法的地方（兩個合成器：電腦輔助 assist、真人 human）。純邏輯，合成器由呼叫端注入（synth.js；測試用假物件）。
//  每一次合成器呼叫都包 try／catch：音源掛掉不能拖垮排程（排程器自己的記錄照常往下走）。
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
  }

  setSynths(assistSynth, humanSynth) {
    this.assistSynth = assistSynth;
    this.humanSynth = humanSynth;
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
  // 見 GM_DEFAULT_*）。載入時送一次，比該 channel 的任何 noteOn 都早。
  applyInitialPatch(staff) {
    const synth = this.synthOf(staff);
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

  /* ── lookahead 的時間戳 ── */

  // 排程器的 tick() 開始時設、結束時清（null）：只有這段期間的電腦輔助聲部會帶時間戳。
  setAudioBase(base) {
    this._audioBase = base;
  }

  // 時鐘時刻 ms 對應的 AudioContext 時間，包成 eventOptions。只有 tick() 裡（_audioBase 有值）的電腦輔助聲部才有；
  // 你的聲部（human）與按鍵、暫停裡的呼叫回傳 undefined＝立刻處理。時刻已經過去時 worklet 也是立刻處理。
  stamp(staff, ms) {
    if (staff.kind === 'human' || !this._audioBase || ms === undefined) return undefined;
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

  // 不帶 eventOptions 的 noteOff（你的下一次按鍵時先收掉 endTick ≤ 新起音的音：一律立刻處理）
  noteOffNow(staff, pitch) {
    try { this.synthOf(staff)?.noteOff(staff.channel, pitch); } catch (err) {}
  }

  // CC123 All Notes Off：暫停、停止時的保險
  allNotesOff(staff) {
    try { this.synthOf(staff)?.controllerChange(staff.channel, 123, 0); } catch (err) {}
  }
}
