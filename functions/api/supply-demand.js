import { corsHeaders, rejectUntrustedOrigin, requireApprovedFirebaseUser, safeErrorResponse } from '../_shared/firebase-auth.js';

/**
 * Cloudflare Pages Function - KIS 투자자별 수급 현황
 * POST /api/supply-demand
 *
 * Request body: { codes: ["005930", "000660"] }
 */

const METHODS = 'POST, OPTIONS';

let _cachedToken = null, _tokenExpiry = 0;
const TOKEN_KEY = 'kis-access-token-v1';
const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000;

function getKisCreds(env) {
  return {
    appKey: env.KIS_APP_KEY || env.KIS_APPKEY || env.KIS_KEY || '',
    appSecret: env.KIS_APP_SECRET || env.KIS_APPSECRET || env.KIS_SECRET || '',
  };
}

function getTokenStore(env) {
  return env.KIS_TOKEN_KV || env.WHALE_TOKEN_KV || env.WHALE_KV || null;
}

function kisBase(env) {
  return env.KIS_MOCK === 'true'
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
}

function parseKisTokenExpiry(data) {
  const expiries = [];
  const sec = Number(data.expires_in || data.expires_in_sec || data.expires_in_second || 0);
  if (sec > 0) expiries.push(Date.now() + sec * 1000);
  const raw = data.access_token_token_expired || data.token_expired || data.expired_at || '';
  if (raw) {
    const parsed = Date.parse(String(raw).replace(' ', 'T'));
    if (Number.isFinite(parsed)) expiries.push(parsed);
  }
  expiries.push(Date.now() + 23 * 60 * 60 * 1000 + 50 * 60 * 1000);
  return Math.min(...expiries) - TOKEN_EXPIRY_BUFFER_MS;
}

function num(value) {
  const n = Number(String(value ?? 0).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

async function readStoredToken(env) {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  const store = getTokenStore(env);
  if (!store || typeof store.get !== 'function') return null;
  try {
    const saved = await store.get(TOKEN_KEY, 'json');
    if (saved?.accessToken && saved?.expiresAt && Date.now() < saved.expiresAt) {
      _cachedToken = saved.accessToken;
      _tokenExpiry = saved.expiresAt;
      return _cachedToken;
    }
  } catch (e) {
    console.warn('KIS token KV read failed:', e.message);
  }
  return null;
}

async function writeStoredToken(env, accessToken, expiresAt) {
  _cachedToken = accessToken;
  _tokenExpiry = expiresAt;
  const store = getTokenStore(env);
  if (!store || typeof store.put !== 'function') return;
  try {
    const ttl = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000));
    await store.put(TOKEN_KEY, JSON.stringify({ accessToken, expiresAt }), { expirationTtl: ttl });
  } catch (e) {
    console.warn('KIS token KV write failed:', e.message);
  }
}

async function getKisToken(env) {
  const stored = await readStoredToken(env);
  if (stored) return stored;

  const { appKey, appSecret } = getKisCreds(env);
  const res = await fetch(`${kisBase(env)}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('KIS 토큰 발급 실패: ' + JSON.stringify(data));
  await writeStoredToken(env, data.access_token, parseKisTokenExpiry(data));
  return _cachedToken;
}

async function fetchInvestorData(code, token, env) {
  const { appKey, appSecret } = getKisCreds(env);
  const res = await fetch(
    `${kisBase(env)}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
    {
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHKST01010900',
        custtype: 'P',
      },
    }
  );
  const data = await res.json();
  const out = data.output || {};
  const row = Array.isArray(out) ? out[0] : out;
  if (!row || (!row.prsn_ntby_qty && !row.frgn_ntby_qty && !row.orgn_ntby_qty)) {
    if (data.msg1) throw new Error(data.msg1);
  }

  return {
    individual: num(row.prsn_ntby_qty || row.ind_ntby_qty || row.indv_ntby_qty),
    foreign: num(row.frgn_ntby_qty || row.for_ntby_qty || row.frgn_seln_qty),
    institution: num(row.orgn_ntby_qty || row.ins_ntby_qty || row.inst_ntby_qty),
    financialInst: num(row.fnnc_ntby_qty),
    insurance: num(row.insn_ntby_qty),
    trust: num(row.mrkt_ntby_qty || row.trst_ntby_qty),
    individualAmt: num(row.prsn_ntby_tr_pbmn || row.ind_ntby_tr_pbmn),
    foreignAmt: num(row.frgn_ntby_tr_pbmn || row.for_ntby_tr_pbmn),
    institutionAmt: num(row.orgn_ntby_tr_pbmn || row.ins_ntby_tr_pbmn),
    date: row.stck_bsop_date || '',
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const blocked = rejectUntrustedOrigin(request, env, METHODS);
    if (blocked) return blocked;
    const auth = await requireApprovedFirebaseUser(request, env);
    if (!auth.ok) return auth.response;
    const { appKey, appSecret } = getKisCreds(env);
    if (!appKey || !appSecret) {
      throw new Error('KIS_APP_KEY / KIS_APP_SECRET 환경변수가 설정되지 않았습니다.');
    }

    const { codes } = await request.json();
    if (!Array.isArray(codes) || !codes.length) {
      throw new Error('codes 배열이 필요합니다.');
    }

    const token = await getKisToken(env);
    const results = {};

    for (const rawCode of codes) {
      const code = String(rawCode || '').trim().toUpperCase();
      if (!/^\d{6}$/.test(code)) {
        results[code] = { error: '국내 6자리 종목코드만 수급 조회를 지원합니다.' };
        continue;
      }
      try {
        results[code] = await fetchInvestorData(code, token, env);
      } catch (e) {
        console.error('KIS supply-demand failed', { code, message: e.message });
        results[code] = { error: 'Investor data unavailable' };
      }
      await new Promise(r => setTimeout(r, 200));
    }

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
