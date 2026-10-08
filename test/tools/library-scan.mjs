// ============================================================
//  library-scan.mjs — 曲庫全掃：用整個遠端 MIDI 曲庫驗證排程器（手動執行，不進 CI，純 Node）
//
//  五種掃描（--only=parse,autoplay,perform,perpart,scenarios，預設全跑）：
//    parse      每首歌解析與聲部切分：沒有例外、至少 1 個 part、每個 staff 都分得到輸出 channel、警告分類統計、
//               多聲部（可指派）的歌有幾首；〈蝸牛與黃鸝鳥〉必須切成「長笛、大鋼琴」（使用者用原始 MuseScore 檔確認過的金標準）；
//               另外印出按鍵負擔：只有被指派的聲部要按（這裡取音符最多的聲部），每首歌要按幾下、原速下每秒要按幾下。
//    autoplay   每首歌整首自動播放（沒有人被指派）：每顆音都發聲、每個 noteOn 一個 noteOff（「成對」以音為單位，
//               原檔用 Note Off 還是 velocity 0 的 Note On 結束都一樣）、起訖時間誤差 ≤ 一個排程 tick（12ms）。
//    perform    多聲部歌曲 × 5 種按鍵風格（準時／快 20％／快 3 倍＋抖動／慢 25％＋抖動／慢 2 倍＋抖動），指派音符最多的聲部：
//               你的每個起音都放行、你的每顆音在按鍵當下發聲（0ms）、電腦聲部不用按而且一顆不丟、每個 noteOn 一個 noteOff、
//               同一個 tick 的音（你的與電腦的）同刻（差 0ms）——任何按鍵速度都成立，沒有放寬的選項。被去抖擋掉的按鍵會重按。
//    perpart    每個聲部（part）單獨指派給一位演奏者、準時按完整首：任何一個聲部都彈得出來（你的音按鍵當下發聲、電腦聲部一顆不丟、同刻音差 0ms）。
//    scenarios  情境掃描：一人兩聲部、多人（2～4 位輪流按，聲部都被指派）、連按（每 24ms 一下，被去抖擋掉的重按）、中途停手
//               （不再回來／回來）、第一下提早按——
//               每個情境都用同一組不變量判定通過與否。
//
//  曲庫：預設放在 test/tools/library/（不進 git）。第一次先 `--download` 從遠端曲庫抓下來（單連線＋間隔，已有的
//  檔案會略過）；也可以用 --dir 指到別的資料夾。--limit=N 只掃前 N 首。
//
//  用法：node test/tools/library-scan.mjs --download
//        node test/tools/library-scan.mjs [--dir=資料夾] [--only=parse,autoplay,perform,perpart,scenarios] [--limit=N]
// ============================================================

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { Scheduler } from '../../src/midi/scheduler.js';
import { autoPlayStats, driverPressLoad, driverSecs, makeRng, measure, onsetPresses, rankedParts, simulate } from './sim.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const DIR = resolve(args.dir || join(dirname(fileURLToPath(import.meta.url)), 'library'));
const ONLY = new Set(String(args.only || 'parse,autoplay,perform,perpart,scenarios').split(','));
const LIMIT = Number(args.limit) || Infinity;
const TICK_TOL_MS = 12.5;                          // 一個排程 tick（12ms）加浮點容差
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════════════════════════════════
   曲庫：下載、載入
   ═══════════════════════════════════════════ */

async function download() {
  // 直接用 app 的曲庫 client（midiApi.js），不另外維護一份 API 網址與回傳格式；它每首會印一行下載連結。
  const { searchSongs, downloadMidiFile } = await import('../../src/midi/midiApi.js');
  mkdirSync(DIR, { recursive: true });
  const { items: all } = await searchSongs({});
  const items = all.slice(0, LIMIT);
  const titles = Object.fromEntries(items.map((it) => [it.id, String(it.title || it.name || '')]));
  writeFileSync(join(DIR, 'titles.json'), JSON.stringify(titles, null, 1));
  console.log(`曲庫共 ${all.length} 首，下載 ${items.length} 首到 ${DIR}`);
  for (const item of items) {
    const file = join(DIR, `${item.id}.mid`);
    if (existsSync(file)) continue;
    for (let attempt = 1; ; attempt++) {
      try { writeFileSync(file, Buffer.from(await (await downloadMidiFile(item.id)).arrayBuffer())); break; }
      catch (err) {
        if (attempt >= 6) { console.error(`下載失敗，略過：${item.id}`); break; }
        await sleep(1500 * attempt);
      }
    }
    await sleep(450);                              // 單連線＋間隔，不要灌爆別人的伺服器
  }
}

function loadLibrary() {
  if (!existsSync(DIR)) { console.error(`找不到曲庫資料夾 ${DIR}：先執行 --download，或用 --dir 指到放 .mid 的資料夾`); process.exit(1); }
  const titlesFile = join(DIR, 'titles.json'), reportFile = join(DIR, 'report.json'); // report.json 是舊版掃描留下的 [{id, title}…]，沒有 titles.json 時拿來補歌名
  const titles = existsSync(titlesFile) ? JSON.parse(readFileSync(titlesFile, 'utf8'))
    : existsSync(reportFile) ? Object.fromEntries(JSON.parse(readFileSync(reportFile, 'utf8')).map((r) => [r.id, r.title])) : {};
  const songs = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.mid')).slice(0, LIMIT)) {
    const buf = readFileSync(join(DIR, f)), id = f.replace(/\.mid$/, '');
    try { songs.push({ id, title: (titles[id] || id).slice(0, 24), score: parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) }); }
    catch (err) { console.warn(`解析失敗，略過：${id}（${err.message}）`); }
  }
  return songs;
}

/* ═══════════════════════════════════════════
   掃描 0：解析與聲部切分
   ═══════════════════════════════════════════ */

function scanParse(songs, fileCount) {
  console.log(`\n=== 解析與聲部切分，共 ${songs.length} 首 ===`);
  let problems = 0;
  const failed = fileCount - songs.length;
  console.log(`解析失敗：${failed} 首`);
  if (failed) problems++;
  const noPart = songs.filter((s) => !s.score.parts.length);
  console.log(`沒有任何 part：${noPart.length} 首`);
  if (noPart.length) problems++;
  const unplaced = [];
  const staffCounts = songs.map((s) => {
    const hp = new Scheduler();
    const stub = { controllerChange() {}, programChange() {}, noteOn() {}, noteOff() {} };
    hp.setSynths(stub, stub); // 有合成器才會用滿 64 個 channel（app 裡兩個合成器都補到 64 個）
    hp.load(s.score, []);
    if (hp.unplacedStaffIds.length) unplaced.push(s.title);
    return s.score.parts.reduce((a, p) => a + p.staves.length, 0);
  });
  console.log(`放不下輸出 channel 的 staff：${unplaced.length} 首${unplaced.length ? '（' + unplaced.slice(0, 5).join('、') + '）' : ''}；staff 總數最多 ${Math.max(...staffCounts)} 個`);
  if (unplaced.length) problems++;
  const multi = songs.filter((s) => s.score.parts.length >= 2);
  console.log(`多聲部（≥2 個 part，可以指派演奏者）：${multi.length} 首／${songs.length} 首；單一 part：${songs.length - multi.length} 首`);
  // 只有被指派的聲部要按，電腦聲部不用按：按鍵數＝這個聲部的不同起音數。原速（樂譜速度）下平均／最忙 1 秒要按幾下，決定好不好彈。
  const loads = songs.map((x) => { const main = rankedParts(x.score)[0]; return main ? driverPressLoad(x.score, [main.id]) : null; }).filter((l) => l && l.presses > 0);
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  console.log(`按鍵負擔（只按主聲部＝音符最多的聲部）：每首要按 中位 ${med(loads.map((l) => l.presses))} 下、最多 ${Math.max(...loads.map((l) => l.presses))} 下；原速每秒平均 中位 ${med(loads.map((l) => l.perSecAvg)).toFixed(1)} 下、最大 ${Math.max(...loads.map((l) => l.perSecAvg)).toFixed(1)} 下；最忙的 1 秒內 中位 ${med(loads.map((l) => l.perSecPeak))} 下、最多 ${Math.max(...loads.map((l) => l.perSecPeak))} 下`);
  const warnKinds = new Map();
  for (const s of songs) for (const w of s.score.warnings) {
    const k = w.replace(/\d+(\.\d+)?/g, 'N').slice(0, 48);
    warnKinds.set(k, (warnKinds.get(k) || 0) + 1);
  }
  const top = [...warnKinds].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${n}×「${k}」`).join('；');
  console.log(`警告：${songs.filter((s) => s.score.warnings.length).length} 首有警告（共 ${[...warnKinds.values()].reduce((a, b) => a + b, 0)} 則）${top ? '；最多的：' + top : ''}`);
  const snail = songs.find((s) => s.title.includes('蝸牛與黃鸝鳥'));
  if (snail) {
    const names = snail.score.parts.map((p) => p.name).join('、');
    const ok = names === '長笛、大鋼琴' && snail.score.parts[1].staves.length === 2;
    console.log(`${ok ? '✓' : '✗'} 金標準〈蝸牛與黃鸝鳥〉：${names}（鋼琴 ${snail.score.parts[1]?.staves.length} 個 staff）`);
    if (!ok) problems++;
  } else console.log('（曲庫裡沒有〈蝸牛與黃鸝鳥〉，略過金標準檢查）');
  return problems;
}

/* ═══════════════════════════════════════════
   掃描 1：整首自動播放
   ═══════════════════════════════════════════ */

// 原檔裡用「velocity 0 的 Note On」當 Note Off 的事件數（parser 已經把它們配成跟 Note Off 一樣的音）。
const velocity0NoteOffs = (score) => score.tracks.reduce((a, t) => a + t.events.filter((e) => e.kind === 'channel' && e.type === 'noteOn' && e.data2 === 0).length, 0);

function scanAutoplay(songs) {
  const rows = songs.map((s) => ({ s, r: autoPlayStats(s.score), v0: velocity0NoteOffs(s.score) }));
  const count = (f) => rows.filter(f).length, sum = (f) => rows.reduce((a, row) => a + f(row), 0);
  console.log(`\n=== 整首自動播放（沒有人被指派），共 ${rows.length} 首 ===`);
  console.log(`沒播完：${count((x) => !x.r.finished)} 首；缺音（樂譜有、沒發聲）：${sum((x) => x.r.total - x.r.sounded)} 顆；放不下的聲部：${count((x) => x.r.unplaced)} 首`);
  console.log(`每個 noteOn 一個 noteOff：沒收的音 ${sum((x) => x.r.unpaired)} 個、多餘的 noteOff ${sum((x) => x.r.strayOff)} 個（有問題的歌 ${count((x) => x.r.unpaired || x.r.strayOff)} 首）；velocity 0 的 noteOn：${sum((x) => x.r.badVelocity)} 個`);
  console.log(`起音誤差 > ${TICK_TOL_MS}ms 的歌：${count((x) => x.r.onErr > TICK_TOL_MS)} 首（最大 ${Math.round(Math.max(...rows.map((x) => x.r.onErr)))}ms）；收音誤差 > ${TICK_TOL_MS}ms 的歌：${count((x) => x.r.offErr > TICK_TOL_MS)} 首（最大 ${Math.round(Math.max(...rows.map((x) => x.r.offErr)))}ms）`);
  console.log(`資訊：用 velocity 0 的 Note On 當 Note Off 的檔案 ${count((x) => x.v0 > 0)} 首（共 ${sum((x) => x.v0)} 個事件，parser 都配成正常的音）`);
  const bad = rows.filter((x) => !x.r.finished || x.r.total !== x.r.sounded || x.r.unpaired || x.r.strayOff || x.r.badVelocity || x.r.onErr > TICK_TOL_MS || x.r.offErr > TICK_TOL_MS);
  for (const x of bad.slice(0, 8)) console.log('  ✗', x.s.title, JSON.stringify(x.r));
  return bad.length;
}

/* ═══════════════════════════════════════════
   掃描 2：多聲部歌曲 × 3 種逐音觸發風格
   ═══════════════════════════════════════════ */

const STYLES = [['準時', 1, 0], ['快 20％', 0.8, 0], ['快 3 倍＋抖動 30％', 0.3, 0.3], ['慢 25％＋抖動 15％', 1.25, 0.15], ['慢 2 倍＋抖動 20％', 2, 0.2]];

// 每次模擬共用的不變量（任何按鍵速度與人數都成立，沒有放寬的選項）：該放行的都發聲（你的音與電腦的音）、每個 noteOn 一個 noteOff、
// 你的每顆音都在按鍵當下發聲、同一個 tick 的音同刻（差 0ms）；completePresses＝你的每個起音都有被按到，這時一個都不能沒被放行。
const violations = (m, { completePresses = true } = {}) => m.releasedMissing || m.unpaired || m.strayOff || m.badVelocity
  || m.offTrigger || m.syncMax > 0 || (completePresses && m.notReleased);

function scanPerform(songs) {
  const multi = songs.filter((s) => s.score.parts.length >= 2 && rankedParts(s.score).length);
  const rows = [];
  for (const s of multi) {
    const main = rankedParts(s.score)[0], secs = driverSecs(s.score, [main.id]);
    for (const [styleName, factor, jitter] of STYLES) {
      const presses = onsetPresses(secs, { factor, jitter, rnd: makeRng(21) });
      rows.push({ s, main, styleName, m: measure(simulate(s.score, [{ partIds: [main.id], presses, keepGoing: true }])) });
    }
  }
  const sum = (key) => rows.reduce((a, r) => a + r.m[key], 0), count = (f) => rows.filter((r) => f(r.m)).length;
  console.log(`\n=== 多聲部歌曲 ${multi.length} 首 × ${STYLES.length} 種按鍵風格 ＝ ${rows.length} 次模擬（各指派音符最多的聲部）===`);
  console.log(`該放行卻沒發聲的音：${sum('releasedMissing')} 顆（${count((m) => m.releasedMissing)} 次模擬）；沒被放行的音（按得不夠多）：${sum('notReleased')} 顆；被去抖擋掉再重按的次數：${sum('blocked')}`);
  console.log(`每個 noteOn 一個 noteOff：沒收的音 ${sum('unpaired')} 個（${count((m) => m.unpaired)} 次）、多餘的 noteOff ${sum('strayOff')} 個、velocity 0 的 noteOn ${sum('badVelocity')} 個`);
  console.log(`你的音不在按鍵當下發聲：${sum('offTrigger')} 顆；同刻音發聲差 > 0ms：${count((m) => m.syncMax > 0)} 次模擬（最大 ${Math.max(...rows.map((r) => r.m.syncMax))}ms）`);
  const bad = rows.filter((r) => violations(r.m));
  for (const r of bad.slice(0, 8)) console.log('  ✗', r.s.title, r.main.name, r.styleName, JSON.stringify(r.m));
  return bad.length;
}

/* ═══════════════════════════════════════════
   掃描 2.5：每個聲部單獨指派
   ═══════════════════════════════════════════ */

// 每個有音符的 part（含打擊）單獨指派給演奏者 1、準時按完整首：不變量同 perform。證明「所有聲部都可以彈奏」。
function scanPerPart(songs) {
  const rows = [];
  for (const s of songs) {
    for (const part of s.score.parts) {
      if (!part.noteCount) continue;
      const presses = onsetPresses(driverSecs(s.score, [part.id]), { rnd: makeRng(5) });
      rows.push({ s, part, m: measure(simulate(s.score, [{ partIds: [part.id], presses, keepGoing: true }])) });
    }
  }
  console.log(`\n=== 每個聲部單獨指派（準時按完整首），共 ${rows.length} 個聲部／${songs.length} 首 ===`);
  const bad = rows.filter((r) => violations(r.m));
  console.log(`不符合不變量：${bad.length} 個聲部`);
  for (const r of bad.slice(0, 8)) console.log('  ✗', r.s.title, r.part.name, JSON.stringify(r.m));
  return bad.length;
}

/* ═══════════════════════════════════════════
   掃描 3：情境
   ═══════════════════════════════════════════ */

// 每個情境：players（每位演奏者的聲部與按鍵時間表）。沒有按完整首的情境（停手）notReleased 不算違規（complete: false）。
// 被指派的聲部（driver）才要按：按鍵時間表依「被指派聲部的起音」排；沒被指派的聲部是電腦輔助，不用按。
function buildScenarios(score, rnd) {
  const [A, B, C, D] = rankedParts(score).map((p) => p.id);
  const secsA = driverSecs(score, [A]);
  const out = [];
  const add = (name, players, o = {}) => out.push({ name, players, ...o });
  const solo = (name, o, extra = {}) => add(name, [{ partIds: [A], presses: onsetPresses(secsA, { rnd, ...o }) }], extra);
  // 同一張時間表（被指派聲部的起音聯集）輪流交給多位演奏者按（第 i 下由第 i % n 位按）：任何有指派聲部的演奏者按一下都推進。
  const roundRobin = (ids, o) => { const all = onsetPresses(driverSecs(score, ids), { rnd, ...o }); return ids.map((id, k) => ({ partIds: [id], presses: all.filter((_, i) => i % ids.length === k) })); };

  solo('準時（單人）', {});
  solo('第一下提早按（單人，落在你的第一個起音之前 70％處，之後準時）', { leadMs: -secsA[0] * 700 });
  solo('按得比樂譜快很多（單人，間隔 ×0.3、抖動 ±30％）', { factor: 0.3, jitter: 0.3 });
  solo('按得比樂譜慢很多（單人，間隔 ×3、抖動 ±30％）', { factor: 3, jitter: 0.3 });
  solo('連按（單人，每 24ms 一下，被去抖擋掉的重按，比樂譜快很多）', { burst: true });
  solo('中途停手（單人，第 20 個起音之後不再按）', { pause: [19, Infinity] }, { complete: false });
  for (const sec of [0.6, 2, 8]) solo(`停手 ${sec} 秒後回來（單人，第 20 個起音之後）`, { pause: [19, sec * 1000] });
  if (B) {
    add('一人兩個聲部', [{ partIds: [A, B], presses: onsetPresses(driverSecs(score, [A, B]), { rnd, jitter: 0.1 }) }]);
    add('兩位演奏者（輪流按、抖動）', roundRobin([A, B], { jitter: 0.1 }));
    const [pa, pb] = roundRobin([A, B], {});
    add('兩位演奏者，其中一位中途停手不再回來（剩下的人按不完全曲）', [pa, { ...pb, presses: pb.presses.slice(0, 10) }], { complete: false });
  }
  if (C) {
    const ids = [A, B, C, D].filter(Boolean);
    add(`${ids.length} 位演奏者（輪流按、抖動）`, roundRobin(ids, { jitter: 0.15 }));
  }
  return out;
}

function scanScenarios(songs) {
  const byName = new Map();
  for (const s of songs.filter((x) => rankedParts(x.score).length >= 1)) {
    for (const sc of buildScenarios(s.score, makeRng(7))) {
      const m = measure(simulate(s.score, sc.players.map((p) => ({ ...p, keepGoing: sc.complete !== false }))));
      if (!byName.has(sc.name)) byName.set(sc.name, []);
      byName.get(sc.name).push({ s, m, opts: { completePresses: sc.complete !== false } });
    }
  }
  console.log(`\n=== 情境掃描（每個情境的不變量：該放行的音都發聲、每個 noteOn 一個 noteOff、你的音在按鍵當下發聲、同刻音差 0ms）===`);
  let failures = 0;
  for (const [name, runs] of byName) {
    const sum = (key) => runs.reduce((a, r) => a + r.m[key], 0);
    const bad = runs.filter((r) => violations(r.m, r.opts));
    failures += bad.length;
    console.log(`${bad.length ? '✗' : '✓'} ${name}：${runs.length} 首；該放行卻沒發聲 ${sum('releasedMissing')}、沒收的音 ${sum('unpaired')}、非觸發當下發聲 ${sum('offTrigger')}、同刻音差最大 ${Math.max(...runs.map((r) => r.m.syncMax))}ms；曲末沒被放行的音 ${sum('notReleased')} 顆（${runs.filter((r) => r.m.notReleased).length} 首）`);
    for (const r of bad.slice(0, 3)) console.log('    ', r.s.title, JSON.stringify(r.m));
  }
  return failures;
}

/* ═══════════════════════════════════════════
   主程式
   ═══════════════════════════════════════════ */

if (args.download) await download();
const started = Date.now();
const songs = loadLibrary();
console.log(`曲庫 ${DIR}：${songs.length} 首`);
let problems = 0;
if (ONLY.has('parse')) problems += scanParse(songs, Math.min(LIMIT, readdirSync(DIR).filter((x) => x.endsWith('.mid')).length));
if (ONLY.has('autoplay')) problems += scanAutoplay(songs);
if (ONLY.has('perform')) problems += scanPerform(songs);
if (ONLY.has('perpart')) problems += scanPerPart(songs);
if (ONLY.has('scenarios')) problems += scanScenarios(songs);
console.log(`\n${problems ? `有 ${problems} 筆不符合` : '全部符合'}（${((Date.now() - started) / 1000).toFixed(0)} 秒）`);
process.exitCode = problems ? 1 : 0;
