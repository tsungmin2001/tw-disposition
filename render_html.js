'use strict';
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// 讀資料
const txt = fs.readFileSync(path.join(__dirname, 'tomorrow_active.txt'), 'utf8').replace(/^﻿/, '');
const lines = txt.split('\n').filter(Boolean);
const headers = lines[0].split('\t');
const rows = lines.slice(1).map(l => l.split('\t'));

// 轉成 JSON 結構
const data = rows.map(r => {
  const obj = {};
  headers.forEach((h, i) => obj[h] = r[i]);
  return obj;
});

// 統計
const ok = data.filter(r => r['漲跌幅'] && r['漲跌幅'] !== '');
const gainers = ok.filter(r => parseFloat(r['漲跌幅']) > 0).length;
const losers = ok.filter(r => parseFloat(r['漲跌幅']) < 0).length;
const flat = ok.length - gainers - losers;

const now = new Date();
const taipeiTime = new Date(now.getTime() + 8*3600*1000);
const stamp = taipeiTime.toISOString().replace('T', ' ').slice(0, 16);

const html = `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>飆股 - 仍在處置期間 ${data.length} 檔 | 飆神</title>
<meta name="description" content="台股上市/上櫃處置股票即時清單，含進處置前收盤、目前收盤、漲跌幅、20日均價、乖離率、細產業分類">
<meta property="og:title" content="台股看板">
<meta property="og:description" content="${data.length} 檔仍在處置期間 — ${gainers} 漲 ${losers} 跌">
<meta property="og:type" content="website">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
    background: #0e1117; color: #e6edf3; font-size: 16px;
  }
  h1 { margin: 0 0 4px; font-size: 22px; color: #58a6ff; }
  .topnav { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .navlink { padding: 6px 14px; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; text-decoration: none; font-size: 14px; background: #161b22; }
  .navlink:hover { border-color: #58a6ff; color: #58a6ff; }
  .navlink.active { background: #f85149; border-color: #f85149; color: white; }
  .meta { color: #8b949e; font-size: 14px; margin-bottom: 10px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 14px; font-size: 14px; }
  .stat .v { font-size: 20px; font-weight: 600; margin-left: 6px; }
  .stat.up .v { color: #f85149; }   /* 台股慣例：紅漲 */
  .stat.dn .v { color: #3fb950; }   /* 台股慣例：綠跌 */
  h2 { font-size: 20px; margin: 28px 0 10px; padding-left: 14px; border-left: 4px solid #58a6ff; }
  h2.section-up { border-left-color: #f85149; color: #f85149; }
  h2.section-dn { border-left-color: #3fb950; color: #3fb950; }
  h2 .count { color: #8b949e; font-size: 15px; margin-left: 6px; font-weight: normal; }
  .live { color: #f0883e; font-weight: 600; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
  .toolbar { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
  .toolbar input, .toolbar select {
    background: #161b22; border: 1px solid #30363d; color: #e6edf3;
    padding: 8px 12px; border-radius: 6px; font-size: 15px;
  }
  .toolbar input { width: 240px; }
  table { width: 100%; border-collapse: collapse; background: #0d1117; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #21262d; white-space: nowrap; font-size: 15px; }
  th { background: #161b22; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 1; }
  th:hover { background: #1f2733; }
  th.sorted-asc::after { content: " ▲"; color: #58a6ff; }
  th.sorted-desc::after { content: " ▼"; color: #58a6ff; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.up { color: #f85149; font-weight: 600; }   /* 台股慣例：紅漲 */
  td.dn { color: #3fb950; font-weight: 600; }   /* 台股慣例：綠跌 */
  td.flat { color: #8b949e; }
  tr:hover td { background: #161b22; }
  .src-twse { background: #1f6feb33; color: #79c0ff; padding: 3px 8px; border-radius: 4px; font-size: 13px; }
  .src-tpex { background: #a371f733; color: #d2a8ff; padding: 3px 8px; border-radius: 4px; font-size: 13px; }
  .ind { font-size: 13px; color: #c9d1d9; }
  .subind { font-size: 13px; color: #ffa657; }
  .period { font-size: 13px; color: #8b949e; }
  .footer { color: #8b949e; font-size: 13px; margin-top: 20px; padding-top: 14px; border-top: 1px solid #21262d; }
  .note { background: #1f6feb22; border: 1px solid #1f6feb44; border-radius: 6px; padding: 10px 14px; font-size: 14px; margin-bottom: 14px; color: #c9d1d9; }
  @media (max-width: 768px) {
    body { padding: 8px; font-size: 14px; }
    h1 { font-size: 18px; }
    h2 { font-size: 17px; }
    .toolbar input { width: 100%; }
    th, td { padding: 6px 8px; font-size: 13px; }
    .stat .v { font-size: 17px; }
  }
</style>
</head>
<body>

<nav class="topnav">
  <a href="/" class="navlink">← 主頁</a>
  <a href="/stocks.html" class="navlink active">📈 飆股</a>
  <a href="/analysis.html" class="navlink">🔍 盤後分析</a>
</nav>
<h1>📈 飆股 <span style="font-size:14px;color:#8b949e;font-weight:400">仍在處置期間</span></h1>
<div class="meta">最後產生時間: ${stamp} (台北時間) · 資料截至 ${data[0] ? data[0]['最新日期'] : ''} 收盤 · 共 ${data.length} 檔仍在處置期間</div>
<div id="liveStatus" class="meta">⏳ 連接即時報價...</div>

<div class="stats">
  <div class="stat up">上漲 <span class="v">${gainers}</span></div>
  <div class="stat dn">下跌 <span class="v">${losers}</span></div>
  <div class="stat">持平 <span class="v">${flat}</span></div>
  <div class="stat">TWSE <span class="v">${data.filter(d => d['來源']==='TWSE').length}</span></div>
  <div class="stat">TPEX <span class="v">${data.filter(d => d['來源']==='TPEX').length}</span></div>
</div>

<div class="note">
  「漲跌幅」= 進處置前一日收盤 → 最新交易日收盤；「20MA乖離率」= (最新收盤 - 20日均價) / 20日均價。
  排序：點欄位標題。篩選：用搜尋框輸入代號或名稱。
</div>

<div class="toolbar">
  <input id="search" placeholder="🔍 搜尋代號 / 名稱 / 產業..." />
  <select id="measureFilter">
    <option value="">全部處置措施</option>
    ${[...new Set(data.map(d => d['處置措施']).filter(Boolean))].sort((a, b) => {
      // 排序：先依「第一次/第二次/再次/督導/人工管制」分組，再依分鐘
      const order = (s) => {
        if (/第一次/.test(s)) return 1;
        if (/第二次/.test(s)) return 2;
        if (/再次/.test(s)) return 3;
        if (/督導/.test(s)) return 4;
        if (/人工管制/.test(s)) return 5;
        return 9;
      };
      const minOf = (s) => { const m = s.match(/(\d+)分/); return m ? parseInt(m[1]) : 0; };
      return (order(a) - order(b)) || (minOf(a) - minOf(b));
    }).map(m => `<option value="${m}">${m}</option>`).join('')}
  </select>
  <select id="indFilter">
    <option value="">全部細產業</option>
    ${[...new Set(data.map(d => d['細產業']))].sort().map(i => `<option value="${i}">${i}</option>`).join('')}
  </select>
</div>

<h2 class="section-up">📈 漲幅榜 <span id="upCount" class="count"></span></h2>
<div style="overflow-x: auto;">
<table id="tblUp" class="data-table">
<thead>
<tr>
  <th data-key="來源">來源</th>
  <th data-key="代號">代號</th>
  <th data-key="名稱">名稱</th>
  <th data-key="細產業">細產業</th>
  <th data-key="次產業">次產業</th>
  <th data-key="處置期間">處置期間</th>
  <th data-key="處置措施">處置措施</th>
  <th data-key="進處置前收盤" class="num">進處置前收盤</th>
  <th data-key="最新收盤" class="num">最新收盤</th>
  <th data-key="當日漲跌幅" class="num">當日漲跌幅</th>
  <th data-key="漲跌幅" class="num">漲跌幅</th>
  <th data-key="20日均價" class="num">20日均價</th>
  <th data-key="20MA乖離率" class="num">20MA乖離率</th>
</tr>
</thead>
<tbody id="tbodyUp"></tbody>
</table>
</div>

<h2 class="section-dn">📉 跌幅榜 <span id="dnCount" class="count"></span></h2>
<div style="overflow-x: auto;">
<table id="tblDn" class="data-table">
<thead>
<tr>
  <th data-key="來源">來源</th>
  <th data-key="代號">代號</th>
  <th data-key="名稱">名稱</th>
  <th data-key="細產業">細產業</th>
  <th data-key="次產業">次產業</th>
  <th data-key="處置期間">處置期間</th>
  <th data-key="處置措施">處置措施</th>
  <th data-key="進處置前收盤" class="num">進處置前收盤</th>
  <th data-key="最新收盤" class="num">最新收盤</th>
  <th data-key="當日漲跌幅" class="num">當日漲跌幅</th>
  <th data-key="漲跌幅" class="num">漲跌幅</th>
  <th data-key="20日均價" class="num">20日均價</th>
  <th data-key="20MA乖離率" class="num">20MA乖離率</th>
</tr>
</thead>
<tbody id="tbodyDn"></tbody>
</table>
</div>

<div class="footer">
  資料來源: 臺灣證券交易所 (TWSE)、證券櫃檯買賣中心 (TPEX) 公開資料 · 細產業/次產業為自製整理
  <br>本資料僅供研究參考，不構成投資建議。處置股具有較高風險與限制交易機制，請審慎評估。
</div>

<script>
const DATA = ${JSON.stringify(data)};
const search = document.getElementById('search');
const measureF = document.getElementById('measureFilter');
const indF = document.getElementById('indFilter');

// 兩個表格各自獨立排序狀態
const sortState = {
  up: { key: '漲跌幅', desc: true },   // 漲幅榜預設: 漲跌幅 大→小
  dn: { key: '漲跌幅', desc: false },  // 跌幅榜預設: 漲跌幅 小→大 (最跌的在上)
};

function parseNum(s) {
  if (s == null || s === '') return null;
  const v = parseFloat(String(s).replace(/[+%,]/g, ''));
  return isNaN(v) ? null : v;
}

function fmtPctCell(s) {
  if (!s) return '<td class="num flat">-</td>';
  const v = parseFloat(String(s).replace(/[+%]/g, ''));
  if (isNaN(v)) return '<td class="num flat">-</td>';
  const cls = v > 0 ? 'up' : (v < 0 ? 'dn' : 'flat');
  return '<td class="num ' + cls + '">' + s + '</td>';
}

// 盤中即時報價 (由 /api/quotes 填入)
const QUOTES = {};

function fmtNum(n, dp = 2) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toFixed(dp);
}

function rowHTML(d) {
  const srcClass = d['來源'] === 'TWSE' ? 'src-twse' : 'src-tpex';
  const q = QUOTES[d['代號']];
  // 若盤中有即時報價，覆蓋價格相關欄位
  let curPrice, curDateLabel, dayChangePct, changePct, biasPct;
  if (q && q.price != null) {
    curPrice = fmtNum(q.price);
    curDateLabel = '<span class="live">● 盤中 ' + (q.time||'') + '</span>';
    dayChangePct = (q.dayChange != null) ? (q.dayChange >= 0 ? '+' : '') + q.dayChange.toFixed(2) + '%' : '';
    const preC = parseFloat(d['進處置前收盤']);
    if (preC) {
      const v = (q.price - preC) / preC * 100;
      changePct = (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    } else changePct = d['漲跌幅'] || '';
    const m20 = parseFloat(d['20日均價']);
    if (m20) {
      const v = (q.price - m20) / m20 * 100;
      biasPct = (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    } else biasPct = d['20MA乖離率'] || '';
  } else {
    curPrice = d['最新收盤'] || '';
    curDateLabel = '<span class="period">' + (d['最新日期']||'') + '</span>';
    dayChangePct = d['當日漲跌幅'] || '';
    changePct = d['漲跌幅'] || '';
    biasPct = d['20MA乖離率'] || '';
  }

  return '<tr>' +
    '<td><span class="' + srcClass + '">' + d['來源'] + '</span></td>' +
    '<td><b>' + d['代號'] + '</b></td>' +
    '<td>' + d['名稱'] + '<br><span class="period">' + (d['處置條件']||'') + '</span></td>' +
    '<td class="ind">' + (d['細產業']||'') + '</td>' +
    '<td class="subind">' + (d['次產業']||'') + '</td>' +
    '<td class="period">' + (d['處置期間']||'') + '</td>' +
    '<td><span class="period">' + (d['處置措施']||'') + '</span></td>' +
    '<td class="num">' + (d['進處置前收盤']||'') + '<br><span class="period">' + (d['前一日日期']||'') + '</span></td>' +
    '<td class="num">' + curPrice + '<br>' + curDateLabel + '</td>' +
    fmtPctCell(dayChangePct) +
    fmtPctCell(changePct) +
    '<td class="num">' + (d['20日均價']||'') + '</td>' +
    fmtPctCell(biasPct) +
    '</tr>';
}

function sortAndRender(tableId, tbodyId, data, st) {
  const sorted = [...data].sort((a, b) => {
    const va = a[st.key], vb = b[st.key];
    const na = parseNum(va), nb = parseNum(vb);
    let cmp;
    if (na !== null && nb !== null) cmp = na - nb;
    else cmp = String(va||'').localeCompare(String(vb||''));
    return st.desc ? -cmp : cmp;
  });
  document.getElementById(tbodyId).innerHTML = sorted.map(rowHTML).join('');
  // 更新該表的排序指示
  document.querySelectorAll('#' + tableId + ' th').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === st.key) th.classList.add(st.desc ? 'sorted-desc' : 'sorted-asc');
  });
}

function render() {
  const q = search.value.trim().toLowerCase();
  const mv = measureF.value;
  const iv = indF.value;
  const filtered = DATA.filter(d => {
    if (mv && d['處置措施'] !== mv) return false;
    if (iv && d['細產業'] !== iv) return false;
    if (q && !(d['代號'].toLowerCase().includes(q) || d['名稱'].toLowerCase().includes(q) || (d['細產業']||'').toLowerCase().includes(q) || (d['次產業']||'').toLowerCase().includes(q))) return false;
    return true;
  });

  // 拆成漲幅 / 跌幅 (0% 歸到漲幅末端，多半是今日新公告 pre=current 同價)
  const ups = filtered.filter(d => (parseNum(d['漲跌幅']) || 0) >= 0);
  const dns = filtered.filter(d => (parseNum(d['漲跌幅']) || 0) < 0);

  document.getElementById('upCount').textContent = '(' + ups.length + ')';
  document.getElementById('dnCount').textContent = '(' + dns.length + ')';

  sortAndRender('tblUp', 'tbodyUp', ups, sortState.up);
  sortAndRender('tblDn', 'tbodyDn', dns, sortState.dn);
}

function attachSortHandlers(tableId, stateKey) {
  document.querySelectorAll('#' + tableId + ' th').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.key;
      const st = sortState[stateKey];
      if (st.key === k) st.desc = !st.desc;
      else { st.key = k; st.desc = (stateKey === 'up'); }
      render();
    });
  });
}

attachSortHandlers('tblUp', 'up');
attachSortHandlers('tblDn', 'dn');

search.addEventListener('input', render);
measureF.addEventListener('change', render);
indF.addEventListener('change', render);

// ===== 盤中即時報價 (每 60 秒) =====
function isMarketHoursClient() {
  // 同 backend: 週一至五 9:00-20:59
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 9 * 60 && mins < 21 * 60;
}

async function fetchQuotes() {
  try {
    const res = await fetch('/api/quotes?_=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (d.quotes) {
      Object.keys(d.quotes).forEach(k => { QUOTES[k] = d.quotes[k]; });
    }
    const el = document.getElementById('liveStatus');
    if (el) {
      if (d.inMarket && d.updated) {
        const t = new Date(d.updated);
        el.innerHTML = '<span class="live">● 盤中即時</span> 最後更新 ' + t.toLocaleTimeString('zh-TW', { hour12: false }) + ' · ' + d.count + ' 檔';
      } else {
        el.innerHTML = '<span class="period">○ 非盤中時段 (顯示昨日收盤)</span>';
      }
    }
    render();
  } catch (e) {
    console.error('fetchQuotes failed:', e);
    const el = document.getElementById('liveStatus');
    if (el) el.innerHTML = '<span class="period">⚠ 即時報價暫無法取得 (' + e.message + ')</span>';
  }
}

render();
fetchQuotes();          // 首次載入立刻抓一次
setInterval(fetchQuotes, 5 * 60 * 1000);  // 之後每 5 分鐘 (對應撮合間隔)
</script>

</body>
</html>
`;

fs.writeFileSync(path.join(PUBLIC_DIR, 'stocks.html'), html, 'utf8');
console.log('Wrote', path.join(PUBLIC_DIR, 'stocks.html'));
console.log('File size:', (fs.statSync(path.join(PUBLIC_DIR, 'index.html')).size / 1024).toFixed(1) + ' KB');
console.log('Rows:', data.length);

// 另外輸出 data/active.json 供盤中 Function 使用
const DATA_DIR = path.join(PUBLIC_DIR, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const activeJson = {
  generated: new Date().toISOString(),
  stocks: data.map(r => ({
    source: r['來源'],
    code: r['代號'],
    name: r['名稱'],
    preClose: parseFloat(r['進處置前收盤']) || null,
    ma20: parseFloat(r['20日均價']) || null,
  })),
};
fs.writeFileSync(path.join(DATA_DIR, 'active.json'), JSON.stringify(activeJson));
console.log('Wrote data/active.json (' + activeJson.stocks.length + ' stocks)');
