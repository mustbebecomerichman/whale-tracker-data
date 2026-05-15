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
const TOKEN_KEY_PREFIX = 'kis-access-token-v2:';  // appKey 끝 8자 suffix
// 메모리 토큰 캐시 — appKey 별로 분리
const _tokenMem = new Map();

function getKisCreds(env, account = {}) {
  // 계좌별로 별도 app key/secret 환경변수 사용 가능
  // account.appKeyEnv / account.appSecretEnv 지정 시 해당 env var 우선
  const keyOverride = account.appKeyEnv ? env[account.appKeyEnv] : null;
  const secretOverride = account.appSecretEnv ? env[account.appSecretEnv] : null;
  return {
    appKey: keyOverride || env.KIS_APP_KEY || env.KIS_APPKEY || env.KIS_KEY || '',
    appSecret: secretOverride || env.KIS_APP_SECRET || env.KIS_APPSECRET || env.KIS_SECRET || '',
    keyEnvName: account.appKeyEnv || 'KIS_APP_KEY',
    secretEnvName: account.appSecretEnv || 'KIS_APP_SECRET',
  };
}

function tokenCacheKey(appKey) {
  return TOKEN_KEY_PREFIX + String(appKey || '').slice(-8);
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

async function readStoredToken(env, appKey) {
  const mem = _tokenMem.get(appKey);
  if (mem && Date.now() < mem.expiry) return mem.token;
  const store = getTokenStore(env);
  if (!store || typeof store.get !== 'function') return null;
  try {
    const saved = await store.get(tokenCacheKey(appKey), 'json');
    if (saved?.accessToken && saved?.expiresAt && Date.now() < saved.expiresAt) {
      _tokenMem.set(appKey, { token: saved.accessToken, expiry: saved.expiresAt });
      return saved.accessToken;
    }
  } catch (e) {}
  return null;
}

async function writeStoredToken(env, appKey, accessToken, expiresAt) {
  _tokenMem.set(appKey, { token: accessToken, expiry: expiresAt });
  const store = getTokenStore(env);
  if (!store || typeof store.put !== 'function') return;
  try {
    const ttl = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000));
    await store.put(tokenCacheKey(appKey), JSON.stringify({ accessToken, expiresAt }), { expirationTtl: ttl });
  } catch (e) {}
}

async function getKisToken(env, account = {}) {
  const { appKey, appSecret, keyEnvName, secretEnvName } = getKisCreds(env, account);
  if (!appKey || !appSecret) {
    throw new Error(`${keyEnvName}/${secretEnvName} 환경변수가 설정되지 않았습니다.`);
  }
  const stored = await readStoredToken(env, appKey);
  if (stored) return stored;
  const res = await fetch(`${getBaseUrl(env)}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('KIS 토큰 발급 실패: ' + (data.error_description || data.error || JSON.stringify(data)));
  }
  await writeStoredToken(env, appKey, data.access_token, parseKisTokenExpiry(data));
  return data.access_token;
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
// appKeyEnv/appSecretEnv: 해당 계좌가 별도 KIS 앱을 사용할 때 환경변수 이름 지정
// 미지정 시 기본 KIS_APP_KEY/KIS_APP_SECRET 사용
function getKisAccounts(env) {
  if (env.KIS_ACCOUNTS) {
    try { return JSON.parse(env.KIS_ACCOUNTS); } catch (_) {}
  }
  return [
    { cano: '64635355', prdt: '01', acctType: 'ISA' },
    { cano: '74118276', prdt: '01', acctType: '위탁', appKeyEnv: 'KIS_APP_KEY_2', appSecretEnv: 'KIS_APP_SECRET_2' },
  ];
}

async function fetchAllBalances(env) {
  const accounts = getKisAccounts(env);
  const allHoldings = [];
  const perAccount = [];
  const errors = [];
  for (const acct of accounts) {
    let domesticOk = false;
    let domesticResult = null;
    // 국내주식 잔고
    try {
      domesticResult = await fetchBalance(env, acct);
      const tagged = (domesticResult.holdings || []).map(h => ({ ...h, acctType: acct.acctType, _cano: acct.cano, _market: 'domestic' }));
      allHoldings.push(...tagged);
      domesticOk = true;
    } catch (e) {
      errors.push({ cano: acct.cano, acctType: acct.acctType, scope: '국내', error: e.message || String(e) });
    }
    // 해외주식 잔고 (silently skip if 권한 없음)
    let overseasCount = 0;
    let overseasErrs = [];
    try {
      const overseas = await fetchOverseasBalance(env, acct);
      const taggedOverseas = (overseas.holdings || []).map(h => ({ ...h, acctType: acct.acctType, _cano: acct.cano, _market: 'overseas' }));
      allHoldings.push(...taggedOverseas);
      overseasCount = taggedOverseas.length;
      overseasErrs = overseas.errors || [];
    } catch (e) {
      errors.push({ cano: acct.cano, acctType: acct.acctType, scope: '해외', error: e.message || String(e) });
    }
    if (domesticOk || overseasCount > 0) {
      perAccount.push({
        cano: acct.cano,
        acctType: acct.acctType,
        holdings: (domesticResult?.holdings?.length || 0) + overseasCount,
        domestic: domesticResult?.holdings?.length || 0,
        overseas: overseasCount,
        summary: domesticResult?.summary || null,
        overseasErrors: overseasErrs,
      });
    }
  }
  return { holdings: allHoldings, accounts: perAccount, errors, source: 'KIS', fetchedAt: new Date().toISOString() };
}

async function fetchBalance(env, account = {}) {
  const { appKey, appSecret, keyEnvName, secretEnvName } = getKisCreds(env, account);
  if (!appKey || !appSecret) {
    throw new Error(`${keyEnvName}/${secretEnvName} 환경변수 누락 (${account.acctType || '계좌'})`);
  }
  const cano = (account.cano || env.KIS_ACCOUNT_NUMBER || env.KIS_CANO || '').toString().trim();
  const prdt = (account.prdt || env.KIS_ACCOUNT_PRODUCT || env.KIS_ACNT_PRDT_CD || '01').toString().trim();
  if (!cano) throw new Error('계좌번호가 설정되지 않았습니다.');

  const token = await getKisToken(env, account);
  const trId = env.KIS_MOCK === 'true' ? 'VTTC8434R' : 'TTTC8434R';
  const baseUrl = getBaseUrl(env);
  // 페이지네이션: tr_cont 헤더 + CTX_AREA_FK100/NK100 로 연속 조회 (KIS 페이지당 ~10건)
  const allRows = [];
  let summary = null;
  let ctxFk = '', ctxNk = '', trCont = '';
  for (let page = 0; page < 10; page++) {
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
      CTX_AREA_FK100: ctxFk,
      CTX_AREA_NK100: ctxNk,
    });
    const res = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: trId,
          custtype: 'P',
          tr_cont: trCont,
        },
      }
    );
    const data = await res.json();
    if (data.rt_cd && data.rt_cd !== '0') {
      throw new Error(`KIS API 오류: ${data.msg1 || 'rt_cd=' + data.rt_cd}`);
    }
    const rows = Array.isArray(data.output1) ? data.output1 : [];
    allRows.push(...rows);
    // 첫 페이지의 output2 (총합 요약) 만 사용
    if (!summary && Array.isArray(data.output2) && data.output2[0]) {
      summary = {
        totalEval: Number(data.output2[0].tot_evlu_amt) || 0,
        totalPurchase: Number(data.output2[0].pchs_amt_smtl_amt) || 0,
        totalPnl: Number(data.output2[0].evlu_pfls_smtl_amt) || 0,
        cash: Number(data.output2[0].dnca_tot_amt) || 0,
      };
    }
    // 응답 tr_cont 헤더가 F/M 이면 다음 페이지 존재
    const respTrCont = res.headers.get('tr_cont') || '';
    if (respTrCont !== 'F' && respTrCont !== 'M') break;
    ctxFk = data.ctx_area_fk100 || '';
    ctxNk = data.ctx_area_nk100 || '';
    if (!ctxFk && !ctxNk) break; // 컨텍스트 없으면 종료
    trCont = 'N';
  }
  // qty=0 행도 포함 (미체결/대출 등 누락 방지). 단, code가 빈 행은 제외
  const holdings = allRows
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
  return { holdings, summary, rawCount: allRows.length, source: 'KIS', fetchedAt: new Date().toISOString() };
}

// 해외주식 잔고 조회 (NASD/NYSE/AMEX — 미국 시장 위주)
async function fetchOverseasBalance(env, account) {
  const { appKey, appSecret } = getKisCreds(env, account);
  if (!appKey || !appSecret) return { holdings: [], errors: [] };
  const cano = (account.cano || env.KIS_ACCOUNT_NUMBER || env.KIS_CANO || '').toString().trim();
  const prdt = (account.prdt || env.KIS_ACCOUNT_PRODUCT || env.KIS_ACNT_PRDT_CD || '01').toString().trim();
  if (!cano) return { holdings: [], errors: [] };
  const token = await getKisToken(env, account);
  const trId = env.KIS_MOCK === 'true' ? 'VTTS3012R' : 'TTTS3012R';
  const baseUrl = getBaseUrl(env);
  // 미국 3개 거래소 + 홍콩(필요시 확장)
  const exchanges = [
    { code: 'NASD', currency: 'USD', market: 'NAS' },
    { code: 'NYSE', currency: 'USD', market: 'NYS' },
    { code: 'AMEX', currency: 'USD', market: 'AMS' },
  ];
  const seenCodes = new Set();  // 거래소별 중복 방지
  const all = [];
  const errors = [];
  for (const exch of exchanges) {
    let ctxFk = '', ctxNk = '';
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({
        CANO: cano,
        ACNT_PRDT_CD: prdt,
        OVRS_EXCG_CD: exch.code,
        TR_CRCY_CD: exch.currency,
        CTX_AREA_FK200: ctxFk,
        CTX_AREA_NK200: ctxNk,
      });
      let data;
      try {
        const res = await fetch(`${baseUrl}/uapi/overseas-stock/v1/trading/inquire-balance?${params}`, {
          headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
            tr_cont: page === 0 ? '' : 'N',
            custtype: 'P',
          },
        });
        data = await res.json();
      } catch (e) {
        errors.push({ exchange: exch.code, error: e.message || String(e) });
        break;
      }
      if (data.rt_cd && data.rt_cd !== '0') {
        if (data.msg_cd && data.msg_cd !== 'KIOK0570') {
          errors.push({ exchange: exch.code, error: data.msg1 || `rt_cd=${data.rt_cd}` });
        }
        break;
      }
      const rows = Array.isArray(data.output1) ? data.output1 : [];
      rows.forEach(r => {
        const code = String(r.ovrs_pdno || r.pdno || '').trim().toUpperCase();
        if (!code) return;
        if (seenCodes.has(code)) return;  // KIS가 거래소별 호출에 같은 종목을 중복 반환하는 경우 방지
        const qty = Number(r.ovrs_cblc_qty || r.hldg_qty || 0);
        if (qty <= 0) return;
        seenCodes.add(code);
        all.push({
          code,
          stockName: r.ovrs_item_name || r.prdt_name || code,
          qty,
          avgBuy: Number(r.pchs_avg_pric) || 0,
          price: Number(r.now_pric2 || r.last_pric) || 0,
          eval: Number(r.frcr_evlu_amt2 || r.ovrs_stck_evlu_amt) || 0,
          purchase: Number(r.frcr_pchs_amt1) || 0,
          pnl: Number(r.frcr_evlu_pfls_amt) || 0,
          _exchange: exch.code,
        });
      });
      ctxFk = (data.ctx_area_fk200 || '').trim();
      ctxNk = (data.ctx_area_nk200 || '').trim();
      if (!ctxNk) break;
    }
  }
  return { holdings: all, errors };
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
    try {
      let data;
      if (qCano) {
        // 단일 계좌 override (기본 env 키 사용)
        data = await fetchBalance(env, { cano: qCano, prdt: qPrdt });
      } else {
        // 고정된 2개 계좌 모두 조회 (계좌별 credentials은 fetchAllBalances 내부에서 처리)
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
