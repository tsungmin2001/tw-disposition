# 台股處置股每日自動看板

每日 21:00 (台北) 自動抓取 TWSE/TPEX 處置股公告，分析仍在處置期間的普通股，計算進處置前收盤 vs 最新收盤的漲跌幅、20 日均價、20MA 乖離率、產業分類，並生成靜態 HTML 部署到 Cloudflare Pages。

## 架構

```
GitHub Actions (cron 0 13 * * *)
    ↓ 每日 21:00 台北
node daily_update.js
    ├─ 抓 TWSE 處置公告 (當年度)
    ├─ 抓 TPEX 處置公告 (2024 至今)
    ├─ 重建 disposition_stocks.txt
    ├─ 找出明天仍在處置期間的普通股
    ├─ 補抓上個月+當月日成交價 (當月強制重抓拿最新收盤)
    ├─ 加產業/次產業
    └─ 生成 public/index.html
    ↓
git commit + push
    ↓
Cloudflare Pages 自動部署 (Git integration)
    ↓
https://你的專案.pages.dev/
```

## 設定步驟 (一次性)

### 1. Push 到 GitHub

```bash
cd disposition_scraper
git init
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<你的帳號>/<repo>.git
git push -u origin main
```

### 2. 連接 Cloudflare Pages

1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左側選單 → **運算** → **Workers & Pages** → **Create** → **Pages** 分頁
3. 選 **Connect to Git** → 授權 GitHub → 選你剛 push 的 repo
4. Build 設定：
   - **Production branch**: `main`
   - **Build command**: 留空 (因為 HTML 是 commit 進來的，不需要 build)
   - **Build output directory**: `public`
5. 點 **Save and Deploy**

完成後拿到網址 `https://<專案名>.pages.dev/`，往後每次 `git push` 都會自動部署。

### 3. 驗證 GitHub Actions

1. GitHub 你的 repo → **Actions** tab
2. 應該看到 **Daily disposition update** workflow
3. 點 **Run workflow** → 選 main → 手動執行一次測試
4. 約 5-10 分鐘完成（首次會比較久因為要抓所有股價）
5. 完成後 main branch 會自動產生 commit，Cloudflare Pages 就會更新

之後每天台北時間 21:00 自動執行（UTC 13:00）。

## 本地開發 / 偵錯

```bash
# 跑整個 pipeline
node daily_update.js

# 或逐步跑
node reproc.js                  # 從 raw/ 重建 disposition_stocks.txt
TARGET_DATE=115/05/27 node tomorrow_active.js   # 指定日期
node add_industry.js
node add_sub_industry.js
node render_html.js             # 產 public/index.html
```

## 注意事項

- **GitHub Actions cron 有 0-30 分延遲**：實際可能 21:00-21:30 才跑。
- **TWSE/TPEX API 用「處置期間」過濾**：endDate 必須超過今天，否則新公告會被排除。daily_update.js 已自動設為今天+30 天。
- **TPEX mega query 有筆數截斷**：分 chunk 處理，chunk_5 涵蓋 2024 起。2026 年底前安全。
- **次產業是手刻分類**：在 `add_sub_industry.js` 內 hardcode mapping，新股票出現會顯示「(未分類)」需手動補上。
- **價格快取**：`prices/` 每天累積，上個月以前的資料只抓一次。當月每天都會重抓拿最新收盤。

## 檔案結構

```
disposition_scraper/
├── daily_update.js          ← 主流程 orchestrator
├── reproc.js                ← raw/ → disposition_stocks.txt
├── tomorrow_active.js       ← 找明天 active + 計算價格 (動態日期)
├── add_industry.js          ← 加 TWSE/TPEX 27 大類產業
├── add_sub_industry.js      ← 加手刻次產業 (MLCC, PCB-板, 半導體-設備...)
├── render_html.js           ← 生 public/index.html
├── raw/                     ← TWSE/TPEX 原始 JSON (committed)
├── prices/                  ← 個股日成交 JSON (committed, 累積)
├── public/                  ← 靜態網站 (Cloudflare Pages 部署目錄)
│   └── index.html
├── disposition_stocks.txt   ← 全歷史處置 TSV
├── tomorrow_active.txt      ← 明日 active TSV
└── .github/workflows/
    └── daily.yml            ← GitHub Actions 排程
```

## 資料來源

- TWSE: <https://www.twse.com.tw/zh/announcement/punish.html>
- TPEX: <https://www.tpex.org.tw/zh-tw/announce/market/disposal.html>
- 個股日成交 (TWSE STOCK_DAY、TPEX tradingStock)
- 公司基本資料 (TWSE/TPEX OpenAPI)

本資料僅供研究參考，不構成投資建議。
