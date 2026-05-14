import { corsHeaders, rejectUntrustedOrigin, requireFirebaseUser, safeErrorResponse } from '../_shared/firebase-auth.js';

/**
 * Cloudflare Pages Function — KIS 주식잔고조회 (관리자 본인 계정 전용)
 * GET /api/kis-balance
 *
 * Cloudflare Pages → Settings → Environment variables (필수):
 *   KIS_APP_KEY           : 한국투자증권 App Key
 *   KIS_APP_SECRET        : 한국투자증권 App Secret
 *   KIS_ACCOUNT_NUMBER    : 종합계좌번호 앞 8자리 (예: 12345678)
 *   KIS_ACCOUNT_PRODUCT   : 계좌상품코드 뒤 2자리 (예: 01)
 *   ADMIN_EMAIL           : 본 엔드포인트 호출 허용 이메일 (단일 또는 콤마구분)
 *   KIS_MOCK              : "true" 면 모의투자 서버 사용
 */

const METHODS = 'GET, OPTIONS';
const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000;
const TOKEN_KEY = 'kis-access-token-v1';
let _cachedToken = null, _tokenExpiry = 0;

function getKisCreds(env) {
  return {
    appKey: env.KIS_APP_KEY || env.KIS_APPKEY || env.KIS_KEY || '',
    appSecret: env.KIS_APP_SECRET || env.KIS_APPSECRET || env.KIS_SECRET || '',
  };
}

function getBaseUrl(env) {
  return env.KIS_MOCK === 'true'
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
}

function getTokenStore(env) {
  return env.KIS_TOKEN_KV || env.WHALE_TOKEN_KV || env.WHALE_KV || null;
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
  } catch (e) {}
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
  } catch (e) {}
}

async function getKisToken(env) {
  const stored = await readStoredToken(env);
  if (stored) return stored;
  const { appKey, appSecret } = getKisCreds(env);
  const res = await fetch(`${getBaseUrl(env)}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('KIS 토큰 발급 실패');
  await writeStoredToken(env, data.access_token, parseKisTokenExpiry(data));
  return _cachedToken;
}

function getAdminEmails(env) {
  const raw = env.ADMIN_EMAIL || env.ADMIN_EMAILS || 'smmoon2030@gmail.com';
  return new Set(String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

function requireAdmin(user, env) {
  const email = String(user?.email || '').toLowerCase();
  const admins = getAdminEmails(env);
  return email && admins.has(email);
}

// 관리자 본인 KIS 계좌 목록 (env KIS_ACCOUNTS JSON으로 override 가능)
function getKisAccounts(env) {
  if (env.KIS_ACCOUNTS) {
    try { return JSON.parse(env.KIS_ACCOUNTS); } catch (_) {}
  }
  return [
    { cano: '64635355', prdt: '01', acctType: 'ISA' },
    { cano: '74118276', prdt: '01', acctType: '위탁' },
  ];
}

async function fetchAllBalances(env) {
  const accounts = getKisAccounts(env);
  const allHoldings = [];
  const perAccount = [];
  const errors = [];
  for (const acct of accounts) {
    try {
      const r = await fetchBalance(env, { cano: acct.cano, prdt: acct.prdt });
      const tagged = (r.holdings || []).map(h => ({ ...h, acctType: acct.acctType, _cano: acct.cano }));
      allHoldings.push(...tagged);
      perAccount.push({ cano: acct.cano, acctType: acct.acctType, holdings: tagged.length, summary: r.summary });
    } catch (e) {
      errors.push({ cano: acct.cano, acctType: acct.acctType, error: e.message || String(e) });
    }
  }
  return { holdings: allHoldings, accounts: perAccount, errors, source: 'KIS', fetchedAt: new Date().toISOString() };
}

async function fetchBalance(env, override = {}) {
  const { appKey, appSecret } = getKisCreds(env);
  const cano = (override.cano || env.KIS_ACCOUNT_NUMBER || env.KIS_CANO || '').toString().trim();
  const prdt = (override.prdt || env.KIS_ACCOUNT_PRODUCT || env.KIS_ACNT_PRDT_CD || '01').toString().trim();
  if (!cano) throw new Error('계좌번호가 설정되지 않았습니다.');

  const token = await getKisToken(env);
  const trId = env.KIS_MOCK === 'true' ? 'VTTC8434R' : 'TTTC8434R';
  const params = new URLSearchParams({
    CANO: cano,
    ACNT_PRDT_CD: prdt,
    AFHR_FLPR_YN: 'N',
    OFL_YN: '',
    INQR_DVSN: '02',
    UNPR_DVSN: '01',
    FUND_STTL_ICLD_YN: 'N',
    FNCG_AMT_AUTO_RDPT_YN: 'N',
    PRCS_DVSN: '01',
    CTX_AREA_FK100: '',
    CTX_AREA_NK100: '',
  });
  const res = await fetch(
    `${getBaseUrl(env)}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`,
    {
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: trId,
        custtype: 'P',
      },
    }
  );
  const data = await res.json();
  if (data.rt_cd && data.rt_cd !== '0') {
    throw new Error(`KIS API 오류: ${data.msg1 || 'rt_cd=' + data.rt_cd}`);
  }
  const rows = Array.isArray(data.output1) ? data.output1 : [];
  // qty=0 행도 포함 (미체결/대출 등 누락 방지). 단, code가 빈 행은 제외
  const holdings = rows
    .filter(r => {
      const code = String(r.pdno || '').trim();
      return code && code !== '000000';
    })
    .map(r => ({
      code: String(r.pdno || '').padStart(6, '0'),
      stockName: r.prdt_name || '',
      qty: Number(r.hldg_qty) || 0,
      avgBuy: Number(r.pchs_avg_pric) || 0,
      price: Number(r.prpr) || 0,
      eval: Number(r.evlu_amt) || 0,
      purchase: Number(r.pchs_amt) || 0,
      pnl: Number(r.evlu_pfls_amt) || 0,
    }));
  const summary = Array.isArray(data.output2) && data.output2[0] ? {
    totalEval: Number(data.output2[0].tot_evlu_amt) || 0,
    totalPurchase: Number(data.output2[0].pchs_amt_smtl_amt) || 0,
    totalPnl: Number(data.output2[0].evlu_pfls_smtl_amt) || 0,
    cash: Number(data.output2[0].dnca_tot_amt) || 0,
  } : null;
  return { holdings, summary, rawCount: rows.length, source: 'KIS', fetchedAt: new Date().toISOString() };
}

function adminError(request, env, message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(request, env, METHODS), 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const blocked = rejectUntrustedOrigin(request, env, METHODS);
    if (blocked) return blocked;
    const auth = await requireFirebaseUser(request, env);
    if (!auth.ok) return auth.response;
    if (!requireAdmin(auth.user, env)) {
      return adminError(request, env, '관리자 본인 계정만 사용 가능합니다.', 403);
    }
    // 단일 계좌 override: ?cano=&prdt= 지정 시 그 계좌만 조회, 미지정 시 고정된 2개 계좌 모두 조회
    const url = new URL(request.url);
    const qCano = (url.searchParams.get('cano') || '').trim();
    const qPrdt = (url.searchParams.get('prdt') || '').trim();
    const { appKey, appSecret } = getKisCreds(env);
    const missing = [];
    if (!appKey) missing.push('KIS_APP_KEY (env)');
    if (!appSecret) missing.push('KIS_APP_SECRET (env)');
    if (missing.length) {
      return adminError(request, env, '설정 누락: ' + missing.join(', '), 500);
    }
    try {
      let data;
      if (qCano) {
        // 단일 계좌 override
        data = await fetchBalance(env, { cano: qCano, prdt: qPrdt });
      } else {
        // 고정된 2개 계좌 모두 조회
        data = await fetchAllBalances(env);
      }
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders(request, env, METHODS), 'Content-Type': 'application/json' },
      });
    } catch (apiErr) {
      console.error('KIS balance fetch failed', apiErr);
      return adminError(request, env, 'KIS 호출 실패: ' + (apiErr.message || String(apiErr)), 502);
    }
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
