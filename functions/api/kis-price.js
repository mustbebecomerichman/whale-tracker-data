/**
 * Cloudflare Pages Function — KIS 현재가 조회
 * POST /api/kis-price
 *
 * 환경변수 (Cloudflare Pages → Settings → Environment variables):
 *   KIS_APP_KEY    : 한국투자증권 App Key
 *   KIS_APP_SECRET : 한국투자증권 App Secret
 *   KIS_MOCK       : "true" 이면 모의투자 서버 사용 (기본값 false)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// KIS 토큰 캐시 (Worker 인스턴스 내 메모리, 요청 간 공유 안 됨)
let _cachedToken = null;
let _tokenExpiry = 0;

async function getKisToken(env) {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  const mock = env.KIS_MOCK === 'true';
  const base = mock
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';

  const res = await fetch(`${base}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('KIS 토큰 발급 실패: ' + JSON.stringify(data));

  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + 6 * 60 * 60 * 1000; // 6시간
  return _cachedToken;
}

async function fetchDomesticPrice(code, token, env) {
  const mock = env.KIS_MOCK === 'true';
  const base = mock
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';

  const res = await fetch(
    `${base}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
    {
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: 'FHKST01010100',
        custtype: 'P',
      },
    }
  );
  const data = await res.json();
  const out = data.output || {};
  const price = parseInt(out.stck_prpr) || 0;
  const change = parseInt(out.prdy_vrss) || 0;
  const changeRate = parseFloat(out.prdy_ctrt) || 0;
  const name = out.prdt_abrv_name || out.stck_kor_isnm || '';
  if (!price) throw new Error(out.msg1 || '데이터 없음');
  return { price, change, changeRate, name };
}

async function fetchOverseasPrice(code, market, token, env) {
  const mock = env.KIS_MOCK === 'true';
  const base = mock
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';

  // 시장 코드 매핑
  const exchMap = { NAS: 'NAS', NYS: 'NYS', AMS: 'AMS', HKS: 'HKS', TSE: 'TSE', SHS: 'SHS' };
  const exch = exchMap[market] || 'NAS';

  const res = await fetch(
    `${base}/uapi/overseas-price/v1/quotations/price?AUTH=&EXCD=${exch}&SYMB=${code}`,
    {
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: 'HHDFS00000300',
        custtype: 'P',
      },
    }
  );
  const data = await res.json();
  const out = data.output || {};
  const price = parseFloat(out.last) || 0;
  const change = parseFloat(out.diff) || 0;
  const changeRate = parseFloat(out.rate) || 0;
  if (!price) throw new Error(out.msg1 || '데이터 없음');
  return { price, change, changeRate };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  try {
    if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) {
      throw new Error('KIS_APP_KEY / KIS_APP_SECRET 환경변수가 설정되지 않았습니다.');
    }

    const { items } = await request.json();
    if (!Array.isArray(items) || !items.length) {
      throw new Error('items 배열이 필요합니다.');
    }

    const token = await getKisToken(env);
    const results = {};

    for (const item of items) {
      const key = `${item.market}:${item.code}`;
      try {
        const isOverseas = ['NAS', 'NYS', 'AMS', 'HKS', 'TSE', 'SHS'].includes(item.market);
        results[key] = isOverseas
          ? await fetchOverseasPrice(item.code, item.market, token, env)
          : await fetchDomesticPrice(item.code, token, env);
      } catch (e) {
        results[key] = { error: e.message };
      }
      // KIS API 과호출 방지 (0.2초 간격)
      await new Promise(r => setTimeout(r, 200));
    }

    return new Response(JSON.stringify(results), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}
