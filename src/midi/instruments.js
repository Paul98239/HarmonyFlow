// ============================================================
//  instruments.js — 樂器層：track 分組成聲部（part）與譜表（staff）、依 GM family 拆 part、staff 的初始音色、命名、音符配對；
//  以及控制器軌（每個絕對 channel 的非音符 channel 事件）、系統軌（SysEx 與分類）、文字軌（FF01～FF0F）。純邏輯，無 DOM／CDN 依賴。
// ============================================================

import { GM_DRUM_KITS, gmProgramNameZh } from './gmNames.js';
import { buildPortOffsets } from './timeline.js';

/** @typedef {import('./midiParser.js').MidiChannelEvent} MidiChannelEvent */
/** @typedef {import('./midiParser.js').MidiNote} MidiNote */

const DRUM_CHANNEL = 9; // GM1 的打擊 channel（第 10 個，索引 9）；GM2 另外允許用 Bank Select 切換，見 gmNames.js 的 GM_DRUM_KITS 說明

/* ═══════════════════════════════════════════
   解析：聲部切分（Part／staff）與音符配對
   ═══════════════════════════════════════════ */

// 切分規則（一條規則，沒有「是不是 MuseScore 檔」的分支）：
//   part ＝ MuseScore 的一個樂器（可指派的單位）。MuseScore 匯出時一個譜表一條 track，只有樂器「最上面一行譜」的 track
//   在 tick 0 對這個樂器的每個 channel 寫初始化區塊（CC121、[Bank]、Program Change、CC7／10／91／93），下面的譜表沒有。
//   所以依軌序掃描：一條 track 併入「目前這一組」，當且僅當它沒有初始化區塊（hasInit）、軌名跟這組首軌相同（任一方是空
//   的也算相同）、它的音符 channel 全在這組已知的 channel 內；否則自成新的一組。沒有音符的組（Meta 軌、空軌）不成聲部。
//   staff ＝ 組內每一個「有音符的 (track, channel)」（一個譜表 × 一個樂器 channel：鋼琴兩行譜是兩個 staff，弓弦的
//   pizzicato channel 有音時是另一個 staff）。
//   不推導高階資訊：譜號、旋律／伴奏、Voice 1–4、演奏法、踏板線、動態曲線、反覆記號在 MIDI 裡不存在或不精準，硬推只會
//   多出誤判，所以不做。已知限制：同一條 track 內的多個 channel 視為同一個樂器的音色層（format 0 的多樂器 GM 檔不會被拆開）。

const CC_BANK_MSB = 0;
const CC_BANK_LSB = 32;
const CC_RESET_ALL_CONTROLLERS = 121;
// 混音器的四個 CC：音量、聲像、殘響、合唱（MuseScore 的 Mixer 面板數值）。
const MIXER_CC = Object.freeze({ 7: 'volume', 10: 'pan', 91: 'reverb', 93: 'chorus' });
// 沒有初始化區塊時下游送的 GM 預設值（CC121 依規格不會重設音量與聲像，見 GML-v1 §3.2.5.2）。
const GM_DEFAULT_MIXER = Object.freeze({ volume: 100, pan: 64, reverb: 0, chorus: 0 });

// 逐軌摘要：有音符的 channel、tick 0 的初始化（每個 channel 的 program／bank／混音 CC，同一個值取最後一次）、
// hasInit（tick 0 有 CC121 或混音 CC；單獨的 Program Change 不算——MuseScore 下行譜有時只有 Program Change）。
function summarizeTrack(track) {
  const noteChannels = new Set();
  const initByChannel = new Map(); // channel → { program, msb, lsb, volume, pan, reverb, chorus }
  let hasInit = false;
  for (const ev of track.events) {
    if (ev.kind !== 'channel') continue;
    if (ev.type === 'noteOn' && ev.data2 > 0) noteChannels.add(ev.channel);
    if (ev.ticks !== 0 || (ev.type !== 'programChange' && ev.type !== 'controlChange')) continue;
    let init = initByChannel.get(ev.channel);
    if (!init) initByChannel.set(ev.channel, (init = {}));
    if (ev.type === 'programChange') {
      init.program = ev.data1;
    } else if (ev.type === 'controlChange') {
      const cc = ev.data1;
      if (cc === CC_RESET_ALL_CONTROLLERS || cc in MIXER_CC) hasInit = true;
      if (cc === CC_BANK_MSB) init.msb = ev.data2;
      else if (cc === CC_BANK_LSB) init.lsb = ev.data2;
      else if (cc in MIXER_CC) init[MIXER_CC[cc]] = ev.data2;
    }
  }
  return { track, noteChannels, initByChannel, hasInit };
}

// 依軌序把 track 分組（＝part）：規則見上方說明。回傳只含有音符的組，每組 { first, tracks, knownChannels }。
function groupTracks(summaries) {
  const groups = [];
  let cur = null;
  for (const s of summaries) {
    const canMerge = cur && !s.hasInit
      && (!s.track.name || !cur.first.track.name || s.track.name === cur.first.track.name)
      && [...s.noteChannels].every((ch) => cur.knownChannels.has(ch));
    if (canMerge) {
      cur.tracks.push(s);
      for (const ch of s.noteChannels) cur.knownChannels.add(ch);
    } else {
      cur = { first: s, tracks: [s], knownChannels: new Set([...s.initByChannel.keys(), ...s.noteChannels]) };
      groups.push(cur);
    }
  }
  return groups.filter((g) => g.tracks.some((t) => t.noteChannels.size > 0));
}

// 這個 channel 在這條軌裡的樂器類別：打擊（bank MSB 120；沒指定 bank 時，絕對 channel 是第 10 個）或 GM family
// （program >> 3，每 8 個音色一組：弦樂、銅管、簧管…）。判定順序跟 buildPart() 決定 staff 音色的規則一致：首軌 tick 0 對這個
// channel 的初始化優先（MuseScore 的下行譜沿用首軌的）；首軌沒有，才看這條軌在該 channel 第一顆音之前最後一次送的
// Program Change／Bank Select；都沒有就當 program 0、bank 沒指定。
function instrumentClassOf(group, summary, channel, absChannel) {
  const fromFirst = group.first.initByChannel.get(channel);
  let program = fromFirst?.program, msb = fromFirst?.msb;
  if (program === undefined || msb === undefined) {
    let ownProgram, ownMsb;
    for (const ev of summary.track.events) {
      if (ev.kind !== 'channel' || ev.channel !== channel) continue;
      if (ev.type === 'noteOn' && ev.data2 > 0) break;
      if (ev.type === 'programChange') ownProgram = ev.data1;
      else if (ev.type === 'controlChange' && ev.data1 === CC_BANK_MSB) ownMsb = ev.data2;
    }
    program ??= ownProgram ?? 0;
    msb ??= ownMsb;
  }
  const isDrum = msb === 120 || (msb === undefined && absChannel % 16 === DRUM_CHANNEL);
  return isDrum ? '打擊' : `family ${program >> 3}`;
}

// 同一組 track（一個 part）裡如果有「不同樂器類別」的 channel（format 0 的多樂器檔、同軌混打擊與旋律），拆成不同的 part；
// 同一個 GM family 的 channel（MuseScore 的 普通 40／撥奏 45／震音 44 這種演奏法 channel）維持在同一個 part。
// part id：第一個 part 沿用 p＋首軌序號，其餘依序 p＋首軌序號＋.1、.2…（id 只是不透明的字串）。
function splitGroupsByInstrument(groups, portOffsets, warn) {
  const out = [];
  for (const group of groups) {
    const byClass = new Map(); // 樂器類別 → [{ summary, channels }]
    for (const summary of group.tracks) {
      const abs = portOffsets.get(summary.track.index) ?? 0;
      for (const channel of [...summary.noteChannels].sort((a, b) => a - b)) {
        const cls = instrumentClassOf(group, summary, channel, channel + abs);
        if (!byClass.has(cls)) byClass.set(cls, new Map());
        const perTrack = byClass.get(cls);
        if (!perTrack.has(summary)) perTrack.set(summary, new Set());
        perTrack.get(summary).add(channel);
      }
    }
    if (byClass.size <= 1) { out.push(group); continue; }
    const baseId = `p${group.first.track.index}`;
    [...byClass.values()].forEach((perTrack, i) => {
      out.push({
        first: group.first, knownChannels: group.knownChannels, id: i === 0 ? baseId : `${baseId}.${i}`,
        tracks: [...perTrack].map(([summary, channels]) => ({ ...summary, noteChannels: channels })),
      });
    });
    warn(`part ${baseId}（track ${group.tracks.map((t) => t.track.index).join('、')}）含 ${byClass.size} 種不同樂器（${[...byClass.keys()].join('、')}），已拆成 ${byClass.size} 個 part`);
  }
  return out;
}

// Program Change 是 channel 的狀態、跨軌共用，但「跨軌共用」不代表可以照檔案裡的軌道排列
// 順序處理——一顆音該用哪個 program，要看「這個時間點」該 channel 實際生效的值，不是「前面
// 處理過的軌道留下的值」。這裡建一份查詢器：優先用同一軌自己在這個時間點之前最後一次送過的
// Program Change；這軌自己從沒送過時，才查全曲所有軌、同一個絕對 channel、時間點更早（同 tick 依
// 軌序決定）的最後一次 Program Change；兩者都沒有就回傳規格預設值 0。
// 呼叫端必須依「事件在檔案裡出現的順序」使用：換軌時呼叫 resetTrack()，逐一遇到 Program
// Change 事件時呼叫 noteProgramChange()，查詢在這之間穿插進行——collectNotes() 本來就是這樣
// 逐軌逐事件處理，不需要額外排序。
export function buildProgramResolver(tracks) {
  // 全曲查詢的 key 是「絕對 channel」（軌內 channel ＋ port 偏移）：不同 port 的同號 channel 是不同的 channel，
  // 只用軌內 channel 當 key 的話，沒有自己 Program Change 的軌會吃到別的 port 同號 channel 的音色。
  const portOffsets = buildPortOffsets(tracks);
  const absChannel = (trackIndex, channel) => channel + (portOffsets.get(trackIndex) ?? 0);
  const globalByChannel = new Map(); // 絕對 channel → [{ticks, trackIndex, program}]（依 tick、軌序排序）
  for (const track of tracks) {
    for (const ev of track.events) {
      if (ev.kind !== 'channel' || ev.type !== 'programChange') continue;
      const key = absChannel(track.index, ev.channel);
      let list = globalByChannel.get(key);
      if (!list) globalByChannel.set(key, (list = []));
      list.push({ ticks: ev.ticks, trackIndex: track.index, program: ev.data1 });
    }
  }
  for (const list of globalByChannel.values()) {
    list.sort((a, b) => a.ticks - b.ticks || a.trackIndex - b.trackIndex);
  }

  function globalLookup(channel, ticks) {
    const list = globalByChannel.get(channel);
    if (!list || !list.length) return null;
    let lo = 0, hi = list.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].ticks <= ticks) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans === -1 ? null : list[ans].program;
  }

  let localProgram = new Map(); // 目前這一軌自己已知的 program，軌內 channel → program
  let currentTrack = -1;        // 目前處理到哪一軌：全曲查詢要靠它算出絕對 channel
  return {
    resetTrack(trackIndex) { localProgram = new Map(); currentTrack = trackIndex; },
    noteProgramChange(channel, program) { localProgram.set(channel, program); },
    programAt(channel, ticks) {
      if (localProgram.has(channel)) return localProgram.get(channel);
      const global = globalLookup(absChannel(currentTrack, channel), ticks);
      return global != null ? global : 0;
    },
  };
}

/**
 * @param {string} partId
 * @param {string} staffId
 * @param {number} trackIndex
 * @param {number} eventIndex  note on 在這條軌事件清單裡的序號（id 用）
 * @param {number} channel  絕對 channel（含 port 偏移）
 * @param {MidiChannelEvent} onEvent
 * @param {number} endTick
 * @param {(ticks:number) => number} midiTicksToSeconds
 * @returns {MidiNote}
 */
function makeNote(partId, staffId, trackIndex, eventIndex, channel, onEvent, endTick, midiTicksToSeconds) {
  const startSeconds = midiTicksToSeconds(onEvent.ticks);
  const endSeconds = midiTicksToSeconds(endTick);
  return {
    id: `${trackIndex}:${eventIndex}`, // 同一版 parser 解析同一個檔一定相同（官方 timeline 的 {tr, ev}），給視覺化對應、日誌與事件排序用
    partId,
    staffId,
    trackIndex,
    eventIndex,
    channel,
    midiNote: onEvent.data1,
    velocity: onEvent.data2,
    startTick: onEvent.ticks,
    endTick,
    durationTicks: endTick - onEvent.ticks,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
  };
}

// 逐軌逐事件把 note-on／note-off 配成音，同時記下每個 staff 的統計（第一顆音當下生效的 program／bank、音符數、起訖、
// 同音高重疊次數）。staffIndex：`${trackIndex}:${軌內 channel}` → { partId, staffId, channel（絕對） }。
function collectNotes(tracks, midiTicksToSeconds, warn, programResolver, staffIndex) {
  const notes = [];
  const statsByStaff = new Map(); // staffId → { program, bank, noteCount, startTick, endTick, overlaps, minPitch, maxPitch }
  const statsOf = (vk, program, bank) => {
    let st = statsByStaff.get(vk.staffId);
    if (!st) statsByStaff.set(vk.staffId, (st = { program, bank, noteCount: 0, startTick: Infinity, endTick: 0, overlaps: 0, minPitch: 127, maxPitch: 0 }));
    return st;
  };
  const emit = (vk, trackIndex, eventIndex, onEv, endTick) => {
    const note = makeNote(vk.partId, vk.staffId, trackIndex, eventIndex, vk.channel, onEv, endTick, midiTicksToSeconds);
    const st = statsByStaff.get(vk.staffId);
    st.noteCount++;
    st.startTick = Math.min(st.startTick, note.startTick);
    st.endTick = Math.max(st.endTick, note.endTick);
    st.minPitch = Math.min(st.minPitch, note.midiNote);
    st.maxPitch = Math.max(st.maxPitch, note.midiNote);
    notes.push(note);
  };

  for (const track of tracks) {
    programResolver.resetTrack(track.index);
    const runningBank = new Map(); // channel → { msb, lsb }：這一軌到目前為止最後一次送的 Bank Select
    // key = channel * 128 + 音高。同一 key 可能同時有多顆未收尾的音（同音重疊），
    // 以先進先出配對：先響的音先被關掉，這是最貼近演奏直覺的解讀。
    const pending = new Map();
    // 沒有對應 note on 的 note off（孤立 note off）：先收集，軌處理完才分類。MuseScore 的樂器有多個演奏法 channel（普通、
    // 撥奏、震音），每個音起音時會對其他演奏法的 channel 補送一個同音高的 note off（把它們切掉），一首歌可以有上千個。
    // 認得出這種補送（同一軌、同一個 tick、同一個音高，別的 channel 有 note on）就不警告；認不出的才依 channel 計數、
    // 各報一則（逐個報警會洗版、還會撞到警告數量上限，把後面真正的警告吃掉）。
    // 這是匯出器的慣例，不是 SMF 規格（見 CLAUDE.md A16）；孤立 note off 不管有沒有警告都是被忽略的，不影響音符。
    const strayOffs = [];        // { channel, ticks, pitch }
    // (tick, 音高) → 在這個位置有 note on 的 channel 集合。集合用 16 位元的整數表示：第 c 位是 1 ＝ channel c 在場
    // （位元遮罩 bitmask，像指示向量 indicator vector；`1 << c` 是只有第 c 位為 1 的向量）。key 用 tick * 128 + 音高，
    // 音高 0～127 所以不會撞（tick 最大約 1e7，乘 128 仍遠小於 2^53，number 能精確表示）。
    const onChannelsAt = new Map();
    for (let eventIndex = 0; eventIndex < track.events.length; eventIndex++) {
      const ev = track.events[eventIndex];
      if (ev.kind !== 'channel') continue;
      if (ev.type === 'programChange') { programResolver.noteProgramChange(ev.channel, ev.data1); continue; }
      if (ev.type === 'controlChange' && (ev.data1 === CC_BANK_MSB || ev.data1 === CC_BANK_LSB)) {
        let b = runningBank.get(ev.channel);
        if (!b) runningBank.set(ev.channel, (b = { msb: 0, lsb: 0 }));
        if (ev.data1 === CC_BANK_MSB) b.msb = ev.data2; else b.lsb = ev.data2;
        continue;
      }
      const isNoteOn = ev.type === 'noteOn' && ev.data2 > 0;
      // 規格允許用「力度 0 的 note on」代替 note off（可讓整段音符共用 running status），
      // 實務上絕大多數檔案都這樣寫。
      const isNoteOff = ev.type === 'noteOff' || (ev.type === 'noteOn' && ev.data2 === 0);
      if (!isNoteOn && !isNoteOff) continue;

      const key = ev.channel * 128 + ev.data1;
      if (isNoteOn) {
        const vk = staffIndex.get(`${track.index}:${ev.channel}`);
        // staff 的 program／bank 取「第一顆音響起當下」生效的值（沒有初始化區塊時才會用到，見 buildPart()）。
        const st = statsOf(vk, programResolver.programAt(ev.channel, ev.ticks), runningBank.has(ev.channel) ? { ...runningBank.get(ev.channel) } : null);
        let queue = pending.get(key);
        if (!queue) pending.set(key, (queue = []));
        if (queue.length) st.overlaps++;
        queue.push({ ev, vk, eventIndex });
        const at = ev.ticks * 128 + ev.data1;
        onChannelsAt.set(at, (onChannelsAt.get(at) ?? 0) | (1 << ev.channel)); // | ＝ 把 channel 加進集合（聯集）
        continue;
      }
      const queue = pending.get(key);
      if (!queue || !queue.length) {
        strayOffs.push({ channel: ev.channel, ticks: ev.ticks, pitch: ev.data1 });
        continue;
      }
      const { ev: onEv, vk, eventIndex: onIndex } = queue.shift();
      emit(vk, track.index, onIndex, onEv, ev.ticks);
    }
    // 要等整條軌掃完才分類：補送的 note off 跟 note on 在同一個 tick，誰先寫沒有規定，不能邊掃邊判。
    const unexplained = new Map(); // channel → { count, ticks, pitch }（第一個對不上的位置，方便追查）
    for (const { channel, ticks, pitch } of strayOffs) {
      // & ~(1 << channel)：取「別的 channel」的集合（`~` 是補集、`&` 是交集），非 0 ＝ 別的 channel 在這裡有 note on
      if ((onChannelsAt.get(ticks * 128 + pitch) ?? 0) & ~(1 << channel)) continue;
      const entry = unexplained.get(channel);
      if (entry) entry.count++;
      else unexplained.set(channel, { count: 1, ticks, pitch });
    }
    for (const [channel, { count, ticks, pitch }] of unexplained) {
      warn(`track ${track.index} 的 channel ${channel}：${count} 個 note off 沒有對應的 note on，已忽略（第一個在 tick ${ticks}、音高 ${pitch}；不是 MuseScore 補送的那種：同 tick、同音高在別的 channel 找不到 note on）`);
    }
    for (const [key, queue] of pending) {
      for (const { ev: on, vk, eventIndex } of queue) {
        warn(`track ${track.index} 的 tick ${on.ticks}：channel ${(key / 128) | 0} 音高 ${key % 128} 的 note on 沒有對應的 note off，已在軌尾收尾`);
        emit(vk, track.index, eventIndex, on, Math.max(on.ticks, track.endTick));
      }
    }
  }
  notes.sort(
    (a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex || a.channel - b.channel || a.midiNote - b.midiNote
  );
  return { notes, statsByStaff };
}

// 一組 track（part）→ part 物件與底下的 staff。staff 的初始狀態：
//   · 這組首軌在 tick 0 對這個 channel 有初始化 → 直接採用（program；bank；混音 CC7／10／91／93，缺的補 GM 預設）。
//     下行譜的 staff 沿用首軌對同一個 channel 的初始化（MuseScore 只在最上行譜寫初始化區塊）。
//   · 沒有 → program 沿用時間軸查詢（自己軌優先、再查全曲、預設 0；見 buildProgramResolver），bank 取第一顆音之前最後一次
//     送的 CC0／CC32，混音 init 記 null（下游用 GM 預設）。
//   · bank 都沒送過時用 GM2 §3.3.1 的規格預設（絕對 channel 的第 10 個 channel 是節奏 bank 120，其餘是旋律 bank 121）；
//     percussionKit ＝ bank MSB 為 120（GM2 §2.4：任何 channel 送 Bank 78H 都是節奏通道，不限 channel 9）。
function buildPart(group, partId, statsByStaff, staffIndex, warn) {
  const staves = [];
  for (const summary of group.tracks) {
    for (const channel of [...summary.noteChannels].sort((a, b) => a - b)) {
      const vk = staffIndex.get(`${summary.track.index}:${channel}`);
      const st = statsByStaff.get(vk.staffId);
      const fromInit = group.first.initByChannel.get(channel) || null;
      const hasBank = fromInit && (fromInit.msb !== undefined || fromInit.lsb !== undefined);
      const defaultMsb = vk.channel % 16 === DRUM_CHANNEL ? 120 : 121;
      const bank = hasBank ? { msb: fromInit.msb ?? defaultMsb, lsb: fromInit.lsb ?? 0 } : (st.bank ?? { msb: defaultMsb, lsb: 0 });
      const program = fromInit?.program ?? st.program;
      const percussionKit = bank.msb === 120;
      const hasMixer = fromInit && Object.values(MIXER_CC).some((k) => fromInit[k] !== undefined);
      const init = hasMixer ? Object.fromEntries(Object.entries(GM_DEFAULT_MIXER).map(([k, d]) => [k, fromInit[k] ?? d])) : null;
      if (percussionKit && !(program in GM_DRUM_KITS)) {
        // 這裡只確定「不是 GM2 規格附錄 B 定義的編號」，顯示名稱因此只能退回用「標準鼓組」代替
        // （見 gmProgramNameZh() 的說明）——但實際播放時會不會也退回標準鼓組，取決於載入的
        // SoundFont 有沒有另外提供這個編號的鼓組（查證過 GeneralUserGS.sf3 就額外提供了
        // program 1/2/26/127 這幾組，不會真的退回標準鼓組），這裡不能斷言一定會退回，只能
        // 提醒顯示名稱不準確。
        warn(`track ${summary.track.index} 的 channel ${channel}：鼓組 program ${program} 不是 GM2 規格附錄 B 定義的編號，顯示名稱只能用「標準鼓組」代替，實際會播放哪一組鼓聲取決於載入的 SoundFont 有沒有提供這個編號`);
      }
      if (st.overlaps) {
        warn(`track ${summary.track.index} 的 channel ${channel}：同音高重疊 ${st.overlaps} 次（依先進先出配對，每個 note-on 配到最早還沒結束的那顆音）`);
      }
      staves.push({
        id: vk.staffId, partId, trackIndex: summary.track.index, channel: vk.channel, program, bank, percussionKit, init,
        noteCount: st.noteCount, startTick: st.startTick, endTick: st.endTick, minPitch: st.minPitch, maxPitch: st.maxPitch,
      });
    }
  }
  return {
    id: partId,
    name: '', // nameParts() 補：要先數過所有 part 才知道哪些音色名需要加序號
    noteCount: staves.reduce((sum, v) => sum + v.noteCount, 0),
    startTick: Math.min(...staves.map((v) => v.startTick)),
    endTick: Math.max(...staves.map((v) => v.endTick)),
    staves,
  };
}

// 命名：基底名＝part 的主 staff（音符最多，同數取 channel 小者）的 GM 繁中音色名，打擊用鼓組名，查不到才用「聲部 N」；
// 不採信軌名、不放高低音譜／旋律伴奏／bank 的任何描述。整份總譜有 ≥2 個 part 基底名相同時依 part 順序（＝總譜由上而下）
// 加序號「 1」「 2」…；基底名本身以數字結尾（「弦樂合奏 1」）改用全形括號「（1）」，免得疊成「弦樂合奏 1 1」這種容易誤讀的雙重編號。
function nameParts(parts) {
  const bases = parts.map((part, i) => {
    const main = [...part.staves].sort((a, b) => b.noteCount - a.noteCount || a.channel - b.channel)[0];
    return gmProgramNameZh(main.program, main.percussionKit) || `聲部 ${i + 1}`;
  });
  const sameBase = (i) => bases.filter((b) => b === bases[i]).length;
  const seen = new Map();
  parts.forEach((part, i) => {
    if (sameBase(i) === 1) { part.name = bases[i]; return; }
    const n = (seen.get(bases[i]) || 0) + 1;
    seen.set(bases[i], n);
    part.name = /\d$/.test(bases[i]) ? `${bases[i]}（${n}）` : `${bases[i]} ${n}`;
  });
}

// 整個聲部切分：track 摘要 → 分組（part）→ 配對音符（同時算 staff 統計）→ 組成 part／staff → 命名。
export function collectPartsAndNotes(tracks, midiTicksToSeconds, warn, programResolver) {
  const portOffsets = buildPortOffsets(tracks);
  const groups = splitGroupsByInstrument(groupTracks(tracks.map(summarizeTrack)), portOffsets, warn);
  // `${trackIndex}:${軌內 channel}` → { partId, staffId, channel（絕對） }；part id ＝ p＋首軌序號（一組拆成多個 part 時依序加 .1、.2…），
  // staff id ＝ t＋軌序號＋c＋絕對 channel。
  const staffIndex = new Map();
  const partIds = new Map(groups.map((g) => [g, g.id ?? `p${g.first.track.index}`]));
  for (const group of groups) {
    for (const summary of group.tracks) {
      for (const channel of summary.noteChannels) {
        const abs = channel + (portOffsets.get(summary.track.index) ?? 0);
        staffIndex.set(`${summary.track.index}:${channel}`, { partId: partIds.get(group), staffId: `t${summary.track.index}c${abs}`, channel: abs });
      }
    }
  }

  const { notes, statsByStaff } = collectNotes(tracks, midiTicksToSeconds, warn, programResolver, staffIndex);
  const parts = groups.map((group) => buildPart(group, partIds.get(group), statsByStaff, staffIndex, warn));
  nameParts(parts);
  if (!parts.length) warn('這份檔案裡沒有任何音符，切分不出聲部');
  return { parts, notes };
}

/* ═══════════════════════════════════════════
   控制器軌：每個絕對 channel 的非音符 channel 事件
   ═══════════════════════════════════════════ */

// 全曲事件的排序鍵（tick → 軌序號 → 軌內序號）＝官方 BasicMIDI timeline 的順序；id 就是「軌序號:軌內序號」。
export const byFileOrder = (a, b) => a.ticks - b.ticks || a.trackIndex - b.trackIndex || a.eventIndex - b.eventIndex;
const eventRef = (trackIndex, eventIndex, ev) => ({ id: `${trackIndex}:${eventIndex}`, ticks: ev.ticks, trackIndex, eventIndex });

// channel 事件解碼後的值：pitch bend 是 14-bit（LSB 在 data1、MSB 在 data2，中心 8192）；program 與 channel pressure 只有
// data1；CC 與 poly pressure 的值在 data2（CC 編號、poly 的音高在 data1）。
function laneValue(ev) {
  if (ev.type === 'pitchBend') return (ev.data2 << 7) | ev.data1;
  if (ev.type === 'programChange' || ev.type === 'channelAftertouch') return ev.data1;
  return ev.data2;
}

/**
 * 每個用到的絕對 channel 一條控制器軌：這個 channel 所有非音符的 channel 事件（CC 0～127、program change、pitch bend、
 * channel／poly pressure），依官方 timeline 的順序。控制器屬於 channel、不屬於譜表：同一個 channel 的所有 staff 共用同一條
 * （staff.channel 就是鑰匙；只有音符的 channel 也有一條空的，所以一定找得到）。tick 0 的事件也在裡面（staff.init 照舊是摘要）。
 * @param {import('./midiParser.js').MidiTrack[]} tracks
 * @param {Map<number, number>} portOffsets  buildPortOffsets() 的結果
 * @returns {Map<number, import('./midiParser.js').LaneEvent[]>}  依絕對 channel 遞增
 */
export function collectChannelLanes(tracks, portOffsets) {
  const lanes = new Map();
  for (const track of tracks) {
    const offset = portOffsets.get(track.index) ?? 0;
    track.events.forEach((ev, eventIndex) => {
      if (ev.kind !== 'channel') return;
      const channel = ev.channel + offset;
      if (!lanes.has(channel)) lanes.set(channel, []);
      if (ev.type === 'noteOn' || ev.type === 'noteOff') return;
      lanes.get(channel).push({ ...eventRef(track.index, eventIndex, ev), channel, type: ev.type, data1: ev.data1, data2: ev.data2, value: laneValue(ev) });
    });
  }
  for (const lane of lanes.values()) lane.sort(byFileOrder);
  return new Map([...lanes].sort((a, b) => a[0] - b[0]));
}

/* ═══════════════════════════════════════════
   系統軌（SysEx 與分類）與文字軌（FF01～FF0F）
   ═══════════════════════════════════════════ */

// SysEx 分類：只解析、不送（要不要送、怎麼送由播放端決定）。data 是 F0 之後的位元組（含結尾的 F7，跟官方 processor 收到的一樣）。
// 依據：MIDI 1.0 的 Universal System Exclusive（7E 非即時、7F 即時；第 2 個位元組是裝置 ID）：GM1 On 7E dev 09 01、GM Off 09 02、
// GM2 On 09 03；Roland GS 的 DT1：41 dev 42 12 位址(3) 資料… checksum（40 00 7F 是 GS Reset，SC-88 的 00 00 7F 也是重設）；
// Yamaha XG 的參數變更：43 1n 4C 位址(3) 資料（00 00 7E 是 XG System On）。GS／XG 的參數依位址判斷是不是指定某個 part：輸出
// channel 重新分配之後，位址裡的 part 會對不上，播放端要另外處理——GS 是 40／50（SC-88 的 port B）開頭、第 2 個位址的高 4 bit
// 是 1／2／4（part 參數區；41 開頭的鼓組設定不是）；XG 是 08 開頭（Multi Part）。分不出來的（長度不夠、資料請求、其他廠商）
// 一律 other，保留原始資料，不猜。
export function classifySysex(data) {
  const n = data.length;
  if (data[0] === 0x7e && n >= 5 && data[2] === 0x09 && data[3] >= 0x01 && data[3] <= 0x03) {
    return { category: ['gmOn', 'gmOff', 'gm2On'][data[3] - 1] };
  }
  if (data[0] === 0x7e && n >= 4) return { category: 'universalNonRealTime' };
  if (data[0] === 0x7f && n >= 4) return { category: 'universalRealTime' };
  if (data[0] === 0x41 && n >= 10 && data[2] === 0x42 && data[3] === 0x12) {
    const [a1, a2, a3] = [data[4], data[5], data[6]];
    if ((a1 === 0x40 || a1 === 0x00) && a2 === 0x00 && a3 === 0x7f) return { category: 'gsReset' };
    return { category: 'gsParameter', channelSpecific: (a1 === 0x40 || a1 === 0x50) && [0x10, 0x20, 0x40].includes(a2 & 0xf0) };
  }
  if (data[0] === 0x43 && n >= 8 && (data[1] & 0xf0) === 0x10 && data[2] === 0x4c) {
    const [a1, a2, a3] = [data[3], data[4], data[5]];
    if (a1 === 0x00 && a2 === 0x00 && a3 === 0x7e) return { category: 'xgOn' };
    return { category: 'xgParameter', channelSpecific: a1 === 0x08 };
  }
  return { category: 'other' };
}

/**
 * 全曲的 SysEx（F0）與 escape（F7）事件，依 tick → 軌序 → 軌內序，附分類（escape 是分段傳送的後續封包或任意位元組，一律 other）。
 * @returns {import('./midiParser.js').SystemEvent[]}
 */
export function collectSystemEvents(tracks) {
  const out = [];
  for (const track of tracks) {
    track.events.forEach((ev, eventIndex) => {
      if (ev.kind !== 'sysex') return;
      out.push({ ...eventRef(track.index, eventIndex, ev), type: ev.type, data: ev.data, ...(ev.type === 'sysex' ? classifySysex(ev.data) : { category: 'other' }) });
    });
  }
  return out.sort(byFileOrder);
}

/**
 * FF01～FF0F 的文字類 meta（文字、版權、軌名、樂器名、歌詞、標記、cue point、程式名、裝置名…），依 tick → 軌序 → 軌內序。
 * 不解讀內容（歌詞的語言與顯示延伸 RP-017／RP-026 等視覺化真的用到再看）。
 * @returns {import('./midiParser.js').TextEvent[]}
 */
export function collectTextEvents(tracks) {
  const out = [];
  for (const track of tracks) {
    track.events.forEach((ev, eventIndex) => {
      if (ev.kind === 'meta' && ev.type >= 0x01 && ev.type <= 0x0f) out.push({ ...eventRef(track.index, eventIndex, ev), type: ev.type, text: ev.text });
    });
  }
  return out.sort(byFileOrder);
}
