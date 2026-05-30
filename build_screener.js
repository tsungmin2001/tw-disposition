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
    out.push({ source: 'TWSE', code, name: (r[idxName]||'').trim(), close, prevClose });
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
    out.push({ source: 'TPEX', code, name: (r[idxName]||'').trim(), close, prevClose });
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

  // 建構每檔股票的價格序列
  const stocks = {};   // code -> { source, name, closes: [{date, close, prevClose}, ...] }
  for (const day of days) {
    for (const s of [...day.twse, ...day.tpex]) {
      if (!stocks[s.code]) stocks[s.code] = { source: s.source, name: s.name, closes: [] };
      stocks[s.code].closes.push({ date: day.date, close: s.close, prevClose: s.prevClose });
    }
  }
  console.log('Total stocks:', Object.keys(stocks).length);

  // 套用條件
  const companies = loadCompanies();
  const minNeeded = MA_PERIOD + MA_GROWTH_LOOKBACK;
  const results = [];
  for (const [code, st] of Object.entries(stocks)) {
    const cs = st.closes;
    if (cs.length < minNeeded) continue;
    if (cs.length < TEN_DAY_LOOKBACK + 1) continue;

    // 條件 1: 近 20 日內任一日單日漲幅 >= 9%
    const last20 = cs.slice(-MA_PERIOD);
    let maxDailyGain = -Infinity, maxDailyGainDate = null;
    for (const c of last20) {
      const dailyPct = (c.close - c.prevClose) / c.prevClose * 100;
      if (dailyPct > maxDailyGain) { maxDailyGain = dailyPct; maxDailyGainDate = c.date; }
    }
    if (maxDailyGain < CRIT_DAILY_GAIN_PCT) continue;

    // 條件 2: MA20[今日] / MA20[5日前] - 1 > 1%
    const closesArr = cs.map(c => c.close);
    if (closesArr.length < MA_PERIOD + MA_GROWTH_LOOKBACK) continue;
    const ma20Today = mean(closesArr.slice(-MA_PERIOD));
    const ma20_5dAgo = mean(closesArr.slice(-(MA_PERIOD + MA_GROWTH_LOOKBACK), -MA_GROWTH_LOOKBACK));
    const maGrowth = (ma20Today / ma20_5dAgo - 1) * 100;
    if (maGrowth <= CRIT_MA_GROWTH_PCT) continue;

    // 條件 3: 10 日累計漲幅 > 20%
    const today = cs[cs.length - 1];
    const tenAgo = cs[cs.length - 1 - TEN_DAY_LOOKBACK];
    const tenDayGain = (today.close - tenAgo.close) / tenAgo.close * 100;
    if (tenDayGain <= CRIT_10D_GAIN_PCT) continue;

    // 加產業
    const c = companies.get(code);
    results.push({
      source: st.source, code, name: st.name || (c?c.name:''),
      industry: c ? c.indName : '(未分類)',
      currentClose: today.close, currentDate: today.date,
      maxDailyGain, maxDailyGainDate,
      maGrowth, ma20Today,
      tenDayGain, tenAgoClose: tenAgo.close, tenAgoDate: tenAgo.date,
    });
  }
  results.sort((a, b) => b.tenDayGain - a.tenDayGain);
  console.log('\nMatches:', results.length);

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
  <b>篩選條件 (全部符合)</b><br>
  ① 近 ${MA_PERIOD} 個交易日內，<b>單日漲幅 ≥ ${CRIT_DAILY_GAIN_PCT}%</b><br>
  ② <b>MA${MA_PERIOD}[今日] / MA${MA_PERIOD}[${MA_GROWTH_LOOKBACK}日前] − 1 > ${CRIT_MA_GROWTH_PCT}%</b> (短線均線正在上揚)<br>
  ③ 近 ${TEN_DAY_LOOKBACK} 個交易日累計漲幅 <b>> ${CRIT_10D_GAIN_PCT}%</b>
</div>

<div class="stats">
  <div class="stat">符合 <span class="v">${results.length}</span> 檔</div>
  <div class="stat">產業數 <span class="v">${indSorted.length}</span></div>
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
  <th>來源</th>
  <th>代號</th>
  <th>名稱</th>
  <th>產業</th>
  <th class="num">最新收盤</th>
  <th class="num">10日漲幅</th>
  <th class="num">MA20成長</th>
  <th class="num">20日最大單日漲</th>
</tr>
</thead>
<tbody>
${results.map(r => {
  const dailyGainDate = r.maxDailyGainDate ? ymd(r.maxDailyGainDate).slice(5) : '';
  return '<tr>' +
    '<td><span class="src-' + r.source.toLowerCase() + '">' + r.source + '</span></td>' +
    '<td><b>' + r.code + '</b></td>' +
    '<td>' + r.name + '<br><span class="ind">' + r.industry + '</span></td>' +
    '<td></td>' +
    '<td class="num">' + r.currentClose.toFixed(2) + '</td>' +
    '<td class="num up">+' + r.tenDayGain.toFixed(2) + '%</td>' +
    '<td class="num up">+' + r.maGrowth.toFixed(2) + '%</td>' +
    '<td class="num up">+' + r.maxDailyGain.toFixed(2) + '% <span class="ind">(' + dailyGainDate + ')</span></td>' +
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
