// timeline.js — 時間層（純邏輯，無 DOM／CDN）：速度表、tick ↔ 秒（midiTicksToSeconds／secondsToMIDITicks，名稱照官方 BasicMIDI）、
// 拍號與調號表、port 偏移（絕對 channel）、小節與拍格線。
// 規格寫進檔案的是格線：division、速度（FF 51）、拍號（FF 58），加起來足以把任何 tick 精確還原成第幾拍、第幾秒，這條鏈是確定性計算。
// 規格沒寫的是格線上的音樂意義（小節線、弱起、強弱、swing、複拍子律動），只能推導，推導必帶假設：只在明確標示假設的地方做（規格文件假設表的 A 項目）。

import { META, makeWarn } from './midiFile.js';

/** @typedef {import('./midiParser.js').MidiDivision} MidiDivision */
/** @typedef {import('./midiParser.js').MidiTrack} MidiTrack */
/** @typedef {import('./midiParser.js').TempoMapEntry} TempoMapEntry */
/** @typedef {import('./midiParser.js').ParsedMidi} ParsedMidi */

const DEFAULT_TEMPO_US = 500000; // 規格：沒有 FF51 時視為 120 BPM

// ── 解析：時間軸（速度表／拍號／調號）──

function collectMeta(tracks, type) {
  const list = [];
  for (const track of tracks) {
    for (const ev of track.events) {
      if (ev.kind === 'meta' && ev.type === type) list.push({ ev, trackIndex: track.index });
    }
  }
  // 穩定排序（ES2019 起保證）：同 tick 維持軌序 → 事件序
  list.sort((a, b) => a.ev.ticks - b.ev.ticks);
  return list;
}

/**
 * @param {MidiTrack[]} tracks
 * @param {MidiDivision} division
 * @param {(msg:string) => void} warn
 * @returns {TempoMapEntry[]}
 */
export function buildTempoMap(tracks, division, warn) {
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

export function makeMidiTicksToSeconds(tempoMap, division) {
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

// midiTicksToSeconds 的反函數（名稱照官方 BasicMIDI.secondsToMIDITicks）：tick → 秒是嚴格遞增的分段線性函數，反函數也是分段線性，
// 先用每段起始秒數（seg.seconds，嚴格遞增）二分搜尋所屬區段，再在區段內反解。回傳值可以是小數。
export function makeSecondsToMIDITicks(tempoMap, division) {
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

// 拍號表：同一個 tick 後出現者生效；沒有 tick 0 的拍號就補 4/4，所以保證至少一筆、第一筆在 tick 0。
export function buildTimeSignatures(tracks) {
  return buildSignatureList(
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
}

// 調號表：同上，沒有就補 C 大調。
export function buildKeySignatures(tracks) {
  return buildSignatureList(
    tracks,
    META.KEY_SIGNATURE,
    (ev) => ({ ticks: ev.ticks, sharpsFlats: ev.sharpsFlats, minor: ev.minor }),
    { sharpsFlats: 0, minor: false }
  );
}

// ── port 偏移（絕對 channel）──

// 每條 track 的 channel 偏移（絕對 channel＝軌內 channel＋偏移），跟官方 SpessaSynth 一致：沒指定 port（FF21）的 track 用最小的已指定 port（都沒有就 0）；
// 依軌序（只看有 channel 事件的軌）第一次出現的 port 配偏移 0、16、32…，用的是出現順序而非 port 數值。
export function buildPortOffsets(tracks) {
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

// ── 小節格線（不塞進 parseMidi() 的回傳值：排程器目前不用它，逐音放行只看 startTick）──

/**
 * @typedef {{index:number, startTick:number, endTick:number, startSeconds:number,
 *   endSeconds:number, numerator:number, denominator:number, notatedBeatTicks:number,
 *   beatTicks:number}} Measure
 */

/**
 * 依拍號與 timeDivision 推算全曲小節線。拍號中途變更處強制斷一條小節線（該段最後一小節可能不完整）；樂曲真正結尾的最後一小節不截短，
 * 保留完整名目長度（演奏者仍有整小節的揮手窗口）。SMPTE division 沒有四分音符概念，timeDivision 為 null，回傳空陣列，呼叫端退回沒有格線的路徑（A5）。
 * 弱起拍不處理，格線一律從 tick 0 起算，有弱起的檔案所有小節線與拍位會整體平移（A1）。
 *
 * FF58 的四個位元組（nn dd cc bb）餵給兩種拍長，都是規格欄位算出來的：
 * - notatedBeatTicks（記譜拍長，算小節長度用）＝一個 dd 音符值有幾個 tick。bb（RP-001 p.10：一個 MIDI 四分音符／24 clocks 等於幾個記譜三十二分音符）
 *   多為 8，此時退化成 tpq*4/denominator；非 8 代表檔案把 MIDI 四分音符重新記譜成別的音符值，公式仍照規格：32*tpq/(bb*denominator)。
 * - beatTicks（律動拍長，演奏者實際要揮的單位）優先採用 cc（節拍器每響一次隔幾個 MIDI clock，24 clocks＝一個四分音符＝tpq ticks）換算的 pulseTicks = tpq*cc/24。
 *   RP-001 的 6/8 範例（FF 58 04 06 03 24 08）cc=36＝附點四分音符＝每小節揮 2 下。
 *   任一保險條件不成立就退回 beatTicks = notatedBeatTicks：cc === 24（內建預設值，多數編曲軟體不論拍號照抄，視為檔案沒表態）、
 *   pulseTicks 不是 notatedBeatTicks 的正整數倍、measureTicks % pulseTicks !== 0。
 *   這是應用層唯一留著的假設：cc = 24 的複拍子檔案仍切成分母音符單位（6/8 會切成 6 下而不是 2 下），保守但不會對沒意義的值信以為真。
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
      // 拍號無效（分子 <=0，或分母經 2**d[1] 算出超大值把 notatedBeatTicks 除到趨近 0）：tick 不會前進，下面的 while 會原地卡死。
      // 警告後退回 4/4；連 4/4 都算不出正數就整段退回「一拍＝一個四分音符」。
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
 * 把小節格線切成拍格線：每拍長度是 m.beatTicks（律動拍長，見 buildMeasureGrid()），不是固定切成 numerator 份（採用 cc 時一小節的拍數少於 numerator，如 6/8 的 2 拍）。
 * 拍號中途變更造成的截短小節，最後一拍夾到 measure.endTick，長度為 0 就不收。SMPTE（格線回空陣列）也回空陣列。
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
