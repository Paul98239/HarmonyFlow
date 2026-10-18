// midiFile.js — 讀檔層：Standard MIDI File 位元組 → 檔頭與每一軌的原始事件（channel／meta／SysEx）。依 MMA 官方規格（SMF 1.0，RP-001）手寫，對照官方 SpessaSynth 的 BasicMIDI／MIDITrack／MIDIMessage。
// 容器容錯（RMID、檔頭雜訊）、running status、截斷軌、警告彙整都在這一層；這一層不解讀音樂（速度表、聲部切分在上面的層）。

/** @typedef {import('./midiParser.js').MidiDivision} MidiDivision */
/** @typedef {import('./midiParser.js').MidiTrack} MidiTrack */

// Meta 事件型別（SMF 規格第 5 節）。0x01~0x0F 全部是文字類。
export const META = Object.freeze({
  SEQUENCE_NUMBER: 0x00,
  TEXT: 0x01,
  COPYRIGHT: 0x02,
  TRACK_NAME: 0x03,
  INSTRUMENT_NAME: 0x04,
  LYRIC: 0x05,
  MARKER: 0x06,
  CUE_POINT: 0x07,
  PROGRAM_NAME: 0x08,
  DEVICE_NAME: 0x09,
  CHANNEL_PREFIX: 0x20,
  PORT: 0x21,
  END_OF_TRACK: 0x2f,
  SET_TEMPO: 0x51,
  SMPTE_OFFSET: 0x54,
  TIME_SIGNATURE: 0x58,
  KEY_SIGNATURE: 0x59,
  SEQUENCER_SPECIFIC: 0x7f,
});

// Channel voice message：高 4 bit 是類型、低 4 bit 是 channel。
const CHANNEL_TYPE = Object.freeze({
  0x80: 'noteOff',
  0x90: 'noteOn',
  0xa0: 'polyAftertouch',
  0xb0: 'controlChange',
  0xc0: 'programChange',
  0xd0: 'channelAftertouch',
  0xe0: 'pitchBend',
});

// programChange 與 channelAftertouch 只有 1 個資料位元組，其餘 2 個。
const CHANNEL_DATA_BYTES = Object.freeze({
  0x80: 2, 0x90: 2, 0xa0: 2, 0xb0: 2, 0xc0: 1, 0xd0: 1, 0xe0: 2,
});

// 各事件的 data1／data2 意義（解析後原樣保留，不另外複製成語意欄位，避免兩份資料不同步）：
//   noteOff / noteOn        data1 = 音高 0~127        data2 = 力度（noteOn 力度 0 等同 noteOff）
//   polyAftertouch          data1 = 音高              data2 = 壓力
//   controlChange           data1 = controller 編號   data2 = 值
//   programChange           data1 = 音色編號          data2 = 0（無此位元組）
//   channelAftertouch       data1 = 壓力              data2 = 0（無此位元組）
//   pitchBend               data1 = LSB               data2 = MSB（合成值 = (data2 << 7) | data1，中心 8192）
// 實際要用的「音符」請直接讀 parsed.notes，那裡已經把 on/off 配對好了。

// 合理的 tick 上限：一般檔案遠小於這個數字（480 tpq 的 3 分鐘曲子約 8 萬 tick）；超過多半是 delta-time 損毀。只警告不拒絕。
const MAX_PLAUSIBLE_TICK = 1e7;
const WARNING_LIMIT = 100;

export class MidiParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MidiParseError';
  }
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

// SMF 規格寫 ASCII，但 MuseScore、Sibelius 等實務上以 UTF-8 寫中文曲名／聲部名。先嚴格試 UTF-8、失敗才退回 Latin-1：反過來中文會變亂碼卻不報錯，最難察覺
function decodeText(bytes) {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  get remaining() {
    return this.bytes.length - this.pos;
  }
  need(n, what) {
    if (this.remaining < n) {
      throw new MidiParseError(`檔案在讀取「${what}」時提早結束：還需要 ${n} bytes，只剩 ${this.remaining}`);
    }
  }
  u8(what) {
    this.need(1, what);
    return this.bytes[this.pos++];
  }
  u16(what) {
    this.need(2, what);
    const v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1];
    this.pos += 2;
    return v;
  }
  u32(what) {
    this.need(4, what);
    const b = this.bytes;
    const v = (b[this.pos] * 0x1000000) + (b[this.pos + 1] << 16) + (b[this.pos + 2] << 8) + b[this.pos + 3];
    this.pos += 4;
    return v;
  }
  ascii(n, what) {
    this.need(n, what);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[this.pos + i]);
    this.pos += n;
    return s;
  }
  // 回傳複本而非 subarray：事件資料會被長期持有，view 會讓整份檔案的 ArrayBuffer 無法 GC，外部改動也會污染來源
  copy(n, what) {
    this.need(n, what);
    const v = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  // Variable-Length Quantity：每位元組 7 bit，最高位為 1 表示還有後續。規格上限 4 位元組。
  vlq(what) {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8(what);
      value = (value << 7) | (b & 0x7f);
      if (!(b & 0x80)) return value >>> 0;
    }
    throw new MidiParseError(`「${what}」的 variable-length quantity 超過規格允許的 4 個位元組，檔案可能已損毀`);
  }
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input; // Node 的 Buffer 也走這條
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new MidiParseError('parseMidi 只接受 ArrayBuffer、Uint8Array 或其他 TypedArray');
}

// 容器容錯：把輸入位元組定位到真正的 SMF（MThd）起點，只改怎麼讀、不改檔案內容：RMID（RIFF 外包裝，裡面 'data' chunk 才是 SMF）、
// 檔頭前雜訊（在前 SMF_SEARCH_LIMIT bytes 內找 'MThd'）；找不到就照原本的錯誤處理。
const SMF_SEARCH_LIMIT = 4096;
function locateSmf(bytes, warn) {
  const tag = (off) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (bytes.length >= 12 && tag(0) === 'RIFF') {
    if (tag(8) !== 'RMID') throw new MidiParseError('這是 RIFF 檔但不是 RMID（Standard MIDI File 的 RIFF 外包裝），不是 MIDI');
    const u32le = (off) => (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
    for (let pos = 12; pos + 8 <= bytes.length;) {
      const size = u32le(pos + 4);
      if (tag(pos) === 'data') {
        warn(`RMID 外包裝（RIFF），已取出裡面的 Standard MIDI File（${Math.min(size, bytes.length - pos - 8)} bytes）`);
        return bytes.subarray(pos + 8, Math.min(bytes.length, pos + 8 + size));
      }
      pos += 8 + size + (size & 1); // RIFF chunk 對齊到偶數位元組
    }
    throw new MidiParseError('RMID 檔裡找不到 data chunk');
  }
  if (bytes.length < 4 || tag(0) === 'MThd') return bytes;
  const last = Math.min(SMF_SEARCH_LIMIT, bytes.length - 4);
  for (let i = 1; i <= last; i++) {
    if (bytes[i] === 0x4d && bytes[i + 1] === 0x54 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) {
      warn(`檔頭前有 ${i} bytes 雜訊，在 offset ${i} 找到 MThd，已略過雜訊`);
      return bytes.subarray(i);
    }
  }
  return bytes;
}

export function makeWarn(list) {
  return (message) => {
    if (list.length < WARNING_LIMIT) list.push(message);
    else if (list.length === WARNING_LIMIT) list.push('（警告數量過多，後續已省略）');
  };
}

// division：最高位 0＝每四分音符的 tick 數；1＝SMPTE，高位元組是負的每秒格數、低位元組是每格 tick 數，此時時間是絕對的，FF51 不影響換算
/** @param {number} raw  @returns {MidiDivision} */
function parseDivision(raw) {
  if (raw & 0x8000) {
    const nominalFps = 256 - ((raw >> 8) & 0xff); // 24 / 25 / 29 / 30
    const ticksPerFrame = raw & 0xff;
    if (!ticksPerFrame) throw new MidiParseError('檔頭的 division 是 SMPTE 格式，但每格 tick 數為 0');
    // 規格的 -29 指的是 30 drop-frame，實際速率是 29.97fps；直接拿 29 算會有 0.1% 誤差。
    const framesPerSecond = nominalFps === 29 ? 30000 / 1001 : nominalFps;
    return {
      type: 'smpte',
      nominalFps,
      framesPerSecond,
      ticksPerFrame,
      ticksPerSecond: framesPerSecond * ticksPerFrame,
      ticksPerQuarter: null,
      raw,
    };
  }
  if (!raw) throw new MidiParseError('檔頭的 division 為 0，無法決定時間單位');
  return { type: 'ppq', ticksPerQuarter: raw, raw };
}

function decorateMeta(ev, warn, trackIndex) {
  const d = ev.data;
  if (ev.type >= 0x01 && ev.type <= 0x0f) {
    ev.text = decodeText(d);
    return;
  }
  switch (ev.type) {
    case META.SEQUENCE_NUMBER:
      if (d.length >= 2) ev.sequenceNumber = (d[0] << 8) | d[1];
      else if (d.length === 0) ev.sequenceNumber = 0; // 部分編碼器會寫長度 0，補規格預設值
      break;
    case META.CHANNEL_PREFIX:
      if (d.length >= 1) ev.channelPrefix = d[0];
      break;
    case META.PORT:
      if (d.length >= 1) ev.port = d[0];
      else ev.port = 0; // 同上，長度 0 時補預設值
      break;
    case META.SET_TEMPO:
      if (d.length >= 3) {
        ev.microsecondsPerQuarter = (d[0] << 16) | (d[1] << 8) | d[2];
        ev.bpm = ev.microsecondsPerQuarter > 0 ? 60000000 / ev.microsecondsPerQuarter : 0;
      } else {
        warn(`track ${trackIndex} 的 tick ${ev.ticks}：速度事件 FF51 長度應為 3，實際 ${d.length}，已忽略`);
      }
      break;
    case META.SMPTE_OFFSET:
      if (d.length >= 5) {
        // hr 是壓縮格式 0yyzzzzz（yy＝影格率代碼），遮掉高 3 位元才不會把影格率誤讀成小時數（本模組目前沒讀 smpteOffset，只求解碼正確）
        ev.smpteOffset = { hours: d[0] & 0x1f, minutes: d[1], seconds: d[2], frames: d[3], subFrames: d[4] };
      }
      break;
    case META.TIME_SIGNATURE:
      if (d.length >= 4) {
        ev.numerator = d[0];
        ev.denominator = 2 ** d[1]; // 規格存的是以 2 為底的指數
        ev.clocksPerClick = d[2];
        ev.thirtySecondNotesPer24Clocks = d[3];
      } else if (d.length === 2) {
        // 部分編碼器只寫 numerator/denominator，省略純顯示用的 metronome／32 分音符欄位；規格沒訂預設值，沿用業界慣用的 24 clocks/click、8 個 32 分音符
        // （RP-001 範例把「24」編碼成 0x18，不是 0x24——0x24 是十進位 36，字面量必須寫十進位 24）。
        ev.numerator = d[0];
        ev.denominator = 2 ** d[1];
        ev.clocksPerClick = 24;
        ev.thirtySecondNotesPer24Clocks = 0x08;
      } else {
        warn(`track ${trackIndex} 的 tick ${ev.ticks}：拍號事件 FF58 長度應為 4（或簡化版 2），實際 ${d.length}，已忽略`);
      }
      break;
    case META.KEY_SIGNATURE:
      if (d.length >= 2) {
        ev.sharpsFlats = (d[0] << 24) >> 24; // 有號數：負數代表降記號個數
        ev.minor = d[1] === 1;
      }
      break;
    default:
      break;
  }
}

/**
 * @param {Uint8Array} body
 * @param {number} trackIndex
 * @param {(msg:string) => void} warn
 * @returns {MidiTrack}
 */
function parseTrack(body, trackIndex, warn) {
  const r = new ByteReader(body);
  const events = [];
  const channels = new Set();
  let tick = 0;
  let runningStatus = 0;
  // runningStatus 中間有沒有被 meta／SysEx 穿過：只有這種情況下真的沿用才警告（channel message 之間的正常沿用是常態，不能每次都警告洗版）
  let runningStatusSurvivedMeta = false;
  let warnedRunningStatusAfterMeta = false; // 每軌只警告一次
  let sawEndOfTrack = false;
  let name = '';
  let instrumentName = '';
  let deviceName = '';
  let port = null;

  while (r.remaining > 0) {
    // 一軌從中間壞掉（截斷、非法的 System Common／Real-Time 狀態位元組、running status 沒有前導）不該讓整份 parseMidi 失敗：
    // 吞下這一軌的 MidiParseError、保住已解析的事件、記警告後停在這裡，其餘的軌照常解析
    try {
      tick += r.vlq(`track ${trackIndex} 的 delta-time`);

      let status = r.bytes[r.pos];
      if (status & 0x80) {
        r.pos++;
        if (status < 0xf0) {
          // channel message：更新 running status，重新開始追蹤有沒有被 meta／SysEx 穿過。
          runningStatus = status;
          runningStatusSurvivedMeta = false;
        } else if (runningStatus) {
          // meta／SysEx：規格對寫檔端建議送完整狀態位元組，但讀檔端不該因此拒絕檔案——不清 runningStatus，只記下穿過了 meta／SysEx，
          // 供偵測到沿用時決定要不要警告（FluidSynth、spessasynth、midi-file、mido 都不會因此清掉 running status）
          runningStatusSurvivedMeta = true;
        }
      } else if (runningStatus) {
        if (runningStatusSurvivedMeta && !warnedRunningStatusAfterMeta) {
          warnedRunningStatusAfterMeta = true;
          warn(`track ${trackIndex} 在 offset ${r.pos}：running status 沿用跨過了 meta／SysEx 事件（規格對「寫檔端」的建議是 meta／SysEx 之後應送出完整狀態位元組，這裡照常延用讀取，不影響解析結果）`);
        }
        status = runningStatus;
      } else {
        throw new MidiParseError(
          `track ${trackIndex} 在 offset ${r.pos} 使用了 running status，但前面沒有可延用的 channel 狀態位元組`
        );
      }

      if (status === 0xff) {
        const type = r.u8(`track ${trackIndex} 的 meta 型別`);
        const length = r.vlq(`track ${trackIndex} 的 meta 長度`);
        const data = r.copy(length, `track ${trackIndex} 的 meta 內容`);
        const ev = { ticks: tick, kind: 'meta', type, data };
        decorateMeta(ev, warn, trackIndex);
        events.push(ev);

        if (type === META.TRACK_NAME && !name) name = ev.text;
        else if (type === META.INSTRUMENT_NAME && !instrumentName) instrumentName = ev.text;
        else if (type === META.DEVICE_NAME) {
          // RP-019：一軌只能有一個 Device Name（FF 09），用來把整軌鎖定給單一裝置。
          if (!deviceName) deviceName = ev.text;
          else warn(`track ${trackIndex} 的 tick ${ev.ticks}：出現第二個 Device Name（FF 09），RP-019 規定一軌只能有一個，已忽略`);
        }
        else if (type === META.PORT) {
          if (port === null) port = ev.port ?? null; // 之後若又出現不同的值，取最後一個（官方 SpessaSynth 整條軌用最後的 port）
          // FF 21（Port）不在 RP-001 正式定義的 meta 清單裡，是業界（Cakewalk、Cubase 等）慣例；RP-019 的 Device Name 隱含「一軌對應一個裝置」，但那是推論不是規定。
          // 中途改變就違反這個慣例；整條軌一律用最後的 port 算絕對 channel（buildPortOffsets()），同軌重複的 channel 號可能因此被誤併成同一個 staff。
          else if (ev.port !== port) {
            warn(`track ${trackIndex} 的 tick ${ev.ticks}：MIDI Port（FF 21，業界慣例欄位，非 RP-001 正式定義）中途從 ${port} 改成 ${ev.port}，違反「一軌對應一個裝置」的慣例，整條軌改用最後的 port`);
            port = ev.port;
          }
        }
        else if (type === META.END_OF_TRACK) {
          sawEndOfTrack = true;
          if (r.remaining > 0) {
            warn(`track ${trackIndex} 在 End of Track 之後還有 ${r.remaining} bytes，已忽略`);
          }
          break;
        }
      } else if (status === 0xf0 || status === 0xf7) {
        // F0：完整 SysEx（結尾的 F7 含在資料內）。F7：escape／續傳封包，資料原樣送出。
        const length = r.vlq(`track ${trackIndex} 的 SysEx 長度`);
        const data = r.copy(length, `track ${trackIndex} 的 SysEx 內容`);
        events.push({ ticks: tick, kind: 'sysex', type: status === 0xf0 ? 'sysex' : 'escape', data });
      } else if (status >= 0x80 && status <= 0xef) {
        const high = status & 0xf0;
        const channel = status & 0x0f;
        const type = CHANNEL_TYPE[high];
        const data1 = r.u8(`track ${trackIndex} 的 ${type} 資料`);
        const data2 = CHANNEL_DATA_BYTES[high] === 2 ? r.u8(`track ${trackIndex} 的 ${type} 資料`) : 0;
        if ((data1 & 0x80) || (data2 & 0x80)) {
          warn(`track ${trackIndex} 的 tick ${tick}：${type} 的資料位元組超過 0x7F，檔案可能已損毀`);
        }
        channels.add(channel);
        events.push({ ticks: tick, kind: 'channel', type, channel, data1, data2 });
      } else {
        // F1~F6、F8~FE 依規格不得出現在 SMF；出現就無從得知它佔幾個位元組，硬猜只會讓整軌解析錯位
        throw new MidiParseError(
          `track ${trackIndex} 的 tick ${tick} 出現不該存在於 MIDI 檔案的狀態位元組 0x${status.toString(16)}`
        );
      }
    } catch (err) {
      if (!(err instanceof MidiParseError)) throw err;
      warn(`track ${trackIndex} 在 offset ${r.pos} 解析中止（${err.message}）；已保留前面 ${events.length} 個事件`);
      break;
    }
  }

  if (!sawEndOfTrack) {
    warn(`track ${trackIndex} 沒有 End of Track（FF 2F 00）事件，已以最後一個事件的位置為軌尾`);
  }
  const endTick = sawEndOfTrack ? tick : (events.length ? events[events.length - 1].ticks : 0);

  return {
    index: trackIndex,
    name,
    instrumentName,
    deviceName,
    port,
    channels: [...channels].sort((a, b) => a - b),
    events,
    endTick,
  };
}

// RP-001 p.7~9 講的是「應該放在哪裡」的慣例，不是位元組合法性：違反不代表損毀，常見記譜軟體也不見得遵守，所以只在違反時警告，方便追查怪異來源的檔案
function validateStructuralConventions(tracks, format, warn) {
  const firstTrack = tracks[0];
  if (firstTrack) {
    // FF 00 Sequence Number：規格要求在軌首、tick 0、且在任何可送出事件（channel／SysEx）之前。
    const seqIdx = firstTrack.events.findIndex((ev) => ev.kind === 'meta' && ev.type === META.SEQUENCE_NUMBER);
    if (seqIdx !== -1) {
      const ev = firstTrack.events[seqIdx];
      const precededByTransmittable = firstTrack.events
        .slice(0, seqIdx)
        .some((e) => e.kind === 'channel' || e.kind === 'sysex');
      if (ev.ticks !== 0 || precededByTransmittable) {
        warn(`track 0 的 tick ${ev.ticks}：Sequence Number（FF 00）沒有出現在軌首（RP-001 規定必須在 tick 0、且在任何可送出事件之前）`);
      }
    }
    // FF 02 Copyright：規格要求在第一軌、tick 0。只查 tick，不強求是整軌第一個事件（與 Sequence Number 哪個先寫沒有規格定論）
    const copyEv = firstTrack.events.find((ev) => ev.kind === 'meta' && ev.type === META.COPYRIGHT);
    if (copyEv && copyEv.ticks !== 0) {
      warn(`track 0 的 tick ${copyEv.ticks}：Copyright Notice（FF 02）沒有出現在 tick 0（RP-001 規定應放在第一軌、tick 0）`);
    }
  }
  // FF 03 Sequence/Track Name：規格要求若有必須出現在 tick 0。
  for (const track of tracks) {
    const ev = track.events.find((e) => e.kind === 'meta' && e.type === META.TRACK_NAME);
    if (ev && ev.ticks !== 0) {
      warn(`track ${track.index} 的 tick ${ev.ticks}：Sequence/Track Name（FF 03）沒有出現在 tick 0（RP-001 規定若有必須在 tick 0）`);
    }
  }
  // format 1：tempo map（FF 51／FF 58）規定放第一軌，SMPTE Offset（FF 54）在其他軌沒有意義（RP-001 p.9）。與第一軌完全相同（種類、tick、內容）的不報
  // （很多編曲軟體每條軌都抄一份拍號，照樣有效）；不同的才報，依種類彙整成一則（含次數與第一個的位置）
  if (format === 1) {
    const watched = {
      [META.SET_TEMPO]: ['Set Tempo（FF 51）', 'RP-001 規定 format 1 的 tempo map 必須放在第一軌'],
      [META.TIME_SIGNATURE]: ['Time Signature（FF 58）', 'RP-001 規定 format 1 的 tempo map 必須放在第一軌'],
      [META.SMPTE_OFFSET]: ['SMPTE Offset（FF 54）', 'RP-001 明訂在 format 1 裡這個事件在其他軌沒有意義'],
    };
    const key = (ev) => `${ev.type}:${ev.ticks}:${[...ev.data].join(',')}`;
    const onFirst = new Set((firstTrack?.events || []).filter((ev) => ev.kind === 'meta' && watched[ev.type]).map(key));
    const found = new Map(); // meta 型別 → { count, trackIndex, ticks }（第一個的位置）
    for (let i = 1; i < tracks.length; i++) {
      for (const ev of tracks[i].events) {
        if (ev.kind !== 'meta' || !watched[ev.type] || onFirst.has(key(ev))) continue;
        const f = found.get(ev.type);
        if (f) f.count++; else found.set(ev.type, { count: 1, trackIndex: i, ticks: ev.ticks });
      }
    }
    for (const [type, f] of found) {
      warn(`${watched[type][0]}出現在非第一軌 ${f.count} 次（第一個在 track ${f.trackIndex}、tick ${f.ticks}）：${watched[type][1]}`);
    }
  }
}

/**
 * 位元組 → 檔頭與每一軌的原始事件（parseMidi() 的第一步）。容器容錯、截斷、未知 chunk、RP-001 的結構慣例都在這裡警告。
 * @param {ArrayBuffer|Uint8Array} input
 * @param {(msg:string) => void} warn
 * @returns {{ format:number, numTracksDeclared:number, division:MidiDivision, tracks:MidiTrack[] }}
 */
export function readSmf(input, warn) {
  const bytes = locateSmf(toBytes(input), warn);
  const reader = new ByteReader(bytes);

  const magic = reader.ascii(4, '檔頭 chunk 標記');
  if (magic !== 'MThd') throw new MidiParseError(`不是 Standard MIDI File：開頭應為 "MThd"，實際為 "${magic}"`);

  const headerLength = reader.u32('檔頭長度');
  if (headerLength < 6) throw new MidiParseError(`檔頭長度應至少為 6，實際為 ${headerLength}`);
  reader.need(headerLength, '檔頭內容');
  const headerEnd = reader.pos + headerLength;
  const format = reader.u16('format');
  const numTracksDeclared = reader.u16('ntrks');
  const division = parseDivision(reader.u16('division'));
  if (headerLength > 6) {
    // 規格明文要求：檔頭可能因未來擴充而變長，解析器必須靠長度欄位跳過多出來的部分。
    warn(`檔頭長度為 ${headerLength}（規格目前定義 6），多出的 ${headerLength - 6} bytes 已依規格略過`);
  }
  reader.pos = headerEnd;
  if (format !== 0 && format !== 1 && format !== 2) {
    warn(`未知的 format ${format}（規格只定義 0／1／2），仍嘗試依 format 1 的方式解析`);
  }

  const tracks = [];
  while (reader.remaining >= 8) {
    const chunkType = reader.ascii(4, 'chunk 標記');
    const declared = reader.u32(`chunk "${chunkType}" 的長度`);
    let length = declared;
    if (length > reader.remaining) {
      warn(`chunk "${chunkType}" 宣告長度 ${declared} 超過檔案剩餘的 ${reader.remaining} bytes，已截斷到檔尾`);
      length = reader.remaining;
    }
    const body = reader.copy(length, `chunk "${chunkType}" 的內容`);
    if (chunkType === 'MTrk') tracks.push(parseTrack(body, tracks.length, warn));
    // 規格：遇到不認得的 chunk 一律當作不存在略過（為未來擴充預留）。
    else warn(`略過不認識的 chunk "${chunkType}"（${length} bytes）`);
  }
  if (reader.remaining > 0) warn(`檔尾多出 ${reader.remaining} bytes 不足以構成一個 chunk，已忽略`);
  if (tracks.length !== numTracksDeclared) {
    warn(`檔頭宣告 ${numTracksDeclared} 軌，實際找到 ${tracks.length} 軌，以實際為準`);
  }
  if (!tracks.length) throw new MidiParseError('這個檔案裡沒有任何 MTrk 音軌');
  if (format === 0 && tracks.length > 1) warn(`format 0 依規格只能有 1 軌，實際有 ${tracks.length} 軌`);
  if (format === 2) {
    // format 2 的各軌是彼此獨立的樂句，沿用同一條時間軸算秒數與重疊音符沒有意義，但檔案仍可解析，所以只警告
    warn('這是 format 2 檔案：各軌是彼此獨立的樂句而非同時演奏的聲部，時間軸與聲部切分的結果未必符合預期');
  }
  validateStructuralConventions(tracks, format, warn);
  const maxTick = tracks.reduce((m, t) => Math.max(m, t.endTick), 0);
  if (maxTick > MAX_PLAUSIBLE_TICK) {
    warn(`最後一個事件在 tick ${maxTick}，超過 ${MAX_PLAUSIBLE_TICK}，檔案可能已損毀（pretty_midi 同樣視為損毀）；仍照常解析`);
  }
  return { format, numTracksDeclared, division, tracks };
}

// 最後一個 channel voice message 的 tick（官方 BasicMIDI 的 lastVoiceEventTick，官方 duration 就是它的秒數；官方另用 loop 記號延長，我們不循環播放，不採用）。
// 跟 durationTicks（End of Track）不同：MuseScore 的 End of Track 在最後一小節的小節線，常比最後一個音晚
export function findLastVoiceEventTick(tracks) {
  let last = 0;
  for (const track of tracks) for (const ev of track.events) if (ev.kind === 'channel' && ev.ticks > last) last = ev.ticks;
  return last;
}
