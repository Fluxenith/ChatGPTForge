# ChatGPTForge

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

![ChatGPTForge：以對話驅動程式、瀏覽器與 Windows 工具](docs/assets/forge-overview-zh-TW.png)

**讓 ChatGPT 對話直接連接你的 Windows 開發環境。**

修改專案、執行驗證、操作已授權瀏覽器與桌面視窗，並保留任務紀錄及支援修改的回復能力。

[English](README.md) · [安裝方式](README.md#get-started) · [部署指南](runtime/docs/deployment.md)

## 主要功能

- 跨檔引用預覽、語意改名與支援操作的回復。
- 可持續接續的任務狀態、操作回執與驗收紀錄。
- 明確加入的跨專案共享記憶與引用更新。
- 已授權瀏覽器及 Windows 桌面操作，操作後重新觀察。
- 選配依賴檢查、修復流程與混合 MCP 元件部署。

需要 Windows、Node 22.19–26.x、npm、Git、PowerShell，以及另外設定的 ChatGPT／HTTPS MCP 連線。目前提供原始碼安裝，屬開發者預覽版。帳號登入、桌面授權與第三方工具核准需各自設定。

## 安裝 Forge Chrome 擴充功能

**ChatGPTForge Continuation** 是本倉庫附帶的擴充功能，用於在已登入的 ChatGPT 瀏覽器接續交接任務，以及協助管理頁填寫專案外掛表單。一般 MCP 程式碼、記憶與桌面工具不需要安裝它；它也不取代 HTTPS MCP／OAuth 連線設定。

1. 啟動 Forge，使用平常已登入 ChatGPT 的 Chrome 設定檔。
2. 開啟 `chrome://extensions`，打開「開發人員模式」，按「載入未封裝項目」。
3. 選擇下載或 clone 後的 `runtime/browser-extension` 資料夾，裡面必須有 `manifest.json`；不要選倉庫根目錄或 ZIP。清單應出現 **ChatGPTForge Continuation**。
4. 開啟本機管理頁 `http://127.0.0.1:8768`，展開「設定 → Chrome 擴充功能配對」，按「複製 Chrome 配對碼」。
5. 開啟擴充功能設定，填入本機管理服務 `http://127.0.0.1:8768`（若自訂管理埠則改用該埠），貼上配對碼。
6. 勾選「啟用自動接續」，按「保存設定」，再按「立即檢查」。沒有待處理任務時，成功狀態應為「已連線，等待交接」。啟用後，排隊的交接提示會在新 ChatGPT 分頁送出。

使用時保持 Forge 與 Chrome 開啟。更新擴充功能檔案後，到 Chrome 擴充功能清單按「重新載入」。配對碼請勿公開；它不是 ChatGPT 密碼，也不是 Playwright token。[連線與疑難排解（英文）](docs/connection.md)。

### 還需要 Playwright Extension 嗎？

只有要走「操作既有 Chrome 分頁」這條路線才需要另外安裝微軟的 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)，設定 Forge 的 `playwright-browser` gateway，並在連線畫面允許存取。只裝擴充功能不會自動完成 gateway 設定。**兩個擴充功能用途不同，不是每個人都要裝兩個。**[設定步驟（英文）](docs/connection.md#optional-existing-chrome-tab-automation)。

## 從需求到結果

![理解、預覽、執行與驗證的操作流程](docs/assets/forge-workflow-zh-TW.png)

先查看目前狀態，再預覽修改；完成操作後核對結果。需要回復時，從回執確認支援的還原方式。

## 安裝與整合需求

[提出需求詢問](https://github.com/Fluxenith/ChatGPTForge/issues/new?template=setup-request.yml)，說明想完成的工作流程；可表達付費安裝或客製整合意願。價格、範圍與可承接時間另行確認，並非已完成付款的服務。公開 issue 請勿填入個資、憑證或私人程式碼。

由 [Fluxenith](https://github.com/Fluxenith) 維護。MIT 授權；本專案與 OpenAI 無隸屬或背書關係。
