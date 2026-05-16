import { corsHeaders, rejectUntrustedOrigin, requireApprovedFirebaseUser, safeErrorResponse } from '../_shared/firebase-auth.js';

/**
 * Cloudflare Pages Function — 네이버 금융 종목 섹터 조회
 * GET /api/naver-sector?code=XXXXXX
 *
 * 1) integration 엔드포인트로 industryCode 획득
 * 2) industry 엔드포인트로 industryName 획득
 * 3) industryName 을 WhaleTracker 12개 RRG 섹터 중 가장 가까운 것으로 매핑
 * 4) KV 에 1주일 캐싱
 *
 * 응답: { code, stockName, industryCode, industryName, mapped: { code, name }|null, cached?, source:'Naver' }
 */

const METHODS = 'GET, OPTIONS';
const CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 1주일

// 네이버 WICS 업종명 키워드 → RRG 섹터 매핑 테이블
// (RRG_SECTORS 의 code 와 동일)
const NAVER_TO_RRG = [
  { code: '091160', name: '반도체',     keywords: ['반도체', '디스플레이', '광학'] },
  { code: '139260', name: 'IT',          keywords: ['소프트웨어', '인터넷', '미디어', '엔터테인먼트', '광고', 'IT서비스', '게임', '통신서비스', '전자장비', '전자제품', '컴퓨터', '사무용', '카탈로그소매', '양방향'] },
  { code: '091170', name: '은행',        keywords: ['은행'] },
  { code: '139270', name: '금융',        keywords: ['보험', '증권', '자본시장', '다각화된금융', '소비자금융', '카드', '리츠', '부동산', '금융서비스'] },
  { code: '091180', name: '자동차',      keywords: ['자동차', '타이어'] },
  { code: '091220', name: '운송',        keywords: ['해운', '항공화물', '항공사', '도로와철도', '운송인프라', '물류', '운수창고'] },
  { code: '117460', name: '에너지화학',  keywords: ['화학', '석유', '가스', '정유', '에너지장비', '2차전지', '신재생'] },
  { code: '117680', name: '철강',        keywords: ['철강', '비철금속', '금속과채광'] },
  { code: '117700', name: '건설',        keywords: ['건설', '건축자재', '시멘트', '도시가스'] },
  { code: '244580', name: '바이오',      keywords: ['제약', '바이오', '생명과학', '의약품', '의료장비', '의료서비스', '헬스케어'] },
  { code: '139310', name: '중공업',      keywords: ['기계', '우주항공', '국방', '조선', '중공업', '복합기업', '중장비', '방위'] },
  { code: '139290', name: '생활소비재',  keywords: ['식품', '음료', '담배', '화장품', '가정용품', '호텔', '레스토랑', '레저', '의류', '잡화', '소매', '농축수산', '종이', '목재', '문구'] },
];

function mapNaverSectorToRRG(industryName) {
  if (!industryName) return null;
  const text = String(industryName).toLowerCase();
  for (const entry of NAVER_TO_RRG) {
    for (const kw of entry.keywords) {
      if (text.includes(kw.toLowerCase())) {
        return { code: entry.code, name: entry.name, matchedKeyword: kw };
      }
    }
  }
  return null;
}

async function fetchIntegration(code) {
  const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/integration`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36',
      'Accept': 'application/json',
    },
    cf: { cacheTtl: 3600 },
  });
  if (!res.ok) throw new Error(`integration HTTP ${res.status}`);
  return await res.json();
}

async function fetchIndustryName(industryCode) {
  const url = `https://m.stock.naver.com/api/stocks/industry/${encodeURIComponent(industryCode)}?page=1&pageSize=1`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36',
      'Accept': 'application/json',
    },
    cf: { cacheTtl: 86400 },
  });
  if (!res.ok) throw new Error(`industry HTTP ${res.status}`);
  const data = await res.json();
  return data?.groupInfo?.name || '';
}

async function lookupNaverSector(code) {
  const integ = await fetchIntegration(code);
  const stockName = integ.stockName || '';
  const industryCode = String(integ.industryCode || '');
  if (!industryCode) return { code, stockName, error: 'industryCode 없음' };
  const industryName = await fetchIndustryName(industryCode);
  const mapped = mapNaverSectorToRRG(industryName);
  return {
    code,
    stockName,
    industryCode,
    industryName,
    mapped,
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

    // KV cache lookup
    const store = getCacheStore(env);
    const cacheKey = `naver-sector:${code}`;
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

    // Naver fetch
    let result;
    try {
      result = await lookupNaverSector(code);
    } catch (e) {
      result = { code, error: e.message || String(e), source: 'Naver' };
    }

    // KV write (success + negative cache for failures, shorter TTL on errors)
    if (store?.put) {
      try {
        const ttl = result.error ? 60 * 60 : CACHE_TTL_SEC; // 에러는 1시간만
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
