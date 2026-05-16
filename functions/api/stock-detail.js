import { corsHeaders, rejectUntrustedOrigin, requireApprovedFirebaseUser, safeErrorResponse } from '../_shared/firebase-auth.js';

/**
 * Cloudflare Pages Function — 종목 핵심 지표 조회
 * GET /api/stock-detail?code=XXXXXX
 *
 * Naver 모바일 stock integration 엔드포인트에서 다음 필드를 정제해 반환:
 *  - name, closePrice, compareToPreviousClosePrice, fluctuationsRatio
 *  - per, eps, pbr, bps
 *  - estimatePer, estimateEps
 *  - foreignerHoldingRate (외인 소진율)
 *  - dealTrendInfos: 최근 5거래일 {bizdate, foreigner, organ, individual}
 *
 * KV 캐싱 5분 (실시간성 보장하면서도 네이버 부하 방지).
 */

const METHODS = 'GET, OPTIONS';
const CACHE_TTL_SEC = 5 * 60;

async function fetchIntegration(code) {
  const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/integration`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36',
      'Accept': 'application/json',
    },
    cf: { cacheTtl: 60 },
  });
  if (!res.ok) throw new Error(`integration HTTP ${res.status}`);
  return await res.json();
}

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s || s === '-' || s === 'N/A') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function pickDealTrend(integ) {
  const candidates = [
    integ?.dealTrendInfos,
    integ?.dealTrendInfoList,
    integ?.dealTrend,
    integ?.investorDealTrend,
  ];
  for (const arr of candidates) {
    if (Array.isArray(arr) && arr.length) return arr;
  }
  return [];
}

function summarizeDealTrend(rows) {
  return (rows || []).slice(0, 5).map(r => ({
    bizdate: r.bizdate || r.localDate || r.date || '',
    foreigner: toNumber(r.foreignerPureBuyQuant ?? r.foreigner ?? r.foreignerQuant ?? r.frgnQuant),
    organ: toNumber(r.organPureBuyQuant ?? r.organ ?? r.organQuant ?? r.orgnQuant),
    individual: toNumber(r.individualPureBuyQuant ?? r.individual ?? r.individualQuant ?? r.indvQuant),
  }));
}

function pickFundamentals(integ) {
  const dest = {};
  const sources = [
    integ?.companyOverview,
    integ?.stockEndPriceInfo,
    integ?.stockIntegrationInfo,
    integ?.stockInvestmentIndicators,
    integ,
  ].filter(Boolean);
  const keys = {
    per: ['per', 'companyPer', 'currentPer'],
    eps: ['eps', 'companyEps', 'currentEps'],
    pbr: ['pbr', 'companyPbr', 'currentPbr'],
    bps: ['bps', 'companyBps', 'currentBps'],
    estimatePer: ['estimatePer', 'forwardPer', 'expectedPer'],
    estimateEps: ['estimateEps', 'forwardEps', 'expectedEps'],
    foreignerHoldingRate: ['foreignerHoldingRate', 'foreignerRatio', 'foreignerOwnRate'],
    dividendYield: ['dividendYield'],
  };
  for (const [out, aliases] of Object.entries(keys)) {
    for (const src of sources) {
      for (const k of aliases) {
        if (src[k] != null && dest[out] == null) {
          const n = toNumber(src[k]);
          if (n != null) dest[out] = n;
        }
      }
    }
  }
  return dest;
}

async function lookupStockDetail(code) {
  const integ = await fetchIntegration(code);
  const fund = pickFundamentals(integ);
  const dealTrend = summarizeDealTrend(pickDealTrend(integ));
  return {
    code,
    name: integ?.stockName || '',
    closePrice: toNumber(integ?.closePrice),
    compareToPreviousClosePrice: toNumber(integ?.compareToPreviousClosePrice),
    fluctuationsRatio: toNumber(integ?.fluctuationsRatio),
    industryName: integ?.industryName || '',
    per: fund.per ?? null,
    eps: fund.eps ?? null,
    pbr: fund.pbr ?? null,
    bps: fund.bps ?? null,
    estimatePer: fund.estimatePer ?? null,
    estimateEps: fund.estimateEps ?? null,
    foreignerHoldingRate: fund.foreignerHoldingRate ?? null,
    dividendYield: fund.dividendYield ?? null,
    dealTrend,
    source: 'Naver',
    fetchedAt: new Date().toISOString(),
  };
}

function getCacheStore(env) {
  return env.KIS_TOKEN_KV || env.WHALE_KV || env.WHALE_TOKEN_KV || null;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const blocked = rejectUntrustedOrigin(request, env, METHODS);
    if (blocked) return blocked;
    const auth = await requireApprovedFirebaseUser(request, env);
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const code = (url.searchParams.get('code') || '').trim();
    if (!/^[\dA-Z]{6,7}$/.test(code)) {
      return new Response(JSON.stringify({ error: 'invalid code (6~7 char Korean stock code)' }), {
        status: 400,
        headers: { ...corsHeaders(request, env, METHODS), 'Content-Type': 'application/json' },
      });
    }

    const store = getCacheStore(env);
    const cacheKey = `stock-detail:${code}`;
    if (store?.get) {
      try {
        const cached = await store.get(cacheKey, 'json');
        if (cached?.code === code) {
          return new Response(JSON.stringify({ ...cached, cached: true }), {
            headers: { ...corsHeaders(request, env, METHODS), 'Content-Type': 'application/json' },
          });
        }
      } catch (e) {}
    }

    let result;
    try {
      result = await lookupStockDetail(code);
    } catch (e) {
      result = { code, error: e.message || String(e), source: 'Naver' };
    }

    if (store?.put) {
      try {
        const ttl = result.error ? 60 : CACHE_TTL_SEC;
        await store.put(cacheKey, JSON.stringify(result), { expirationTtl: ttl });
      } catch (e) {}
    }

    return new Response(JSON.stringify(result), {
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
