'use strict';
const fs = require('fs');
const path = require('path');

// Auto-compute target date (tomorrow in Taipei) or override via env
function taipeiNow() { return new Date(Date.now() + 8*3600*1000); }
function rocOf(d) { return (d.getUTCFullYear() - 1911) + '/' + String(d.getUTCMonth()+1).padStart(2,'0') + '/' + String(d.getUTCDate()).padStart(2,'0'); }
function ymOf(d) { return d.getUTCFullYear() + String(d.getUTCMonth()+1).padStart(2,'0'); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

const TODAY = taipeiNow();
const TOMORROW_DEFAULT = addDays(TODAY, 1);
const TARGET = process.env.TARGET_DATE || rocOf(TOMORROW_DEFAULT);

const PRICE_DIR = path.join(__dirname, 'prices');
// Previous month + current month in Taipei timezone
const prevMonth = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - 1, 1));
const MONTHS = process.env.MONTHS ? process.env.MONTHS.split(',') : [ymOf(prevMonth), ymOf(TODAY)];

console.log('[tomorrow_active] TARGET=' + TARGET + ', MONTHS=[' + MONTHS.join(',') + ']');

function rocKey(d) {
  const m = String(d).match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return 0;
  return parseInt(m[1].padStart(3,'0') + m[2].padStart(2,'0') + m[3].padStart(2,'0'));
}
function num(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || t === '--' || t === 'X') return null;
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

function loadStock(source, code) {
  const days = [];
  for (const ym of MONTHS) {
    const fp = path.join(PRICE_DIR, `${source}_${code}_${ym}.json`);
    if (!fs.existsSync(fp)) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    let rows = [];
    if (source === 'TWSE' && Array.isArray(d.data)) rows = d.data;
    else if (source === 'TPEX' && d.tables && d.tables[0]) rows = d.tables[0].data;
    for (const r of rows) {
      const close = num(r[6]);
      if (close == null || close === 0) continue;
      days.push({ date: r[0], key: rocKey(r[0]), close });
    }
  }
  const uniq = new Map();
  for (const d of days) uniq.set(d.key, d);
  return [...uniq.values()].sort((a,b) => a.key - b.key);
}

const txt = fs.readFileSync(path.join(__dirname, 'disposition_stocks.txt'), 'utf8').replace(/^﻿/, '');
const lines = txt.split('\n').filter(Boolean);
const rows = lines.slice(1).map(l => l.split('\t')).map(r => ({
  source: r[0], announce: r[1], code: r[2], name: r[3], cum: r[4], cond: r[5], period: r[6], measure: r[7]
}));

const targetKey = rocKey(TARGET);
const active = [];
for (const r of rows) {
  const parts = r.period.split(/[~～]/);
  if (parts.length !== 2) continue;
  const startKey = rocKey(parts[0]);
  const endKey = rocKey(parts[1]);
  if (startKey <= targetKey && targetKey <= endKey) {
    active.push({ ...r, startKey, endKey });
  }
}

// Dedupe by code: keep EARLIEST start (so we see the original price impact)
const byCode = new Map();
for (const a of active) {
  const prev = byCode.get(a.code);
  if (!prev || a.startKey < prev.startKey) byCode.set(a.code, a);
}
const unique = [...byCode.values()];

// Filter to equity only (4-digit codes, plus TWSE 911xxx DR)
const equity = unique.filter(s => {
  const c = String(s.code);
  if (s.source === 'TWSE') return /^\d{4}$/.test(c) || /^911\d{3}$/.test(c);
  if (s.source === 'TPEX') return /^\d{4}$/.test(c);
  return false;
});

console.log(`Stocks active on ${TARGET}: ${unique.length} unique (incl warrants/CB)`);
console.log(`Equity-only: ${equity.length}`);

const results = [];
for (const s of equity) {
  const days = loadStock(s.source, s.code);
  if (!days.length) { results.push({ ...s, status: 'NO_DATA' }); continue; }
  // pre_close: trading day before s.startKey
  const before = days.filter(d => d.key < s.startKey);
  const preDay = before.length ? before[before.length - 1] : null;
  const curDay = days[days.length - 1];
  const last20 = days.slice(-20);
  const ma20 = last20.length ? last20.reduce((a,d) => a+d.close, 0) / last20.length : null;
  const changePct = (preDay && curDay) ? (curDay.close - preDay.close) / preDay.close * 100 : null;
  results.push({
    ...s, status: 'OK',
    preClose: preDay?.close, preDate: preDay?.date,
    curClose: curDay.close, curDate: curDay.date,
    changePct, ma20,
    ma20From: last20[0].date, ma20To: last20[last20.length-1].date, ma20N: last20.length,
  });
}

results.sort((a, b) => {
  if (a.changePct == null) return 1;
  if (b.changePct == null) return -1;
  return b.changePct - a.changePct;
});

const fmt = n => n == null ? '' : (Math.round(n * 100) / 100).toFixed(2);
const fmtP = n => n == null ? '' : (n >= 0 ? '+' : '') + (Math.round(n * 100) / 100).toFixed(2) + '%';
// Add bias (乖離率) calculation
for (const r of results) {
  r.bias = (r.curClose != null && r.ma20 != null && r.ma20 !== 0)
    ? (r.curClose - r.ma20) / r.ma20 * 100 : null;
}

const headers = ['來源', '代號', '名稱', '處置期間', '處置條件', '處置措施', '進處置前收盤', '前一日日期', '最新收盤', '最新日期', '漲跌幅', '20日均價', '20MA乖離率', '20MA起迄'];
const out = [headers.join('\t')];
for (const r of results) {
  out.push([
    r.source, r.code, r.name, r.period, r.cond, r.measure,
    fmt(r.preClose), r.preDate || '', fmt(r.curClose), r.curDate || '', fmtP(r.changePct), fmt(r.ma20), fmtP(r.bias),
    r.ma20N ? `${r.ma20From}~${r.ma20To} (${r.ma20N}日)` : '',
  ].join('\t'));
}
fs.writeFileSync(path.join(__dirname, 'tomorrow_active.txt'), '﻿' + out.join('\n') + '\n', 'utf8');

const ok = results.filter(r => r.changePct != null);
const gainers = ok.filter(r => r.changePct >= 0);
const losers = ok.filter(r => r.changePct < 0);
console.log(`Gainers: ${gainers.length}, Losers: ${losers.length}`);
if (gainers.length) console.log('Top gainer:', gainers[0].code, gainers[0].name, fmtP(gainers[0].changePct));
if (losers.length) console.log('Worst loser:', losers[losers.length-1].code, losers[losers.length-1].name, fmtP(losers[losers.length-1].changePct));
console.log('Saved: tomorrow_active.txt');
