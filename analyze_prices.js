'use strict';
const fs = require('fs');
const path = require('path');

const PRICE_DIR = path.join(__dirname, 'prices');
const ACTIVE_TSV = path.join(__dirname, 'active_list.tsv');
const OUT_TXT = path.join(__dirname, 'active_with_prices.txt');
const MONTHS = ['202604', '202605'];

function rocKey(d) {
  const m = String(d).match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return 0;
  return parseInt(m[1].padStart(3,'0') + m[2].padStart(2,'0') + m[3].padStart(2,'0'));
}
function num(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || t === '--' || t === 'X' || t === 'N/A') return null;
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

const lines = fs.readFileSync(ACTIVE_TSV, 'utf8').split('\n').filter(Boolean);
const stocks = lines.slice(1).map(l => l.split('\t')).map(r => ({
  source: r[0], code: r[1], name: r[2], announce: r[3], period: r[4], cond: r[5], measure: r[6]
}));

const equity = stocks.filter(s => {
  const c = String(s.code);
  if (s.source === 'TWSE') return /^\d{4}$/.test(c) || /^911\d{3}$/.test(c);
  if (s.source === 'TPEX') return /^\d{4}$/.test(c);
  return false;
});

function loadStock(source, code) {
  const days = [];
  for (const ym of MONTHS) {
    const fp = path.join(PRICE_DIR, `${source}_${code}_${ym}.json`);
    if (!fs.existsSync(fp)) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    if (d.stat === 'ERROR') continue;
    let rows = [];
    if (source === 'TWSE' && Array.isArray(d.data)) rows = d.data;
    else if (source === 'TPEX' && d.tables && d.tables[0] && Array.isArray(d.tables[0].data)) rows = d.tables[0].data;
    for (const r of rows) {
      const date = r[0];
      const close = num(r[6]);
      if (close == null || close === 0) continue;
      days.push({ date, key: rocKey(date), close });
    }
  }
  // Sort ascending by date
  days.sort((a, b) => a.key - b.key);
  // Dedup same date keep last
  const seen = new Map();
  for (const d of days) seen.set(d.key, d);
  return [...seen.values()].sort((a,b) => a.key - b.key);
}

const results = [];
for (const s of equity) {
  const days = loadStock(s.source, s.code);
  if (days.length === 0) {
    results.push({ ...s, status: 'NO_DATA', preClose: null, curClose: null, changePct: null, ma20: null, preDate: '', curDate: '', ma20From: '', ma20To: '', ma20N: 0 });
    continue;
  }
  // Parse disposition start
  const startStr = s.period.split(/[~～]/)[0].trim();
  const startKey = rocKey(startStr);
  // pre_close = last day BEFORE startKey
  const before = days.filter(d => d.key < startKey);
  const preDay = before.length ? before[before.length - 1] : null;
  // cur_close = latest day
  const curDay = days[days.length - 1];
  // 20-day MA ending at latest day
  const last20 = days.slice(-20);
  const ma20 = last20.length ? last20.reduce((a,d) => a+d.close, 0) / last20.length : null;
  const changePct = (preDay && curDay) ? (curDay.close - preDay.close) / preDay.close * 100 : null;
  results.push({
    ...s,
    status: preDay ? 'OK' : 'NO_PRE',
    preClose: preDay ? preDay.close : null,
    preDate: preDay ? preDay.date : '',
    curClose: curDay.close,
    curDate: curDay.date,
    changePct,
    ma20,
    ma20From: last20[0].date,
    ma20To: last20[last20.length-1].date,
    ma20N: last20.length,
  });
}

// Sort by changePct desc then source/code
results.sort((a, b) => {
  if (a.changePct == null && b.changePct == null) return 0;
  if (a.changePct == null) return 1;
  if (b.changePct == null) return -1;
  return b.changePct - a.changePct;
});

const fmt = n => n == null ? '' : (Math.round(n * 100) / 100).toFixed(2);
const fmtP = n => n == null ? '' : (n >= 0 ? '+' : '') + (Math.round(n * 100) / 100).toFixed(2) + '%';

const headers = ['來源', '代號', '名稱', '處置期間', '處置條件', '處置措施', '進處置前收盤', '前一日日期', '最新收盤', '最新日期', '漲跌幅', '20日均價', '20MA起迄'];
const tsv = [headers.join('\t')];
for (const r of results) {
  tsv.push([
    r.source, r.code, r.name, r.period, r.cond, r.measure,
    fmt(r.preClose), r.preDate, fmt(r.curClose), r.curDate, fmtP(r.changePct), fmt(r.ma20),
    r.ma20N ? `${r.ma20From}~${r.ma20To} (${r.ma20N}日)` : '',
  ].join('\t'));
}
fs.writeFileSync(OUT_TXT, '﻿' + tsv.join('\n') + '\n', 'utf8');

// Pretty print to console
console.log(`Latest market date in data: ${results.length ? results.find(r=>r.curDate)?.curDate : 'N/A'}`);
console.log(`Total equity stocks: ${equity.length}`);
console.log(`Computed OK: ${results.filter(r=>r.status==='OK').length}, no_pre: ${results.filter(r=>r.status==='NO_PRE').length}, no_data: ${results.filter(r=>r.status==='NO_DATA').length}`);
console.log();

// Group display: gainers / losers
const ok = results.filter(r => r.changePct != null);
const gainers = ok.filter(r => r.changePct >= 0);
const losers = ok.filter(r => r.changePct < 0);
console.log(`Gainers since pre-disposition: ${gainers.length}`);
console.log(`Losers since pre-disposition: ${losers.length}`);
if (gainers.length) {
  console.log('Top gainer:', gainers[0].code, gainers[0].name, fmtP(gainers[0].changePct));
}
if (losers.length) {
  console.log('Worst loser:', losers[losers.length-1].code, losers[losers.length-1].name, fmtP(losers[losers.length-1].changePct));
}
console.log(`Saved: ${OUT_TXT}`);
