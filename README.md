# HarmonyFlow

瀏覽器端的 MIDI 演奏應用：觸發來源（目前是電腦鍵盤四排字元鍵＝分譜下拉的「PC 鍵盤手」，攝影機 → MediaPipe 姿勢追蹤＋拋物線手勢暫時沒有接進播放器）每觸發一次，就放行你的聲部的下一個起音，音在按下的當下立刻發聲；一個演奏者可以同時控制多個聲部。沒被你控制的聲部由電腦輔助、不用按，跟著你的位置與速度走（依你最近的按鍵估速度），與你的起音同一個 tick 的電腦音跟你的音同刻發聲；音長依你的速度等比例縮放（結尾接著或橫跨你下一個起音的音會 loop 到你按下去；你早按時電腦聲部不會往前跳）。任何一首歌（含單聲部）都能指派，播放中改指派會從目前位置接續。另有「試聽」鈕，用官方 SpessaSynth Sequencer 播同一份 MIDI 讓你用耳朵對照。純原生 JavaScript（ES module），沒有 build step、沒有後端、沒有 Node 工具鏈。

## 需求

- 桌機瀏覽器（Chrome／Edge／Firefox／Safari 近兩年的版本）＋ 攝影機。
- 需要網路連線：第三方套件（MediaPipe、spessasynth）直接從 CDN 載入，不在本機安裝；音色庫與姿勢模型也走 CDN（`src/assets/` 的本地副本只在 CDN 失敗時備用）。

## 本地開發

clone 下來直接用 VS Code 的 Live Server（ritwickdey.liveserver）開：以這個資料夾為工作區根目錄開啟，「Go Live」→ `http://127.0.0.1:5500/`（`.vscode/settings.json` 已設好 port 與忽略清單；它對 `.wasm` 回 `application/wasm`）。ES module 的 `import` 與 `getUserMedia` 都需要 `http(s)://`，不能直接用 `file://` 開 `index.html`。部署＝把資料夾原樣 serve 出去，所以這樣跑起來看到的就是部署後的樣子。

## 資料夾

```
index.html        唯一進入點；完整的靜態 UI markup 都在這裡（HTML-first），preload／modulepreload 也在這裡
src/
  main.js         啟動點（composition root）：initUi(midiPlayer)、接 vision → 播放器的人數監聽與鍵盤 → 播放器的觸發、並行推進兩條啟動軌道
  keyboard.js     鍵盤觸發：四排字元鍵＝PC 鍵盤手的一次觸發（防呆：按住重複、組合鍵、打字、下拉 type-ahead）
  ui.js           UI 外殼：Store（EventTarget 狀態容器）＋ rafThrottle、uiStore、載入／錯誤遮罩＋inert、--ui-fs、
                  系統控制列、面板開合、事件代理、render 排程
  vision/         攝影機／WebGL／MediaPipe（vision.js）＋ 純邏輯的多人追蹤（tracking.js）與揮手手勢（gesture.js）
  midi/           spessasynth 合成器（synth.js）、播放器狀態＋動作＋畫面（midiPlayer.js）、雲端曲庫 client（midiApi.js）
                  ＋ 純邏輯的 SMF 解析與聲部切分（midiParser.js）、排程器（scheduler.js：每次觸發放行你的聲部的下一個起音並立刻發聲、
                  按鍵啟動電腦聲部負責的那一段）、按鍵節奏（pressTiming.js：估速、去抖）、試聽（previewPlayer.js：官方 Sequencer 的薄包裝）
  styles.css      唯一的樣式檔（@layer base／ui／states）
  assets/         MediaPipe 模型（.task）與 soundfont（.sf3）的本地備用副本（平常走 CDN，CDN 失敗才載這裡），進 git
```

## 第三方套件

`@mediapipe/tasks-vision`（`src/vision/vision.js`）與 `spessasynth_lib`（`src/midi/synth.js`）都直接寫死完整 CDN 網址（jsDelivr）匯入，`tasks-vision` 固定 `@1.1.0`、`spessasynth_lib` 綁 `@latest`；沒有 import map、JS 套件沒有本地副本。

## 文件

[`CLAUDE.md`](./CLAUDE.md)：怎麼跑、架構、慣例與禁止事項（給 Claude Code 也給人看）。
