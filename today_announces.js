'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const TODAY = '115/05/25';
const PRICE_DIR = path.join(__dirname, 'prices');
const MONTHS = ['202604', '202605'];
const SLEEP_MS = 5_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
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

async function fetchMonth(source, code, ym) {
  const fname = path.join(PRICE_DIR, `${source}_${code}_${ym}.json`);
  if (fs.existsSync(fname) && fs.statSync(fname).size > 200) return JSON.parse(fs.readFileSync(fname, 'utf8'));
  const url = source === 'TWSE'
    ? `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}01&stockNo=${code}&response=json`
    : `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${ym.slice(0,4)}/${ym.slice(4,6)}/01&response=json`;
  const referer = source === 'TWSE' ? 'https://www.twse.com.tw/' : 'https://www.tpex.org.tw/zh-tw/mainboard/trading/info/stock-pricing.html';
  console.log(`  fetching ${source} ${code} ${ym}...`);
  const res = await httpsGet(url, referer);
  if (res.status !== 200 || res.body.trim().startsWith('<')) throw new Error('fetch failed');
  const data = JSON.parse(res.body);
  fs.writeFileSync(fname, JSON.stringify(data));
  await sleep(SLEEP_MS);
  return data;
}

function extractDays(data, source) {
  let rows = [];
  if (source === 'TWSE' && Array.isArray(data.data)) rows = data.data;
  else if (source === 'TPEX' && data.tables && data.tables[0] && Array.isArray(data.tables[0].data)) rows = data.tables[0].data;
  const days = [];
  for (const r of rows) {
    const close = num(r[6]);
    if (close == null || close === 0) continue;
    days.push({ date: r[0], key: rocKey(r[0]), close });
  }
  return days;
}

(async () => {
  const txt = fs.readFileSync(path.join(__dirname, 'disposition_stocks.txt'), 'utf8').replace(/^﻿/, '');
  const lines = txt.split('\n').filter(Boolean);
  const allRows = lines.slice(1).map(l => l.split('\t')).map(r => ({
    source: r[0], announce: r[1], code: r[2], name: r[3], cum: r[4], cond: r[5], period: r[6], measure: r[7]
  }));

  const today = allRows.filter(r => r.announce === TODAY);
  const equity = today.filter(r => {
    const c = String(r.code);
    if (r.source === 'TWSE') return /^\d{4}$/.test(c) || /^911\d{3}$/.test(c);
    if (r.source === 'TPEX') return /^\d{4}$/.test(c);
    return false;
  });

  console.log(`Today (${TODAY}) all announces: ${today.length}`);
  console.log(`Equity-only: ${equity.length}`);

  const results = [];
  for (const s of equity) {
    let days = [];
    for (const ym of MONTHS) {
      try {
        const d = await fetchMonth(s.source, s.code, ym);
        days = days.concat(extractDays(d, s.source));
      } catch (e) {
        console.log(`  ! ${s.source} ${s.code} ${ym}: ${e.message}`);
      }
    }
    const uniq = new Map();
    for (const d of days) uniq.set(d.key, d);
    days = [...uniq.values()].sort((a,b) => a.key - b.key);
    if (!days.length) { results.push({ ...s, status: 'NO_DATA' }); continue; }

    const todayKey = rocKey(TODAY);
    // Pre-announce close: last close BEFORE today
    const before = days.filter(d => d.key < todayKey);
    const preDay = before.length ? before[before.length - 1] : null;
    // Today's close
    const todayDay = days.find(d => d.key === todayKey) || days[days.length - 1];
    // 20MA ending today
    const upTo = days.filter(d => d.key <= todayKey);
    const last20 = upTo.slice(-20);
    const ma20 = last20.length ? last20.reduce((a,d) => a+d.close, 0) / last20.length : null;
    const changePct = (preDay && todayDay) ? (todayDay.close - preDay.close) / preDay.close * 100 : null;
    results.push({
      ...s, status: 'OK',
      preClose: preDay?.close, preDate: preDay?.date,
      todayClose: todayDay.close, todayDate: todayDay.date,
      changePct, ma20, ma20From: last20[0].date, ma20To: last20[last20.length-1].date, ma20N: last20.length,
    });
  }

  results.sort((a, b) => {
    if (a.changePct == null) return 1;
    if (b.changePct == null) return -1;
    return b.changePct - a.changePct;
  });

  const fmt = n => n == null ? '' : (Math.round(n * 100) / 100).toFixed(2);
  const fmtP = n => n == null ? '' : (n >= 0 ? '+' : '') + (Math.round(n * 100) / 100).toFixed(2) + '%';
  const headers = ['來源', '代號', '名稱', '處置期間', '處置條件', '處置措施', '公告前一日收盤', '前一日日期', '今日(5/25)收盤', '漲跌幅', '20日均價', '20MA起迄'];
  const out = [headers.join('\t')];
  for (const r of results) {
    out.push([
      r.source, r.code, r.name, r.period, r.cond, r.measure,
      fmt(r.preClose), r.preDate || '', fmt(r.todayClose), fmtP(r.changePct), fmt(r.ma20),
      r.ma20N ? `${r.ma20From}~${r.ma20To} (${r.ma20N}日)` : '',
    ].join('\t'));
  }
  fs.writeFileSync(path.join(__dirname, 'today_announces.txt'), '﻿' + out.join('\n') + '\n', 'utf8');
  console.log('\n--- Output ---');
  out.forEach(l => console.log(l));
  console.log('\nSaved: today_announces.txt');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
