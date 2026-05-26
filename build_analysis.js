'use strict';
// 盤後分析: 抓 TWSE/TPEX 當日所有股票收盤行情，篩 +9.5% 以上 (漲停股) 後依細產業統計
// 輸出: public/analysis.html

const fs = require('fs');
const path = require('path');
const https = require('https');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const LIMIT_UP_THRESHOLD = 9.5;   // 漲停: 漲跌幅 >= 9.5%

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// ===== Time =====
function taipeiNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function ymdCompact(d) { return d.getUTCFullYear() + String(d.getUTCMonth()+1).padStart(2,'0') + String(d.getUTCDate()).padStart(2,'0'); }
function ymd(d) { return d.getUTCFullYear() + '/' + String(d.getUTCMonth()+1).padStart(2,'0') + '/' + String(d.getUTCDate()).padStart(2,'0'); }

function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
let TODAY = taipeiNow();
// 允許 env 覆蓋
if (process.env.ANALYSIS_DATE) {
  // 格式: YYYY-MM-DD or YYYYMMDD
  const m = process.env.ANALYSIS_DATE.replace(/[-\/]/g, '');
  TODAY = new Date(Date.UTC(parseInt(m.slice(0,4)), parseInt(m.slice(4,6))-1, parseInt(m.slice(6,8))));
}

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
      await sleep(10_000);
    }
  }
}

function num(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || t === '--' || t === 'X') return null;
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

// ===== Industry mapping (從 t187ap03 公司基本資料) =====
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
  const map = new Map();    // code -> { name, indCode, indName }
  try {
    const twse = JSON.parse(fs.readFileSync(path.join(__dirname, 'twse_companies.json'), 'utf8'));
    for (const c of twse) {
      const indCode = c['產業別'];
      map.set(c['公司代號'], { name: c['公司簡稱'], indCode, indName: INDUSTRY[indCode] || '(代碼'+indCode+')' });
    }
  } catch (e) { console.log('! twse_companies.json load failed:', e.message); }
  try {
    const tpex = JSON.parse(fs.readFileSync(path.join(__dirname, 'tpex_companies.json'), 'utf8'));
    for (const c of tpex) {
      const indCode = c.SecuritiesIndustryCode;
      map.set(c.SecuritiesCompanyCode, { name: c.CompanyAbbreviation, indCode, indName: INDUSTRY[indCode] || '(代碼'+indCode+')' });
    }
  } catch (e) { console.log('! tpex_companies.json load failed:', e.message); }
  return map;
}

// ===== TWSE 全市場日成交 (MI_INDEX 表 [8]) =====
async function fetchTwseDaily() {
  const dateCompact = ymdCompact(TODAY);
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${dateCompact}&type=ALLBUT0999&response=json`;
  console.log(`Fetching TWSE MI_INDEX ${dateCompact}...`);
  const data = await fetchJson(url, 'https://www.twse.com.tw/', 'TWSE MI_INDEX');
  // table[8] = 每日收盤行情(全部)
  const table = (data.tables || []).find(t => /每日收盤行情/.test(t.title || ''));
  if (!table) { console.log('  ! no daily quotes table found'); return []; }
  const fields = table.fields;
  const idxCode = fields.indexOf('證券代號');
  const idxName = fields.indexOf('證券名稱');
  const idxClose = fields.indexOf('收盤價');
  const idxChange = fields.indexOf('漲跌價差');
  const idxDir = fields.indexOf('漲跌(+/-)');     // 漲跌符號 (HTML img tag, 含 + 或 -)
  console.log(`  TWSE rows: ${table.data.length}`);
  const out = [];
  for (const r of table.data) {
    const code = r[idxCode];
    const close = num(r[idxClose]);
    const change = num(r[idxChange]);
    if (close == null || change == null) continue;
    // 漲跌方向: 從 dir 圖檔判斷 (HTML中含 <p style='color:red'>+</p> 或 <p style='color:green'>-</p>)
    const dirStr = String(r[idxDir] || '');
    const isDown = /color:\s*green|<p.*?-/i.test(dirStr);
    const signedChange = isDown ? -change : change;
    const prevClose = close - signedChange;
    if (prevClose <= 0) continue;
    const pct = signedChange / prevClose * 100;
    out.push({ source: 'TWSE', code, name: r[idxName].trim(), close, prevClose, pct });
  }
  return out;
}

// ===== TPEX 全市場日成交 =====
async function fetchTpexDaily() {
  const dateStr = ymd(TODAY);
  const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${dateStr}&type=AL&response=json`;
  console.log(`Fetching TPEX dailyQuotes ${dateStr}...`);
  const data = await fetchJson(url, 'https://www.tpex.org.tw/', 'TPEX dailyQuotes');
  const table = (data.tables || [])[0];
  if (!table || !table.data) { console.log('  ! TPEX no data'); return []; }
  const fields = table.fields;
  // 預期 fields: 代號, 名稱, 收盤, 漲跌, ... 但欄位順序可能不同; 用 includes 比對
  const idxCode = fields.findIndex(f => /代號/.test(f));
  const idxName = fields.findIndex(f => /名稱/.test(f));
  const idxClose = fields.findIndex(f => /收盤/.test(f) && !/前/.test(f));
  const idxChange = fields.findIndex(f => /^漲跌$/.test(f) || /漲跌價/.test(f));
  console.log(`  TPEX rows: ${table.data.length}, fields: code=${idxCode} close=${idxClose} change=${idxChange}`);
  if (idxClose < 0 || idxChange < 0) {
    console.log('  ! TPEX fields not recognized:', fields);
    return [];
  }
  const out = [];
  for (const r of table.data) {
    const code = r[idxCode];
    const close = num(r[idxClose]);
    const change = num(r[idxChange]);
    if (close == null || change == null) continue;
    const prevClose = close - change;
    if (prevClose <= 0) continue;
    const pct = change / prevClose * 100;
    out.push({ source: 'TPEX', code, name: (r[idxName] || '').trim(), close, prevClose, pct });
  }
  return out;
}

// ===== Main =====
(async () => {
  console.log('=== 盤後分析 build started ===');
  console.log('Today (Taipei):', ymd(TODAY));

  const companies = loadCompanies();
  console.log('Company info loaded:', companies.size);

  // 抓兩個市場 (如本日無資料，回退至最近交易日 - 最多回退 7 天)
  let twse = [], tpex = [];
  let originalDate = TODAY;
  for (let back = 0; back < 7; back++) {
    if (back > 0) {
      TODAY = addDays(originalDate, -back);
      console.log('Trying fallback date:', ymd(TODAY));
    }
    try { twse = await fetchTwseDaily(); } catch (e) { console.log('TWSE fetch failed:', e.message); }
    await sleep(3000);
    try { tpex = await fetchTpexDaily(); } catch (e) { console.log('TPEX fetch failed:', e.message); }
    if (twse.length > 0 || tpex.length > 0) break;
    console.log('No data for ' + ymd(TODAY) + ', try previous day...');
    await sleep(2000);
  }

  console.log('Total stocks today: TWSE=' + twse.length + ', TPEX=' + tpex.length);

  // 篩漲停 (>= 9.5%) 並且只看 4 位數普通股
  const all = [...twse, ...tpex];
  const limitUp = all
    .filter(s => /^\d{4}$/.test(s.code) || /^911\d{3}$/.test(s.code))
    .filter(s => s.pct >= LIMIT_UP_THRESHOLD)
    .sort((a,b) => b.pct - a.pct);

  console.log('漲停 stocks (>=' + LIMIT_UP_THRESHOLD + '%):', limitUp.length);

  // 加產業
  for (const s of limitUp) {
    const c = companies.get(s.code);
    s.indName = c ? c.indName : '(未分類)';
    if (c && (!s.name || s.name === '')) s.name = c.name;
  }

  // 按產業統計
  const groups = {};
  for (const s of limitUp) {
    const ind = s.indName;
    if (!groups[ind]) groups[ind] = { name: ind, count: 0, sumPct: 0, stocks: [] };
    groups[ind].count++;
    groups[ind].sumPct += s.pct;
    groups[ind].stocks.push(s);
  }
  const indArr = Object.values(groups).sort((a,b) => b.count - a.count || (b.sumPct/b.count) - (a.sumPct/a.count));

  // ===== Render HTML =====
  const taipeiTime = ymd(TODAY) + ' ' + String(TODAY.getUTCHours()).padStart(2,'0') + ':' + String(TODAY.getUTCMinutes()).padStart(2,'0');
  const dateLabel = ymd(TODAY).replace(/^\d{4}\//, '');

  const focusInd = indArr[0];
  const focusText = focusInd
    ? `今日漲停集中在 <b style="color:#f85149">${focusInd.name}</b>（${focusInd.count} 檔，平均 +${(focusInd.sumPct/focusInd.count).toFixed(2)}%）`
    : '今日無明顯漲停股';

  const html = `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<meta http-equiv="Cache-Control" content="no-cache">
<title>盤後分析 ${dateLabel} | 飆神</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px 16px; font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", "Microsoft JhengHei", sans-serif; background: #0e1117; color: #e6edf3; font-size: 16px; }
  .topnav { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .navlink { padding: 6px 14px; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; text-decoration: none; font-size: 14px; background: #161b22; }
  .navlink:hover { border-color: #58a6ff; color: #58a6ff; }
  .navlink.active { background: #f85149; border-color: #f85149; color: white; }
  h1 { margin: 0 0 4px; font-size: 22px; color: #58a6ff; }
  .meta { color: #8b949e; font-size: 14px; margin-bottom: 16px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 16px; font-size: 14px; }
  .stat .v { font-size: 22px; font-weight: 700; margin-left: 6px; color: #f85149; }
  .insight { background: linear-gradient(135deg, rgba(248,81,73,0.12), rgba(240,136,62,0.08)); border-left: 4px solid #f85149; border-radius: 8px; padding: 14px 18px; margin-bottom: 18px; font-size: 16px; line-height: 1.6; }
  .insight b { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; background: #0d1117; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { background: #161b22; font-size: 14px; }
  td { font-size: 14px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.up { color: #f85149; font-weight: 600; }
  .stock-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { background: rgba(248,81,73,0.15); border: 1px solid rgba(248,81,73,0.3); border-radius: 4px; padding: 3px 8px; font-size: 12px; color: #ff7b72; white-space: nowrap; }
  .chip b { color: #f85149; margin-right: 4px; }
  .chip .pct { color: #f0883e; font-size: 11px; margin-left: 4px; }
  .src-twse { background: #1f6feb33; color: #79c0ff; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-right: 4px; }
  .src-tpex { background: #a371f733; color: #d2a8ff; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-right: 4px; }
  .empty { background: #161b22; border: 1px dashed #30363d; border-radius: 8px; padding: 30px; text-align: center; color: #8b949e; }
  .footer { color: #8b949e; font-size: 12px; margin-top: 24px; padding-top: 14px; border-top: 1px solid #21262d; }
</style>
</head>
<body>

<nav class="topnav">
  <a href="/" class="navlink">← 主頁</a>
  <a href="/stocks.html" class="navlink">📈 飆股</a>
  <a href="/analysis.html" class="navlink active">🔍 盤後分析</a>
</nav>

<h1>🔍 盤後分析 <span style="font-size:14px;color:#8b949e;font-weight:400">當日漲停產業熱度</span></h1>
<div class="meta">產生時間: ${taipeiTime} (台北) · 漲停定義: 漲跌幅 ≥ ${LIMIT_UP_THRESHOLD}% · 涵蓋 TWSE 上市 + TPEX 上櫃普通股</div>

<div class="stats">
  <div class="stat">漲停總數 <span class="v">${limitUp.length}</span></div>
  <div class="stat">產業數 <span class="v">${indArr.length}</span></div>
  <div class="stat">TWSE <span class="v">${limitUp.filter(s=>s.source==='TWSE').length}</span></div>
  <div class="stat">TPEX <span class="v">${limitUp.filter(s=>s.source==='TPEX').length}</span></div>
</div>

${limitUp.length === 0 ? `
<div class="empty">
  📭 今日無漲停股 (≥ ${LIMIT_UP_THRESHOLD}%)，或非交易日。
</div>
` : `
<div class="insight">
  💡 ${focusText}
</div>

<table>
<thead>
<tr>
  <th>細產業</th>
  <th class="num">漲停檔數</th>
  <th class="num">平均漲跌幅</th>
  <th>漲停個股</th>
</tr>
</thead>
<tbody>
${indArr.map(g => {
  const avgPct = (g.sumPct / g.count).toFixed(2);
  return '<tr>' +
    '<td><b>' + g.name + '</b></td>' +
    '<td class="num up">' + g.count + '</td>' +
    '<td class="num up">+' + avgPct + '%</td>' +
    '<td><div class="stock-chips">' +
      g.stocks.map(s => '<span class="chip"><span class="src-' + s.source.toLowerCase() + '">' + s.source + '</span><b>' + s.code + '</b>' + s.name + '<span class="pct">+' + s.pct.toFixed(2) + '%</span></span>').join('') +
    '</div></td>' +
  '</tr>';
}).join('\n')}
</tbody>
</table>
`}

<div class="footer">
  資料來源: TWSE MI_INDEX 每日收盤行情 + TPEX dailyQuotes · 產業分類: TWSE/TPEX OpenAPI 公司基本資料
  <br>漲停定義: 漲跌幅 ≥ ${LIMIT_UP_THRESHOLD}% (含部分接近漲停的股票) · 排除權證、ETF、可轉債
  <br>本資料僅供研究參考，不構成投資建議
</div>

</body>
</html>
`;

  fs.writeFileSync(path.join(PUBLIC_DIR, 'analysis.html'), html, 'utf8');
  console.log('Wrote', path.join(PUBLIC_DIR, 'analysis.html'));
  console.log('Limit-up by industry (Top 5):');
  indArr.slice(0, 5).forEach(g => console.log('  ' + g.name + ': ' + g.count + ' 檔, avg +' + (g.sumPct/g.count).toFixed(2) + '%'));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
