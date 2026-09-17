// ============================================================
//  midiApi.js — 遠端 MIDI 曲庫 client（分類／搜尋／下載），純資料層、無 DOM
//
//  所有請求都有逾時保護；曲庫 API 回傳的每一筆都當成可能是壞的（型別檢查後跳過）。
//  這裡的逾時涵蓋「連線 ＋ 整個 body 下載」（MIDI 檔只有幾 KB），跟 synth.js 的
//  fetchWithTimeout 只涵蓋回應標頭不同——那邊擋的是 10.6MB 的 soundfont。
// ============================================================

const MIDI_LIBRARY_API = "https://imuse.ncnu.edu.tw/Midi-library/api";
const FETCH_TIMEOUT_MS = 12000;

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`請求逾時：${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadMidiFile(id) {
  if (!id) throw new Error("下載失敗：缺少歌曲 ID");

  const downloadUrl = `${MIDI_LIBRARY_API}/midis/${encodeURIComponent(id)}/download`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(downloadUrl, { signal: controller.signal });
    if (!response.ok) throw new Error("下載失敗：" + response.status);
    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength < 14) {
      throw new Error("下載內容過短，檔案可能已損毀或伺服器回傳錯誤內容");
    }
    return new Blob([arrayBuffer], { type: "audio/midi" });
  } catch (err) {
    const finalErr = err.name === "AbortError" ? new Error(`下載逾時：${downloadUrl}`) : err;
    console.error("❌ [下載 MIDI 錯誤]", finalErr);
    throw finalErr;
  } finally {
    clearTimeout(timer);
  }
}

function buildSearchUrl({ query, category }) {
  const url = new URL(`${MIDI_LIBRARY_API}/midis`);
  url.searchParams.set("page", "1");
  url.searchParams.set("limit", "1000");
  url.searchParams.set("sort", "uploaded_at");
  url.searchParams.set("order", "desc");
  if (query) url.searchParams.set("q", query);
  if (category) url.searchParams.set("category", category);
  return url.toString();
}

function normalizeCategories(payload) {
  if (!payload) return [];
  const source = Array.isArray(payload) ? payload
    : Array.isArray(payload.items) ? payload.items
    : Array.isArray(payload.data) ? payload.data : [];

  return source.map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        return (item.name || item.title || item.category || item.categories_text || item.label || "").trim();
      }
      return "";
    }).filter(Boolean);
}

// 遠端曲庫是控制不了的第三方來源：回傳陣列裡混進一個 null、或某個 category 不是字串，
// 都不該讓整個搜尋顯示「API 讀取失敗」。
function extractItemCategories(item) {
  if (!item || typeof item !== "object") return [];
  const categories = [];
  if (Array.isArray(item.categories)) categories.push(...item.categories);
  if (typeof item.categories_text === "string") categories.push(...item.categories_text.split(/[、,/]/));
  return categories
    .filter((category) => typeof category === "string")
    .map((category) => category.trim())
    .filter(Boolean);
}

// 分類清單：依序試三個 endpoint，第一個有內容的就用；全部失敗回傳空陣列（分類還是會從搜尋結果累積）。
export async function fetchCategories() {
  const endpoints = [
    `${MIDI_LIBRARY_API}/categories`,
    `${MIDI_LIBRARY_API}/midis/categories`,
    `${MIDI_LIBRARY_API}/public/categories`,
  ];
  for (const endpoint of endpoints) {
    try {
      const categories = normalizeCategories(await fetchJson(endpoint));
      if (categories.length) return categories;
    } catch (error) {
      // 靜默略過單一 endpoint 的失敗，繼續嘗試下一個
    }
  }
  return [];
}

// 搜尋：回傳 { items, categories }。items 只留有 id 的（缺 id 的異常項目跳過）；categories 是這批
// items 分類的聯集，呼叫端累積進自己的分類集合。
export async function searchSongs({ query, category }) {
  const payload = await fetchJson(buildSearchUrl({ query, category }));
  const raw = Array.isArray(payload?.items) ? payload.items : [];
  const items = raw.filter((item) => item && item.id !== undefined && item.id !== null);
  const categories = [...new Set(items.flatMap(extractItemCategories))];
  return { items, categories };
}
