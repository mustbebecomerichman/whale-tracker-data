import { corsHeaders, rejectUntrustedOrigin, requireFirebaseUser, safeErrorResponse } from '../_shared/firebase-auth.js';

/**
 * Cloudflare Pages Function — OHLC daily history proxy (Stooq)
 * GET  /api/ohlc-history?code=005930&market=J&days=120
 * POST /api/ohlc-history  body: { items: [{ code, market }, ...], days }
 *
 * Returns: { "J:005930": { code, market, source:"Stooq", bars:[{date,open,high,low,close,volume}, ...] }, ... }
 *
 * Wilder 알고리즘(RSI/RTS/ASI)에 필요한 일봉 시계열을 제공한다.
 * - 국내 (J/KOSPI/KOSDAQ): {code}.kr
 * - 미국 (NAS/NYS/AMS):    {code}.us
 * - 홍콩 (HKS):            {code}.hk
 * - 일본 (TSE):            {code}.jp
 *
 * Stooq daily CSV 응답 포맷: Date,Open,High,Low,Close,Volume
 */

const METHODS = 'GET, POST, OPTIONS';
const DEFAULT_DAYS = 120;
const MAX_DAYS = 400;
const STOOQ_TIMEOUT_MS = 8000;

function stooqSymbol(code, market) {
  const raw = String(code || '').trim().toLowerCase().replace(/\./g, '-');
  if (!raw) return '';
  if (market === 'HKS') return `${raw}.hk`;
  if (market === 'TSE') return `${raw}.jp`;
  if (market === 'SHS') return `${raw}.cn`;
  if (['NAS','NYS','AMS'].includes(market)) return `${raw}.us`;
  // 국내 (J, 빈값, KOSPI/KOSDAQ 등)
  if (/^\d{6}$/.test(raw)) return `${raw}.kr`;
  // 알파벳 코드는 기본 미국으로
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

async function fetchStooqDaily(code, market, days) {
  const symbol = stooqSymbol(code, market);
  if (!symbol) throw new Error('Invalid symbol');
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STOOQ_TIMEOUT_MS);
  let text;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'WhaleTrackerPro/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  if (/no data/i.test(text)) throw new Error('Stooq: no data for symbol');
  const all = parseStooqCsv(text);
  if (!all.length) throw new Error('Stooq: empty bars');
  // 최신 days개만 (꼬리 자르기)
  const bars = all.slice(-Math.min(days, MAX_DAYS));
  return { code, market: market || 'J', source: 'Stooq', symbol, bars };
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
  // Stooq 동시성은 보수적으로: 직렬 + 50ms 간격
  for (const item of items) {
    const code = String(item.code || '').trim().toUpperCase();
    const market = item.market || 'J';
    const key = `${market}:${code}`;
    try {
      results[key] = await fetchStooqDaily(code, market, days);
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
    const auth = await requireFirebaseUser(request, env);
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
    const auth = await requireFirebaseUser(request, env);
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
