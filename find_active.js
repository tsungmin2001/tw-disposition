'use strict';
const fs = require('fs');
const path = require('path');

const TODAY = '115/05/25';  // 民國 115/05/25 = 2026/05/25
const txt = fs.readFileSync(path.join(__dirname, 'disposition_stocks.txt'), 'utf8').replace(/^﻿/, '');
const lines = txt.split('\n').filter(Boolean);
const headers = lines[0].split('\t');
const rows = lines.slice(1).map(l => l.split('\t'));

function rocKey(d) {
  // "115/05/25" -> 1150525 (numeric for comparison)
  const m = String(d).match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return 0;
  return parseInt(m[1].padStart(3,'0') + m[2].padStart(2,'0') + m[3].padStart(2,'0'));
}

const todayKey = rocKey(TODAY);
console.log('Today (民國):', TODAY, '→ key:', todayKey);

const active = [];
for (const r of rows) {
  const [source, announce, code, name, cum, cond, period, measure] = r;
  // period like "115/05/25~115/06/05" or "115/05/22～115/06/04"
  const parts = period.split(/[~～]/);
  if (parts.length !== 2) continue;
  const startKey = rocKey(parts[0]);
  const endKey = rocKey(parts[1]);
  if (startKey === 0 || endKey === 0) continue;
  if (startKey <= todayKey && todayKey <= endKey) {
    active.push({ source, announce, code, name, cum, cond, period, measure, startKey, endKey });
  }
}

// Sort by source then code
active.sort((a, b) => {
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  return String(a.code).localeCompare(String(b.code));
});

// Dedupe by code (same stock may have multiple overlapping dispositions; keep most recent)
const byCode = new Map();
for (const a of active) {
  const prev = byCode.get(a.code);
  if (!prev || a.startKey > prev.startKey) byCode.set(a.code, a);
}
const unique = [...byCode.values()];
unique.sort((a, b) => {
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  return String(a.code).localeCompare(String(b.code));
});

console.log('\n=== Total active dispositions (incl multiple per stock):', active.length);
console.log('=== Unique stocks:', unique.length);
console.log('\n=== Unique stocks currently in disposition (sorted) ===');
console.log('來源\t代號\t名稱\t公布日期\t處置期間\t處置條件\t處置措施');
for (const a of unique) {
  console.log(`${a.source}\t${a.code}\t${a.name}\t${a.announce}\t${a.period}\t${a.cond}\t${a.measure}`);
}

// Output by source
const twse = unique.filter(a => a.source === 'TWSE');
const tpex = unique.filter(a => a.source === 'TPEX');
console.log('\n=== TWSE:', twse.length, '檔');
console.log('=== TPEX:', tpex.length, '檔');

// Save list
fs.writeFileSync(path.join(__dirname, 'active_list.tsv'),
  '來源\t代號\t名稱\t公布日期\t處置期間\t處置條件\t處置措施\n' +
  unique.map(a => [a.source, a.code, a.name, a.announce, a.period, a.cond, a.measure].join('\t')).join('\n') + '\n',
  'utf8');
console.log('Saved to active_list.tsv');
