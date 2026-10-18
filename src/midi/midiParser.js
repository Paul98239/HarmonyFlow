// midiParser.js — 解析入口與資料型別，對外唯一出口：呼叫端一律只 import 這個檔。parseMidi(await file.arrayBuffer())；
// parsed.parts＝聲部（MuseScore 一個樂器＝一個 part，底下是 staff＝譜表 × channel），parsed.segments＝全曲垂直切片（scheduler.js 一次觸發放行一個），parsed.notes＝連同 parts 建立 staff。
// 分層（每層只依賴下面的層）：midiFile.js 讀檔 → timeline.js 時間（速度表、tick ↔ 秒、拍號／調號、port 偏移、格線）→ parts.js（名稱表、聲部切分、音符配對、控制器軌／系統軌／文字軌、控制器狀態與 chase）；本檔依序呼叫各層並轉出它們的名稱。

import { makeWarn, readSmf, findLastVoiceEventTick } from './midiFile.js';
import { buildTempoMap, makeMidiTicksToSeconds, makeSecondsToMIDITicks, buildTimeSignatures, buildKeySignatures, buildPortOffsets } from './timeline.js';
import { buildProgramResolver, collectPartsAndNotes, collectChannelLanes, collectSystemEvents, collectTextEvents } from './parts.js';

export { META, MidiParseError } from './midiFile.js';
export { gmProgramNameZh, midiNoteName, ChannelStateTracker, controllerStateAt, chaseEventsAt, byFileOrder } from './parts.js';
export { CC, DRUM_CHANNEL, BANK_MSB_RHYTHM, BANK_MSB_MELODY, PITCH_BEND_CENTER, RESET_CC, PARAMETER_CC, GM_DEFAULT_MIXER } from './parts.js';
export { buildMeasureGrid, buildBeatGrid } from './timeline.js';

// 全曲的垂直切片（名稱借自 MuseScore 的 Segment）：notes 已依 startTick 排序，相同 startTick 的音一定相鄰，線性掃描 O(n) 即可。
// 排程器一次放行一個 segment，全曲所有聲部在同一次呼叫內一起起音，上下對齊由結構保證，不靠時間比對。
export function buildSegments(notes) {
  const segments = [];
  for (const note of notes) {
    const last = segments[segments.length - 1];
    if (last && last.ticks === note.startTick) last.notes.push(note);
    else segments.push({ ticks: note.startTick, notes: [note] });
  }
  return segments;
}

// 資料模型的型別（JSDoc typedef）：手寫一份而不用 ReturnType<typeof parseMidi>：TypeScript 把 .js 的物件字面量當「開放的」，讀到不存在的屬性不會報錯，要抓錯字就得有「封閉」的宣告。
// 改了 midiFile.js 的 parseTrack、parts.js 的 makeNote／collectPartsAndNotes 的欄位時同步改這裡。其他模組用 import('./midiParser.js').ParsedMidi 取得。

/**
 * channel voice message（note-on／off、CC、program change、pitch bend…）。
 * data1／data2 的意義依 type 而定，見 midiFile.js 的 CHANNEL_DATA_BYTES 旁的對照表。
 * @typedef {object} MidiChannelEvent
 * @property {number} ticks * @property {'channel'} kind
 * @property {'noteOff'|'noteOn'|'polyAftertouch'|'controlChange'|'programChange'|'channelAftertouch'|'pitchBend'} type
 * @property {number} channel  0~15
 * @property {number} data1
 * @property {number} data2  單資料位元組的訊息（programChange／channelAftertouch）固定 0
 */

/**
 * meta 事件（FF xx）。data 是原始位元組；decorateMeta() 依 type 另外解出語意欄位（有就有、沒有就 undefined）。
 * @typedef {object} MidiMetaEvent
 * @property {number} ticks * @property {'meta'} kind
 * @property {number} type  meta 型別位元組（見 META）
 * @property {Uint8Array} data
 * @property {string} [text]  FF 01~0F 的文字類 meta
 * @property {number} [sequenceNumber]
 * @property {number} [channelPrefix]
 * @property {number} [port]
 * @property {number} [microsecondsPerQuarter]  FF 51
 * @property {number} [bpm]
 * @property {{hours:number, minutes:number, seconds:number, frames:number, subFrames:number}} [smpteOffset]
 * @property {number} [numerator]  FF 58
 * @property {number} [denominator]
 * @property {number} [clocksPerClick]
 * @property {number} [thirtySecondNotesPer24Clocks]
 * @property {number} [sharpsFlats]  FF 59，負數代表降記號個數
 * @property {boolean} [minor]
 */

/**
 * @typedef {object} MidiSysexEvent
 * @property {number} ticks * @property {'sysex'} kind
 * @property {'sysex'|'escape'} type  F0 或 F7
 * @property {Uint8Array} data
 */

/** @typedef {MidiChannelEvent|MidiMetaEvent|MidiSysexEvent} MidiEvent */

/**
 * @typedef {object} MidiTrack
 * @property {number} index
 * @property {string} name  FF 03；沒有就空字串
 * @property {string} instrumentName  FF 04；沒有就空字串
 * @property {string} deviceName  FF 09（RP-019）；沒有就空字串
 * @property {number|null} port  FF 21
 * @property {number[]} channels  這一軌用到的 channel（0~15，遞增）
 * @property {MidiEvent[]} events  依檔案順序，tick 為絕對值
 * @property {number} endTick
 */

/**
 * SMF 檔頭的 division。ppq：每四分音符幾個 tick；smpte：每秒幾格 × 每格幾個 tick。
 * @typedef {{type:'ppq', ticksPerQuarter:number, raw:number} | {type:'smpte', nominalFps:number, framesPerSecond:number, ticksPerFrame:number, ticksPerSecond:number, ticksPerQuarter:null, raw:number}} MidiDivision
 */

/** @typedef {{ticks:number, microsecondsPerQuarter:number, bpm:number, seconds:number}} TempoMapEntry */
/** @typedef {{ticks:number, numerator:number, denominator:number, clocksPerClick:number, thirtySecondNotesPer24Clocks:number}} TimeSignatureEntry */
/** @typedef {{ticks:number, sharpsFlats:number, minor:boolean}} KeySignatureEntry */

/**
 * 一顆音（note-on 配對到 note-off 之後的結果），由 collectNotes() 產生。
 * @typedef {object} MidiNote
 * @property {string} id  「軌序號:note on 在該軌事件清單的序號」：同一版 parser 解析同一個檔一定相同（官方 timeline 的 {tr, ev}）
 * @property {string} partId  所屬 part（MuseScore 的一個樂器）
 * @property {string} staffId  所屬 staff（一個譜表 × 一個樂器 channel）
 * @property {number} trackIndex
 * @property {number} eventIndex  note on 在 tracks[trackIndex].events 的序號
 * @property {number} channel  絕對 channel：軌內 channel 加上 port 偏移（依 port 第一次出現的順序 +16，跟官方 SpessaSynth 一致）
 * @property {number} midiNote  音高 0~127
 * @property {number} velocity  note-on 的力度
 * @property {number} startTick
 * @property {number} endTick
 * @property {number} durationTicks
 * @property {number} startSeconds
 * @property {number} endSeconds
 * @property {number} durationSeconds
 */

/**
 * 一個 staff ＝ 組內一個「有音符的 (track, channel)」：一個譜表 × 一個樂器 channel（排程單位）。
 * @typedef {object} MidiStaff
 * @property {string} id  t{trackIndex}c{絕對 channel}
 * @property {string} partId
 * @property {number} trackIndex
 * @property {number} channel  絕對 channel（含 port 偏移）
 * @property {number} program  GM program：有初始化區塊用 tick 0 的值，沒有就依時間軸查詢（預設 0）
 * @property {{msb:number, lsb:number}} bank  Bank Select；檔案從未送過就是 GM2 §3.3.1 的規格預設值
 *   （第 10 個 channel 為 120/0 節奏，其餘為 121/0 旋律）
 * @property {boolean} percussionKit  bank MSB 是否為 120（GM2 §2.4：任何 channel 都可以切成節奏通道）
 * @property {{volume:number, pan:number, reverb:number, chorus:number}|null} init
 *   tick 0 的混音初始化（CC7／10／91／93，缺的補 GM 預設）；沒有初始化區塊是 null（下游用 GM 預設 100／64／0／0）
 * @property {number} noteCount
 * @property {number} startTick
 * @property {number} endTick
 * @property {number} minPitch  這個 staff 最低的音高（MIDI 0~127），分譜清單顯示譜表音域用
 * @property {number} maxPitch  最高的音高
 */

/**
 * 全曲同一個 startTick 的所有音（跨聲部、跨譜表）。
 * @typedef {object} MidiSegment
 * @property {number} ticks  這個 segment 的起音 tick（＝裡面每顆音的 startTick）
 * @property {MidiNote[]} notes  維持 notes 的排序（trackIndex、channel、midiNote）
 */

/**
 * 一個聲部（part）＝ MuseScore 的一個樂器，可指派的單位；底下有一個以上的 staff（鋼琴兩行譜是兩個 staff）。
 * 切分規則見 parts.js 的「聲部切分」說明。
 * @typedef {object} MidiPart
 * @property {string} id  p{首軌的 track 序號}
 * @property {string} name  GM 繁中音色名（取主 staff 的音色；同名依序加序號）
 * @property {number} noteCount
 * @property {number} startTick
 * @property {number} endTick
 * @property {MidiStaff[]} staves
 */

/**
 * 控制器軌裡的一個事件（非音符的 channel 事件）。trackIndex／eventIndex 指回原檔：tracks[trackIndex].events[eventIndex]。
 * @typedef {object} LaneEvent
 * @property {string|null} id  「軌序號:軌內序號」；chase 補送的合成事件是 null
 * @property {number} ticks
 * @property {number} trackIndex
 * @property {number} eventIndex
 * @property {number} channel  絕對 channel（含 port 偏移）
 * @property {'controlChange'|'programChange'|'pitchBend'|'channelAftertouch'|'polyAftertouch'} type
 * @property {number} data1  原始資料（CC 編號、音色編號、pitch bend 的 LSB、壓力、poly 的音高）
 * @property {number} data2  原始資料（單資料位元組的訊息固定 0）
 * @property {number} value  解碼後的值：CC 值、音色編號、pitch bend 14-bit（中心 8192）、壓力
 * @property {true} [synthetic]  chase 補送、原檔沒有的事件（CC121 之後的預設值、選參數）
 */

/**
 * 某個 tick 之前一個 channel 的控制器狀態（parts.js 的 controllerStateAt()）。null＝檔案還沒設過（接收端的預設值）。
 * @typedef {object} ControllerState
 * @property {(number|null)[]} cc  每個控制器編號最後的值（原始資料；CC121 重設過的是預設值）；120～127 是 channel mode 訊息，不在這裡
 * @property {number|null} program
 * @property {{msb:number|null, lsb:number|null}|null} programBank  program change 當下生效的 bank 暫存器
 * @property {number|null} pitchBend  14-bit，中心 8192
 * @property {number|null} channelPressure
 * @property {Map<number, number>} polyPressure  音高 → 壓力
 * @property {'mono'|'poly'|null} mode  最後一個 CC126／127
 * @property {{type:'rpn'|'nrpn', msb:number|null, lsb:number|null}|null} selection  目前選的參數（RPN 127/127 是 null 參數）
 * @property {Map<string, {type:'rpn'|'nrpn', msb:number, lsb:number, value:[number|null, number|null], adjusted:boolean}>} parameters
 *   'rpn:MSB:LSB' → data entry 設的值（例如 'rpn:0:0' 的 value[0] 是彎音範圍的半音數）；adjusted＝之後有 CC96／97（不換算）
 */

/**
 * 系統軌的一個事件（SysEx F0 或 escape F7）。
 * @typedef {object} SystemEvent
 * @property {string} id  「軌序號:軌內序號」
 * @property {number} ticks
 * @property {number} trackIndex
 * @property {number} eventIndex
 * @property {'sysex'|'escape'} type
 * @property {Uint8Array} data  F0／F7 之後的位元組（SysEx 含結尾的 F7）
 * @property {'gmOn'|'gmOff'|'gm2On'|'gsReset'|'xgOn'|'gsParameter'|'xgParameter'|'universalRealTime'|'universalNonRealTime'|'other'} category
 * @property {boolean} [channelSpecific]  只有 gsParameter／xgParameter 有：位址是不是指定某個 part（輸出 channel 重新分配後會對不上）
 */

/**
 * 文字軌的一個事件（FF01～FF0F）。
 * @typedef {object} TextEvent
 * @property {string} id  「軌序號:軌內序號」
 * @property {number} ticks
 * @property {number} trackIndex
 * @property {number} eventIndex
 * @property {number} type  meta 型別（META.TEXT、META.LYRIC、META.MARKER…）
 * @property {string} text  UTF-8 優先、Latin-1 退路
 */

/**
 * parseMidi() 的解析結果。
 * @typedef {object} ParsedMidi
 * @property {number} format  0／1／2
 * @property {number} numTracksDeclared
 * @property {MidiDivision} division
 * @property {number|null} timeDivision  smpte 時為 null
 * @property {MidiTrack[]} tracks
 * @property {TempoMapEntry[]} tempoMap
 * @property {TimeSignatureEntry[]} timeSignatures  保證至少一筆、且第一筆在 tick 0
 * @property {KeySignatureEntry[]} keySignatures  同上
 * @property {MidiNote[]} notes  依 startTick 排序
 * @property {MidiSegment[]} segments  全曲的垂直切片：依 startTick 把 notes 分組（每個 startTick 一個 segment，ticks 遞增）
 * @property {MidiPart[]} parts  依首軌的 track 序號排序（＝總譜由上而下）
 * @property {number} durationTicks  End of Track（各軌最晚的那個）
 * @property {number} durationSeconds
 * @property {number} lastVoiceEventTick  最後一個 channel 事件的 tick（官方 BasicMIDI 同名欄位，官方的 duration ＝ 它的秒數）；
 *   durationTicks 可能更晚（MuseScore 的 End of Track 在最後一小節的小節線）
 * @property {Map<number, LaneEvent[]>} channelLanes  控制器軌：每個用到的絕對 channel 一條（依 channel 遞增），所有非音符的
 *   channel 事件依官方 timeline 的順序（tick → 軌序 → 軌內序）；同一個 channel 的 staff 共用（staff.channel 是鑰匙）
 * @property {SystemEvent[]} systemEvents  系統軌：全曲的 SysEx 與 escape，依 tick → 軌序 → 軌內序，附分類（只解析、不送）
 * @property {TextEvent[]} textEvents  文字軌：FF01～FF0F 的文字類 meta（歌詞、標記…），依 tick → 軌序 → 軌內序
 * @property {(ticks:number) => number} midiTicksToSeconds  依速度表把 tick 換算成秒
 * @property {(seconds:number) => number} secondsToMIDITicks  midiTicksToSeconds 的反函數（回傳值可以是小數）
 * @property {string[]} warnings  解析過程中發現的問題（不中斷解析）
 */

/**
 * 解析一份 Standard MIDI File。
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {ParsedMidi} 解析結果；解析過程中發現的問題收在 .warnings，不會中斷解析
 */
export function parseMidi(input) {
  const warnings = [];
  const warn = makeWarn(warnings);
  const { format, numTracksDeclared, division, tracks } = readSmf(input, warn);
  const tempoMap = buildTempoMap(tracks, division, warn);
  const midiTicksToSeconds = makeMidiTicksToSeconds(tempoMap, division);
  const timeSignatures = buildTimeSignatures(tracks);
  const keySignatures = buildKeySignatures(tracks);
  // program 依時間軸查詢（沒有初始化區塊的 staff 用），見 parts.js 的 buildProgramResolver()。
  const programResolver = buildProgramResolver(tracks);
  const { parts, notes } = collectPartsAndNotes(tracks, midiTicksToSeconds, warn, programResolver);
  const durationTicks = tracks.reduce((max, t) => Math.max(max, t.endTick), 0);

  return {
    format,
    numTracksDeclared,
    division,
    timeDivision: division.ticksPerQuarter,
    tracks,
    tempoMap,
    timeSignatures,
    keySignatures,
    notes,
    segments: buildSegments(notes),
    parts,
    durationTicks,
    durationSeconds: midiTicksToSeconds(durationTicks),
    lastVoiceEventTick: findLastVoiceEventTick(tracks),
    channelLanes: collectChannelLanes(tracks, buildPortOffsets(tracks)),
    systemEvents: collectSystemEvents(tracks),
    textEvents: collectTextEvents(tracks),
    midiTicksToSeconds,
    secondsToMIDITicks: makeSecondsToMIDITicks(tempoMap, division),
    warnings,
  };
}
