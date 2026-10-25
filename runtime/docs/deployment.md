# 新機與混合元件部署

本流程適用 Windows、Node >=22.19 <27、npm、Git、Windows PowerShell。先安裝這些基礎工具；Forge 不替換全機工具版本、不搬移舊機帳號憑證。Node/npm 來源應由部署者核對。可攜包帶有產品檔案及 package-lock.json；npm 依賴仍需網路或預先準備的 npm cache，不是完整離線映像。

## 產生並移交部署包

在已完成 build 的 runtime 執行：

```powershell
node dist/forge-cli.js deployment export --file C:\Releases\Forge-New
```

目的地必須尚不存在，且位於 runtime 外。記錄輸出的 `manifest_sha256`；部署包包含 `runtime`、`setup.mjs`、`manifest.json`。保留 UPSTREAM 與元件授權檔。這個雜湊用於核對移交內容，不是廠商數位簽章。不得把使用者設定、OAuth 資料庫、browser profile、token 或目前 node_modules 放進部署包。

## 新機安裝

將整個目錄搬到新機，以該目錄為工作目錄執行：

```powershell
node setup.mjs --check --port 8877 --manager-port 8878 --manifest-sha256 RELEASE_HASH
node setup.mjs --apply --workspace C:\Projects\Example --config-dir C:\ForgeState\Example --public-url https://YOUR_EXISTING_HOST --port 8877 --manager-port 8878 --manifest-sha256 RELEASE_HASH
node start.mjs
```

工作目錄必須已存在；設定目錄必須是全新路徑，且不得位於工作目錄內。Apply 先核對檔案雜湊與連接埠，執行鎖定版 `npm ci --omit=dev`，再建立專用設定與啟動入口。它不覆寫既有安裝，不啟動 Tunnel，不自動安裝／核准外部元件。`install-receipt.json` 與產生的 `start.mjs` 是機器本地資料，不回填到可攜指南。

若 npm 失敗，保留錯誤輸出和該目錄，先判斷是下載、native addon／工具鏈或權限問題；使用另一個全新部署目錄修復安裝。不刪除原服務的資料，也不靠終止不明 PID 搶連接埠。

服務啟動後，用該設定目錄的 `manager.json` 開啟本機 Manager；網址內有本機管理憑證，不貼到共用文件。將使用者已有的 HTTPS Tunnel 指到 MCP 連接埠，核對 public origin；沒有 Tunnel 時先停在 localhost readiness，不宣稱 ChatGPT 已連通。帳號授權在新機重新進行，不複製舊機 token。

## 混合元件部署

### 依賴檢查、修復與執行

新入口使用相同 profile。component 可設 `required: false`（預設 true），Playwright 可設 `chromium: true` 要求檢查其固定版瀏覽器。gateway 的 `required` 預設 false。

```powershell
node runtime/dist/forge-cli.js deployment check --manifest PROFILE.json
node runtime/dist/forge-cli.js deployment repair --manifest PROFILE.json
node runtime/dist/forge-cli.js deployment repair --manifest PROFILE.json --from C:\Tools\uv.exe --apply
node runtime/dist/forge-cli.js deployment repair --manifest PROFILE.json --apply --online
node runtime/dist/forge-cli.js deployment apply --manifest PROFILE.json --probe-file PROBES.json --apply --online
```

`check` 不下載或啟動外部服務，依所選元件檢查 Node、配套 npm、uv、Python 3.13／3.14、Git、Skills profile，以及選用 Chromium 的檔案。缺件回傳具體 repair 指引。它檢查必要依賴與 gateway 設定，不把檔案存在或已安裝當作實調成功。

`repair` 沒有 `--apply` 時只預覽。`--from` 接受現有 uv 的絕對路徑，驗證版本後存入此 Forge 設定目錄的 `deployment-tools.json`；現有 `FORGE_UV` 環境覆寫仍優先。若 uv 根本未安裝，依檢查結果從官方來源安裝，再提供路徑；不默默改全機 PATH。`--online` 才允許透過 uv 安裝缺少的指定 Python，或使用已安裝、固定版本的 Playwright CLI 安裝 Chromium。Node/npm/Git 與 Skills profile 問題回傳手動修復步驟，不宣稱已自動修復。修復後會重新檢查。

`apply --apply` 安裝／核對 profile 明確列出的 managed 元件、綁定後逐一驗證 gateway；需要下載或重建元件時須加 `--online`。已驗證且版本相同的元件直接重用；同版損壞走既有鎖定修復流程。若相同 ID 已由外部提供者使用，回報 `binding_conflict`，不覆寫外部設定。新綁定仍未核准，既有核准範圍維持原樣；不開啟 GUI、不取得登入態、不建立 Tunnel。設定更新後依正常程序重啟 Forge。

PROBES.json 是 gateway ID 對應到既有唯讀探測的 mapping：

```json
{"reference-service":[{"tool":"ping","arguments":{},"expect":{"text_equals":"ready"}}]}
```

探測只能使用已核准的 read 工具。未提供 probe 的成功只代表 initialize／工具目錄；`safe_call: success` 才代表指定內容斷言通過。每個 provider 個別記錄，不可用選配服務不阻斷其他來源；必要服務失敗回傳 `blocked`、exit 1，選配失敗回傳 `degraded`、exit 0。`repair` 的完成判斷只涵蓋元件依賴，gateway 實調由 `apply` 負責。

每次執行留下 state 目錄下 `deployment-receipts/*.json`，包括檢查、動作及結果摘要，不保存 token 或 provider 回傳內容。外部 HTTP listener 不會被停止／替換；stdio 僅啟動既有核准命令的連線子程序，結束時關閉該連線。既有成功安裝不因另一選配失敗而回滾；可修正缺件後重跑，或使用既有 `components external-rollback ID` 回復指定元件。

`deployment plan --manifest PROFILE.json` 只驗證與產生計畫，不下載、啟動或修改元件。範例見 [deployment-profile.json](../examples/deployment-profile.json)。managed 元件必須指定相容的固定版本／commit；外部 HTTP 或 stdio 服務保留原管理者生命週期。

```powershell
$env:CHATGPTFORGE_CONFIG_DIR='C:\ForgeState\Example'
node runtime/dist/forge-cli.js deployment plan --manifest runtime/examples/deployment-profile.json
node runtime/dist/forge-cli.js deployment inventory
node runtime/dist/forge-cli.js components external-list
```

按需求安裝 plan 列出的元件；不要為了盤點而強制裝滿所有語言與 GUI 元件。Playwright 的安裝、瀏覽器可操作、已登入日常 profile 是三個狀態。Serena 的套件完整性、語言伺服器與實際專案語意能力也要分開核對。Windows-MCP 是選配，安裝不等於整機 GUI 授權。

外部元件用既有 `gateway manifest --manifest FILE` 或 `gateway add-http ID --endpoint URL`／`gateway import` 登記；預設未核准。依實際 schema 分類 read/write 工具後，再用 `gateway approve ID --read TOOL` 核准需要的最小集合。唯讀探測範例：

```json
[{"tool":"echo","arguments":{"text":"forge-deployment-probe"}}]
```

```powershell
node runtime/dist/forge-cli.js gateway onboard SERVER_ID --probe-file probes.json --apply
```

重啟由本次安裝擁有的 Forge 後，從真實 Host 呼叫 `project_context`、Gateway 讀取與一項本機任務驗收。重啟前先查看活躍任務；外部 listener 不隨 Forge 重啟。設定／目錄／版本改動會使舊 onboarding 證據失效，需重新探測。

## 驗收層級與升級回復

| 層級 | 必要證據 | 不可推論 |
|---|---|---|
| 檔案 | manifest 雜湊、鎖定檔、授權文件 | 已安裝成功 |
| 安裝 | 全新目錄 npm ci、專用設定、安裝回執 | 乾淨 OS 上已成功 |
| Core | 認證 MCP 握手、工具目錄、固定任務通過 | 外部 HTTPS／ChatGPT 已連通 |
| 混合服務 | stdio + HTTP 各自安全實調、同時存在且結果可區分 | 所有供應商／帳號均可用 |
| Host | 真實連線工具呼叫及必要的使用者流程 | 所有平台、GUI 與語言全覆蓋 |

升級部署到新目錄並保留舊版；先使用新設定／隔離連接埠驗收，核對資料格式相容後才安排切換。不要讓兩個服務同時寫同一個狀態庫。回復元件可使用既有 `components external-rollback ID`；回復整體服務前先停止新版、核對原程序 ownership 與資料相容性，禁止直接用舊程式打開未確認相容的新資料庫。

完整操作流程與經驗模板見 [可攜操作指南](../skills/forge-operation/SKILL.md)。

獨立攜帶指南時，執行 `deployment guide --file NEW_DIRECTORY`。輸出包含 SKILL.md、流程索引、部署 runbook、profile 範例與經驗／交接模板，內部連結已轉成可攜相對路徑；不需要攜帶原 checkout。這是操作知識的結構與內容覆蓋，不代表已做跨模型經驗學習效果評測。
