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
<title>台股看板 - 仍在處置期間 (${data.length} 檔)</title>
<meta name="description" content="台股上市/上櫃處置股票即時清單，含進處置前收盤、目前收盤、漲跌幅、20日均價、乖離率、細產業分類">
<meta property="og:title" content="台股看板">
<meta property="og:description" content="${data.length} 檔仍在處置期間 — ${gainers} 漲 ${losers} 跌">
<meta property="og:type" content="website">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
    background: #0e1117; color: #e6edf3; font-size: 14px;
  }
  h1 { margin: 0 0 4px; font-size: 18px; color: #58a6ff; }
  .meta { color: #8b949e; font-size: 12px; margin-bottom: 8px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; font-size: 12px; }
  .stat .v { font-size: 16px; font-weight: 600; margin-left: 6px; }
  .stat.up .v { color: #f85149; }   /* 台股慣例：紅漲 */
  .stat.dn .v { color: #3fb950; }   /* 台股慣例：綠跌 */
  .toolbar { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
  .toolbar input, .toolbar select {
    background: #161b22; border: 1px solid #30363d; color: #e6edf3;
    padding: 6px 10px; border-radius: 6px; font-size: 13px;
  }
  .toolbar input { width: 200px; }
  table { width: 100%; border-collapse: collapse; background: #0d1117; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #21262d; white-space: nowrap; font-size: 13px; }
  th { background: #161b22; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 1; }
  th:hover { background: #1f2733; }
  th.sorted-asc::after { content: " ▲"; color: #58a6ff; }
  th.sorted-desc::after { content: " ▼"; color: #58a6ff; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.up { color: #f85149; font-weight: 600; }   /* 台股慣例：紅漲 */
  td.dn { color: #3fb950; font-weight: 600; }   /* 台股慣例：綠跌 */
  td.flat { color: #8b949e; }
  tr:hover td { background: #161b22; }
  .src-twse { background: #1f6feb33; color: #79c0ff; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
  .src-tpex { background: #a371f733; color: #d2a8ff; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
  .ind { font-size: 11px; color: #c9d1d9; }
  .subind { font-size: 11px; color: #ffa657; }
  .period { font-size: 11px; color: #8b949e; }
  .footer { color: #8b949e; font-size: 11px; margin-top: 16px; padding-top: 12px; border-top: 1px solid #21262d; }
  .note { background: #1f6feb22; border: 1px solid #1f6feb44; border-radius: 6px; padding: 8px 12px; font-size: 12px; margin-bottom: 12px; color: #c9d1d9; }
  @media (max-width: 768px) {
    body { padding: 8px; font-size: 12px; }
    h1 { font-size: 16px; }
    .toolbar input { width: 100%; }
    th, td { padding: 4px 6px; font-size: 11px; }
  }
</style>
</head>
<body>

<h1>📊 台股看板</h1>
<div class="meta">最後產生時間: ${stamp} (台北時間) · 資料截至 ${data[0] ? data[0]['最新日期'] : ''} 收盤 · 共 ${data.length} 檔仍在處置期間</div>

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
    ${[...new Set(data.map(d => {
      const m = (d['處置措施']||'').match(/(\d+)分/);
      return m ? m[1] + '分' : null;
    }).filter(Boolean))].sort((a,b) => parseInt(a) - parseInt(b)).map(i => `<option value="${i}">${i} 撮合</option>`).join('')}
  </select>
  <select id="indFilter">
    <option value="">全部細產業</option>
    ${[...new Set(data.map(d => d['細產業']))].sort().map(i => `<option value="${i}">${i}</option>`).join('')}
  </select>
</div>

<div style="overflow-x: auto;">
<table id="tbl">
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
  <th data-key="漲跌幅" class="num">漲跌幅</th>
  <th data-key="20日均價" class="num">20日均價</th>
  <th data-key="20MA乖離率" class="num">20MA乖離率</th>
</tr>
</thead>
<tbody id="tbody"></tbody>
</table>
</div>

<div class="footer">
  資料來源: 臺灣證券交易所 (TWSE)、證券櫃檯買賣中心 (TPEX) 公開資料 · 細產業/次產業為自製整理
  <br>本資料僅供研究參考，不構成投資建議。處置股具有較高風險與限制交易機制，請審慎評估。
</div>

<script>
const DATA = ${JSON.stringify(data)};
const tbody = document.getElementById('tbody');
const search = document.getElementById('search');
const measureF = document.getElementById('measureFilter');
const indF = document.getElementById('indFilter');

let sortKey = '漲跌幅';
let sortDesc = true;

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

function render() {
  const q = search.value.trim().toLowerCase();
  const mv = measureF.value;
  const iv = indF.value;
  let filtered = DATA.filter(d => {
    if (mv) {
      const mm = (d['處置措施']||'').match(/(\d+)分/);
      if (!mm || (mm[1] + '分') !== mv) return false;
    }
    if (iv && d['細產業'] !== iv) return false;
    if (q && !(d['代號'].toLowerCase().includes(q) || d['名稱'].toLowerCase().includes(q) || (d['細產業']||'').toLowerCase().includes(q) || (d['次產業']||'').toLowerCase().includes(q))) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    const na = parseNum(va), nb = parseNum(vb);
    let cmp;
    if (na !== null && nb !== null) cmp = na - nb;
    else cmp = String(va||'').localeCompare(String(vb||''));
    return sortDesc ? -cmp : cmp;
  });

  // 更新標頭排序指示
  document.querySelectorAll('th').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === sortKey) th.classList.add(sortDesc ? 'sorted-desc' : 'sorted-asc');
  });

  tbody.innerHTML = filtered.map(d => {
    const srcClass = d['來源'] === 'TWSE' ? 'src-twse' : 'src-tpex';
    return '<tr>' +
      '<td><span class="' + srcClass + '">' + d['來源'] + '</span></td>' +
      '<td><b>' + d['代號'] + '</b></td>' +
      '<td>' + d['名稱'] + '<br><span class="period">' + (d['處置條件']||'') + '</span></td>' +
      '<td class="ind">' + (d['細產業']||'') + '</td>' +
      '<td class="subind">' + (d['次產業']||'') + '</td>' +
      '<td class="period">' + (d['處置期間']||'') + '</td>' +
      '<td><span class="period">' + (d['處置措施']||'') + '</span></td>' +
      '<td class="num">' + (d['進處置前收盤']||'') + '<br><span class="period">' + (d['前一日日期']||'') + '</span></td>' +
      '<td class="num">' + (d['最新收盤']||'') + '<br><span class="period">' + (d['最新日期']||'') + '</span></td>' +
      fmtPctCell(d['漲跌幅']) +
      '<td class="num">' + (d['20日均價']||'') + '</td>' +
      fmtPctCell(d['20MA乖離率']) +
      '</tr>';
  }).join('');
}

document.querySelectorAll('th').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.key;
    if (sortKey === k) sortDesc = !sortDesc;
    else { sortKey = k; sortDesc = true; }
    render();
  });
});

search.addEventListener('input', render);
measureF.addEventListener('change', render);
indF.addEventListener('change', render);

render();
</script>

</body>
</html>
`;

fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), html, 'utf8');
console.log('Wrote', path.join(PUBLIC_DIR, 'index.html'));
console.log('File size:', (fs.statSync(path.join(PUBLIC_DIR, 'index.html')).size / 1024).toFixed(1) + ' KB');
console.log('Rows:', data.length);
