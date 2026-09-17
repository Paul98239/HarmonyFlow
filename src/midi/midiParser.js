// ============================================================
//  midiParser.js — Standard MIDI File 解析／切分／重新編碼（純邏輯，無 DOM／CDN 依賴）
//
//  依 MMA 官方規格（Standard MIDI Files 1.0，SMF）手寫，不依賴任何第三方套件：這裡要能把
//  一份總譜精確拆成分部再寫回合法的 .mid，所以保留每一個位元組層級的事件（controller、
//  bank select、SysEx、port…），切分時只做「篩選 ＋ 補齊全域資訊」。
//
//  典型用法：
//    const parsed = parseMidi(await file.arrayBuffer());
//    parsed.parts   // → 這份總譜有哪些聲部（細到 track × channel × program，即「樂器」）
//    parsed.notes   // → humanPerformer.js 直接拿這份（連同 parts、buildMeasureGrid()）
//                   //   建立聲部，不需要先用 extractParts 切成 Blob 再解碼一次。
//    extractParts()／splitByTrack()／splitByPart() 目前只有 test-midi-parser.html（分譜驗證頁）
//    在用，拿來跟 MuseScore 個別匯出的分譜比對正確性。
//
//  本模組不碰 Blob／DOM／AudioContext——包成 Blob 是呼叫端的事。
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

// 「全曲共用」而非「屬於某一軌」的 meta。切分聲部時這些一定要複製進分部檔，
// 否則分部會用預設的 120bpm 4/4 播放，跟總譜對不起來。
// 刻意不含 COPYRIGHT／TEXT 這類純註記：複製到每一份分部只會變成雜訊，漏掉也不影響演奏結果。
/** @type {Set<number>} */
const GLOBAL_META = new Set([
  META.SET_TEMPO,
  META.TIME_SIGNATURE,
  META.KEY_SIGNATURE,
  META.SMPTE_OFFSET,
  META.MARKER, // 排練記號：合奏對位時要靠它，屬於全曲
]);

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
const WARNING_LIMIT = 100;

// General MIDI Level 1 音色表（program 0~127），拼法對齊 MMA「General MIDI Level 1
// Sound Set」官方文件（例：Clavi 而非 Clavinet、SynthStrings 1、Pad 5 (bowed)、
// Lead 8 (bass + lead)、Electric Bass (pick)、Agogo、Guitar harmonics 小寫 h）。
// 這裡刻意保留規格的英文原名，不自行翻譯：它是規格的一部分，翻譯屬於顯示層的事。
// 用途是靠音色編號認出「這個聲部是什麼樂器」（不採信檔案的 track name／instrument name）。
const GM_PROGRAM_NAMES = Object.freeze([
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavi',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'SynthStrings 1', 'SynthStrings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'SynthBrass 1', 'SynthBrass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
]);

// GM 打擊樂 channel（第 10 軌，索引 9）上 program 代表的是鼓組而非旋律樂器。
const GM_DRUM_KITS = Object.freeze({
  0: 'Standard Kit', 8: 'Room Kit', 16: 'Power Kit', 24: 'Electronic Kit',
  25: 'TR-808 Kit', 32: 'Jazz Kit', 40: 'Brush Kit', 48: 'Orchestra Kit', 56: 'Sound FX Kit',
});
const DRUM_CHANNEL = 9;

// General MIDI Level 1 音色表的繁體中文對照，索引與 GM_PROGRAM_NAMES 對齊。
// 分譜清單一律用這份表命名聲部，不採信檔案裡的軌名（FF03）／樂器名（FF04）：那些欄位常常是
// 其他語言、排版用的分隔線或空白。GM program 是規格明訂、與語言無關的欄位，而且就是音源引擎
// 實際會奏出的音色。
const GM_PROGRAM_NAMES_ZH = Object.freeze([
  '大鋼琴', '明亮鋼琴', '電平台鋼琴', '酒吧鋼琴',
  '電鋼琴 1', '電鋼琴 2', '大鍵琴', '電鍵琴',
  '鋼片琴', '鐘琴', '音樂盒', '顫音琴',
  '馬林巴琴', '木琴', '管鐘', '揚琴',
  '拉桿風琴', '打擊式風琴', '搖滾風琴', '教堂管風琴',
  '簧風琴', '手風琴', '口琴', '探戈手風琴',
  '尼龍弦吉他', '鋼弦吉他', '爵士電吉他', '清音電吉他',
  '悶音電吉他', '過載電吉他', '破音電吉他', '吉他泛音',
  '原聲貝斯', '指彈電貝斯', '撥片電貝斯', '無格貝斯',
  '擊弦貝斯 1', '擊弦貝斯 2', '合成貝斯 1', '合成貝斯 2',
  '小提琴', '中提琴', '大提琴', '低音提琴',
  '震音弦樂', '撥弦弦樂', '豎琴', '定音鼓',
  '弦樂合奏 1', '弦樂合奏 2', '合成弦樂 1', '合成弦樂 2',
  '人聲「啊」', '人聲「喔」', '合成人聲', '管弦樂齊奏',
  '小號', '長號', '低音號', '弱音小號',
  '法國號', '銅管組', '合成銅管 1', '合成銅管 2',
  '高音薩克斯風', '中音薩克斯風', '次中音薩克斯風', '上低音薩克斯風',
  '雙簧管', '英國管', '低音管', '單簧管',
  '短笛', '長笛', '直笛', '排笛',
  '吹瓶', '尺八', '哨子', '陶笛',
  '方波主音', '鋸齒波主音', '汽笛風琴主音', '吹管主音',
  '香蘭琴主音', '人聲主音', '五度疊置主音', '貝斯加主音',
  '新世紀鋪底', '溫暖鋪底', '複音合成鋪底', '人聲鋪底',
  '弓弦鋪底', '金屬鋪底', '光暈鋪底', '掃頻鋪底',
  '音效：雨聲', '音效：配樂', '音效：水晶', '音效：氛圍',
  '音效：明亮', '音效：精靈', '音效：回聲', '音效：科幻',
  '西塔琴', '班鳩琴', '三味線', '箏',
  '卡林巴琴', '風笛', '民謠提琴', '嗩吶',
  '叮噹鈴', '阿哥哥鈴', '鋼鼓', '木塊',
  '太鼓', '旋律筒鼓', '合成鼓', '反轉鈸',
  '吉他換把雜音', '呼吸聲', '海浪聲', '鳥鳴',
  '電話鈴聲', '直升機', '掌聲', '槍聲',
]);

const GM_DRUM_KITS_ZH = Object.freeze({
  0: '標準鼓組', 8: '房間鼓組', 16: '強力鼓組', 24: '電子鼓組',
  25: 'TR-808 鼓組', 32: '爵士鼓組', 40: '刷擊鼓組', 48: '管弦打擊組', 56: '音效鼓組',
});

/**
 * GM 音色編號 → 名稱。isDrum 為 true 時查鼓組表（打擊 channel 的 program 意義不同）。
 */
export function gmProgramName(program, isDrum = false) {
  if (!Number.isInteger(program) || program < 0 || program > 127) return '';
  if (isDrum) return GM_DRUM_KITS[program] || `Drum Kit ${program}`;
  return GM_PROGRAM_NAMES[program];
}

/**
 * GM 音色編號 → 繁體中文名稱。分譜清單的聲部命名一律走這裡（見 GM_PROGRAM_NAMES_ZH
 * 的說明）。查不到（program 超出 0~127）時回傳空字串，由呼叫端決定退路。
 */
export function gmProgramNameZh(program, isDrum = false) {
  if (!Number.isInteger(program) || program < 0 || program > 127) return '';
  if (isDrum) return GM_DRUM_KITS_ZH[program] || `鼓組 ${program}`;
  return GM_PROGRAM_NAMES_ZH[program];
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
const textEncoder = new TextEncoder();

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
        warn(`track ${trackIndex} 的 tick ${ev.tick}：速度事件 FF51 長度應為 3，實際 ${d.length}，已忽略`);
      }
      break;
    case META.SMPTE_OFFSET:
      if (d.length >= 5) {
        ev.smpteOffset = { hours: d[0], minutes: d[1], seconds: d[2], frames: d[3], subFrames: d[4] };
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
        // 規格沒訂這種簡化版的預設值，沿用業界慣用的 24 clocks/click、8 個 32分音符。
        ev.numerator = d[0];
        ev.denominator = 2 ** d[1];
        ev.clocksPerClick = 0x24;
        ev.thirtySecondNotesPer24Clocks = 0x08;
      } else {
        warn(`track ${trackIndex} 的 tick ${ev.tick}：拍號事件 FF58 長度應為 4（或簡化版 2），實際 ${d.length}，已忽略`);
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
  let sawEndOfTrack = false;
  let name = '';
  let instrumentName = '';
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
        // 規格：SysEx 與 meta 事件會清掉 running status，只有 channel message 能被延用。
        runningStatus = status < 0xf0 ? status : 0;
      } else if (runningStatus) {
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
        const ev = { tick, kind: 'meta', type, data };
        decorateMeta(ev, warn, trackIndex);
        events.push(ev);

        if (type === META.TRACK_NAME && !name) name = ev.text;
        else if (type === META.INSTRUMENT_NAME && !instrumentName) instrumentName = ev.text;
        else if (type === META.PORT && port === null) port = ev.port ?? null;
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
        events.push({ tick, kind: 'sysex', type: status === 0xf0 ? 'sysex' : 'escape', data });
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
        events.push({ tick, kind: 'channel', type, channel, data1, data2 });
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
  const endTick = sawEndOfTrack ? tick : (events.length ? events[events.length - 1].tick : 0);

  return {
    index: trackIndex,
    name,
    instrumentName,
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
  list.sort((a, b) => a.ev.tick - b.ev.tick);
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
    if (last && last.tick === ev.tick) {
      if (last.microsecondsPerQuarter !== ev.microsecondsPerQuarter) {
        warn(`tick ${ev.tick} 有互相衝突的速度事件（track ${trackIndex} 指定 ${ev.bpm.toFixed(2)} BPM），採用先出現的那一個`);
      }
      continue;
    }
    if (last && last.microsecondsPerQuarter === ev.microsecondsPerQuarter) continue; // 重複值不必新增區段
    map.push({ tick: ev.tick, microsecondsPerQuarter: ev.microsecondsPerQuarter, bpm: ev.bpm, seconds: 0 });
  }
  if (!map.length || map[0].tick !== 0) {
    map.unshift({ tick: 0, microsecondsPerQuarter: DEFAULT_TEMPO_US, bpm: 60000000 / DEFAULT_TEMPO_US, seconds: 0 });
  }
  // 逐段累積起始秒數，之後 tickToSeconds 只要找到所屬區段再線性內插即可。
  if (division.type === 'ppq') {
    for (let i = 1; i < map.length; i++) {
      const prev = map[i - 1];
      map[i].seconds =
        prev.seconds + ((map[i].tick - prev.tick) * prev.microsecondsPerQuarter) / 1e6 / division.ticksPerQuarter;
    }
  }
  return map;
}

function makeTickToSeconds(tempoMap, division) {
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
      if (tempoMap[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const seg = tempoMap[lo];
    return seg.seconds + ((tick - seg.tick) * seg.microsecondsPerQuarter) / 1e6 / tpq;
  };
}

function buildSignatureList(tracks, type, decorate, fallback) {
  const out = [];
  for (const { ev } of collectMeta(tracks, type)) {
    const last = out[out.length - 1];
    if (last && last.tick === ev.tick) continue; // 同 tick 只取先出現的
    out.push(decorate(ev));
  }
  if (!out.length || out[0].tick !== 0) out.unshift({ tick: 0, ...fallback });
  return out;
}

/* ═══════════════════════════════════════════
   解析：音符配對
   ═══════════════════════════════════════════ */

function partIdOf(trackIndex, channel, program) {
  return `t${trackIndex}c${channel}p${program}`;
}

/**
 * @param {number} trackIndex
 * @param {MidiChannelEvent} onEvent
 * @param {number} endTick
 * @param {number} offVelocity
 * @param {(tick:number) => number} tickToSeconds
 * @param {number} program  note-on 當下這個 channel 生效的音色（見 collectNotes 的 currentProgram）
 * @returns {MidiNote}
 */
function makeNote(trackIndex, onEvent, endTick, offVelocity, tickToSeconds, program) {
  const startSeconds = tickToSeconds(onEvent.tick);
  const endSeconds = tickToSeconds(endTick);
  return {
    // 產生這顆音的那個 note-on 事件本身（同一個物件，不是複製）：note 這一層有樂理資訊
    // （拍點、樂句、和弦），事件那一層才是 extractParts() 真正會編碼出去的東西。目前沒有
    // 任何地方會改寫它（parseMidi 的輸出都當唯讀），保留這個參照是為了萬一之後需要
    // 就地改力度之類的加工時，兩層資料能對得起來，不必再重新對應一次。
    onEvent,
    trackIndex,
    channel: onEvent.channel,
    program,
    partId: partIdOf(trackIndex, onEvent.channel, program),
    note: onEvent.data1,
    velocity: onEvent.data2,
    offVelocity,
    startTick: onEvent.tick,
    endTick,
    durationTicks: endTick - onEvent.tick,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
  };
}

function collectNotes(tracks, tickToSeconds, warn) {
  const notes = [];
  for (const track of tracks) {
    // key = channel * 128 + 音高。同一 key 可能同時有多顆未收尾的音（同音重疊），
    // 以先進先出配對：先響的音先被關掉，這是最貼近演奏直覺的解讀。
    const pending = new Map();
    // 逐 channel 追蹤目前生效的音色，用來把每顆音歸到「它響起當下實際在吹奏的樂器」；
    // 沒有明確 program change 時 GM 規格預設就是 0（Acoustic Grand Piano）。這是分聲部
    // 除了 track×channel 之外還要看 program 的原因：一個 channel 中途換過音色，
    // 換過去之後彈的音不該跟換之前混成同一個聲部（見 partIdOf 的說明）。
    const currentProgram = new Array(16).fill(0);
    for (const ev of track.events) {
      if (ev.kind !== 'channel') continue;
      if (ev.type === 'programChange') { currentProgram[ev.channel] = ev.data1; continue; }
      const isNoteOn = ev.type === 'noteOn' && ev.data2 > 0;
      // 規格允許用「力度 0 的 note on」代替 note off（可讓整段音符共用 running status），
      // 實務上絕大多數檔案都這樣寫。
      const isNoteOff = ev.type === 'noteOff' || (ev.type === 'noteOn' && ev.data2 === 0);
      if (!isNoteOn && !isNoteOff) continue;

      const key = ev.channel * 128 + ev.data1;
      if (isNoteOn) {
        let queue = pending.get(key);
        if (!queue) pending.set(key, (queue = []));
        // 記下 note-on 那一刻生效的音色，不是 note-off 那一刻的——決定「這是哪個樂器彈的」
        // 應該看音符開始的當下，中途換音色不該回頭影響已經在響的音符。
        queue.push({ ev, program: currentProgram[ev.channel] });
        continue;
      }
      const queue = pending.get(key);
      if (!queue || !queue.length) {
        warn(`track ${track.index} 的 tick ${ev.tick}：channel ${ev.channel} 音高 ${ev.data1} 有 note off 卻沒有對應的 note on，已忽略`);
        continue;
      }
      const { ev: onEv, program } = queue.shift();
      notes.push(makeNote(track.index, onEv, ev.tick, ev.type === 'noteOff' ? ev.data2 : 0, tickToSeconds, program));
    }
    for (const [key, queue] of pending) {
      for (const { ev: on, program } of queue) {
        warn(`track ${track.index} 的 tick ${on.tick}：channel ${(key / 128) | 0} 音高 ${key % 128} 的 note on 沒有對應的 note off，已在軌尾收尾`);
        notes.push(makeNote(track.index, on, Math.max(on.tick, track.endTick), 0, tickToSeconds, program));
      }
    }
  }
  notes.sort(
    (a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex || a.channel - b.channel || a.note - b.note
  );
  return notes;
}

/* ═══════════════════════════════════════════
   解析：聲部切分
   ═══════════════════════════════════════════ */

// 一個「聲部」＝（track, channel, program）這個組合上真的有音符的那一群事件。
// 細到 channel 而不只看 track：同一軌常同時放同一件樂器的不同奏法（ch0 弓弦／ch1 撥弦／
// ch2 震音），或把多件樂器塞在同一軌（format 0 更是全部擠在一軌）。只用 track 切會漏掉這層，
// 只用 channel 切則會把不同軌的同號 channel 混在一起。
// 還要看 program：同一個 channel 中途換過音色（program change）時，換過去之後彈的音已經是
// 不同樂器在演奏，不該跟換之前的音混成同一個聲部——這種情況常見於受限在 16 個 channel、
// 中途借用同一個 channel 切換音色的複雜總譜。

/* ── 聲部的「高低音譜」與「旋律／和聲」判定（啟發式，門檻可調）──
   MIDI 位元組層級沒有譜號、也沒有「這是主旋律」的欄位，只能從音高分佈與同時發聲數
   反推。一份鋼琴 MIDI 常是「右手一軌、左手一軌」，切出來只會是「大鋼琴 1／2」，
   分不出誰是旋律誰是伴奏——這裡補上 clef／role 兩個標籤，命名時用來取代無意義的數字尾碼。
   這幾個門檻是憑樂理常識挑的；覺得判錯時直接調這裡的常數即可，不影響 parseMidi 的其他輸出。 */
const CLEF_TREBLE_MEDIAN_MIN = 60; // 中位音高 ≥ 中央 C 才可能是高音譜
const CLEF_TREBLE_LOW_MIN = 48;    // 且最低音不低於此，否則音域橫跨太廣 → mixed
const CLEF_BASS_MEDIAN_MAX = 55;   // 中位音高 < 此值才可能是低音譜
const CLEF_BASS_HIGH_MAX = 67;     // 且最高音不高於此
const POLY_CHORDAL_MIN = 1.6;      // 平均同時發聲數 ≥ 此值 → 視為和弦／和聲
const POLY_MONOPHONIC_MAX = 1.25;  // ≤ 此值 → 明確單音；中間是模糊帶，依 clef 傾向

function medianOf(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 「作響期間的平均同時發聲數」＝ 所有音符的總持續 tick ÷ 聲部的時間跨度。
// 單音線 ≈ 1（音符首尾相接）、和弦聲部 ≈ 每個和弦的音數。免 sweep-line。
function polyphonyAverage(sumDurationTicks, spanTicks) {
  return spanTicks > 0 ? sumDurationTicks / spanTicks : 1;
}

function classifyClef(medianNote, lowestNote, highestNote) {
  if (medianNote == null) return null;
  if (medianNote >= CLEF_TREBLE_MEDIAN_MIN && lowestNote >= CLEF_TREBLE_LOW_MIN) return 'treble';
  if (medianNote < CLEF_BASS_MEDIAN_MAX && highestNote <= CLEF_BASS_HIGH_MAX) return 'bass';
  return 'mixed';
}

function classifyRole(polyphonyAvg, clef) {
  if (clef == null) return null;
  if (polyphonyAvg >= POLY_CHORDAL_MIN) return 'harmony';
  if (polyphonyAvg <= POLY_MONOPHONIC_MAX) return clef === 'bass' ? 'bass' : 'melody';
  // 模糊帶：偏單音，依 clef 傾向（treble→旋律、bass→低音線、mixed→歸進伴奏最安全）
  if (clef === 'treble') return 'melody';
  if (clef === 'bass') return 'bass';
  return 'harmony';
}

// 同名聲部（三部小提琴、鋼琴左右手都是「大鋼琴」）用來區分的描述子。
// clef=bass 且 role=bass 時兩段都是「低音」，去重成單一「低音」。
const CLEF_LABEL = Object.freeze({ treble: '高音', bass: '低音', mixed: '' });
const ROLE_LABEL = Object.freeze({ melody: '旋律', harmony: '伴奏', bass: '低音' });
function partDescriptor(part) {
  const clefLabel = CLEF_LABEL[part.clef] ?? '';
  const roleLabel = ROLE_LABEL[part.role] ?? '';
  const segs = [];
  if (clefLabel) segs.push(clefLabel);
  if (roleLabel && roleLabel !== clefLabel) segs.push(roleLabel);
  return segs.join('·');
}

/**
 * @param {MidiTrack[]} tracks
 * @param {MidiNote[]} notes
 * @param {(msg:string) => void} warn
 * @returns {MidiPart[]}
 */
function collectParts(tracks, notes, warn) {
  const stats = new Map();
  for (const note of notes) {
    let stat = stats.get(note.partId);
    if (!stat) {
      stats.set(note.partId, (stat = {
        trackIndex: note.trackIndex,
        channel: note.channel,
        program: note.program,
        noteCount: 0,
        startTick: note.startTick,
        endTick: note.endTick,
        lowestNote: note.note,
        highestNote: note.note,
        // 下面 clef／role 判定用的暫存，建立 part 物件時會被排除、不外流
        pitches: [],
        sumDurationTicks: 0,
      }));
    }
    stat.noteCount++;
    stat.startTick = Math.min(stat.startTick, note.startTick);
    stat.endTick = Math.max(stat.endTick, note.endTick);
    stat.lowestNote = Math.min(stat.lowestNote, note.note);
    stat.highestNote = Math.max(stat.highestNote, note.note);
    stat.pitches.push(note.note);
    stat.sumDurationTicks += note.durationTicks;
  }

  // 各 (track, channel, program) 的 Bank Select（CC0 MSB / CC32 LSB）。MIDI 規格：選音色是
  // 「先送 bank select（CC0、CC32），再送 program change」。bank 取「這個 program change
  // 當下生效的值」——記譜軟體通常把 bank select 和 program change 寫在同一個音色設定區塊；
  // 沒有 program change 的 channel 就取整軌看到的最後一組（此時 program 是 GM 預設值 0）。
  // GM／GM2 melodic 的預設 bank MSB 是 0（GM2 也接受 121），MSB 120 是 GM2 的節奏（鼓組）
  // bank；其他 MSB 代表檔案選了非 GM 的變體音色。
  const banks = new Map(); // id → { msb, lsb }
  for (const track of tracks) {
    const running = new Map(); // channel → { msb, lsb }（這一軌目前生效的 bank）
    const currentProgram = new Array(16).fill(0);
    for (const ev of track.events) {
      if (ev.kind !== 'channel') continue;
      if (ev.type === 'controlChange' && (ev.data1 === 0 || ev.data1 === 32)) {
        let b = running.get(ev.channel);
        if (!b) running.set(ev.channel, (b = { msb: 0, lsb: 0 }));
        if (ev.data1 === 0) b.msb = ev.data2; else b.lsb = ev.data2;
        continue;
      }
      if (ev.type !== 'programChange') continue;
      currentProgram[ev.channel] = ev.data1;
      const id = partIdOf(track.index, ev.channel, ev.data1);
      if (!banks.has(id)) banks.set(id, { ...(running.get(ev.channel) || { msb: 0, lsb: 0 }) });
    }
    for (const [ch, b] of running) {
      const id = partIdOf(track.index, ch, currentProgram[ch]);
      if (!banks.has(id)) banks.set(id, { ...b });
    }
  }

  const parts = [];
  for (const [id, stat] of stats) {
    // pitches／sumDurationTicks 只是 clef／role 判定的中間值，不放進對外的 part 物件
    const { pitches, sumDurationTicks, ...statPublic } = stat;
    const track = tracks[stat.trackIndex];
    const program = stat.program;
    const bank = banks.get(id) || { msb: 0, lsb: 0 };
    const isDrum = stat.channel === DRUM_CHANNEL;      // 規格：第 10 個 channel（索引 9）
    const percussionKit = isDrum || bank.msb === 120;  // GM2 節奏 bank 也是鼓組
    // 打擊／鼓組聲部沒有音高譜號的概念，clef／role／medianNote 一律 null（命名退回數字尾碼）
    const medianNote = percussionKit ? null : medianOf(pitches);
    const polyphonyAvg = polyphonyAverage(sumDurationTicks, stat.endTick - stat.startTick);
    const clef = percussionKit ? null : classifyClef(medianNote, stat.lowestNote, stat.highestNote);
    const role = percussionKit ? null : classifyRole(polyphonyAvg, clef);
    parts.push({
      id,
      ...statPublic,
      trackName: track.name,
      instrumentName: track.instrumentName,
      programs: [program], // 保留陣列形狀給呼叫端相容；分聲部現在本來就是一個 id 對一個 program
      bank,
      programName: gmProgramName(program, percussionKit),
      isDrum,
      percussionKit,
      medianNote,
      polyphonyAvg,
      clef,
      role,
      name: '', // 下面補：要先數過所有聲部才知道哪些音色名需要加描述子／尾碼區分
    });
  }
  parts.sort((a, b) => a.trackIndex - b.trackIndex || a.channel - b.channel);

  // 命名：基底一律用 GM 音色的繁體中文名（不採信檔案裡的軌名／樂器名，見
  // GM_PROGRAM_NAMES_ZH 的說明）。整份總譜裡有多個聲部共用同一個基底名時
  // （三部小提琴、或鋼琴左右手都是「大鋼琴」），先試著用「高低音譜＋旋律／和聲」
  // 的描述子把它們區分開（大鋼琴（高音·旋律）／大鋼琴（低音·伴奏））；描述子
  // 不足以讓群組裡「每個都不一樣」時，才退回依聲部順序加數字尾碼「 1」「 2」…。
  // 群組裡只有一個的，什麼後綴都不加。
  const zhBaseOf = (part) => {
    let n = gmProgramNameZh(part.program, part.percussionKit)
      || `聲部 ${part.trackIndex + 1}-${part.channel + 1}`;
    // 檔案用 Bank Select 選了非 GM 的變體音色（MSB 不是 GM/GM2 的 0/121、也不是鼓組
    // 的 120）→ GM 名只能當近似，標註實際 bank 讓使用者知道。
    if (!part.percussionKit && part.bank.msb !== 0 && part.bank.msb !== 121) {
      n += `（非 GM bank ${part.bank.msb}:${part.bank.lsb}）`;
    }
    return n;
  };
  const groups = new Map(); // 基底名 → 同名聲部（維持 parts 的排序）
  for (const part of parts) {
    const base = zhBaseOf(part);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(part);
  }
  for (const [base, group] of groups) {
    if (group.length === 1) { group[0].name = base; continue; }
    const descriptors = group.map(partDescriptor);
    const allDistinct = descriptors.every((d) => d) && new Set(descriptors).size === group.length;
    group.forEach((part, i) => {
      part.name = allDistinct ? `${base}（${descriptors[i]}）` : `${base} ${i + 1}`;
    });
  }

  if (!parts.length) warn('這份檔案裡沒有任何音符，切分不出聲部');
  return parts;
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
 * @property {number} tick
 * @property {'channel'} kind
 * @property {'noteOff'|'noteOn'|'polyAftertouch'|'controlChange'|'programChange'|'channelAftertouch'|'pitchBend'} type
 * @property {number} channel  0~15
 * @property {number} data1
 * @property {number} data2  單資料位元組的訊息（programChange／channelAftertouch）固定 0
 */

/**
 * meta 事件（FF xx）。data 是原始位元組；decorateMeta() 依 type 另外解出語意欄位（有就有、沒有就 undefined）。
 * @typedef {object} MidiMetaEvent
 * @property {number} tick
 * @property {'meta'} kind
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
 * @property {number} tick
 * @property {'sysex'} kind
 * @property {'sysex'|'escape'} type  F0 或 F7
 * @property {Uint8Array} data
 */

/** @typedef {MidiChannelEvent|MidiMetaEvent|MidiSysexEvent} MidiEvent */

/**
 * @typedef {object} MidiTrack
 * @property {number} index
 * @property {string} name  FF 03；沒有就空字串
 * @property {string} instrumentName  FF 04；沒有就空字串
 * @property {number|null} port  FF 21
 * @property {number[]} channels  這一軌用到的 channel（0~15，遞增）
 * @property {MidiEvent[]} events  依檔案順序，tick 為絕對值
 * @property {number} endTick
 */

/**
 * SMF 檔頭的 division。ppq：每四分音符幾個 tick；smpte：每秒幾格 × 每格幾個 tick。
 * @typedef {{type:'ppq', ticksPerQuarter:number, raw:number} | {type:'smpte', nominalFps:number, framesPerSecond:number, ticksPerFrame:number, ticksPerSecond:number, ticksPerQuarter:null, raw:number}} MidiDivision
 */

/** @typedef {{tick:number, microsecondsPerQuarter:number, bpm:number, seconds:number}} TempoMapEntry */
/** @typedef {{tick:number, numerator:number, denominator:number, clocksPerClick:number, thirtySecondNotesPer24Clocks:number}} TimeSignatureEntry */
/** @typedef {{tick:number, sharpsFlats:number, minor:boolean}} KeySignatureEntry */

/**
 * 一顆音（note-on 配對到 note-off 之後的結果），由 collectNotes() 產生。
 * @typedef {object} MidiNote
 * @property {MidiChannelEvent} onEvent  產生這顆音的 note-on 事件本身（同一個物件，見 makeNote 的說明）
 * @property {number} trackIndex
 * @property {number} channel
 * @property {number} program  這顆音 note-on 當下這個 channel 生效的音色
 * @property {string} partId  t{trackIndex}c{channel}p{program}
 * @property {number} note  音高 0~127
 * @property {number} velocity  note-on 當下的力度（onEvent.data2 的快照）
 * @property {number} offVelocity
 * @property {number} startTick
 * @property {number} endTick
 * @property {number} durationTicks
 * @property {number} startSeconds
 * @property {number} endSeconds
 * @property {number} durationSeconds
 */

/**
 * 一個聲部 ＝ 一個 (track, channel, program) 組合，由 collectParts() 產生。同一個 channel
 * 中途換過音色時，換過去之後的音符會被視為不同聲部（見 midiParser.js 開頭「聲部切分」的說明）。
 * @typedef {object} MidiPart
 * @property {string} id  t{trackIndex}c{channel}p{program}
 * @property {number} trackIndex
 * @property {number} channel
 * @property {number} noteCount
 * @property {number} startTick
 * @property {number} endTick
 * @property {number} lowestNote
 * @property {number} highestNote
 * @property {string} trackName  只是 metadata，命名不用它（見 GM_PROGRAM_NAMES_ZH 的說明）
 * @property {string} instrumentName
 * @property {number} program  這個聲部固定使用的音色；沒有明確 program change 就是 GM 預設值 0
 * @property {number[]} programs  相容用的陣列形狀，恆為 [program]（見上）
 * @property {{msb:number, lsb:number}} bank  這個 program change 當下生效的 Bank Select
 * @property {string} programName  GM 英文名
 * @property {boolean} isDrum  channel 9
 * @property {boolean} percussionKit  channel 9 或 GM2 節奏 bank（MSB 120）
 * @property {number|null} medianNote  鼓組為 null
 * @property {number} polyphonyAvg  作響期間的平均同時發聲數
 * @property {'treble'|'bass'|'mixed'|null} clef
 * @property {'melody'|'harmony'|'bass'|null} role
 * @property {string} name  顯示名稱（GM 繁中音色名＋描述子／數字尾碼）
 */

/**
 * parseMidi() 的解析結果。
 * @typedef {object} ParsedMidi
 * @property {number} format  0／1／2
 * @property {number} numTracksDeclared
 * @property {MidiDivision} division
 * @property {number|null} ticksPerQuarter  smpte 時為 null
 * @property {MidiTrack[]} tracks
 * @property {TempoMapEntry[]} tempoMap
 * @property {TimeSignatureEntry[]} timeSignatures  保證至少一筆、且第一筆在 tick 0
 * @property {KeySignatureEntry[]} keySignatures  同上
 * @property {MidiNote[]} notes  依 startTick 排序
 * @property {MidiPart[]} parts  依 trackIndex、channel 排序
 * @property {number} durationTicks
 * @property {number} durationSeconds
 * @property {(tick:number) => number} tickToSeconds  依速度表把 tick 換算成秒
 * @property {string[]} warnings  解析過程中發現的問題（不中斷解析）
 */

/**
 * 解析一份 Standard MIDI File。
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {ParsedMidi} 解析結果；解析過程中發現的問題收在 .warnings，不會中斷解析
 */
export function parseMidi(input) {
  const bytes = toBytes(input);
  const warnings = [];
  const warn = makeWarn(warnings);
  const reader = new ByteReader(bytes);

  const magic = reader.ascii(4, '檔頭 chunk 標記');
  if (magic !== 'MThd') {
    if (magic === 'RIFF') {
      throw new MidiParseError('這是 RIFF 包裝的 RMID 檔，不是裸的 Standard MIDI File；請先取出其中的 MThd 區段');
    }
    throw new MidiParseError(`不是 Standard MIDI File：開頭應為 "MThd"，實際為 "${magic}"`);
  }

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

  const tempoMap = buildTempoMap(tracks, division, warn);
  const tickToSeconds = makeTickToSeconds(tempoMap, division);
  const timeSignatures = buildSignatureList(
    tracks,
    META.TIME_SIGNATURE,
    (ev) => ({
      tick: ev.tick,
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
    (ev) => ({ tick: ev.tick, sharpsFlats: ev.sharpsFlats, minor: ev.minor }),
    { sharpsFlats: 0, minor: false }
  );

  const notes = collectNotes(tracks, tickToSeconds, warn);
  const parts = collectParts(tracks, notes, warn);
  const durationTicks = tracks.reduce((max, t) => Math.max(max, t.endTick), 0);

  return {
    format,
    numTracksDeclared,
    division,
    ticksPerQuarter: division.ticksPerQuarter,
    tracks,
    tempoMap,
    timeSignatures,
    keySignatures,
    notes,
    parts,
    durationTicks,
    durationSeconds: tickToSeconds(durationTicks),
    tickToSeconds,
    warnings,
  };
}

/* ═══════════════════════════════════════════
   小節格線：多人合奏共用同步用（humanPerformer.js）。不塞進 parseMidi() 的回傳值，
   避免影響 test-midi-parser.html 的分譜比對基準。
   ═══════════════════════════════════════════ */

/**
 * @typedef {{index:number, startTick:number, endTick:number, startSeconds:number,
 *   endSeconds:number, numerator:number, denominator:number, beatTicks:number}} Measure
 */

/**
 * 依拍號（timeSignatures）與 ticksPerQuarter 推算全曲的小節線。拍號中途變更處強制斷一條
 * 小節線，該段落最後一小節可能因此不是完整長度；樂曲真正結尾的最後一小節不截短，保留完整
 * 名目長度（讓演奏者仍有整小節的揮手窗口）。SMPTE division 沒有「四分音符」這個概念，
 * ticksPerQuarter 為 null，回傳空陣列——呼叫端退回沒有格線的路徑。弱起拍（anacrusis）
 * 目前不處理，格線一律從 tick 0 起算。
 * @param {ParsedMidi} parsed  parseMidi() 的結果
 * @returns {Measure[]}
 */
export function buildMeasureGrid(parsed) {
  const tpq = parsed.ticksPerQuarter;
  if (!tpq) return [];
  const sigs = parsed.timeSignatures; // 保證至少一筆、且第一筆在 tick 0
  const pieceEnd = Math.max(parsed.durationTicks, sigs[sigs.length - 1].tick + 1);

  const grid = [];
  let tick = 0;
  for (let i = 0; i < sigs.length; i++) {
    const sig = sigs[i];
    const isLastSection = i + 1 >= sigs.length;
    const sectionEnd = isLastSection ? pieceEnd : sigs[i + 1].tick;
    const measureTicks = Math.round((tpq * 4 * sig.numerator) / sig.denominator);
    const beatTicks = Math.round((tpq * 4) / sig.denominator);

    while (tick < sectionEnd) {
      const full = tick + measureTicks;
      const endTick = isLastSection ? full : Math.min(full, sectionEnd);
      grid.push({
        index: grid.length,
        startTick: tick,
        endTick,
        startSeconds: parsed.tickToSeconds(tick),
        endSeconds: parsed.tickToSeconds(endTick),
        numerator: sig.numerator,
        denominator: sig.denominator,
        beatTicks,
      });
      tick = endTick;
    }
  }
  return grid;
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
    const delta = ev.tick - previousTick;
    if (delta < 0) {
      throw new MidiParseError(`事件未依 tick 遞增排序，無法編碼（tick ${ev.tick} 出現在 ${previousTick} 之後）`);
    }
    w.vlq(delta);
    previousTick = ev.tick;
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

/* ═══════════════════════════════════════════
   切分：抽出指定聲部
   ═══════════════════════════════════════════ */

// 同一 tick 內的排序權重。切分時唯一會「插隊」的是補進來的全域 meta（速度／拍號／調號），
// 它們可能來自別軌、沒有既定位置；其餘事件一律維持原始相對順序，靠 sort 的穩定性保證。
// 除了軌名之外，其他 meta 都不能往前排——FF21（MIDI Port）與 FF20（Channel Prefix）是
// 「宣告接下來的事件屬於哪個 port／channel」的位置性事件，記譜軟體會把它夾在各 channel 的
// 設定區塊之間，提前等於把它宣告的範圍整個改掉。bank select → program change → note on 的
// 先後也只是靠「維持原序」來保證。
function eventRank(ev) {
  if (ev.kind !== 'meta') return 2;
  if (ev.type === META.TRACK_NAME || ev.type === META.INSTRUMENT_NAME) return 0;
  if (GLOBAL_META.has(ev.type)) return 1;
  return 2;
}

function resolveParts(parsed, selector) {
  const wanted = Array.isArray(selector) ? selector : [selector];
  const byId = new Map(parsed.parts.map((p) => [p.id, p]));
  return wanted.map((item) => {
    const id = typeof item === 'string' ? item : item?.id;
    const part = byId.get(id);
    if (!part) {
      throw new MidiParseError(
        `找不到聲部「${id}」；這份檔案有：${parsed.parts.map((p) => p.id).join('、') || '（無）'}`
      );
    }
    return part;
  });
}

// 從所有軌收集全域 meta 並去重。去重的比較基準是「tick ＋ 型別 ＋ 內容」——
// 總譜各軌常常都寫著同一份調號，若不去重，抽出來的分部會拿到好幾份一模一樣的事件。
function collectGlobalMeta(parsed, warn) {
  const seenExact = new Set();
  const seenSlot = new Set();
  const out = [];
  for (const track of parsed.tracks) {
    for (const ev of track.events) {
      if (ev.kind !== 'meta' || !GLOBAL_META.has(ev.type)) continue;
      const exact = `${ev.tick}:${ev.type}:${Array.from(ev.data).join(',')}`;
      if (seenExact.has(exact)) continue;
      const slot = `${ev.tick}:${ev.type}`;
      if (seenSlot.has(slot)) {
        warn(`tick ${ev.tick} 有內容不同的重複全域 meta（型別 0x${ev.type.toString(16)}），切分後兩份都會保留`);
      }
      seenExact.add(exact);
      seenSlot.add(slot);
      out.push(ev);
    }
  }
  return out;
}

/**
 * 從總譜抽出指定聲部，產生一份新的、可直接播放的 SMF。
 *
 * 被保留的不只是音符：該 channel 的所有 controller、bank select、pitch bend、
 * program change 都原樣帶走，音色與表情才不會跑掉；同時把全曲共用的速度、拍號、
 * 調號補進來（總譜常常只把它們寫在第一軌），並讓輸出檔的總長度與總譜一致，
 * 這樣各分部單獨播放時仍能彼此對齊。
 *
 * @param {ParsedMidi} parsed  parseMidi 的結果（事件與聲部不會被修改，但同一 tick 有內容
 *        衝突的重複全域 meta 時會往 parsed.warnings 追加一則警告）
 * @param {string[]|object[]} selector  要保留的聲部 id 或 part 物件
 * @param {{name?: string}} [options]  name：覆寫輸出檔第一軌的軌名
 * @returns {Uint8Array} 可直接包成 Blob 播放的 .mid 位元組
 */
export function extractParts(parsed, selector, options = {}) {
  const selected = resolveParts(parsed, selector);
  if (!selected.length) throw new MidiParseError('extractParts 至少要選一個聲部');

  // key 要連 program 一起比對：一個 channel 中途換過音色時，只保留「被選中的那個聲部」
  // 演奏當下的事件，換到別的音色之後彈的音不該跟著被留下來。
  const keep = new Set(selected.map((p) => `${p.trackIndex}:${p.channel}:${p.program}`));
  // 「有音符的 (channel, program)」＝所有聲部。沒出現在這裡的組合只有音色／controller
  // 設定而不發聲（備用奏法，或換過去後其實沒彈過的音色）。切分的目的是拿掉「別人的聲音」，
  // 不是拿掉樂器設定，所以純設定的組合一律保留。
  const soundingChannels = new Set(parsed.parts.map((p) => `${p.trackIndex}:${p.channel}:${p.program}`));
  const trackIndices = [...new Set(selected.map((p) => p.trackIndex))].sort((a, b) => a - b);
  const globalMeta = collectGlobalMeta(parsed, makeWarn(parsed.warnings));
  const endTick = parsed.durationTicks;

  const outTracks = trackIndices.map((trackIndex, outIndex) => {
    const source = parsed.tracks[trackIndex];
    const events = [];
    // 逐 channel 追蹤目前生效的音色，跟 collectNotes()／collectParts() 用同一套邏輯，
    // 才能正確判斷「這個 controller／pitch bend 事件當下屬於哪個聲部」。
    const currentProgram = new Array(16).fill(0);
    for (const ev of source.events) {
      if (ev.kind === 'meta') {
        if (ev.type === META.END_OF_TRACK) continue; // 最後統一補在全曲長度處
        if (GLOBAL_META.has(ev.type)) continue;      // 改由去重後的 globalMeta 統一注入
        events.push(ev);
      } else if (ev.kind === 'sysex') {
        // SysEx 是給裝置的整體設定，無法歸屬到單一 channel，保留在原本那一軌。
        events.push(ev);
      } else {
        if (ev.type === 'programChange') currentProgram[ev.channel] = ev.data1;
        const key = `${trackIndex}:${ev.channel}:${currentProgram[ev.channel]}`;
        if (keep.has(key) || !soundingChannels.has(key)) events.push(ev);
      }
    }
    if (outIndex === 0) events.push(...globalMeta);

    if (outIndex === 0 && options.name) {
      const data = textEncoder.encode(options.name);
      const at = events.findIndex((ev) => ev.kind === 'meta' && ev.type === META.TRACK_NAME);
      const renamed = {
        tick: at >= 0 ? events[at].tick : 0,
        kind: 'meta',
        type: META.TRACK_NAME,
        data,
        text: options.name,
      };
      // 換成新物件而不是改動原事件——parsed 是呼叫端的資料，這裡不能有副作用。
      if (at >= 0) events[at] = renamed;
      else events.push(renamed);
    }

    events.sort((a, b) => a.tick - b.tick || eventRank(a) - eventRank(b));
    const lastTick = events.length ? events[events.length - 1].tick : 0;
    events.push({ tick: Math.max(endTick, lastTick), kind: 'meta', type: META.END_OF_TRACK, data: new Uint8Array(0) });
    return events;
  });

  return encodeMidi({ format: 1, division: parsed.division, tracks: outTracks });
}

/**
 * 只含「拍子」的最小 SMF：去重後的全域 meta（速度／拍號／調號／排練記號）＋一個
 * 落在全曲長度的 End of Track，沒有任何音符。給「所有聲部都交給真人、電腦沒有東西
 * 可伴奏」的情況當主時鐘來源——播放器仍能靠它的 currentTime 推進，讓 humanPerformer
 * 依這個時鐘把每個聲部排出來（整首用手勢指揮）。
 * @param {ParsedMidi} parsed  parseMidi 的結果（同 extractParts：事件不會被修改，
 *        但可能往 parsed.warnings 追加警告）
 * @returns {Uint8Array}
 */
export function extractTempoTrack(parsed) {
  const globalMeta = collectGlobalMeta(parsed, makeWarn(parsed.warnings));
  const events = [...globalMeta].sort((a, b) => a.tick - b.tick || eventRank(a) - eventRank(b));
  const lastTick = events.length ? events[events.length - 1].tick : 0;
  events.push({
    tick: Math.max(parsed.durationTicks, lastTick),
    kind: 'meta',
    type: META.END_OF_TRACK,
    data: new Uint8Array(0),
  });
  return encodeMidi({ format: 1, division: parsed.division, tracks: [events] });
}

/**
 * 依「軌」切分：一軌一份檔案，同軌內的多個 channel（同一件樂器的不同奏法）留在一起。
 * 這就是一般記譜軟體「匯出分譜」的粒度。
 * @returns {Array<{trackIndex: number, name: string, partIds: string[], bytes: Uint8Array}>}
 */
export function splitByTrack(parsed) {
  const grouped = new Map();
  for (const part of parsed.parts) {
    if (!grouped.has(part.trackIndex)) grouped.set(part.trackIndex, []);
    grouped.get(part.trackIndex).push(part);
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([trackIndex, parts]) => {
      const track = parsed.tracks[trackIndex];
      return {
        trackIndex,
        name: track.name || track.instrumentName || `Track ${trackIndex + 1}`,
        partIds: parts.map((p) => p.id),
        bytes: extractParts(parsed, parts.map((p) => p.id)),
      };
    });
}

/**
 * 依「聲部」切分：細到 track × channel × program，一個奏法／一件樂器一份檔案。
 * 總譜把多件樂器塞在同一軌（format 0 檔一定是這樣），或同一個 channel 中途換過音色時，
 * 要用這個粒度。
 * @returns {Array<{part: object, name: string, partIds: string[], bytes: Uint8Array}>}
 */
export function splitByPart(parsed) {
  return parsed.parts.map((part) => ({
    part,
    name: part.name,
    partIds: [part.id],
    bytes: extractParts(parsed, [part.id], { name: part.name }),
  }));
}
