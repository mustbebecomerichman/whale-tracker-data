/**
 * Cloudflare Pages Function — 투자자별 수급 현황
 * POST /api/supply-demand
 *
 * Request body: { codes: ["005930", "000660", ...] }  // 국내 종목 코드 배열
 *
 * Response:
 * {
 *   "005930": {
 *     individual:    -12345,   // 개인 순매수 수량 (음수 = 순매도)
 *     foreign:       +56789,   // 외국인 순매수 수량
 *     institution:   +11111,   // 기관 순매수 수량
 *     individualAmt: -1234,    // 개인 순매수 금액 (백만원)
 *     foreignAmt:    +5678,
 *     institutionAmt:+1111,
 *   }, ...
 * }
 *
 * 환경변수:
 *   KIS_APP_KEY, KIS_APP_SECRET
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
  if (!data.access_token) throw new Error('KIS 토큰 발급 실패');
  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + 6 * 60 * 60 * 1000;
  return _cachedToken;
}

async function fetchInvestorData(code, token, env) {
  const mock = env.KIS_MOCK === 'true';
  const base = mock
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';

  // 투자자별 매매 동향 (당일)
  const res = await fetch(
    `${base}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
    {
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: 'FHKST01010900',
        custtype: 'P',
      },
    }
  );
  const data = await res.json();
  const out = data.output || {};

  // 당일 기준 최신 데이터 (output 배열의 첫 번째 행)
  const row = Array.isArray(out) ? out[0] : out;

  return {
    individual:     parseInt(row.prsn_ntby_qty      || row.ind_ntby_qty  || 0),
    foreign:        parseInt(row.frgn_ntby_qty       || row.for_ntby_qty  || 0),
    institution:    parseInt(row.orgn_ntby_qty       || row.ins_ntby_qty  || 0),
    financialInst:  parseInt(row.fnnc_ntby_qty       || 0),  // 금융투자
    insurance:      parseInt(row.insn_ntby_qty       || 0),  // 보험
    trust:          parseInt(row.mrkt_ntby_qty       || 0),  // 투신
    individualAmt:  parseInt(row.prsn_ntby_tr_pbmn   || row.ind_ntby_tr_pbmn || 0),  // 백만원
    foreignAmt:     parseInt(row.frgn_ntby_tr_pbmn   || row.for_ntby_tr_pbmn || 0),
    institutionAmt: parseInt(row.orgn_ntby_tr_pbmn   || row.ins_ntby_tr_pbmn || 0),
    date:           row.stck_bsop_date || '',
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  try {
    if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) {
      throw new Error('KIS_APP_KEY / KIS_APP_SECRET 환경변수가 없습니다.');
    }

    const { codes } = await request.json();
    if (!Array.isArray(codes) || !codes.length) {
      throw new Error('codes 배열이 필요합니다.');
    }

    const token = await getKisToken(env);
    const results = {};

    for (const code of codes) {
      try {
        results[code] = await fetchInvestorData(code, token, env);
      } catch (e) {
        results[code] = { error: e.message };
      }
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
