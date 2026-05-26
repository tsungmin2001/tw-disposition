'use strict';
// 每日 21:00 (台北) 跑的 orchestrator
// 流程：
//   1. 重抓 TWSE 當年度處置公告 + TPEX chunk_5 (含未來 30 天，捕捉今日新公告)
//   2. 跑 reproc.js 重建 disposition_stocks.txt
//   3. 動態算出明天日期 (台北時區)，找仍在處置期間的普通股
//   4. 補抓上個月+當月日成交價（當月強制重抓以拿到最新收盤）
//   5. 跑 tomorrow_active.js → add_industry.js → add_sub_industry.js → render_html.js
//   6. 完成，public/index.html 等著被 git commit

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = __dirname;
const RAW = path.join(ROOT, 'raw');
const PRICES = path.join(ROOT, 'prices');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SLEEP_MS = 5_000;

[RAW, PRICES].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ===== Time utilities =====
function taipeiNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function rocOf(d) { return (d.getUTCFullYear() - 1911) + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0'); }
function ymOf(d) { return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0'); }
function ymd(d) { return d.getUTCFullYear() + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0'); }
function ymdCompact(d) { return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); }

const TODAY = taipeiNow();
const TOMORROW = addDays(TODAY, 1);
const CURRENT_YEAR = TODAY.getUTCFullYear();
const CURRENT_YM = ymOf(TODAY);
const PREV_MONTH_DATE = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - 1, 1));
const PREV_YM = ymOf(PREV_MONTH_DATE);
const TARGET_ROC = rocOf(TOMORROW);
const FUTURE_END_PLUS30 = addDays(TODAY, 30);

console.log('=== Daily update started ===');
console.log('Today (Taipei):', rocOf(TODAY));
console.log('Tomorrow (Taipei):', TARGET_ROC);
console.log('Current month:', CURRENT_YM, '| Previous month:', PREV_YM);

// ===== HTTP =====
function httpsGet(url, referer) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': referer || '', 'Cache-Control': 'no-cache' },
      timeout: 60_000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, referer, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await httpsGet(url, referer);
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      if (res.body.trim().startsWith('<')) throw new Error('HTML response');
      return JSON.parse(res.body);
    } catch (e) {
      console.log(`  ! ${label} attempt ${attempt}/3: ${e.message}`);
      if (attempt === 3) throw e;
      await sleep(15_000);
    }
  }
}

// ===== Step 1: refresh raw =====
async function refreshRaw() {
  const futureEndCompact = ymdCompact(FUTURE_END_PLUS30);
  const futureEndYmd = ymd(FUTURE_END_PLUS30);

  // TWSE current year disposal announcements
  console.log(`\n[1/4] Refreshing TWSE ${CURRENT_YEAR} disposition (endDate=${futureEndCompact})...`);
  const twseUrl = `https://www.twse.com.tw/rwd/zh/announcement/punish?response=json&startDate=${CURRENT_YEAR}0101&endDate=${futureEndCompact}`;
  const twseData = await fetchJson(twseUrl, 'https://www.twse.com.tw/zh/announcement/punish.html', 'TWSE ' + CURRENT_YEAR);
  const twseFile = path.join(RAW, `twse_${CURRENT_YEAR}.json`);
  fs.writeFileSync(twseFile, JSON.stringify(twseData));
  console.log(`  saved ${path.basename(twseFile)} (total: ${twseData.total}, rows: ${(twseData.data || []).length})`);

  await sleep(SLEEP_MS);

  // TPEX chunk_5 (2024 onwards to future)
  console.log(`\n[2/4] Refreshing TPEX chunk_5 disposition (endDate=${futureEndYmd})...`);
  const tpexUrl = `https://www.tpex.org.tw/www/zh-tw/bulletin/disposal?startDate=2024/01/01&endDate=${futureEndYmd}&type=all&id=&response=json`;
  const tpexData = await fetchJson(tpexUrl, 'https://www.tpex.org.tw/zh-tw/announce/market/disposal.html', 'TPEX chunk5');
  const tpexFile = path.join(RAW, 'tpex_chunk_5_2024-2026.json');
  fs.writeFileSync(tpexFile, JSON.stringify(tpexData));
  const valid = (tpexData.tables[0].data || []).filter(r => r[2] && !(r[7] && /本日無處置資料/.test(r[7])));
  console.log(`  saved ${path.basename(tpexFile)} (valid: ${valid.length})`);

  await sleep(SLEEP_MS);

  // TWSE company basic info (for industry classification)
  console.log(`\n[3/4] Refreshing TWSE company info (產業別 lookup)...`);
  const twseComp = await fetchJson('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', 'https://openapi.twse.com.tw/', 'TWSE companies');
  fs.writeFileSync(path.join(ROOT, 'twse_companies.json'), JSON.stringify(twseComp));
  console.log(`  saved twse_companies.json (${twseComp.length} companies)`);

  await sleep(SLEEP_MS);

  // TPEX company basic info
  console.log(`\n[4/4] Refreshing TPEX company info...`);
  const tpexComp = await fetchJson('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O', 'https://www.tpex.org.tw/openapi/', 'TPEX companies');
  fs.writeFileSync(path.join(ROOT, 'tpex_companies.json'), JSON.stringify(tpexComp));
  console.log(`  saved tpex_companies.json (${tpexComp.length} companies)`);
}

// ===== Step 2: identify active stocks =====
function rocKey(d) {
  const m = String(d || '').match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return 0;
  return parseInt(m[1].padStart(3, '0') + m[2].padStart(2, '0') + m[3].padStart(2, '0'));
}

function identifyActiveEquity(targetROC) {
  const txt = fs.readFileSync(path.join(ROOT, 'disposition_stocks.txt'), 'utf8').replace(/^﻿/, '');
  const lines = txt.split('\n').filter(Boolean);
  const rows = lines.slice(1).map(l => l.split('\t'));
  const targetKey = rocKey(targetROC);

  const byCode = new Map();
  for (const r of rows) {
    const [source, announce, code, name, cum, cond, period, measure] = r;
    const parts = (period || '').split(/[~～]/);
    if (parts.length !== 2) continue;
    const startKey = rocKey(parts[0]);
    const endKey = rocKey(parts[1]);
    if (startKey === 0 || endKey === 0) continue;
    if (startKey <= targetKey && targetKey <= endKey) {
      const prev = byCode.get(code);
      if (!prev || startKey < prev.startKey) {
        byCode.set(code, { source, code, name, startKey, endKey });
      }
    }
  }

  // Filter to equity only (4-digit + TWSE 911xxx DR)
  return [...byCode.values()].filter(s => {
    const c = String(s.code);
    if (s.source === 'TWSE') return /^\d{4}$/.test(c) || /^911\d{3}$/.test(c);
    if (s.source === 'TPEX') return /^\d{4}$/.test(c);
    return false;
  });
}

// ===== Step 3: ensure price data =====
async function fetchStockMonth(source, code, ymVal) {
  const url = source === 'TWSE'
    ? `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ymVal}01&stockNo=${code}&response=json`
    : `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${ymVal.slice(0, 4)}/${ymVal.slice(4, 6)}/01&response=json`;
  const referer = source === 'TWSE' ? 'https://www.twse.com.tw/' : 'https://www.tpex.org.tw/zh-tw/mainboard/trading/info/stock-pricing.html';
  return fetchJson(url, referer, `${source} ${code} ${ymVal}`);
}

async function ensurePrices(equity) {
  const tasks = [
    { ym: PREV_YM, forceRefresh: false },
    { ym: CURRENT_YM, forceRefresh: true },   // 當月強制重抓（每日新增最新收盤）
  ];
  let count = 0, total = equity.length * tasks.length;

  for (let i = 0; i < equity.length; i++) {
    const s = equity[i];
    for (const t of tasks) {
      count++;
      const file = path.join(PRICES, `${s.source}_${s.code}_${t.ym}.json`);
      const exists = fs.existsSync(file) && fs.statSync(file).size > 200;
      if (exists && !t.forceRefresh) {
        // already cached, skip silently
        continue;
      }
      console.log(`  [${count}/${total}] ${s.source} ${s.code} ${s.name} ${t.ym} fetching...`);
      try {
        const data = await fetchStockMonth(s.source, s.code, t.ym);
        fs.writeFileSync(file, JSON.stringify(data));
      } catch (e) {
        console.log(`     ! permanently failed: ${e.message}`);
        fs.writeFileSync(file, JSON.stringify({ error: e.message, stat: 'ERROR' }));
      }
      if (count < total) await sleep(SLEEP_MS);
    }
  }
}

// ===== Step 4: chain downstream scripts =====
function runDownstream() {
  const env = { ...process.env, TARGET_DATE: TARGET_ROC, MONTHS: `${PREV_YM},${CURRENT_YM}` };
  for (const script of ['reproc.js', 'tomorrow_active.js', 'add_industry.js', 'add_sub_industry.js', 'render_html.js', 'render_home.js', 'build_analysis.js']) {
    console.log(`\n[downstream] node ${script}`);
    execSync(`node ${script}`, { stdio: 'inherit', cwd: ROOT, env });
  }
}

// ===== Main =====
(async () => {
  try {
    await refreshRaw();

    console.log('\n[step] Rebuild disposition_stocks.txt...');
    execSync('node reproc.js', { stdio: 'inherit', cwd: ROOT });

    console.log('\n[step] Identify active equity for ' + TARGET_ROC + '...');
    const equity = identifyActiveEquity(TARGET_ROC);
    console.log('  Active equity stocks: ' + equity.length);

    console.log('\n[step] Ensure price cache...');
    await ensurePrices(equity);

    console.log('\n[step] Run downstream pipeline...');
    runDownstream();

    console.log('\n=== Daily update complete ===');
  } catch (e) {
    console.error('FATAL:', e.stack || e.message);
    process.exit(1);
  }
})();
