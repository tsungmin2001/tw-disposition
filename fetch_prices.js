'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = __dirname;
const PRICE_DIR = path.join(OUT_DIR, 'prices');
const PROGRESS_FILE = path.join(OUT_DIR, 'progress.log');
const SLEEP_MS = 5_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MONTHS = ['202604', '202605'];  // need both for 20-day MA window

if (!fs.existsSync(PRICE_DIR)) fs.mkdirSync(PRICE_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(PROGRESS_FILE, line + '\n');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url, referer) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': referer || '' },
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

async function fetchWithRetry(url, referer, label, maxRetry = 3) {
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      const res = await httpsGet(url, referer);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      if (res.body.trim().startsWith('<')) throw new Error('HTML response (maintenance?)');
      return JSON.parse(res.body);
    } catch (e) {
      if (attempt === maxRetry) throw e;
      log(`  ! ${label} retry ${attempt}/${maxRetry}: ${e.message}`);
      await sleep(15_000);
    }
  }
}

// Load active stock list, filter to 普通股 (4-digit codes), plus TWSE DR (9xxxxx like 911608)
const txt = fs.readFileSync(path.join(OUT_DIR, 'active_list.tsv'), 'utf8');
const lines = txt.split('\n').filter(Boolean);
const stocks = lines.slice(1).map(l => l.split('\t')).map(r => ({
  source: r[0], code: r[1], name: r[2], announce: r[3], period: r[4], cond: r[5], measure: r[6]
}));

const equity = stocks.filter(s => {
  const c = String(s.code);
  // TWSE pure equity: 4-digit, or DR (911xxx)
  if (s.source === 'TWSE') return /^\d{4}$/.test(c) || /^911\d{3}$/.test(c);
  // TPEX pure equity: 4-digit
  if (s.source === 'TPEX') return /^\d{4}$/.test(c);
  return false;
});

log(`Equity stocks to fetch: ${equity.length} (total active: ${stocks.length})`);

async function fetchTwseMonth(code, ym) {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}01&stockNo=${code}&response=json`;
  return fetchWithRetry(url, 'https://www.twse.com.tw/', `TWSE ${code} ${ym}`);
}
async function fetchTpexMonth(code, ym) {
  const dStr = `${ym.slice(0,4)}/${ym.slice(4,6)}/01`;
  const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${dStr}&response=json`;
  return fetchWithRetry(url, 'https://www.tpex.org.tw/zh-tw/mainboard/trading/info/stock-pricing.html', `TPEX ${code} ${ym}`);
}

(async () => {
  log(`=== Price fetch started ===`);
  log(`Stocks: ${equity.length}, months per stock: ${MONTHS.length}, sleep: ${SLEEP_MS/1000}s`);
  log(`Estimated time: ~${Math.ceil(equity.length * MONTHS.length * SLEEP_MS / 60_000)} minutes`);

  let count = 0;
  const total = equity.length * MONTHS.length;
  for (let i = 0; i < equity.length; i++) {
    const s = equity[i];
    for (const ym of MONTHS) {
      count++;
      const fname = path.join(PRICE_DIR, `${s.source}_${s.code}_${ym}.json`);
      // Skip if already fetched (resume support)
      if (fs.existsSync(fname) && fs.statSync(fname).size > 200) {
        log(`[${count}/${total}] ${s.source} ${s.code} ${s.name} ${ym} — cached, skip`);
        continue;
      }
      log(`[${count}/${total}] ${s.source} ${s.code} ${s.name} ${ym} fetching...`);
      try {
        const data = s.source === 'TWSE' ? await fetchTwseMonth(s.code, ym) : await fetchTpexMonth(s.code, ym);
        fs.writeFileSync(fname, JSON.stringify(data));
      } catch (e) {
        log(`  X failed permanently: ${e.message}`);
        fs.writeFileSync(fname, JSON.stringify({ error: e.message, stat: 'ERROR' }));
      }
      if (count < total) await sleep(SLEEP_MS);
    }
  }
  log(`=== Price fetch complete: ${count} requests ===`);
})().catch(e => { log(`FATAL: ${e.stack || e.message}`); process.exit(1); });
