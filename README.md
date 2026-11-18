# Google Play Points 每週獎勵自動領取（Chrome 擴充功能）

**Google Play Points Weekly Prize Auto Claim — Chrome extension (multi-account)**

每週五自動打開 [Google Play Points 網頁](https://play.google.com/store/points/perks)的「獎勵」分頁，幫 Chrome 裡登入的**每一個 Google 帳號**領「每週獎勵」。不用手機、不用模擬器，也不存任何密碼。

> Automatically claims the Google Play Points **weekly prize** for every Google account signed in to Chrome, using the Play Points web page (`play.google.com/store/points/perks?authuser=N`). No phone or emulator needed, no passwords stored.

<p align="center"><img src="icons/icon128.png" width="96" alt="icon"></p>

## 功能

- **多帳號**：用網址 `authuser=0, 1, 2…` 依序切換 Chrome 裡登入的 Google 帳號，全部自動處理
- **整週重試**：週五 00:05 起到下週四，每 2 小時檢查一次，還有帳號沒領到就再試
- **Chrome 一打開就補跑**：電腦沒開、Chrome 沒開時錯過也沒關係
- **領過就跳過**：按鈕是灰色、卡片上的推出日期還沒到 → 判定本週已領過，不會重複開頁面
- **分得出「還沒開放」**：推出日期到了但按鈕還是灰的 → 2 小時後再試
- **沒有每週獎勵的帳號自動略過**：沒加入 Play Points、或獎勵分頁寫「你升級後解鎖的獎勵會顯示在這裡」
- 背景分頁執行，跑完自動關掉；有領到或有問題時跳 Windows 通知
- 工具列圖示顯示還有幾個帳號沒處理完，全部完成顯示 ✓

## 安裝

1. 下載這個專案（綠色 **Code** 按鈕 → **Download ZIP**），解壓縮
2. Chrome 網址列輸入 `chrome://extensions`
3. 右上角打開「**開發人員模式**」
4. 按「**載入未封裝項目**」，選解壓縮出來的資料夾（裡面有 `manifest.json` 的那層）
5. 工具列拼圖圖示 → 把「Google Play 每週獎勵」釘選出來
6. 點圖示 →「**立即檢查並領取**」先跑一次，看每個帳號的狀態

前提：這個 Chrome 已經登入你要領獎勵的 Google 帳號（可以登入多個）。

## 小視窗

- 本週完成幾個帳號、每個帳號的狀態、最近紀錄
- 「只處理這些帳號」：只想領某幾個帳號就填 email（逗號或換行分開）；空白 = 全部
- 「在 Ko-fi 贊助作者」按鈕

## 狀態說明

| 狀態 | 意思 |
|---|---|
| ✅ 已領取 | 這次按了領取，重新整理後按鈕變灰 → 成功 |
| ☑ 本週已領過 | 按鈕是灰的，而且推出日期還沒到（在等下一份） |
| ⏳ 還沒開放 | 推出日期到了但按鈕還是灰的，2 小時後再試 |
| － 沒有每週獎勵 | 獎勵分頁寫「你升級後解鎖的獎勵會顯示在這裡」，本週不再試 |
| － 沒加入 Play Points | 頁面只有「免費加入」，本週不再試 |
| ⚠ 網頁不能領，要用 App | Google 要求用 Android 的 Play 商店 App 領取 |
| ⚠ 按了但沒確認到／找不到 | 2 小時後再試；一直找不到可能是網頁改版 |

## 狀態檔（進階）

插件會把「本週處理完了沒」寫到 `下載資料夾\Chrome插件狀態\google_play_weekly.json`：

```json
{ "week": "2026-11-20", "allDone": true, "accounts": 6, "pending": 0, "updated": "2026-11-20 00:07" }
```

`week` 是最近一個週五。可以讓開機腳本讀這個檔決定要不要開 Chrome（已經領完就不開）。寫檔時會暫時關掉下載通知、寫完從下載紀錄刪除，不會跳出下載提示。

## 權限說明

| 權限 | 用途 |
|---|---|
| `https://play.google.com/*` | 打開 Play Points 獎勵頁、讀取每週獎勵按鈕狀態並點擊 |
| `tabs`、`scripting` | 開背景分頁、在頁面裡執行檢查程式 |
| `alarms` | 每 30 分鐘檢查一次要不要執行 |
| `storage` | 記錄每個帳號本週的狀態 |
| `notifications` | 領到或有問題時通知 |
| `downloads`、`downloads.ui` | 寫上面的狀態檔（並暫時隱藏下載通知） |

不會讀取或傳送你的密碼、Cookie 或任何資料到外部伺服器。

## 注意事項

- 這是用網頁畫面上的文字和按鈕判斷，Google 改版時可能需要更新。
- Chrome 要開著才會執行。
- 使用自動化工具可能不符合 Google Play 服務條款，請自行斟酌風險。
- 非 Google 官方專案，與 Google 無關。Google Play 是 Google LLC 的商標。

## 贊助

覺得好用的話，可以請作者喝杯咖啡 ☕ → [ko-fi.com/sagiriben](https://ko-fi.com/sagiriben)
