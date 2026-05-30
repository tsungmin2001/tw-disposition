'use strict';
// 飆股篩選 (Screener)
// 條件：
//   1. 20 個交易日內單日漲幅 >= 9%
//   2. MA20[今日] / MA20[5日前] - 1 > 1% (近5日 MA20 成長)
//   3. 近 10 個交易日累計漲幅 > 20%
// 輸出: public/screen.html

const fs = require('fs');
const path = require('path');
const https = require('https');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// 設定
const LOOKBACK_TRADING_DAYS = 25;   // 需要 25 個交易日 (MA20[t-5] + 20 = 25)
const MA_PERIOD = 20;
const MA_GROWTH_LOOKBACK = 5;
const TEN_DAY_LOOKBACK = 10;
const CRIT_DAILY_GAIN_PCT = 9.0;
const CRIT_MA_GROWTH_PCT = 1.0;
const CRIT_10D_GAIN_PCT = 20.0;
// 流動性門檻 (任一不足即剔除)
const CRIT_MIN_5D_VOL_LOTS = 1000;          // 5日均量 (張) 至少 1000
const CRIT_MIN_5D_TURNOVER_NTD = 1_000_000_000;   // 5日均成交額 (元) 至少 10億
// 持久狀態 (符合首日起持續列出 N 個交易日)
const STICKY_TRADING_DAYS = 12;
const STATE_FILE = path.join(__dirname, 'data', 'screener_state.json');

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// ===== Time / utils =====
function taipeiNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function ymd(d) { return d.getUTCFullYear() + '/' + String(d.getUTCMonth()+1).padStart(2,'0') + '/' + String(d.getUTCDate()).padStart(2,'0'); }
function ymdCompact(d) { return d.getUTCFullYear() + String(d.getUTCMonth()+1).padStart(2,'0') + String(d.getUTCDate()).padStart(2,'0'); }
function isWeekend(d) { const day = d.getUTCDay(); return day === 0 || day === 6; }
function num(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || t === '--' || t === 'X') return null;
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}
function mean(arr) { return arr.reduce((a,x)=>a+x,0) / arr.length; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 簡單最小平方法線性迴歸斜率 (y units / x unit, x=0,1,2,...)
function linearSlope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  const sumX = (n-1)*n/2;
  const sumX2 = (n-1)*n*(2*n-1)/6;
  let sumY=0, sumXY=0;
  for (let i=0; i<n; i++) { sumY+=ys[i]; sumXY+=i*ys[i]; }
  const denom = n*sumX2 - sumX*sumX;
  return denom===0 ? 0 : (n*sumXY - sumX*sumY)/denom;
}

function isoDate(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0'); }

// ===== HTTP =====
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

async function fetchJson(url, referer, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await httpsGet(url, referer);
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      if (res.body.trim().startsWith('<')) throw new Error('HTML response');
      return JSON.parse(res.body);
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(15_000);
    }
  }
}

// ===== Industry mapping =====
const INDUSTRY = {
  '01':'水泥工業','02':'食品工業','03':'塑膠工業','04':'紡織纖維','05':'電機機械','06':'電器電纜',
  '08':'玻璃陶瓷','09':'造紙工業','10':'鋼鐵工業','11':'橡膠工業','12':'汽車工業','13':'電子工業',
  '14':'建材營造','15':'航運業','16':'觀光餐旅','17':'金融保險','18':'貿易百貨','19':'綜合',
  '20':'其他','21':'化學工業','22':'生技醫療','23':'油電燃氣','24':'半導體業','25':'電腦及週邊設備',
  '26':'光電業','27':'通信網路業','28':'電子零組件','29':'電子通路','30':'資訊服務業','31':'其他電子業',
  '32':'文化創意','33':'農業科技','35':'綠能環保','36':'數位雲端','37':'運動休閒','38':'居家生活',
  '91':'存託憑證(DR)',
};

function loadCompanies() {
  const map = new Map();
  try {
    const twse = JSON.parse(fs.readFileSync(path.join(__dirname, 'twse_companies.json'), 'utf8'));
    for (const c of twse) {
      const indCode = c['產業別'];
      map.set(c['公司代號'], { name: c['公司簡稱'], indCode, indName: INDUSTRY[indCode] || '(代碼'+indCode+')' });
    }
  } catch (e) {}
  try {
    const tpex = JSON.parse(fs.readFileSync(path.join(__dirname, 'tpex_companies.json'), 'utf8'));
    for (const c of tpex) {
      const indCode = c.SecuritiesIndustryCode;
      map.set(c.SecuritiesCompanyCode, { name: c.CompanyAbbreviation, indCode, indName: INDUSTRY[indCode] || '(代碼'+indCode+')' });
    }
  } catch (e) {}
  return map;
}

// ===== Daily quote fetchers (filtered to 普通股) =====
async function fetchTwseDay(date) {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymdCompact(date)}&type=ALLBUT0999&response=json`;
  let data;
  try { data = await fetchJson(url, 'https://www.twse.com.tw/', `TWSE ${ymd(date)}`); }
  catch (e) { return []; }
  const table = (data.tables || []).find(t => /每日收盤行情/.test(t.title || ''));
  if (!table) return [];
  const fields = table.fields;
  const idxCode = fields.indexOf('證券代號');
  const idxName = fields.indexOf('證券名稱');
  const idxClose = fields.indexOf('收盤價');
  const idxChange = fields.indexOf('漲跌價差');
  const idxDir = fields.indexOf('漲跌(+/-)');
  const idxVol = fields.indexOf('成交股數');
  const idxTurn = fields.indexOf('成交金額');
  const out = [];
  for (const r of table.data) {
    const code = r[idxCode];
    if (!/^\d{4}$/.test(code) && !/^911\d{3}$/.test(code)) continue;
    const close = num(r[idxClose]);
    const change = num(r[idxChange]);
    if (close == null || change == null) continue;
    const dirStr = String(r[idxDir] || '');
    const isDown = /color:\s*green|<p.*?-/i.test(dirStr);
    const signedChange = isDown ? -change : change;
    const prevClose = close - signedChange;
    if (prevClose <= 0) continue;
    const volShares = num(r[idxVol]) || 0;
    const turnover = num(r[idxTurn]) || 0;
    out.push({ source: 'TWSE', code, name: (r[idxName]||'').trim(), close, prevClose, volLots: volShares/1000, turnover });
  }
  return out;
}

async function fetchTpexDay(date) {
  const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${ymd(date)}&type=AL&response=json`;
  let data;
  try { data = await fetchJson(url, 'https://www.tpex.org.tw/', `TPEX ${ymd(date)}`); }
  catch (e) { return []; }
  const table = (data.tables || [])[0];
  if (!table || !table.data) return [];
  const fields = table.fields;
  const idxCode = fields.findIndex(f => /代號/.test(f));
  const idxName = fields.findIndex(f => /名稱/.test(f));
  const idxClose = fields.findIndex(f => /收盤/.test(f) && !/前/.test(f));
  const idxChange = fields.findIndex(f => /^漲跌/.test(f.trim()));
  const idxVol = fields.findIndex(f => /成交股數/.test(f));
  const idxTurn = fields.findIndex(f => /成交金額/.test(f));
  if (idxClose < 0 || idxChange < 0) return [];
  const out = [];
  for (const r of table.data) {
    const code = (r[idxCode]||'').trim();
    if (!/^\d{4}$/.test(code)) continue;
    const close = num(r[idxClose]);
    const change = num(r[idxChange]);
    if (close == null || change == null) continue;
    const prevClose = close - change;
    if (prevClose <= 0) continue;
    const volShares = num(r[idxVol]) || 0;
    const turnover = num(r[idxTurn]) || 0;
    out.push({ source: 'TPEX', code, name: (r[idxName]||'').trim(), close, prevClose, volLots: volShares/1000, turnover });
  }
  return out;
}

// ===== Main =====
(async () => {
  console.log('=== Screener build started ===');
  console.log('Settings:');
  console.log('  Lookback:', LOOKBACK_TRADING_DAYS, '交易日');
  console.log('  條件 1: 20日內單日漲幅 >=', CRIT_DAILY_GAIN_PCT, '%');
  console.log('  條件 2: MA20 5日成長 >', CRIT_MA_GROWTH_PCT, '%');
  console.log('  條件 3: 10日累計漲幅 >', CRIT_10D_GAIN_PCT, '%');

  // 抓最近 N 個交易日 (倒推, 跳過週末/假日)
  const days = [];   // 由舊到新
  let cursor = taipeiNow();
  // 若目前時間 < 14:00 台北 (盤前), 從昨天倒推 (今日尚無收盤)
  if (cursor.getUTCHours() < 14) cursor = addDays(cursor, -1);

  let attempts = 0;
  console.log('\nFetching daily quotes...');
  while (days.length < LOOKBACK_TRADING_DAYS && attempts < 50) {
    attempts++;
    if (isWeekend(cursor)) { cursor = addDays(cursor, -1); continue; }
    console.log('  [' + (days.length + 1) + '/' + LOOKBACK_TRADING_DAYS + '] ' + ymd(cursor) + '...');
    // TWSE + TPEX 平行抓 (不同 server)
    const [twse, tpex] = await Promise.all([fetchTwseDay(cursor), fetchTpexDay(cursor)]);
    if (twse.length > 0 || tpex.length > 0) {
      days.unshift({ date: new Date(cursor), twse, tpex });
    } else {
      console.log('     (no data, prob holiday)');
    }
    cursor = addDays(cursor, -1);
    await sleep(4500);   // 節流
  }
  console.log('\nCollected ' + days.length + ' trading days, latest:', ymd(days[days.length-1].date), 'earliest:', ymd(days[0].date));

  // 建構每檔股票的價格序列 (含量價)
  const stocks = {};
  for (const day of days) {
    for (const s of [...day.twse, ...day.tpex]) {
      if (!stocks[s.code]) stocks[s.code] = { source: s.source, name: s.name, closes: [] };
      stocks[s.code].closes.push({ date: day.date, close: s.close, prevClose: s.prevClose, volLots: s.volLots, turnover: s.turnover });
    }
  }
  console.log('Total stocks:', Object.keys(stocks).length);

  // 計算每檔指標 (今日符合 3 + 流動性 條件 → todayMatches)
  const companies = loadCompanies();
  const minNeeded = MA_PERIOD + MA_GROWTH_LOOKBACK;
  const todayDate = days[days.length - 1].date;
  const todayDateISO = isoDate(todayDate);
  const tradingDateISOs = days.map(d => isoDate(d.date));    // 由舊到新

  // computeFeatures: 算出所有可顯示的指標, 不做篩選
  function computeFeatures(code, st) {
    const cs = st.closes;
    if (cs.length < minNeeded || cs.length < TEN_DAY_LOOKBACK + 1) return null;
    const last20 = cs.slice(-MA_PERIOD);
    let maxDailyGain = -Infinity, maxDailyGainDate = null;
    for (const c of last20) {
      const p = (c.close - c.prevClose) / c.prevClose * 100;
      if (p > maxDailyGain) { maxDailyGain = p; maxDailyGainDate = c.date; }
    }
    const closesArr = cs.map(c => c.close);
    const ma20Today = mean(closesArr.slice(-MA_PERIOD));
    const ma20_5dAgo = mean(closesArr.slice(-(MA_PERIOD + MA_GROWTH_LOOKBACK), -MA_GROWTH_LOOKBACK));
    const maGrowth = (ma20Today / ma20_5dAgo - 1) * 100;
    // MA20 6 個值 (從 t-5 到 t) 做線性迴歸算斜率 (NT$/day)
    const recentMA = [];
    for (let i = MA_GROWTH_LOOKBACK; i >= 0; i--) {
      const slice = closesArr.slice(-(MA_PERIOD + i), closesArr.length - i || undefined);
      recentMA.push(mean(slice));
    }
    const ma20Slope = linearSlope(recentMA);

    const today = cs[cs.length - 1];
    const tenAgo = cs[cs.length - 1 - TEN_DAY_LOOKBACK];
    const tenDayGain = (today.close - tenAgo.close) / tenAgo.close * 100;

    // 5 日均量 / 均成交額
    const last5 = cs.slice(-5);
    const avg5dVolLots = mean(last5.map(c => c.volLots || 0));
    const avg5dTurnover = mean(last5.map(c => c.turnover || 0));

    return {
      maxDailyGain, maxDailyGainDate, maGrowth, ma20Today, ma20Slope,
      tenDayGain, tenAgoClose: tenAgo.close, tenAgoDate: tenAgo.date,
      currentClose: today.close, currentDate: today.date,
      avg5dVolLots, avg5dTurnover,
    };
  }

  function meetsAllConditions(f) {
    return f && f.maxDailyGain >= CRIT_DAILY_GAIN_PCT
            && f.maGrowth > CRIT_MA_GROWTH_PCT
            && f.tenDayGain > CRIT_10D_GAIN_PCT
            && f.avg5dVolLots >= CRIT_MIN_5D_VOL_LOTS
            && f.avg5dTurnover >= CRIT_MIN_5D_TURNOVER_NTD;
  }

  // ===== 持久狀態: 12 個交易日 sticky =====
  let state = { lastUpdate: null, stocks: {} };
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (!state.stocks) state.stocks = {};
    }
  } catch (e) { console.log('  ! state load failed:', e.message); }

  // 今天符合的 set
  const todayMatchSet = new Set();
  const codeFeatures = {};
  for (const [code, st] of Object.entries(stocks)) {
    const f = computeFeatures(code, st);
    if (!f) continue;
    codeFeatures[code] = { source: st.source, name: st.name, features: f };
    if (meetsAllConditions(f)) {
      todayMatchSet.add(code);
      // 加入或更新 state
      if (!state.stocks[code]) state.stocks[code] = { firstMatchDate: todayDateISO };
      // firstMatchDate 保持原值; 重複符合不重置
    }
  }

  // 清理 state 中超過 STICKY 天的; 補上 state 中今日不符但仍在 12 天內的
  const keptState = {};
  const allListed = [];   // 要呈現的清單
  for (const [code, entry] of Object.entries(state.stocks)) {
    const firstIdx = tradingDateISOs.indexOf(entry.firstMatchDate);
    let daysSince;
    if (firstIdx < 0) {
      // firstMatchDate 不在當前 25 天視窗 → 已過期
      daysSince = STICKY_TRADING_DAYS + 1;
    } else {
      daysSince = (tradingDateISOs.length - 1) - firstIdx;   // 0 = 今日符合
    }
    if (daysSince >= STICKY_TRADING_DAYS) continue;   // 超過 12 天剔除
    keptState[code] = entry;

    const cf = codeFeatures[code];
    if (!cf) continue;   // 已沒資料 (下市或視窗外)
    const c = companies.get(code);
    allListed.push({
      source: cf.source, code, name: cf.name || (c?c.name:''),
      industry: c ? c.indName : '(未分類)',
      firstMatchDate: entry.firstMatchDate,
      daysSinceFirstMatch: daysSince,
      stickyRemaining: STICKY_TRADING_DAYS - daysSince,
      matchedToday: todayMatchSet.has(code),
      ...cf.features,
    });
  }
  // 排序: 今日符合的在前, 再依 10 日漲幅 desc
  allListed.sort((a, b) => {
    if (a.matchedToday !== b.matchedToday) return a.matchedToday ? -1 : 1;
    return b.tenDayGain - a.tenDayGain;
  });

  // 寫回 state
  state.lastUpdate = new Date().toISOString();
  state.stocks = keptState;
  const dataDir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  console.log('\nState saved to', STATE_FILE, '|', Object.keys(keptState).length, 'stocks tracked');

  const results = allListed;   // 給後續 render
  const matchedTodayCount = results.filter(r => r.matchedToday).length;
  const stickyCount = results.length - matchedTodayCount;
  console.log('Matched today:', matchedTodayCount, '| In 12-day grace:', stickyCount, '| Total listed:', results.length);

  // ===== Render HTML =====
  const taipei = taipeiNow();
  const stamp = taipei.toISOString().slice(0, 16).replace('T', ' ');
  const latestDate = days.length ? ymd(days[days.length-1].date) : '-';

  // 產業統計
  const indGroups = {};
  for (const r of results) {
    if (!indGroups[r.industry]) indGroups[r.industry] = 0;
    indGroups[r.industry]++;
  }
  const indSorted = Object.entries(indGroups).sort((a,b) => b[1]-a[1]);
  const topInd = indSorted[0];
  // (legacy var, not used after refactor)

  const html = `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<meta http-equiv="Cache-Control" content="no-cache">
<title>飆股篩選 ${latestDate} | 飆神</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px 16px; font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", "Microsoft JhengHei", sans-serif; background: #0e1117; color: #e6edf3; font-size: 16px; }
  .topnav { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .navlink { padding: 6px 14px; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; text-decoration: none; font-size: 14px; background: #161b22; }
  .navlink:hover { border-color: #58a6ff; color: #58a6ff; }
  .navlink.active { background: #f85149; border-color: #f85149; color: white; }
  h1 { margin: 0 0 4px; font-size: 22px; color: #58a6ff; }
  .meta { color: #8b949e; font-size: 14px; margin-bottom: 12px; }
  .criteria { background: #161b22; border-left: 4px solid #f0883e; border-radius: 6px; padding: 12px 16px; margin-bottom: 14px; font-size: 14px; line-height: 1.7; }
  .criteria b { color: #f0883e; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 16px; font-size: 14px; }
  .stat .v { font-size: 22px; font-weight: 700; margin-left: 6px; color: #f85149; }
  .insight { background: linear-gradient(135deg, rgba(248,81,73,0.12), rgba(240,136,62,0.08)); border-left: 4px solid #f85149; border-radius: 8px; padding: 14px 18px; margin-bottom: 18px; font-size: 16px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; background: #0d1117; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #21262d; font-size: 14px; vertical-align: top; white-space: nowrap; }
  th { background: #161b22; font-size: 14px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.up { color: #f85149; font-weight: 600; }
  .src-twse { background: #1f6feb33; color: #79c0ff; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .src-tpex { background: #a371f733; color: #d2a8ff; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .ind { font-size: 12px; color: #ffa657; }
  .empty { background: #161b22; border: 1px dashed #30363d; border-radius: 8px; padding: 30px; text-align: center; color: #8b949e; }
  .footer { color: #8b949e; font-size: 12px; margin-top: 24px; padding-top: 14px; border-top: 1px solid #21262d; }
</style>
</head>
<body>

<nav class="topnav">
  <a href="/" class="navlink">← 主頁</a>
  <a href="/stocks.html" class="navlink">📈 飆股(處置中)</a>
  <a href="/analysis.html" class="navlink">🔍 盤後分析</a>
  <a href="/screen.html" class="navlink active">🎯 飆股篩選</a>
</nav>

<h1>🎯 飆股篩選 <span style="font-size:14px;color:#8b949e;font-weight:400">3 條件全符合</span></h1>
<div class="meta">產生時間: ${stamp} (台北) · 資料截至: ${latestDate} · 涵蓋 ${Object.keys(stocks).length} 檔 TWSE+TPEX 普通股</div>

<div class="criteria">
  <b>篩選條件 (全部符合才入榜，入榜後持續列出 ${STICKY_TRADING_DAYS} 個交易日)</b><br>
  ① 近 ${MA_PERIOD} 個交易日內，<b>單日漲幅 ≥ ${CRIT_DAILY_GAIN_PCT}%</b><br>
  ② <b>MA${MA_PERIOD}[今日] / MA${MA_PERIOD}[${MA_GROWTH_LOOKBACK}日前] − 1 > ${CRIT_MA_GROWTH_PCT}%</b><br>
  ③ 近 ${TEN_DAY_LOOKBACK} 個交易日累計漲幅 <b>> ${CRIT_10D_GAIN_PCT}%</b><br>
  ④ <b>5 日均量 ≥ ${CRIT_MIN_5D_VOL_LOTS} 張 且 5 日均成交額 ≥ ${(CRIT_MIN_5D_TURNOVER_NTD/1e8).toFixed(0)}億元</b> (流動性過濾)
</div>

<div class="stats">
  <div class="stat">追蹤中 <span class="v">${results.length}</span> 檔</div>
  <div class="stat">今日符合 <span class="v">${matchedTodayCount}</span></div>
  <div class="stat">${STICKY_TRADING_DAYS}日寬限 <span class="v">${stickyCount}</span></div>
  <div class="stat">TWSE <span class="v">${results.filter(r=>r.source==='TWSE').length}</span></div>
  <div class="stat">TPEX <span class="v">${results.filter(r=>r.source==='TPEX').length}</span></div>
</div>

${results.length === 0 ? `
<div class="empty">📭 今日無股票同時符合 3 個條件</div>
` : `
${topInd ? `<div class="insight">💡 主要集中在 <b style="color:#f85149">${topInd[0]}</b>（${topInd[1]} 檔）</div>` : ''}

<table>
<thead>
<tr>
  <th>狀態</th>
  <th>來源</th>
  <th>代號</th>
  <th>名稱 / 產業</th>
  <th class="num">最新收盤</th>
  <th class="num">10日漲幅</th>
  <th class="num">MA20斜率<br>(元/日)</th>
  <th class="num">MA20成長<br>(5日%)</th>
  <th class="num">20日最大<br>單日漲</th>
  <th class="num">5日均量<br>(張)</th>
  <th class="num">5日均成交額<br>(億元)</th>
  <th class="num">入榜<br>剩餘日</th>
</tr>
</thead>
<tbody>
${results.map(r => {
  const dailyGainDate = r.maxDailyGainDate ? ymd(r.maxDailyGainDate).slice(5) : '';
  const slopeStr = (r.ma20Slope >= 0 ? '+' : '') + r.ma20Slope.toFixed(2);
  const slopeCls = r.ma20Slope > 0 ? 'up' : 'dn';
  const volStr = r.avg5dVolLots >= 10000 ? (r.avg5dVolLots/1000).toFixed(1) + 'K' : Math.round(r.avg5dVolLots).toLocaleString();
  const turnoverStr = (r.avg5dTurnover / 1e8).toFixed(2);
  const status = r.matchedToday
    ? '<span style="color:#f85149;font-weight:700">● 今日符合</span>'
    : '<span style="color:#8b949e">○ 寬限中</span>';
  return '<tr style="' + (r.matchedToday ? '' : 'opacity:0.75') + '">' +
    '<td>' + status + '</td>' +
    '<td><span class="src-' + r.source.toLowerCase() + '">' + r.source + '</span></td>' +
    '<td><b>' + r.code + '</b></td>' +
    '<td>' + r.name + '<br><span class="ind">' + r.industry + '</span></td>' +
    '<td class="num">' + r.currentClose.toFixed(2) + '</td>' +
    '<td class="num up">+' + r.tenDayGain.toFixed(2) + '%</td>' +
    '<td class="num ' + slopeCls + '">' + slopeStr + '</td>' +
    '<td class="num up">+' + r.maGrowth.toFixed(2) + '%</td>' +
    '<td class="num up">+' + r.maxDailyGain.toFixed(2) + '%<br><span class="ind">' + dailyGainDate + '</span></td>' +
    '<td class="num">' + volStr + '</td>' +
    '<td class="num">' + turnoverStr + '</td>' +
    '<td class="num">' + r.stickyRemaining + '/' + STICKY_TRADING_DAYS + '<br><span class="ind">起 ' + (r.firstMatchDate||'').slice(5) + '</span></td>' +
  '</tr>';
}).join('\n')}
</tbody>
</table>
`}

<div class="footer">
  資料來源: TWSE MI_INDEX + TPEX dailyQuotes 各日全市場收盤行情<br>
  條件計算: ① 20 日內最大單日漲幅 ② MA${MA_PERIOD} 5 日成長率 ③ ${TEN_DAY_LOOKBACK} 日累計報酬<br>
  排除權證、ETF、可轉債、興櫃，僅含 TWSE 上市 + TPEX 上櫃普通股<br>
  本資料僅供研究參考，不構成投資建議
</div>

</body>
</html>
`;

  fs.writeFileSync(path.join(PUBLIC_DIR, 'screen.html'), html, 'utf8');
  console.log('Wrote', path.join(PUBLIC_DIR, 'screen.html'), '(' + (fs.statSync(path.join(PUBLIC_DIR, 'screen.html')).size / 1024).toFixed(1) + ' KB)');
  console.log('Top 10 matches:');
  results.slice(0, 10).forEach(r => console.log('  ' + r.code + ' ' + r.name + ' (' + r.industry + ') 10D+' + r.tenDayGain.toFixed(1) + '% MA+' + r.maGrowth.toFixed(2) + '%'));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
