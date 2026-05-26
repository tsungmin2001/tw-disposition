// Cloudflare Pages Function: /api/quotes
// 盤中即時報價: 從 TWSE MIS 5 秒揭示 API 拉所有 active 處置股的最新成交價
// 盤中: 09:00-13:35 台北時間，回傳即時 (CDN 快取 5 分鐘)
// 盤後: 直接回傳 "in_market: false" + 上次快照

const UA = 'Mozilla/5.0 (compatible; Cloudflare-Pages-Function/1.0)';

function taipeiNow() { return new Date(Date.now() + 8 * 3600 * 1000); }

function isMarketHours(d) {
  // 週一至五 9:00-20:59 (盤中即時 + 盤後 MIS 仍能取到當日收盤)
  // 21:00 之後讓 daily cron 處理
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutes >= 9 * 60 && minutes < 21 * 60;
}

export async function onRequest({ request }) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  };

  const taipei = taipeiNow();
  const inMarket = isMarketHours(taipei);

  if (!inMarket) {
    return new Response(JSON.stringify({
      inMarket: false,
      taipei: taipei.toISOString(),
      message: '非盤中時段 (09:00-20:59 台北週一至五，盤後仍可顯示當日收盤)',
      quotes: {},
    }), {
      headers: { ...corsHeaders, 'Cache-Control': 'public, s-maxage=600, max-age=60' }
    });
  }

  // 讀 active list (同網站下的靜態檔)
  let activeList;
  try {
    const activeRes = await fetch(new URL('/data/active.json', request.url).href, {
      headers: { 'User-Agent': UA },
    });
    if (!activeRes.ok) throw new Error('active.json HTTP ' + activeRes.status);
    activeList = await activeRes.json();
  } catch (e) {
    return new Response(JSON.stringify({
      error: 'cannot load active list: ' + e.message,
      quotes: {},
    }), { status: 500, headers: corsHeaders });
  }

  const stocks = activeList.stocks || [];
  if (stocks.length === 0) {
    return new Response(JSON.stringify({
      inMarket: true,
      taipei: taipei.toISOString(),
      message: '沒有 active 標的',
      quotes: {},
    }), { headers: corsHeaders });
  }

  // 組 MIS ex_ch
  const exCh = stocks
    .map(s => (s.source === 'TWSE' ? 'tse_' : 'otc_') + s.code + '.tw')
    .join('|');

  const misUrl = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp'
    + '?ex_ch=' + exCh
    + '&json=1&delay=0&_=' + Date.now();

  let misData;
  try {
    const misRes = await fetch(misUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://mis.twse.com.tw/stock/',
        'Accept': 'application/json',
      },
    });
    if (!misRes.ok) throw new Error('MIS HTTP ' + misRes.status);
    misData = await misRes.json();
  } catch (e) {
    return new Response(JSON.stringify({
      error: 'MIS fetch failed: ' + e.message,
      quotes: {},
    }), { status: 502, headers: corsHeaders });
  }

  // 解析 MIS 回應 → 每檔的最新價、昨收
  const quotes = {};
  for (const m of (misData.msgArray || [])) {
    const price = parseFloat(m.z);              // 最新成交價 (盤中變動)
    const yesterday = parseFloat(m.y);          // 昨收
    const open = parseFloat(m.o);
    const high = parseFloat(m.h);
    const low = parseFloat(m.l);
    const validPrice = isNaN(price) || price === 0 ? yesterday : price;

    quotes[m.c] = {
      price: validPrice,
      yesterday: yesterday || null,
      open: isNaN(open) ? null : open,
      high: isNaN(high) ? null : high,
      low: isNaN(low) ? null : low,
      time: m.t || null,                         // 最後更新時間 HH:MM:SS
      dayChange: (yesterday && validPrice) ? ((validPrice - yesterday) / yesterday * 100) : null,
    };
  }

  return new Response(JSON.stringify({
    inMarket: true,
    taipei: taipei.toISOString(),
    updated: new Date().toISOString(),
    count: Object.keys(quotes).length,
    quotes,
  }), {
    headers: {
      ...corsHeaders,
      // CDN 快取 5 分鐘 (對應撮合間隔)，瀏覽器快取 60 秒
      'Cache-Control': 'public, s-maxage=300, max-age=60',
    },
  });
}
