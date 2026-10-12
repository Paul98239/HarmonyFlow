// ============================================================
//  gmNames.js — 名稱表：GM 繁中（台灣用語）音色名、鼓組名、音名（純資料；分譜清單與 midiPlayer.js 用）
// ============================================================

// GM1 打擊樂固定使用第 10 個 MIDI channel（索引 9，不是第 10 個 track）上 program 代表的
// 是鼓組而非旋律樂器。GM2 §2.4／§3.3.1 允許用 Bank Select（CC0 MSB／CC32 LSB）在任何 channel
// 上切換：bank 79H(121)＝旋律（channel 9 以外的規格預設值）、bank 78H(120)＝節奏（channel 9
// 的規格預設值）——staff 的 percussionKit 判定依這條規則走（見 buildPart()），不是只看
// channel 號碼。這張表只用來檢查鼓組 program 是不是 GM2 附錄 B 定義的編號。
// 拼法對齊 GM2 規格文件附錄 B「General MIDI 2 Percussion Sound Set」表格標題（PC#1 STANDARD Set、
// PC#9 ROOM Set…）：全部是「XXX Set」，不是「XXX Kit」；56 號那組官方寫的是縮寫「SFX Set」，
// 不是「Sound FX」。
export const GM_DRUM_KITS = Object.freeze({
  0: 'Standard Set', 8: 'Room Set', 16: 'Power Set', 24: 'Electronic Set',
  25: 'Analog Set', 32: 'Jazz Set', 40: 'Brush Set', 48: 'Orchestra Set', 56: 'SFX Set',
});

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
