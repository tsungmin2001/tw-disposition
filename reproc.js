'use strict';
const fs = require('fs');
const path = require('path');

function parseIntervalMinutes(content) {
  if (!content) return '';
  const m1 = content.match(/約每([一二三四五六七八九十百\d]+)分鐘?撮合/);
  if (m1) return chToNum(m1[1]) + '分';
  const m2 = content.match(/每([一二三四五六七八九十百\d]+)分鐘?撮合/);
  if (m2) return chToNum(m2[1]) + '分';
  return '';
}
function chToNum(s) {
  if (/^\d+$/.test(s)) return s;
  const map = { '零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
  if (s.length === 1 && map[s] != null) return String(map[s]);
  if (s === '二十') return '20';
  if (s === '二十五') return '25';
  if (s === '三十') return '30';
  if (s === '十五') return '15';
  if (s.startsWith('十')) return '1' + (s.length === 1 ? '0' : map[s[1]]);
  if (s.length === 2 && s[1] === '十') return map[s[0]] + '0';
  if (s.length === 3 && s[1] === '十') return map[s[0]] + (map[s[2]] || '0');
  return s;
}
function cleanName(name) {
  if (!name) return '';
  return String(name).replace(/\([^)]*\)/g, '').trim();
}
function stripUrlParens(s) {
  if (s == null) return '';
  return String(s).replace(/\((\.{0,2}\/[^)]*|https?:\/\/[^)]*)\)/g, '');
}
function cleanText(s) {
  if (s == null) return '';
  return stripUrlParens(String(s).replace(/[\t\r\n]+/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s{2,}/g, ' ').trim();
}
function inferTpexMeasure(condition, content, cumulative) {
  const c = String(content || '');
  if (/監視業務督導會報/.test(c) || /監視業務督導會報/.test(condition || '')) return '督導會報決議';
  if (/最近30個營業日內曾發布處置|再次處置|又因/.test(c)) return '再次處置';
  const n = parseInt(cumulative, 10);
  if (!isNaN(n) && n >= 2) return '再次處置';
  return '第一次處置';
}
function dateKey(s) {
  const m = String(s || '').match(/^(\d+)\/(\d+)\/(\d+)/);
  if (!m) return '000/00/00';
  return m[1].padStart(3, '0') + '/' + m[2].padStart(2, '0') + '/' + m[3].padStart(2, '0');
}

const RAW = path.join(__dirname, 'raw');
const OUT = path.join(__dirname, 'disposition_stocks.txt');
const all = [];

const twseFiles = fs.readdirSync(RAW).filter(f => /^twse_\d{4}\.json$/.test(f)).sort();
for (const f of twseFiles) {
  const d = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
  const rows = d.data || [];
  for (const r of rows) {
    const action = cleanText(r[7]);
    const interval = parseIntervalMinutes(r[8]);
    all.push({
      source: 'TWSE',
      announce: r[1] || '',
      code: r[2] || '',
      name: cleanName(r[3]),
      cumulative: r[4] != null ? r[4] : '',
      condition: cleanText(r[5]),
      period: cleanText(r[6]),
      measure: [action, interval].filter(Boolean).join(' / '),
    });
  }
}
console.log('TWSE rows loaded:', all.length);

// TPEX: use chunked queries to maximize coverage (legacy tpex_all.json was truncated)
const TPEX_SOURCES = [
  'tpex_chunk_1a_2003Q3-2005.json',
  'tpex_2006_test.json',
  'tpex_2007h1.json',
  'tpex_2007h2.json',
  'tpex_2008_single.json',
  'tpex_chunk_2_2009-2013.json',
  'tpex_chunk_3_2014-2018.json',
  'tpex_chunk_4_2019-2023.json',
  'tpex_chunk_5_2024-2026.json',
];

const tpexSeen = new Set();
let tpexCount = 0;
let tpexDupes = 0;
for (const f of TPEX_SOURCES) {
  const fp = path.join(RAW, f);
  if (!fs.existsSync(fp)) {
    const alt = path.join(__dirname, f);
    if (!fs.existsSync(alt)) { console.warn('  missing:', f); continue; }
    fs.copyFileSync(alt, fp);
  }
  const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const trows = (d.tables && d.tables[0] && d.tables[0].data) || [];
  let added = 0;
  for (const r of trows) {
    if (!r[2] || (r[7] && /本日無處置資料/.test(r[7]))) continue;
    const key = (r[1]||'') + '|' + r[2] + '|' + (r[5]||'') + '|' + (r[6]||'');
    if (tpexSeen.has(key)) { tpexDupes++; continue; }
    tpexSeen.add(key);
    const interval = parseIntervalMinutes(r[7]);
    const action = inferTpexMeasure(r[6], r[7], r[4]);
    all.push({
      source: 'TPEX',
      announce: r[1] || '',
      code: r[2] || '',
      name: cleanName(r[3]),
      cumulative: r[4] != null ? r[4] : '',
      condition: cleanText(r[6]),
      period: cleanText(r[5]),
      measure: [action, interval].filter(Boolean).join(' / '),
    });
    tpexCount++;
    added++;
  }
  console.log('  ' + f + ':', added, 'unique added');
}
console.log('TPEX rows loaded:', tpexCount, '(dedup skipped:', tpexDupes + ')');

all.sort((a, b) => {
  const da = dateKey(a.announce);
  const db = dateKey(b.announce);
  if (da !== db) return db.localeCompare(da);
  return String(a.code).localeCompare(String(b.code));
});

const headers = ['來源', '公布日期', '證券代號', '名稱', '累計', '處置條件', '處置期間', '處置措施'];
const lines = [headers.join('\t')];
for (const r of all) {
  lines.push([r.source, r.announce, r.code, r.name, r.cumulative, r.condition, r.period, r.measure].join('\t'));
}
fs.writeFileSync(OUT, '﻿' + lines.join('\n') + '\n', 'utf8');
console.log('Wrote', all.length, 'rows to', OUT);
