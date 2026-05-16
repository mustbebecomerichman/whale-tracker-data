import { corsHeaders, rejectUntrustedOrigin, requireApprovedFirebaseUser, safeErrorResponse } from '../_shared/firebase-auth.js';

/**
 * Cloudflare Pages Function — OHLC daily history proxy
 * GET  /api/ohlc-history?code=005930&market=J&days=120
 * POST /api/ohlc-history  body: { items: [{ code, market }, ...], days }
 *
 * Returns: { "J:005930": { code, market, source, bars:[{date,open,high,low,close,volume}, ...] }, ... }
 *
 * Wilder 알고리즘(RSI/RTS/ASI)에 필요한 일봉 시계열을 제공한다.
 *
 * Primary: Yahoo Finance Chart API (한국·미국 모두 지원, 토큰 불필요)
 *   - 코스피: {code}.KS  / 코스닥 fallback: {code}.KQ
 *   - 미국: {code} (NAS/NYS 모두 무접미사)
 *   - 홍콩: {code}.HK / 일본: {code}.T / 중국: {code}.SS / {code}.SZ
 * Fallback: Stooq daily CSV (미국 위주, 한국은 빈 데이터 가능)
 */

const METHODS = 'GET, POST, OPTIONS';
const DEFAULT_DAYS = 120;
const MAX_DAYS = 400;
const FETCH_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

function rangeForDays(days) {
  if (days <= 30) return '1mo';
  if (days <= 60) return '3mo';
  if (days <= 180) return '6mo';
  if (days <= 365) return '1y';
  return '2y';
}

function yahooSymbolCandidates(code, market) {
  const raw = String(code || '').trim().toUpperCase();
  if (!raw) return [];
  if (market === 'HKS') return [`${raw.replace(/^0+/, '').padStart(4, '0')}.HK`];
  if (market === 'TSE') return [`${raw}.T`];
  if (market === 'SHS') return [`${raw}.SS`, `${raw}.SZ`];
  if (['NAS','NYS','AMS'].includes(market)) return [raw];
  if (/^\d{6}$/.test(raw)) return [`${raw}.KS`, `${raw}.KQ`]; // 코스피 우선, 실패 시 코스닥
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(raw)) return [raw, `${raw.replace(/\./g, '-')}`];
  return [raw];
}

async function fetchYahooChart(symbol, days) {
  const range = rangeForDays(days);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`;
  const res = await withTimeout(fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WhaleTrackerPro/1.0)',
      'Accept': 'application/json',
    },
  }), FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const data = await res.json();
  if (data?.chart?.error) throw new Error('Yahoo: ' + (data.chart.error.description || data.chart.error.code));
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo: no result');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0];
  if (!q || !ts.length) throw new Error('Yahoo: empty quote');
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (!Number.isFinite(c) || c <= 0) continue;
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l)) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    bars.push({ date, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
  }
  if (!bars.length) throw new Error('Yahoo: empty bars');
  return bars;
}

function stooqSymbol(code, market) {
  const raw = String(code || '').trim().toLowerCase().replace(/\./g, '-');
  if (!raw) return '';
  if (market === 'HKS') return `${raw}.hk`;
  if (market === 'TSE') return `${raw}.jp`;
  if (market === 'SHS') return `${raw}.cn`;
  if (['NAS','NYS','AMS'].includes(market)) return `${raw}.us`;
  if (/^\d{6}$/.test(raw)) return `${raw}.kr`;
  if (/^[a-z][a-z0-9-]{0,9}$/.test(raw)) return `${raw}.us`;
  return raw;
}

function parseStooqCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase();
  if (!header.includes('date') || !header.includes('close')) return [];
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    const date = cols[0];
    const open = Number(cols[1]);
    const high = Number(cols[2]);
    const low = Number(cols[3]);
    const close = Number(cols[4]);
    const volume = cols[5] ? Number(cols[5]) : 0;
    if (!Number.isFinite(close) || close <= 0) continue;
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(open)) continue;
    bars.push({ date, open, high, low, close, volume });
  }
  return bars;
}

async function fetchStooqDaily(code, market) {
  const symbol = stooqSymbol(code, market);
  if (!symbol) throw new Error('Stooq: invalid symbol');
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const res = await withTimeout(fetch(url, {
    headers: { 'User-Agent': 'WhaleTrackerPro/1.0' },
  }), FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
  const text = await res.text();
  if (/no data/i.test(text)) throw new Error('Stooq: no data');
  const bars = parseStooqCsv(text);
  if (!bars.length) throw new Error('Stooq: empty bars');
  return bars;
}

async function fetchOhlc(code, market, days) {
  const errors = [];
  // 1) Yahoo Finance (한국·미국 모두 지원)
  for (const sym of yahooSymbolCandidates(code, market)) {
    try {
      const bars = await fetchYahooChart(sym, days);
      return {
        code, market: market || 'J', source: 'Yahoo', symbol: sym,
        bars: bars.slice(-Math.min(days, MAX_DAYS)),
      };
    } catch (e) {
      errors.push(`Yahoo ${sym}: ${e.message}`);
    }
  }
  // 2) Stooq fallback (미국 위주)
  try {
    const bars = await fetchStooqDaily(code, market);
    return {
      code, market: market || 'J', source: 'Stooq', symbol: stooqSymbol(code, market),
      bars: bars.slice(-Math.min(days, MAX_DAYS)),
    };
  } catch (e) {
    errors.push(`Stooq: ${e.message}`);
  }
  throw new Error(errors.join(' | '));
}

async function handleRequest(request) {
  let items = [];
  let days = DEFAULT_DAYS;
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const market = url.searchParams.get('market') || 'J';
    const d = Number(url.searchParams.get('days'));
    if (Number.isFinite(d) && d > 0) days = Math.min(d, MAX_DAYS);
    if (code) items = [{ code, market }];
  } else {
    const body = await request.json().catch(() => ({}));
    items = Array.isArray(body.items) ? body.items : [];
    const d = Number(body.days);
    if (Number.isFinite(d) && d > 0) days = Math.min(d, MAX_DAYS);
  }
  if (!items.length) throw new Error('items 배열 또는 ?code= 값이 필요합니다.');
  if (items.length > 30) throw new Error('한 번에 최대 30개 종목까지 조회할 수 있습니다.');

  const results = {};
  for (const item of items) {
    const code = String(item.code || '').trim().toUpperCase();
    const market = item.market || 'J';
    const key = `${market}:${code}`;
    try {
      results[key] = await fetchOhlc(code, market, days);
    } catch (e) {
      results[key] = { error: e.message || 'history unavailable', code, market };
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return results;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const blocked = rejectUntrustedOrigin(request, env, METHODS);
    if (blocked) return blocked;
    const auth = await requireApprovedFirebaseUser(request, env);
    if (!auth.ok) return auth.response;
    const results = await handleRequest(request);
    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders(request, env, METHODS), 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return safeErrorResponse(request, env, e, 500, METHODS);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const blocked = rejectUntrustedOrigin(request, env, METHODS);
    if (blocked) return blocked;
    const auth = await requireApprovedFirebaseUser(request, env);
    if (!auth.ok) return auth.response;
    const results = await handleRequest(request);
    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders(request, env, METHODS), 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return safeErrorResponse(request, env, e, 500, METHODS);
  }
}

export async function onRequestOptions(context) {
  const { request, env } = context;
  const blocked = rejectUntrustedOrigin(request, env, METHODS);
  if (blocked) return blocked;
  return new Response(null, { headers: corsHeaders(request, env, METHODS) });
}
