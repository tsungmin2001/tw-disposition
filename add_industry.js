'use strict';
const fs = require('fs');
const path = require('path');

// TWSE / TPEX 產業別代碼對照（依公開資訊觀測站分類）
const INDUSTRY = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維',
  '05': '電機機械', '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙工業',
  '10': '鋼鐵工業', '11': '橡膠工業', '12': '汽車工業', '13': '電子工業',
  '14': '建材營造', '15': '航運業', '16': '觀光餐旅', '17': '金融保險',
  '18': '貿易百貨', '19': '綜合', '20': '其他', '21': '化學工業',
  '22': '生技醫療', '23': '油電燃氣', '24': '半導體業', '25': '電腦及週邊設備',
  '26': '光電業', '27': '通信網路業', '28': '電子零組件', '29': '電子通路',
  '30': '資訊服務業', '31': '其他電子業', '32': '文化創意', '33': '農業科技',
  '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活',
  '91': '存託憑證(DR)',
};

const twse = JSON.parse(fs.readFileSync(path.join(__dirname, 'twse_companies.json'), 'utf8'));
const tpex = JSON.parse(fs.readFileSync(path.join(__dirname, 'tpex_companies.json'), 'utf8'));

const twseMap = new Map();
for (const c of twse) twseMap.set(c['公司代號'], { code: c['產業別'], name: c['公司簡稱'] });
const tpexMap = new Map();
for (const c of tpex) tpexMap.set(c.SecuritiesCompanyCode, { code: c.SecuritiesIndustryCode, name: c.CompanyAbbreviation });

function lookupIndustry(source, code) {
  const map = source === 'TWSE' ? twseMap : tpexMap;
  const rec = map.get(String(code));
  if (!rec) return { code: '', name: '' };
  return { code: rec.code, name: INDUSTRY[rec.code] || ('(代碼' + rec.code + ')') };
}

// Read tomorrow_active.txt, add industry column
const txt = fs.readFileSync(path.join(__dirname, 'tomorrow_active.txt'), 'utf8').replace(/^﻿/, '');
const lines = txt.split('\n').filter(Boolean);
const headers = lines[0].split('\t');
const rows = lines.slice(1).map(l => l.split('\t'));

// Insert 細產業 after 名稱 (column index 2 -> insert at 3)
const NAME_IDX = 2;
const newHeaders = [...headers.slice(0, NAME_IDX+1), '細產業', ...headers.slice(NAME_IDX+1)];

const newRows = rows.map(r => {
  const source = r[0], code = r[1];
  const ind = lookupIndustry(source, code);
  return [...r.slice(0, NAME_IDX+1), ind.name || '(查無)', ...r.slice(NAME_IDX+1)];
});

// Save
fs.writeFileSync(path.join(__dirname, 'tomorrow_active.txt'),
  '﻿' + newHeaders.join('\t') + '\n' + newRows.map(r => r.join('\t')).join('\n') + '\n', 'utf8');

// Print summary
console.log('Industry stats for active 5/26 stocks:');
const stats = {};
newRows.forEach(r => { const ind = r[3]; stats[ind] = (stats[ind]||0)+1; });
Object.entries(stats).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log('  ' + k + ':', v));

// Print sample
console.log('\nSample (first 10 rows):');
newRows.slice(0,10).forEach(r => console.log('  ' + r.slice(0,5).join('\t')));

// Note any stocks without industry data
const missing = newRows.filter(r => r[3] === '(查無)');
if (missing.length) {
  console.log('\nStocks without industry data:');
  missing.forEach(r => console.log('  ' + r[0] + ' ' + r[1] + ' ' + r[2]));
}
