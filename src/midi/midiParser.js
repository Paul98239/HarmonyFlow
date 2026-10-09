// ============================================================
//  midiParser.js — Standard MIDI File 解析／重新編碼（純邏輯，無 DOM／CDN 依賴）
//
//  依 MMA 官方規格（Standard MIDI Files 1.0，SMF，RP-001）手寫，不依賴任何第三方套件。
//
//  典型用法：
//    const parsed = parseMidi(await file.arrayBuffer());
//    parsed.parts   // → 這份總譜有哪些聲部（MuseScore 的一個樂器＝一個 part，底下是 staff＝譜表 × channel）
//    parsed.segments // → 全曲的垂直切片（同一個 startTick 的所有音）：scheduler.js 一次觸發放行一個 segment
//    parsed.notes   // → scheduler.js 連同 parts 建立 staff（音符依 staffId 分給各 staff）
//
//  本模組不碰 Blob／DOM／AudioContext——包成 Blob 是呼叫端的事。
//
//  ── 本模組的界線：規格保證什麼、應用層假設什麼 ──
//  SMF 規格真正寫進檔案的是「格線」：時間解析度（division）、速度（FF 51）、拍號（FF 58）。
//  這三樣加起來足以把任何一個 tick 精確還原成「第幾拍、第幾秒」，`buildTempoMap()`／
//  `makeMidiTicksToSeconds()`／`buildMeasureGrid()`／`buildBeatGrid()` 這條鏈是確定性計算，不是
//  推導。規格沒有寫進檔案的是格線上的「音樂意義」：小節線本身、弱起、強弱、swing、複拍子
//  的實際律動——這些只能由應用層推導，而推導必然帶假設，本模組只在明確標示假設（CLAUDE.md「拍子從哪裡來」的假設表，
//  A 開頭的項目，散在各函式的 JSDoc／註解裡）的地方才做這類啟發式推導，其餘一律照規格算出來的數字為準。
// ============================================================

/* ═══════════════════════════════════════════
   規格常數
   ═══════════════════════════════════════════ */

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
const CHANNEL_STATUS = Object.freeze({
  noteOff: 0x80,
  noteOn: 0x90,
  polyAftertouch: 0xa0,
  controlChange: 0xb0,
  programChange: 0xc0,
  channelAftertouch: 0xd0,
  pitchBend: 0xe0,
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

const DEFAULT_TEMPO_US = 500000; // 規格：沒有 FF51 時視為 120 BPM
// 合理的 tick 上限：一般檔案遠小於這個數字（480 tpq 的 3 分鐘曲子約 8 萬 tick）；超過多半是 delta-time 損毀。只警告不拒絕。
const MAX_PLAUSIBLE_TICK = 1e7;
const WARNING_LIMIT = 100;

// GM1 打擊樂固定使用第 10 個 MIDI channel（索引 9，不是第 10 個 track）上 program 代表的
// 是鼓組而非旋律樂器。GM2 §2.4／§3.3.1 允許用 Bank Select（CC0 MSB／CC32 LSB）在任何 channel
// 上切換：bank 79H(121)＝旋律（channel 9 以外的規格預設值）、bank 78H(120)＝節奏（channel 9
// 的規格預設值）——staff 的 percussionKit 判定依這條規則走（見 buildPart()），不是只看
// channel 號碼。這張表只用來檢查鼓組 program 是不是 GM2 附錄 B 定義的編號。
// 拼法對齊 GM2 規格文件附錄 B「General MIDI 2 Percussion Sound Set」表格標題（PC#1 STANDARD Set、
// PC#9 ROOM Set…）：全部是「XXX Set」，不是「XXX Kit」；56 號那組官方寫的是縮寫「SFX Set」，
// 不是「Sound FX」。
const GM_DRUM_KITS = Object.freeze({
  0: 'Standard Set', 8: 'Room Set', 16: 'Power Set', 24: 'Electronic Set',
  25: 'Analog Set', 32: 'Jazz Set', 40: 'Brush Set', 48: 'Orchestra Set', 56: 'SFX Set',
});
const DRUM_CHANNEL = 9;

// General MIDI Level 1 音色表的繁體中文（台灣用語）對照，索引就是 GM program 編號（0~127）。
// 分譜清單一律用這份表命名聲部，不採信檔案裡的軌名（FF03）／樂器名（FF04）：那些欄位常常是
// 其他語言、排版用的分隔線或空白。GM program 是規格明訂、與語言無關的欄位，而且就是音源引擎
// 實際會奏出的音色。這張表只管畫面上的顯示名稱；內部一律用 GM program 編號與 SoundFont 的音色，不依賴名稱。
// 台灣用語的統一規則（同一個概念全表用同一個詞）：acoustic＝「原音」（不用大陸的「原聲」）、synth＝「合成器」、
// lead＝「主奏」、pad＝「音墊」、slap＝「拍弦」、fretless＝「無琴格」、choir＝「合唱」、woodblock＝「木魚」、
// tom＝「通通鼓」、pizzicato＝「撥奏」、brush＝「鼓刷」、管風琴不加「教堂」。
const GM_PROGRAM_NAMES_ZH = Object.freeze([
  '大鋼琴', '明亮鋼琴', '電子大鋼琴', '酒吧鋼琴',
  '電鋼琴 1', '電鋼琴 2', '大鍵琴', '擊弦古鋼琴',
  '鋼片琴', '鐘琴', '音樂盒', '顫音琴',
  '馬林巴琴', '木琴', '管鐘', '揚琴',
  '拉桿風琴', '打擊式風琴', '搖滾風琴', '管風琴',
  '簧風琴', '手風琴', '口琴', '探戈手風琴',
  '尼龍弦吉他', '鋼弦吉他', '爵士電吉他', '清音電吉他',
  '悶音電吉他', '過載電吉他', '破音電吉他', '吉他泛音',
  '原音貝斯', '指彈電貝斯', '撥片電貝斯', '無琴格貝斯',
  '拍弦貝斯 1', '拍弦貝斯 2', '合成器貝斯 1', '合成器貝斯 2',
  '小提琴', '中提琴', '大提琴', '低音提琴',
  '震音弦樂', '撥奏弦樂', '豎琴', '定音鼓',
  '弦樂合奏 1', '弦樂合奏 2', '合成器弦樂 1', '合成器弦樂 2',
  '合唱「啊」', '合唱「喔」', '合成器人聲', '管弦樂團重擊',
  '小號', '長號', '低音號', '弱音小號',
  '法國號', '銅管組', '合成器銅管 1', '合成器銅管 2',
  '高音薩克斯風', '中音薩克斯風', '次中音薩克斯風', '上低音薩克斯風',
  '雙簧管', '英國管', '低音管', '單簧管',
  '短笛', '長笛', '直笛', '排笛',
  '吹瓶', '尺八', '口哨', '陶笛',
  '方波主奏', '鋸齒波主奏', '汽笛風琴主奏', '吹氣主奏',
  '查朗戈主奏', '人聲主奏', '五度主奏', '貝斯加主奏',
  '新世紀音墊', '溫暖音墊', '複音合成器音墊', '合唱音墊',
  '弓弦音墊', '金屬音墊', '光暈音墊', '掃頻音墊',
  '音效：雨聲', '音效：配樂', '音效：水晶', '音效：氛圍',
  '音效：明亮', '音效：精靈', '音效：回聲', '音效：科幻',
  '西塔琴', '班鳩琴', '三味線', '箏',
  '拇指琴', '風笛', '民謠提琴', '嗩吶',
  '叮噹鈴', '阿哥哥鈴', '鋼鼓', '木魚',
  '太鼓', '旋律通通鼓', '合成器鼓', '反向鈸',
  '吉他換把雜音', '呼吸聲', '海浪聲', '鳥鳴',
  '電話鈴聲', '直升機', '掌聲', '槍聲',
]);

const GM_DRUM_KITS_ZH = Object.freeze({
  0: '標準鼓組', 8: '房間鼓組', 16: '強力鼓組', 24: '電子鼓組',
  25: '類比鼓組', 32: '爵士鼓組', 40: '鼓刷鼓組', 48: '管弦樂打擊組', 56: '音效打擊組',
});

/**
 * GM 音色編號 → 繁體中文名稱。分譜清單的聲部命名一律走這裡（見 GM_PROGRAM_NAMES_ZH
 * 的說明）。查不到（program 超出 0~127）時回傳空字串，由呼叫端決定退路；鼓組編號查不到時
 * 回傳標準鼓組：GM2 §2.6 [recommended] 明訂 Bank 78H/00H 選到未定義的 program 時，音源
 * 實際會播放 Program 1（GM1 Drum Set）——名稱要反映音源真正會發出的聲音。
 */
export function gmProgramNameZh(program, isDrum = false) {
  if (!Number.isInteger(program) || program < 0 || program > 127) return '';
  if (isDrum) return GM_DRUM_KITS_ZH[program] || GM_DRUM_KITS_ZH[0];
  return GM_PROGRAM_NAMES_ZH[program];
}

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * MIDI 音高 → 科學音名（中央 C ＝ 60 ＝ C4，升記號用 #），例如 57 → 'A3'、88 → 'E6'。分譜清單顯示譜表音域用。
 * 非 0~127 的整數回傳空字串。
 */
export function midiNoteName(midiNote) {
  if (!Number.isInteger(midiNote) || midiNote < 0 || midiNote > 127) return '';
  return PITCH_CLASS_NAMES[midiNote % 12] + (Math.floor(midiNote / 12) - 1);   // MIDI 0 ＝ C-1，所以八度要減 1
}

/* ═══════════════════════════════════════════
   錯誤型別
   ═══════════════════════════════════════════ */

export class MidiParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MidiParseError';
  }
}

/* ═══════════════════════════════════════════
   位元組讀寫
   ═══════════════════════════════════════════ */

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

// SMF 規格寫的是 ASCII，但實務上（MuseScore、Sibelius 等）中文曲名／聲部名都以
// UTF-8 寫入。先嚴格試 UTF-8，失敗才退回 Latin-1——反過來的話，中文會變成亂碼卻
// 不會報錯，最難察覺。
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
  // 回傳複本而非 subarray：事件資料會被長期持有，若是 view 就會讓整份檔案的
  // ArrayBuffer 都被 GC 卡住，且外部若改動也會污染來源。
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

class ByteWriter {
  constructor() {
    this.buf = new Uint8Array(4096);
    this.len = 0;
  }
  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v) {
    this._ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  u16(v) {
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v) {
    this.u8(v >>> 24);
    this.u8(v >>> 16);
    this.u8(v >>> 8);
    this.u8(v);
  }
  ascii(s) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  bytes(arr) {
    this._ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }
  vlq(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
      throw new MidiParseError(`無法編碼 variable-length quantity：${value} 超出規格允許的 0 ~ 268435455`);
    }
    const stack = [value & 0x7f];
    let v = value >>> 7;
    while (v > 0) {
      stack.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    for (let i = stack.length - 1; i >= 0; i--) this.u8(stack[i]);
  }
  toUint8Array() {
    return this.buf.slice(0, this.len);
  }
}

/* ═══════════════════════════════════════════
   解析：檔頭與 chunk
   ═══════════════════════════════════════════ */

function toBytes(input) {
  if (input instanceof Uint8Array) return input; // Node 的 Buffer 也走這條
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new MidiParseError('parseMidi 只接受 ArrayBuffer、Uint8Array 或其他 TypedArray');
}

// 容器容錯：把輸入的位元組定位到真正的 SMF（MThd）起點，只改「怎麼讀」，不改檔案內容。
//   · RMID：RIFF 外包裝（'RIFF' 小端 size 'RMID'，裡面的 'data' chunk 才是 SMF；SpessaSynth 也支援這種外包裝）。
//   · 檔頭前有雜訊（例如別的程式留下的標頭）：在前 SMF_SEARCH_LIMIT bytes 內找 'MThd'。
// 找不到就照原本的錯誤處理。
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

function makeWarn(list) {
  return (message) => {
    if (list.length < WARNING_LIMIT) list.push(message);
    else if (list.length === WARNING_LIMIT) list.push('（警告數量過多，後續已省略）');
  };
}

// division 欄位：最高位為 0 表示每四分音符的 tick 數；為 1 表示 SMPTE 時間碼，
// 高位元組是負數的每秒格數、低位元組是每格 tick 數。SMPTE 模式下時間是絕對的，
// FF51 速度事件不影響換算。
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

function encodeDivision(division) {
  if (typeof division === 'number') return division & 0xffff;
  if (division?.type === 'smpte') {
    return (((256 - division.nominalFps) & 0xff) << 8) | (division.ticksPerFrame & 0xff);
  }
  const tpq = division?.ticksPerQuarter;
  if (!Number.isInteger(tpq) || tpq <= 0 || tpq > 0x7fff) {
    throw new MidiParseError(`無法編碼 division：ticksPerQuarter 必須是 1 ~ 32767 的整數，收到 ${tpq}`);
  }
  return tpq;
}

/* ═══════════════════════════════════════════
   解析：單一 MTrk
   ═══════════════════════════════════════════ */

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
        // hr 是壓縮格式 0yyzzzzz：yy＝影格率代碼（MIDI Time Code 規格）、zzzzz 才是真正的
        // 0-23 小時，遮掉高 3 位元才不會把影格率代碼誤讀成小時數（本模組目前沒有任何地方
        // 讀取 smpteOffset，這裡只是讓解碼本身正確）。
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
        // 部分編碼器只寫 numerator/denominator，省略 metronome／32分音符這兩個純顯示用欄位；
        // 規格沒訂這種簡化版的預設值，沿用業界慣用的 24 clocks/click、8 個 32分音符（RP-001
        // 自己的逐位元組範例把「24 clocks/click」編碼成十六進位 0x18，不是 0x24——0x24 是
        // 十進位 36，跟這裡要的十進位 24 是兩回事，字面量必須寫成十進位）。
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
  // 目前的 runningStatus 中間有沒有被至少一個 meta／SysEx 事件穿過——只有這種情況下真的
  // 被沿用才值得警告（見下方 status 判斷分支），channel message 之間的正常沿用（絕大多數
  // 檔案的常態）不算，不能每次沿用都警告，會洗版。
  let runningStatusSurvivedMeta = false;
  let warnedRunningStatusAfterMeta = false; // 每軌只警告一次
  let sawEndOfTrack = false;
  let name = '';
  let instrumentName = '';
  let deviceName = '';
  let port = null;

  while (r.remaining > 0) {
    // 一軌從中間壞掉（位元組截斷、非法的 System Common／Real-Time 狀態位元組、running status
    // 沒有前導）不該讓整份 parseMidi 失敗：吞下這一軌的 MidiParseError、保住已解析的事件、
    // 記警告後停在這裡，其餘的軌照常解析。
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
          // meta／SysEx：規格對「寫檔端」的建議是應該送出完整狀態位元組，但這不是「讀檔端」
          // 該拿來拒絕檔案的理由——不清掉 runningStatus，只記下「中間穿過了一個 meta／
          // SysEx」，供下面偵測到延用時判斷值不值得警告。已查證 FluidSynth、spessasynth、
          // `midi-file`、`mido` 四個成熟解析器讀取時都不會因此清掉 running status。
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
          // FF 21（Port／Cable 編號）其實不在 RP-001 正式定義的 meta event 清單裡（該清單只到
          // FF 00/01-0F/03/04/05/06/07/20/2F/51/54/58/59/7F），是業界（Cakewalk、Cubase 等）
          // 常見但沒有被正式標準化的慣例欄位。RP-019 定義的是 FF 09 Device Name，該文件把
          // Device Name 描述成「取代 cable number（也就是這裡的 FF 21）的更好做法」，隱含同一個
          // 「一軌對應一個裝置」的假設，但這是慣例上的推論，不是 RP-019 對 FF 21 本身的規定
          // ——中途改變代表這軌違反了這個推論出來的慣例；整條軌一律用最後的 port 算絕對 channel
          // （buildPortOffsets()），同一軌內重複的 channel 號碼可能因此被誤併成同一個 staff。
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
        // F1~F6、F8~FE 是 System Common／Real-Time，依規格不得出現在 SMF 檔案裡；
        // 一旦出現就無從得知它佔幾個位元組，硬猜只會讓整軌解析錯位。
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

/* ═══════════════════════════════════════════
   解析：時間軸（速度表／拍號／調號）
   ═══════════════════════════════════════════ */

function collectMeta(tracks, type) {
  const list = [];
  for (const track of tracks) {
    for (const ev of track.events) {
      if (ev.kind === 'meta' && ev.type === type) list.push({ ev, trackIndex: track.index });
    }
  }
  // Array.prototype.sort 自 ES2019 起保證穩定，同 tick 時維持「軌序 → 事件序」。
  list.sort((a, b) => a.ev.ticks - b.ev.ticks);
  return list;
}

/**
 * @param {MidiTrack[]} tracks
 * @param {MidiDivision} division
 * @param {(msg:string) => void} warn
 * @returns {TempoMapEntry[]}
 */
function buildTempoMap(tracks, division, warn) {
  const map = [];
  for (const { ev, trackIndex } of collectMeta(tracks, META.SET_TEMPO)) {
    if (!(ev.microsecondsPerQuarter > 0)) continue;
    const last = map[map.length - 1];
    if (last && last.ticks === ev.ticks) {
      // 同一個 tick 有多個速度事件：後出現者生效（軌序、事件序在後的），跟官方 SpessaSynth 一致。
      if (last.microsecondsPerQuarter !== ev.microsecondsPerQuarter) {
        warn(`tick ${ev.ticks} 有互相衝突的速度事件（track ${trackIndex} 指定 ${ev.bpm.toFixed(2)} BPM），採用後出現的那一個`);
        last.microsecondsPerQuarter = ev.microsecondsPerQuarter;
        last.bpm = ev.bpm;
      }
      continue;
    }
    if (last && last.microsecondsPerQuarter === ev.microsecondsPerQuarter) continue; // 重複值不必新增區段
    map.push({ ticks: ev.ticks, microsecondsPerQuarter: ev.microsecondsPerQuarter, bpm: ev.bpm, seconds: 0 });
  }
  if (!map.length || map[0].ticks !== 0) {
    map.unshift({ ticks: 0, microsecondsPerQuarter: DEFAULT_TEMPO_US, bpm: 60000000 / DEFAULT_TEMPO_US, seconds: 0 });
  }
  // 逐段累積起始秒數，之後 midiTicksToSeconds 只要找到所屬區段再線性內插即可。
  if (division.type === 'ppq') {
    for (let i = 1; i < map.length; i++) {
      const prev = map[i - 1];
      map[i].seconds =
        prev.seconds + ((map[i].ticks - prev.ticks) * prev.microsecondsPerQuarter) / 1e6 / division.ticksPerQuarter;
    }
  }
  return map;
}

function makeMidiTicksToSeconds(tempoMap, division) {
  // SMPTE 的 tick 本身就是絕對時間，速度事件在這個模式下不參與換算（規格明訂）。
  if (division.type === 'smpte') {
    return (tick) => tick / division.ticksPerSecond;
  }
  const tpq = division.ticksPerQuarter;
  return (tick) => {
    let lo = 0;
    let hi = tempoMap.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tempoMap[mid].ticks <= tick) lo = mid;
      else hi = mid - 1;
    }
    const seg = tempoMap[lo];
    return seg.seconds + ((tick - seg.ticks) * seg.microsecondsPerQuarter) / 1e6 / tpq;
  };
}

// midiTicksToSeconds 的反函數（名稱照官方 BasicMIDI.secondsToMIDITicks）。數學上：tick → 秒在每個速度區段內是斜率固定的
// 線性函數、區段之間接得起來，整條是嚴格遞增的分段線性函數，所以反函數也是分段線性——先用 seg.seconds（每段的起始秒數，
// 嚴格遞增）二分搜尋找到所屬區段，再在區段內反解線性式。回傳值可以是小數（秒不一定剛好落在整數 tick 上）。
function makeSecondsToMIDITicks(tempoMap, division) {
  if (division.type === 'smpte') {
    return (seconds) => seconds * division.ticksPerSecond;
  }
  const tpq = division.ticksPerQuarter;
  return (seconds) => {
    let lo = 0;
    let hi = tempoMap.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tempoMap[mid].seconds <= seconds) lo = mid;
      else hi = mid - 1;
    }
    const seg = tempoMap[lo];
    return seg.ticks + ((seconds - seg.seconds) * 1e6 * tpq) / seg.microsecondsPerQuarter;
  };
}

function buildSignatureList(tracks, type, decorate, fallback) {
  const out = [];
  for (const { ev } of collectMeta(tracks, type)) {
    const last = out[out.length - 1];
    // 同一個 tick 有多個拍號／調號：後出現者生效（軌序、事件序在後的），跟速度表（buildTempoMap）與官方 SpessaSynth 一致。
    if (last && last.ticks === ev.ticks) { out[out.length - 1] = decorate(ev); continue; }
    out.push(decorate(ev));
  }
  if (!out.length || out[0].ticks !== 0) out.unshift({ ticks: 0, ...fallback });
  return out;
}

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

// 每條 track 的 channel 偏移（絕對 channel＝軌內 channel＋偏移），跟官方 SpessaSynth 一致：沒有指定 port（FF21）的 track
// 用「最小的已指定 port」（都沒有就 0）；依軌序（只看有 channel 事件的軌）第一次出現的 port 配偏移 0、16、32…，
// 用的是出現順序，不是 port 的數值。
function buildPortOffsets(tracks) {
  const withChannels = tracks.filter((t) => t.channels.length);
  const given = withChannels.filter((t) => t.port !== null).map((t) => t.port);
  const defaultPort = given.length ? Math.min(...given) : 0;
  const offsetOfPort = new Map();
  const offsets = new Map(); // trackIndex → 偏移
  for (const t of withChannels) {
    const port = t.port ?? defaultPort;
    if (!offsetOfPort.has(port)) offsetOfPort.set(port, offsetOfPort.size * 16);
    offsets.set(t.index, offsetOfPort.get(port));
  }
  return offsets;
}

// Program Change 是 channel 的狀態、跨軌共用，但「跨軌共用」不代表可以照檔案裡的軌道排列
// 順序處理——一顆音該用哪個 program，要看「這個時間點」該 channel 實際生效的值，不是「前面
// 處理過的軌道留下的值」。這裡建一份查詢器：優先用同一軌自己在這個時間點之前最後一次送過的
// Program Change；這軌自己從沒送過時，才查全曲所有軌、同一個絕對 channel、時間點更早（同 tick 依
// 軌序決定）的最後一次 Program Change；兩者都沒有就回傳規格預設值 0。
// 呼叫端必須依「事件在檔案裡出現的順序」使用：換軌時呼叫 resetTrack()，逐一遇到 Program
// Change 事件時呼叫 noteProgramChange()，查詢在這之間穿插進行——collectNotes() 本來就是這樣
// 逐軌逐事件處理，不需要額外排序。
function buildProgramResolver(tracks) {
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
 * @param {number} channel  絕對 channel（含 port 偏移）
 * @param {MidiChannelEvent} onEvent
 * @param {number} endTick
 * @param {(ticks:number) => number} midiTicksToSeconds
 * @returns {MidiNote}
 */
function makeNote(partId, staffId, trackIndex, channel, onEvent, endTick, midiTicksToSeconds) {
  const startSeconds = midiTicksToSeconds(onEvent.ticks);
  const endSeconds = midiTicksToSeconds(endTick);
  return {
    partId,
    staffId,
    trackIndex,
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
  const emit = (vk, trackIndex, onEv, endTick) => {
    const note = makeNote(vk.partId, vk.staffId, trackIndex, vk.channel, onEv, endTick, midiTicksToSeconds);
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
    for (const ev of track.events) {
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
        queue.push({ ev, vk });
        const at = ev.ticks * 128 + ev.data1;
        onChannelsAt.set(at, (onChannelsAt.get(at) ?? 0) | (1 << ev.channel)); // | ＝ 把 channel 加進集合（聯集）
        continue;
      }
      const queue = pending.get(key);
      if (!queue || !queue.length) {
        strayOffs.push({ channel: ev.channel, ticks: ev.ticks, pitch: ev.data1 });
        continue;
      }
      const { ev: onEv, vk } = queue.shift();
      emit(vk, track.index, onEv, ev.ticks);
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
      for (const { ev: on, vk } of queue) {
        warn(`track ${track.index} 的 tick ${on.ticks}：channel ${(key / 128) | 0} 音高 ${key % 128} 的 note on 沒有對應的 note off，已在軌尾收尾`);
        emit(vk, track.index, on, Math.max(on.ticks, track.endTick));
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
function collectPartsAndNotes(tracks, midiTicksToSeconds, warn, programResolver) {
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

// 全曲的垂直切片（名稱借自 MuseScore 的 Segment：同一個 tick 上所有譜表的音）。notes 已依 startTick 排序，所以相同
// startTick 的音一定相鄰，一次線性掃描就分完（時間 O(n)）。這是「總譜觸發」的最小單位：排程器一次放行一個 segment，
// 全曲所有聲部在同一次呼叫內一起起音，上下對齊由結構保證，不靠時間比對。
export function buildSegments(notes) {
  const segments = [];
  for (const note of notes) {
    const last = segments[segments.length - 1];
    if (last && last.ticks === note.startTick) last.notes.push(note);
    else segments.push({ ticks: note.startTick, notes: [note] });
  }
  return segments;
}

/* ═══════════════════════════════════════════
   RP-001 結構性慣例檢查（只加警告，不影響解析結果或播放）
   ═══════════════════════════════════════════ */

// RP-001 p.7~9 講的是「應該放在哪裡」的慣例，不是位元組層級的合法性規則——違反不代表檔案
// 損毀，常見的記譜軟體匯出也不見得完全遵守，只在真的違反時送警告，方便追查來源怪異的檔案。
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
    // FF 02 Copyright：規格要求在第一軌、tick 0。只查 tick，不強求是整軌第一個事件——RP-001
    // 對 Sequence Number 的敘述同樣建議放在最前面，兩者都合規時哪個先寫入沒有規格上的定論。
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
  // format 1：tempo map（FF 51／FF 58）與 SMPTE Offset（FF 54）規定要放第一軌，出現在其他軌
  // RP-001 p.9 明講「沒有意義」（SMPTE Offset）或違反「tempo map 必須放第一軌」的要求。
  // 與第一軌「完全相同」（同種類、同 tick、同內容）的不報——很多編曲軟體每條軌都抄一份拍號，照樣有效，報了只是洗版；
  // 不同的才報，而且依種類彙整成一則（含次數與第一個的位置），不是每個事件一則。
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

/* ═══════════════════════════════════════════
   對外：parseMidi
   ═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   資料模型的型別（JSDoc typedef）
   ─────────────────────────────────────────
   手寫一份而不用 ReturnType<typeof parseMidi>：TypeScript 把 .js 檔裡的物件字面量當「開放的」，
   推導型別讀到不存在的屬性不會報錯；要抓錯字就得有一份「封閉」的宣告。改了 parseTrack／
   makeNote／collectParts 的欄位時同步改這裡。其他模組用 import('./midiParser.js').ParsedMidi 取得。
   ═══════════════════════════════════════════ */

/**
 * channel voice message（note-on／off、CC、program change、pitch bend…）。
 * data1／data2 的意義依 type 而定，見檔頭 CHANNEL_DATA_BYTES 旁的對照表。
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
 * @property {string} partId  所屬 part（MuseScore 的一個樂器）
 * @property {string} staffId  所屬 staff（一個譜表 × 一個樂器 channel）
 * @property {number} trackIndex
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
 * @property {MidiNote[]} notes  依 notes 的排序（trackIndex、channel、midiNote）
 */

/**
 * 全曲同一個 startTick 的所有音（跨聲部、跨譜表）。
 * @typedef {object} MidiSegment
 * @property {number} ticks  這個 segment 的起音 tick（＝裡面每顆音的 startTick）
 * @property {MidiNote[]} notes  維持 notes 的排序（trackIndex、channel、midiNote）
 */

/**
 * 一個聲部（part）＝ MuseScore 的一個樂器，可指派的單位；底下有一個以上的 staff（鋼琴兩行譜是兩個 staff）。
 * 切分規則見 midiParser.js 的「聲部切分」說明。
 * @typedef {object} MidiPart
 * @property {string} id  p{首軌的 track 序號}
 * @property {string} name  GM 繁中音色名（取主 staff 的音色；同名依序加序號）
 * @property {number} noteCount
 * @property {number} startTick
 * @property {number} endTick
 * @property {MidiStaff[]} staves
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
 * @property {MidiSegment[]} segments  全曲的垂直切片：依 startTick 把 notes 分組（每個 startTick 一個 segment，ticks 遞增）
 * @property {MidiPart[]} parts  依首軌的 track 序號排序（＝總譜由上而下）
 * @property {number} durationTicks
 * @property {number} durationSeconds
 * @property {(ticks:number) => number} midiTicksToSeconds  依速度表把 tick 換算成秒
 * @property {(seconds:number) => number} secondsToMIDITicks  midiTicksToSeconds 的反函數（回傳值可以是小數）
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
    // format 2 的每一軌是各自獨立的樂句，不是同時發聲的聲部；沿用同一條時間軸去
    // 算秒數與重疊音符會得到沒有意義的結果，但檔案本身仍可正確解析，所以只警告。
    warn('這是 format 2 檔案：各軌是彼此獨立的樂句而非同時演奏的聲部，時間軸與聲部切分的結果未必符合預期');
  }
  validateStructuralConventions(tracks, format, warn);
  const maxTick = tracks.reduce((m, t) => Math.max(m, t.endTick), 0);
  if (maxTick > MAX_PLAUSIBLE_TICK) {
    warn(`最後一個事件在 tick ${maxTick}，超過 ${MAX_PLAUSIBLE_TICK}，檔案可能已損毀（pretty_midi 同樣視為損毀）；仍照常解析`);
  }

  const tempoMap = buildTempoMap(tracks, division, warn);
  const midiTicksToSeconds = makeMidiTicksToSeconds(tempoMap, division);
  const timeSignatures = buildSignatureList(
    tracks,
    META.TIME_SIGNATURE,
    (ev) => ({
      ticks: ev.ticks,
      numerator: ev.numerator,
      denominator: ev.denominator,
      clocksPerClick: ev.clocksPerClick,
      thirtySecondNotesPer24Clocks: ev.thirtySecondNotesPer24Clocks,
    }),
    { numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }
  );
  const keySignatures = buildSignatureList(
    tracks,
    META.KEY_SIGNATURE,
    (ev) => ({ ticks: ev.ticks, sharpsFlats: ev.sharpsFlats, minor: ev.minor }),
    { sharpsFlats: 0, minor: false }
  );

  // program 依時間軸查詢（沒有初始化區塊的 staff 用），見 buildProgramResolver() 的說明。
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
    midiTicksToSeconds,
    secondsToMIDITicks: makeSecondsToMIDITicks(tempoMap, division),
    warnings,
  };
}

/* ═══════════════════════════════════════════
   小節格線：不塞進 parseMidi() 的回傳值（排程器目前不用它，逐音放行只看 startTick）。
   ═══════════════════════════════════════════ */

/**
 * @typedef {{index:number, startTick:number, endTick:number, startSeconds:number,
 *   endSeconds:number, numerator:number, denominator:number, notatedBeatTicks:number,
 *   beatTicks:number}} Measure
 */

/**
 * 依拍號（timeSignatures）與 timeDivision 推算全曲的小節線。拍號中途變更處強制斷一條
 * 小節線，該段落最後一小節可能因此不是完整長度；樂曲真正結尾的最後一小節不截短，保留完整
 * 名目長度（讓演奏者仍有整小節的揮手窗口）。SMPTE division 沒有「四分音符」這個概念，
 * timeDivision 為 null，回傳空陣列——呼叫端退回沒有格線的路徑（A5，應用層限制，不是
 * 規格的一部分）。弱起拍（anacrusis）目前不處理，格線一律從 tick 0 起算，檔案若有弱起，
 * 所有小節線與拍位會整體平移（A1）。
 *
 * FF58 的四個位元組（`nn dd cc bb`）分別餵給兩種不同的「拍長」，都是規格欄位算出來的，
 * 不是猜的：
 *
 * - `notatedBeatTicks`（記譜拍長，算小節長度用）＝一個 `dd`（分母）音符值有幾個 tick。
 *   `bb`（RP-001 p.10：一個 MIDI 認知的四分音符／24 clocks 等於幾個記譜三十二分音符）
 *   多數檔案是規格最常見的值 8，這時退化成 `tpq*4/denominator`；非 8 代表這份檔案把
 *   「MIDI 四分音符」重新記譜成別的音符值（RP-001 原文：「已有多個程式允許使用者指定
 *   MIDI 認知的四分音符要被記譜成、或對應到別的東西」），公式仍然照規格算：
 *   `32*tpq/(bb*denominator)`。
 * - `beatTicks`（律動拍長，演奏者實際要揮的單位）優先採用 `cc`（節拍器每響一次隔幾個
 *   MIDI clock，24 clocks＝一個四分音符＝`tpq` ticks）換算出的 `pulseTicks = tpq*cc/24`。
 *   RP-001 自己的 6/8 範例（`FF 58 04 06 03 24 08`）就是 `cc=36`＝附點四分音符＝每小節
 *   揮 2 下，不是切成 6 個八分音符。
 *
 * 採用 `cc` 有三個保險條件，任一不成立就退回 `beatTicks = notatedBeatTicks`（也就是舊版
 * 「一拍＝拍號分母那個音符」的算法）：`cc !== 24`（24 是 MIDI 的內建預設值，多數編曲軟體
 * 不論拍號一律照抄，視為「檔案沒有表態」）、`pulseTicks` 是 `notatedBeatTicks` 的正整數倍
 * （否則不構成一個合理的記譜單位）、`measureTicks % pulseTicks === 0`（否則一小節切不出
 * 整數次揮手）。這是應用層唯一還留著的假設（取代舊版的 A2／A10）：`cc = 24` 的複拍子檔案
 * 仍然會切成分母音符單位（例如 6/8 若 `cc` 剛好也是 24，會切成 6 下而不是 2 下），代價是
 * 保守但不會對音樂上沒有意義的值信以為真。
 *
 * 拍號本身無效（`numerator<=0` 或算出的 `measureTicks<=0`，例如 `denominator` 透過
 * `2**d[1]` 算出離譜的大值）時，會送一則警告並把這段拍號當 4/4 處理再繼續，不會讓迴圈
 * 卡在原地出不來（曾經是真的會凍結分頁的無限迴圈）。
 * @param {ParsedMidi} parsed  parseMidi() 的結果（可能被追加警告，見上）
 * @returns {Measure[]}
 */
export function buildMeasureGrid(parsed) {
  const tpq = parsed.timeDivision;
  if (!tpq) return [];
  const sigs = parsed.timeSignatures; // 保證至少一筆、且第一筆在 tick 0
  const pieceEnd = Math.max(parsed.durationTicks, sigs[sigs.length - 1].ticks + 1);
  const warn = makeWarn(parsed.warnings);

  const grid = [];
  let tick = 0;
  for (let i = 0; i < sigs.length; i++) {
    const sig = sigs[i];
    const isLastSection = i + 1 >= sigs.length;
    const sectionEnd = isLastSection ? pieceEnd : sigs[i + 1].ticks;
    let numerator = sig.numerator;
    let denominator = sig.denominator;
    // bb 非正整數（規格外的值）時退回規格最常見的 8（一個四分音符＝8 個三十二分音符，見上）。
    let bb = Number.isInteger(sig.thirtySecondNotesPer24Clocks) && sig.thirtySecondNotesPer24Clocks > 0
      ? sig.thirtySecondNotesPer24Clocks : 8;
    let notatedBeatTicks = Math.round((32 * tpq) / (bb * denominator));
    let measureTicks = numerator * notatedBeatTicks;
    if (!(measureTicks > 0)) {
      // 拍號無效（分子 <=0，或分母透過 2**d[1] 算出超大值把 notatedBeatTicks 除到趨近 0）：
      // 這裡的 tick 永遠不會前進，下面的 while 迴圈會原地卡死。警告後退回 4/4；連 4/4
      // 都算不出正數（denominator 本身也異常）就整段退回「一拍＝一個四分音符」。
      warn(`拍號 ${sig.numerator}/${sig.denominator}（tick ${sig.ticks}）無效，已當作 4/4 處理`);
      numerator = 4;
      denominator = 4;
      bb = 8;
      notatedBeatTicks = Math.round((32 * tpq) / (bb * denominator));
      measureTicks = numerator * notatedBeatTicks;
      if (!(measureTicks > 0)) {
        notatedBeatTicks = tpq;
        measureTicks = tpq * numerator;
      }
    }

    let beatTicks = notatedBeatTicks;
    const cc = sig.clocksPerClick;
    if (Number.isInteger(cc) && cc > 0 && cc !== 24) {
      const pulseTicks = Math.round((tpq * cc) / 24);
      if (pulseTicks > 0 && pulseTicks % notatedBeatTicks === 0 && measureTicks % pulseTicks === 0) {
        beatTicks = pulseTicks;
      }
    }

    while (tick < sectionEnd) {
      const full = tick + measureTicks;
      const endTick = isLastSection ? full : Math.min(full, sectionEnd);
      grid.push({
        index: grid.length,
        startTick: tick,
        endTick,
        startSeconds: parsed.midiTicksToSeconds(tick),
        endSeconds: parsed.midiTicksToSeconds(endTick),
        numerator,
        denominator,
        notatedBeatTicks,
        beatTicks,
      });
      tick = endTick;
    }
  }
  return grid;
}

/**
 * @typedef {{index:number, measureIndex:number, beatInMeasure:number, startTick:number,
 *   endTick:number, startSeconds:number, endSeconds:number}} Beat
 */

/**
 * 把小節格線（`buildMeasureGrid()`）切成拍格線：每拍長度是 `m.beatTicks`（律動拍長，見
 * `buildMeasureGrid()` 的說明），不是固定切成 `numerator` 份——採用 `cc` 時一小節的拍數會
 * 少於 `numerator`（例如 6/8 的 2 拍）。拍號中途變更造成的截短小節，最後一拍夾到
 * `measure.endTick`；長度為 0 就不收。SMPTE division（`buildMeasureGrid()` 回空陣列）
 * 這裡也回空陣列。
 * @param {ParsedMidi} parsed  parseMidi() 的結果
 * @returns {Beat[]}
 */
export function buildBeatGrid(parsed) {
  const beats = [];
  for (const m of buildMeasureGrid(parsed)) {
    let b = 0;
    for (let startTick = m.startTick; startTick < m.endTick; startTick += m.beatTicks, b++) {
      const endTick = Math.min(startTick + m.beatTicks, m.endTick);
      beats.push({
        index: beats.length,
        measureIndex: m.index,
        beatInMeasure: b,
        startTick,
        endTick,
        startSeconds: parsed.midiTicksToSeconds(startTick),
        endSeconds: parsed.midiTicksToSeconds(endTick),
      });
    }
  }
  return beats;
}

/* ═══════════════════════════════════════════
   編碼：模型 → SMF 位元組
   ═══════════════════════════════════════════ */

function writeEvent(w, ev) {
  if (ev.kind === 'meta') {
    w.u8(0xff);
    w.u8(ev.type);
    w.vlq(ev.data.length);
    w.bytes(ev.data);
    return;
  }
  if (ev.kind === 'sysex') {
    w.u8(ev.type === 'escape' ? 0xf7 : 0xf0);
    w.vlq(ev.data.length);
    w.bytes(ev.data);
    return;
  }
  const high = CHANNEL_STATUS[ev.type];
  if (high === undefined) throw new MidiParseError(`無法編碼未知的事件型別「${ev.type}」`);
  w.u8(high | (ev.channel & 0x0f));
  w.u8(ev.data1 & 0x7f);
  if (CHANNEL_DATA_BYTES[high] === 2) w.u8(ev.data2 & 0x7f);
}

// 刻意不做 running status 壓縮：省下的位元組（約 25%）換不到任何功能，
// 卻讓編碼多一個「上一個狀態位元組是什麼」的隱含狀態，是這類程式最常見的錯誤來源。
// 每個事件都寫出完整狀態位元組完全符合規格，任何播放器都讀得懂。
function encodeTrack(events) {
  const w = new ByteWriter();
  let previousTick = 0;
  for (const ev of events) {
    const delta = ev.ticks - previousTick;
    if (delta < 0) {
      throw new MidiParseError(`事件未依 tick 遞增排序，無法編碼（tick ${ev.ticks} 出現在 ${previousTick} 之後）`);
    }
    w.vlq(delta);
    previousTick = ev.ticks;
    writeEvent(w, ev);
  }
  const last = events[events.length - 1];
  const endsWithEndOfTrack = !!last && last.kind === 'meta' && last.type === META.END_OF_TRACK;
  if (!endsWithEndOfTrack) {
    // 規格要求每一軌都以 FF 2F 00 結尾，少了它多數播放器會直接判定檔案損毀。
    w.vlq(0);
    w.u8(0xff);
    w.u8(META.END_OF_TRACK);
    w.vlq(0);
  }
  return w.toUint8Array();
}

/**
 * 把事件模型寫回 SMF 位元組。
 * @param {{format?: number, division: object|number, tracks: Array<Array<object>>}} model
 *        division 可直接沿用 parseMidi 的結果，或給一個代表 ticksPerQuarter 的數字。
 * @returns {Uint8Array}
 */
export function encodeMidi({ format = 1, division, tracks }) {
  if (!Array.isArray(tracks) || !tracks.length) throw new MidiParseError('encodeMidi 至少需要一軌');
  const w = new ByteWriter();
  w.ascii('MThd');
  w.u32(6);
  w.u16(format);
  w.u16(tracks.length);
  w.u16(encodeDivision(division));
  for (const events of tracks) {
    const body = encodeTrack(events);
    w.ascii('MTrk');
    w.u32(body.length);
    w.bytes(body);
  }
  return w.toUint8Array();
}

/* extractParts()／splitByTrack()／splitByPart()／extractTempoTrack()（連同只給它們用的
   eventRank()／resolveParts()／collectGlobalMeta()）已移除：全專案沒有任何呼叫端，而且
   逐事件依「事件當下的 currentProgram」判斷去留這套邏輯本身有已知的正確性問題——一顆音
   跨越 program change 邊界才結束時，它的 Note Off 會被誤判成屬於新音色而丟棄；Control
   Change 規格也證實 RPN／NRPN 這種「先選參數（CC100/101）、再設值（CC6/38）」的兩段式
   訊息可能被同一套邏輯拆散。沒人呼叫、又有已知問題，留著只會增加維護面積；`encodeMidi()`
   本身沒有已知問題，保留給以後真的需要匯出功能時使用。 */
