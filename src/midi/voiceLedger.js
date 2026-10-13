// ============================================================
//  voiceLedger.js — 發聲帳本：每個譜表正在響的音（staff.sounding：音高 → 依發聲順序排隊的佇列）、同音高先進先出收音、
//  hold（loop 等你按下一個起音，N10）的判定與放行、尾巴收尾（同譜表新音發聲時截短舊音，N3）、你的下一次按鍵時依 tick 先收、
//  暫停時全部收音。送給合成器的指令都經過輸出路由（outputRouter.js），收發音的事件排進對外事件（performanceEvents.js）。
//  帳本只管「正在響的音」：時鐘、driver 游標、速度這些「目前」的值都由排程器在呼叫時傳進來；driver 起音的 tick、hold 容差、
//  tick → 樂譜秒的換算在載入／改指派時綁定（bind()）。純邏輯，無 DOM。
// ============================================================

/* ═══════════════════════════════════════════
   應用層常數——不是規格
   ═══════════════════════════════════════════ */
// 有限的音長（檔案音長 ÷ 速度）上限：極慢（例如 0.015×）時 0.1 秒的短音會被拉成 6 秒，所以被「拉長」的部分最多到 NOTE_MAX_MS；
// 但不會比檔案本身的長度更短（檔案裡 12 秒的長音在 1× 就是 12 秒，整首自動播放與你彈得跟原譜一樣快時都不能被切）。
// 起音位置仍用完整速度排開，hold 著等你按的音照舊響到你按下去。排程器排電腦音的長度也用它，所以 export。
const NOTE_MAX_MS = 8000;
export const scaledMs = (lenSec, rate) => Math.min((lenSec * 1000) / rate, Math.max(NOTE_MAX_MS, lenSec * 1000));
// 排程時刻是一路加法算出來的浮點數，跟時鐘比大小時不能要求逐位元相等（排程器比時刻也用它）。
export const EPS_MS = 1e-6;
// hold（loop 等你按下一個起音）的對齊容差：音的結尾比某個 driver 起音早不超過這麼多，就算「結尾接著這個起音」。
// 容差 ＝ max(HOLD_GAP_TICKS, min(音起音到那個起音的間隔 × HOLD_GAP_RATIO, 上限))，都是匯出器的慣例，不是規格：
//  · 至少 2 tick：MuseScore 匯出相連音時記譜長度少 1 tick，再多一點吸收取整誤差。
//  · 比例 1/8：有些匯出器把每顆音統一縮短一個比例（曲庫量測：54/164 首的主聲部，結尾固定比下一個起音早約 5.4% 的間隔，
//    只容許 2 tick 時這些歌完全不會 hold）。真正的斷奏空隙是間隔的一半左右，遠超過 1/8，不會被誤判成相連。
//  · 上限十六分音符（四分音符的 1/4；沒有四分音符的 SMPTE 用 0.125 秒）：免得長音後面的短休止被填滿。
const HOLD_GAP_TICKS = 2;
const HOLD_GAP_RATIO = 1 / 8;
const HOLD_GAP_MAX_QUARTER = 1 / 4;
const HOLD_GAP_MAX_SECONDS = 0.125;

// hold 容差的上限（tick）：有 ticks per quarter 就是十六分音符；SMPTE（timeDivision 是 null）用固定秒數換成 tick
export function holdCapTicksFor(score) {
  const cap = score.timeDivision ? score.timeDivision * HOLD_GAP_MAX_QUARTER : score.secondsToMIDITicks?.(HOLD_GAP_MAX_SECONDS);
  return Number.isFinite(cap) ? Math.max(HOLD_GAP_TICKS, Math.round(cap)) : HOLD_GAP_TICKS;
}

// 同音高佇列裡「下一個該收的音」的位置：先進先出只排沒有 hold 的音——hold 著的音要等你按到它的起音才收，不能擋住排在它後面、
// 已經到期的音（延遲放出的舊 tick 的電腦音可能比新 tick 的音晚發聲）。第一個沒有 hold 的音到期（offMs ≤ limit）就回傳它的位置，否則 -1。
export function dueIndex(queue, limit) {
  const i = queue.findIndex((e) => e.holdIdx === null);
  return i !== -1 && queue[i].offMs <= limit + EPS_MS ? i : -1;
}

// 這顆音要 hold 到第幾個 driver 起音、那個起音之後還要再響多久？回傳 { idx, tailSec }（樂譜秒），不 hold 回傳 null（照原長收）。
// driverTicks＝driver 起音的 tick（遞增）、fromIndex＝driver 游標（下一個要放行的起音）、holdCapTicks＝容差上限（holdCapTicksFor）、
// secOf＝tick → 樂譜秒。挑「結尾（加上容差）之前最後一個、在這顆音起音之後、還沒放行（編號 >= fromIndex）的 driver 起音」：
//  · 起音比結尾早或相等（橫跨、或剛好對齊）：tailSec ＝ 檔案裡那個起音到結尾的長度（對齊時 0），你按下那個起音之後再響完它（÷ 速度）；
//  · 起音比結尾晚、差距在容差內（結尾接著它，含匯出器統一縮短的相連音，容差見 HOLD_GAP_*）：tailSec ＝ 0，按下去就收。
//    差距超過容差的更晚起音不算（那是休止或斷奏，照原長收），改看再前一個起音。
// 為什麼看每顆音自己的結尾而不是它屬於哪個 segment：同一個 tick 你的音短、電腦音長時，短音（結尾與起音之間沒有任何 driver 起音）
// 照原長收，長音一路等到它結尾所在的那個起音，不被中間的按鍵切掉，也不會被拉長到不屬於它的起音。
// 為什麼橫跨的音也要等：照原長在真實時間收，你比預估慢時，音會在你按到它該響著的那個起音之前就停了，檔案裡它明明還在響。
// 整首自動播放沒有 driver 起音，永遠 null。零長度、結尾早於起音等怪音符：沒有任何起音落在（起音，結尾＋容差]，自然 null。
export function holdOf(note, driverTicks, fromIndex, holdCapTicks, secOf) {
  const a = driverTicks;
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= note.endTick + holdCapTicks) lo = mid + 1; else hi = mid; }   // upper bound：第一個超過「結尾＋容差上限」的起音
  for (let c = lo - 1; c >= fromIndex && a[c] > note.startTick; c--) {
    const gap = a[c] - note.endTick;          // > 0：音比這個起音早收
    if (gap <= 0) return { idx: c, tailSec: secOf(note.endTick) - secOf(a[c]) };
    // 上限（holdCapTicks）已經由上面的搜尋視窗保證：候選起音最多比結尾晚這麼多
    if (gap <= Math.max(HOLD_GAP_TICKS, (a[c] - note.startTick) * HOLD_GAP_RATIO)) return { idx: c, tailSec: 0 };
  }
  return null;
}

export class VoiceLedger {
  constructor(router, events) {
    this._router = router;      // 所有合成器呼叫都經過它（outputRouter.js）
    this._events = events;      // 收發音的事件排進這裡（performanceEvents.js；排程器在每次呼叫結束時才發出去）
    this._staves = new Map();   // staffId → staff（排程器建的；帳本操作每個 staff 的 sounding）
    this._driverTicks = [];     // driver 起音的 tick（hold 判定用）
    this._holdCapTicks = 0;     // hold 對齊容差的上限（tick），見 holdCapTicksFor()
    this._secOf = null;         // tick → 樂譜秒
  }

  // 載入、改指派時綁定這一輪的譜表與計畫（排程器建好 staff 與 driver 起音之後呼叫）。
  bind({ staves, driverTicks, holdCapTicks, secOf }) {
    this._staves = staves;
    this._driverTicks = driverTicks;
    this._holdCapTicks = holdCapTicks;
    this._secOf = secOf;
  }

  // 以 driver 游標 cursor 判斷這顆音要不要 hold（唯讀查詢）。方法裡呼叫的 holdOf(...) 是上面模組層級的同名函式，不是這個方法自己
  // （類別的方法名稱不會變成可以直接呼叫的變數名稱）。
  holdOf(note, cursor) { return holdOf(note, this._driverTicks, cursor, this._holdCapTicks, this._secOf); }

  // 讓一顆音發聲：noteOn，記進正在響的佇列（同音高先進先出）。dueMs＝預定發聲的時鐘時刻（你的音就是按下的那一刻），只有 tick() 裡的
  // 電腦音（lookahead）才會帶時間戳；onTime 記下那顆 noteOn 的 AudioContext 時間（沒帶時間戳＝undefined）。
  // cursor＝driver 游標（hold 判定用）、rate＝目前速度、fromTick＝由 tick() 放出（記在 noteOn 事件裡：遲到統計只算這種，
  // 見 performanceEvents.js）、clockMs＝排程器時鐘。
  sound(staff, note, offMs, dueMs, { cursor, rate, fromTick, clockMs }) {
    this._capOverlaps(staff, note, dueMs, rate, clockMs);
    let queue = staff.sounding.get(note.midiNote);
    if (!queue) staff.sounding.set(note.midiNote, (queue = []));
    const opts = this._router.stamp(staff, dueMs);
    // hold：結尾接著、或橫跨某個還沒放行的 driver 起音的音（你的與電腦的一樣），先不排收音（Infinity），等你按到那個起音才收
    // （releaseHeld）；tailSec 是檔案裡那個起音到這顆音結尾的樂譜秒數。被同譜表的新音截短過的不再 hold（見 _capOverlaps，capped）
    const hold = this.holdOf(note, cursor);
    queue.push({ endTick: note.endTick, offMs: hold ? Infinity : offMs, holdIdx: hold ? hold.idx : null, tailSec: hold ? hold.tailSec : 0, note, onTime: opts?.time, capped: false }); // 先登記再 noteOn：合成器收到 noteOn 時，佇列最後一項就是這顆音
    this._router.noteOn(staff, note.midiNote, note.velocity, opts);
    this._events.queue('noteOn', {
      note, noteId: note.id ?? null, staffId: staff.id, kind: staff.kind, dueMs, clockMs,
      timed: opts !== undefined, fromTick, lateMs: Math.max(0, clockMs - dueMs),
    });
  }

  // 尾巴收尾：同一個譜表的新音在 onsetMs 發聲時，還在響的舊音（起音 tick 比新音早）的收音時刻不能晚於
  // 「onsetMs ＋ 檔案裡這兩顆音的重疊量依目前速度 rate 換算」（檔案裡舊音結尾在新音起音之前＝重疊 0，就在新音發聲時收）。
  // 為什麼：舊音的結尾是依發聲當時估到的速度排好的，速度之後變快、或舊音還在 hold（結尾是無限大）時，舊音就會比檔案裡的重疊多響一截
  // （糊在一起）；照檔案的 tick 位置收尾，重疊量就跟檔案一樣，也不會丟音、不會擠。只會把收音提早，不會延長（所以你按得晚時不撐）。
  // 同譜表內起音 tick 相同的音（和弦）不算「下一個音」，不互相截。
  _capOverlaps(staff, note, onsetMs, rate, clockMs) {
    const startSec = this._secOf(note.startTick);
    for (const queue of staff.sounding.values()) {
      for (const entry of queue) {
        if (entry.note.startTick >= note.startTick) continue;
        // 例外：檔案裡這兩顆音真的重疊、音高不同（同一行譜的多聲部，長音底下另有音在動），舊音又還在 hold：保留 loop 到它的結尾起音，
        // 不修剪——修剪只用來擋「檔案沒寫的」多疊（你早按造成的），檔案寫了的重疊是樂譜本意。同音高不適用（同一個 key 不能同時有兩個音）
        if (entry.holdIdx !== null && entry.note.midiNote !== note.midiNote && entry.endTick > note.startTick) continue;
        const capMs = onsetMs + scaledMs(Math.max(0, this._secOf(entry.endTick) - startSec), rate);
        // 只有「真的截短」才標成 capped、不再 hold（EPS：capMs 與 offMs 從同一個錨點算出來，相等時只差浮點誤差，不算截短）。
        // 單音旋律的譜表因此不會糊到你下一次按鍵；hold 著的音（offMs＝Infinity）遇到同譜表的新音也在這裡被截成有限值
        if (capMs < entry.offMs - EPS_MS) { entry.offMs = capMs; entry.capped = true; entry.holdIdx = null; }
        // 同音高：新音的收音在先進先出佇列裡排在舊音後面，舊音若還 hold 著，新音的收音會被拖住，所以也不再 hold
        else if (entry.note.midiNote === note.midiNote) { entry.capped = true; entry.holdIdx = null; }
      }
    }
    // 同音高的舊音若因此到期，要在新音 noteOn 之前先收（先收再放：不然同音高的 noteOff 會連新音一起關掉）
    const same = staff.sounding.get(note.midiNote);
    for (let i; same && (i = dueIndex(same, onsetMs)) !== -1; ) {
      this._off(staff, note.midiNote, same[i], this._router.offOpts(staff, same[i], same[i].offMs), clockMs);
      same.splice(i, 1);
    }
    if (same && !same.length) staff.sounding.delete(note.midiNote);
  }

  // 收掉到期的音（offMs ≤ limitMs）。同音高重疊時先進先出（hold 著的音不算，見 dueIndex）。limitMs 預設是時鐘 clockMs；tick()
  // 帶 lookahead 時是時鐘 + LOOKAHEAD_MS，只對電腦輔助聲部生效——你的音永遠在時鐘到了才收。
  closeDue(clockMs, limitMs = clockMs) {
    for (const staff of this._staves.values()) {
      const limit = staff.kind === 'human' ? clockMs : limitMs;
      for (const [pitch, queue] of staff.sounding) {
        for (let i; (i = dueIndex(queue, limit)) !== -1; ) {
          this._off(staff, pitch, queue[i], this._router.offOpts(staff, queue[i], queue[i].offMs), clockMs);
          queue.splice(i, 1);
        }
        if (!queue.length) staff.sounding.delete(pitch);
      }
    }
  }

  // 第 j 個 driver segment 在時鐘 clock 放行時：hold 著、等的是第 j 個（或更早）起音的音，收音時刻＝你按下的那一刻 ＋ 檔案裡那個起音
  // 到結尾的長度 ÷ 速度 rate（你的音與電腦音一樣：電腦聲部每次按下都在你按下的那一刻對齊，早按時也不會落後）。
  // 以你的聲部為準：對齊起音的音（剩 0）在起音那一刻就收，就算它依速度換算的原長還沒走完（你比預估快）也收；你慢就一直響到你按下去。
  releaseHeld(j, clock, rate) {
    for (const staff of this._staves.values()) {
      for (const queue of staff.sounding.values()) {
        for (const entry of queue) {
          if (entry.holdIdx === null || entry.holdIdx === undefined || entry.holdIdx > j) continue;
          entry.offMs = clock + scaledMs(entry.tailSec, rate);
          entry.holdIdx = null;
        }
      }
    }
  }

  // 下一次按鍵時，driver 的音 endTick ≤ 新錨點 tick 的先收掉（你的下一個起音發聲時，之前該結束的音已經結束，不管估到的
  // 速度怎樣）。只收 driver：follower 的音照自己的時刻（MIDI 音符長度）放完，不被你的按鍵切斷。
  closeByTick(ticks, clockMs) {
    for (const staff of this._staves.values()) {
      if (staff.kind !== 'human') continue;
      for (const [pitch, queue] of staff.sounding) {
        while (queue.length && queue[0].endTick <= ticks) {
          this._offNow(staff, pitch, queue[0], clockMs);
          queue.shift();
        }
        if (!queue.length) staff.sounding.delete(pitch);
      }
    }
  }

  // 把所有還在響的音收掉：每個 noteOn 各送一個 noteOff。
  noteOffAll(clockMs) {
    for (const staff of this._staves.values()) {
      for (const [pitch, queue] of staff.sounding) {
        for (const entry of queue) {
          this._off(staff, pitch, entry, this._router.offOpts(staff, entry), clockMs);
        }
      }
      staff.sounding.clear();
    }
  }

  // 沒有任何音在響（排程器的 isFinished() 用）。
  isSilent() {
    for (const staff of this._staves.values()) {
      if (staff.sounding.size > 0) return false;
    }
    return true;
  }

  // 收一顆音：送出 noteOff（opts＝時間戳，見 outputRouter.js 的 offOpts()），並排一個 noteOff 事件。
  _off(staff, pitch, entry, opts, clockMs) {
    this._router.noteOff(staff, pitch, opts);
    this._queueNoteOff(staff, entry, opts !== undefined, clockMs);
  }

  // 不帶時間戳、立刻處理的收音（你的下一次按鍵時先收掉 endTick ≤ 新起音的音）。
  _offNow(staff, pitch, entry, clockMs) {
    this._router.noteOffNow(staff, pitch);
    this._queueNoteOff(staff, entry, false, clockMs);
  }

  _queueNoteOff(staff, entry, timed, clockMs) {
    this._events.queue('noteOff', {
      note: entry.note, noteId: entry.note.id ?? null, staffId: staff.id, kind: staff.kind, offMs: entry.offMs, clockMs, timed,
    });
  }
}
