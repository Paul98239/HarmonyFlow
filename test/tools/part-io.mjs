// ============================================================
//  part-io.mjs — 總譜 MIDI ⇄ 分譜 MIDI（只給開發與測試用，不進 src/）
//
//  splitByPart(parsed)：把 parseMidi() 的結果依 part 切成一份份獨立的 SMF 事件模型（一個 part 一份）。
//  mergeParts(splits)：把切出來的各份合回一份總譜的事件模型。
//  兩者只用 parsed.tracks[].events（原始事件，不改）與 parsed.parts[].staves，寫成位元組用 encodeMidi()。
//
//  切法（每份分譜）：
//    · 第 0 軌是「指揮軌」：全曲的速度／拍號／調號（各軌合併、依 tick 穩定排序），讓單獨一份分譜也能播出正確速度。
//    · 之後是這個 part 的 staff 所在的 track 片段：
//        channel 事件只留這個 part 擁有的 channel（staff.channel % 16；絕對 channel = 軌內 channel + 16 × port 偏移）；
//        軌的「擁有者」（第一個在這條軌上有 staff 的 part；沒有 staff 的軌，例如 Meta 軌，歸第 0 個 part）另外保留
//        沒人擁有的 channel 事件、其他 meta、SysEx、End of Track；非擁有者只複製 port 與軌名（還原絕對 channel 要用）。
//  合回：指揮軌取第一份的；各片段依原本的 track 序號（origTracks）歸組，同一條軌被 A14 拆給多個 part 時依 tick 穩定合併。
//
//  CLI：node test/tools/part-io.mjs split <總譜.mid> [--out=資料夾]   每個 part 寫成一個 .mid
//       node test/tools/part-io.mjs merge <分譜1.mid> <分譜2.mid> ... --out=合併.mid   依檔案順序接回（位元組層級，不還原原本的 track 序號）
// ============================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMidi, encodeMidi, META } from '../../src/midi/midiParser.js';

const GLOBAL_META = new Set([META.SET_TEMPO, META.TIME_SIGNATURE, META.KEY_SIGNATURE]);
const isGlobalMeta = (ev) => ev.kind === 'meta' && GLOBAL_META.has(ev.type);
const isEot = (ev) => ev.kind === 'meta' && ev.type === META.END_OF_TRACK;

// 穩定排序：Array.prototype.sort 在現代引擎本來就穩定，這裡明寫比較函式只比 tick，同 tick 保持原順序。
const byTick = (a, b) => a.ticks - b.ticks;

/**
 * @param {import('../../src/midi/midiParser.js').ParsedMidi} parsed
 * @returns {{ partId:string, name:string, origTracks:number[], model:{format:number, division:object, tracks:object[][]} }[]}
 */
export function splitByPart(parsed) {
  const parts = parsed.parts;
  // 每條軌的擁有者：第一個在這條軌上有 staff 的 part；沒有 staff 的軌歸第 0 個 part
  const owner = new Map();
  parts.forEach((p, pi) => { for (const s of p.staves) if (!owner.has(s.trackIndex)) owner.set(s.trackIndex, pi); });
  for (const t of parsed.tracks) if (!owner.has(t.index)) owner.set(t.index, 0);

  // 每條軌上，各 part 擁有的軌內 channel（0~15）
  const owned = (pi, trackIndex) => new Set(parts[pi].staves.filter((s) => s.trackIndex === trackIndex).map((s) => s.channel % 16));
  const claimedBy = (trackIndex, ch) => parts.some((_, pi) => owned(pi, trackIndex).has(ch));

  const conductor = parsed.tracks.flatMap((t) => t.events.filter(isGlobalMeta)).sort(byTick);

  return parts.map((part, pi) => {
    const origTracks = [];
    const tracks = [conductor];
    for (const t of parsed.tracks) {
      const mine = owned(pi, t.index);
      const isOwner = owner.get(t.index) === pi;
      if (!mine.size && !isOwner) continue;
      const events = t.events.filter((ev) => {
        if (isGlobalMeta(ev)) return false;
        if (ev.kind === 'channel') return mine.has(ev.channel) || (isOwner && !claimedBy(t.index, ev.channel));
        if (isOwner) return true;                                          // 其他 meta、SysEx、End of Track
        return ev.kind === 'meta' && (ev.type === META.PORT || ev.type === META.TRACK_NAME);
      });
      origTracks.push(t.index);
      tracks.push(events);
    }
    return { partId: part.id, name: part.name, origTracks, model: { format: 1, division: parsed.division, tracks } };
  });
}

/**
 * @param {{origTracks?:number[], model:{division:object, tracks:object[][]}}[]} splits
 * @returns {{format:number, division:object, tracks:object[][]}}
 */
export function mergeParts(splits) {
  if (!splits.length) throw new Error('mergeParts 至少需要一份分譜');
  const groups = new Map(); // 原本的 track 序號 → 事件（各片段依序接起來，最後依 tick 穩定排序）
  let fallback = 0;
  for (const s of splits) {
    s.model.tracks.slice(1).forEach((events, i) => {
      const key = s.origTracks ? s.origTracks[i] : fallback++;
      groups.set(key, (groups.get(key) || []).concat(events));
    });
  }
  const tracks = [splits[0].model.tracks[0]];
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    const all = groups.get(key);
    // 同一條軌的多份片段各有一個 End of Track：只留 tick 最大的那個，並放在最後
    const eots = all.filter(isEot).sort(byTick);
    const body = all.filter((ev) => !isEot(ev)).sort(byTick);
    tracks.push(eots.length ? [...body, eots[eots.length - 1]] : body);
  }
  return { format: 1, division: splits[0].model.division, tracks };
}

export const toBytes = (model) => encodeMidi(model);

/** 音符的比對鍵：不含 track／staff／part 的 id（分合之後序號會變），含絕對 channel。 */
export const noteKey = (n) => `${n.channel}:${n.midiNote}:${n.startTick}:${n.endTick}:${n.velocity}`;
export const noteMultiset = (notes) => notes.map(noteKey).sort();

/* ═══════════════════════════════════════════
   CLI
   ═══════════════════════════════════════════ */
const readParsed = (file) => {
  const b = readFileSync(file);
  return parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
  const [cmd, ...files] = args.filter((a) => !a.startsWith('--'));
  if (cmd === 'split' && files.length === 1) {
    const out = resolve(flags.out || '.');
    mkdirSync(out, { recursive: true });
    const stem = basename(files[0]).replace(/\.mid$/i, '');
    for (const s of splitByPart(readParsed(files[0]))) {
      const path = join(out, `${stem}-${s.name}.mid`);
      writeFileSync(path, toBytes(s.model));
      console.log(`寫出 ${path}`);
    }
  } else if (cmd === 'merge' && files.length >= 1 && flags.out) {
    const splits = files.map((f) => {
      const p = readParsed(f);
      return { model: { format: 1, division: p.division, tracks: p.tracks.map((t) => t.events) } };
    });
    writeFileSync(resolve(flags.out), toBytes(mergeParts(splits)));
    console.log(`寫出 ${resolve(flags.out)}`);
  } else {
    console.error('用法：part-io.mjs split <總譜.mid> [--out=資料夾]\n      part-io.mjs merge <分譜.mid>... --out=合併.mid');
    process.exit(1);
  }
}
