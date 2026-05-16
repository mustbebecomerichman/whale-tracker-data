import { corsHeaders, rejectUntrustedOrigin, requireFirebaseUser, safeErrorResponse } from '../_shared/firebase-auth.js';

/**
 * Cloudflare Pages Function — KIS 일별 주문체결조회 (관리자 본인 계정 전용)
 * GET /api/kis-transactions?from=YYYYMMDD&to=YYYYMMDD
 *
 * Cloudflare Pages → Settings → Environment variables (필수):
 *   KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT_NUMBER, KIS_ACCOUNT_PRODUCT
 *   ADMIN_EMAIL (선택)
 *
 * TR_ID: TTTC8001R (실전, 일별주문체결조회 - 90일 이내)
 *        VTTC8001R (모의)
 */

const METHODS = 'GET, OPTIONS';
const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000;
const TOKEN_KEY_PREFIX = 'kis-access-token-v2:';
const _tokenMem = new Map();

function getKisCreds(env, account = {}) {
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
  const sec = Number(data.expires_in || 0);
  if (sec > 0) expiries.push(Date.now() + sec * 1000);
  const raw = data.access_token_token_expired || '';
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
  return email && getAdminEmails(env).has(email);
}

// 관리자 본인 KIS 계좌 목록 (env KIS_ACCOUNTS JSON으로 override 가능)
function getKisAccounts(env) {
  if (env.KIS_ACCOUNTS) {
    try { return JSON.parse(env.KIS_ACCOUNTS); } catch (_) {}
  }
  return [
    { cano: '64635355', prdt: '01', acctType: 'ISA' },
    { cano: '74118276', prdt: '01', acctType: '위탁', appKeyEnv: 'KIS_APP_KEY_2', appSecretEnv: 'KIS_APP_SECRET_2' },
  ];
}

function ymdToDate(ymd) {
  const s = String(ymd).replace(/-/g, '');
  return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00`);
}

// fromYmd~toYmd 범위를 90일 청크로 나눠 모두 조회
async function fetchTransactionsChunked(env, fromYmd, toYmd, account = {}) {
  const start = ymdToDate(fromYmd);
  const end = ymdToDate(toYmd);
  const all = [];
  let chunkEnd = new Date(end);
  while (chunkEnd >= start) {
    const chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() - 89);
    const effectiveStart = chunkStart < start ? new Date(start) : chunkStart;
    const items = await fetchTransactions(env, ymd(effectiveStart), ymd(chunkEnd), account);
    all.push(...items);
    chunkEnd = new Date(effectiveStart);
    chunkEnd.setDate(chunkEnd.getDate() - 1);
    if (all.length > 20000) break;
  }
  return all;
}

async function fetchAllTransactions(env, fromYmd, toYmd) {
  const accounts = getKisAccounts(env);
  const allItems = [];
  const errors = [];
  for (const acct of accounts) {
    try {
      const items = await fetchTransactionsChunked(env, fromYmd, toYmd, acct);
      const tagged = items.map(t => ({ ...t, acctType: acct.acctType, _cano: acct.cano }));
      allItems.push(...tagged);
    } catch (e) {
      errors.push({ cano: acct.cano, acctType: acct.acctType, error: e.message || String(e) });
    }
  }
  return { items: allItems, errors };
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function isoFromKisDate(s) {
  const t = String(s || '').replace(/[^0-9]/g, '');
  if (t.length < 8) return '';
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

async function fetchTransactions(env, fromYmd, toYmd, account = {}) {
  const { appKey, appSecret, keyEnvName, secretEnvName } = getKisCreds(env, account);
  if (!appKey || !appSecret) {
    throw new Error(`${keyEnvName}/${secretEnvName} 환경변수 누락 (${account.acctType || '계좌'})`);
  }
  const cano = (account.cano || env.KIS_ACCOUNT_NUMBER || env.KIS_CANO || '').toString().trim();
  const prdt = (account.prdt || env.KIS_ACCOUNT_PRODUCT || env.KIS_ACNT_PRDT_CD || '01').toString().trim();
  if (!cano) throw new Error('계좌번호가 설정되지 않았습니다.');
  const token = await getKisToken(env, account);
  const trId = env.KIS_MOCK === 'true' ? 'VTTC8001R' : 'TTTC8001R';
  const results = [];
  let ctxFk = '';
  let ctxNk = '';
  const baseUrl = getBaseUrl(env);
  // 연속조회 처리 (최대 10페이지)
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      CANO: cano,
      ACNT_PRDT_CD: prdt,
      INQR_STRT_DT: fromYmd,
      INQR_END_DT: toYmd,
      SLL_BUY_DVSN_CD: '00',  // 00: 전체, 01: 매도, 02: 매수
      INQR_DVSN: '00',         // 00: 역순, 01: 정순
      PDNO: '',
      CCLD_DVSN: '01',         // 00: 전체, 01: 체결, 02: 미체결
      ORD_GNO_BRNO: '',
      ODNO: '',
      INQR_DVSN_3: '00',
      INQR_DVSN_1: '',
      CTX_AREA_FK100: ctxFk,
      CTX_AREA_NK100: ctxNk,
    });
    const trIdFinal = page === 0 ? trId : trId;
    const res = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/trading/inquire-daily-ccld?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: trIdFinal,
          tr_cont: page === 0 ? '' : 'N',
          custtype: 'P',
        },
      }
    );
    const data = await res.json();
    if (data.rt_cd && data.rt_cd !== '0') {
      throw new Error(`KIS 거래내역 조회 오류: ${data.msg1 || 'rt_cd=' + data.rt_cd}`);
    }
    const rows = Array.isArray(data.output1) ? data.output1 : [];
    rows.forEach(r => {
      // 취소 주문 제외
      if (String(r.cncl_yn || '').trim().toUpperCase() === 'Y') return;
      const qty = Number(r.tot_ccld_qty || 0);
      // 체결되지 않은 주문 제외 (qty=0)
      if (qty <= 0) return;
      const code = String(r.pdno || '').padStart(6, '0');
      if (!code || code === '000000') return;
      const isBuy = String(r.sll_buy_dvsn_cd || '').trim() === '02';
      const price = Number(r.avg_prvs || 0) || Number(r.ord_unpr || 0);
      // 위탁수수료(comm_smtl) 와 제비용합계(tlex_smtl) 분리
      // tlex_smtl 은 수수료+세금 합산 → 차이가 세금 분
      const commission = Number(r.comm_smtl || 0);
      const totalCharges = Number(r.tlex_smtl || 0);
      const fee = commission > 0 ? commission : totalCharges;
      const tax = commission > 0 ? Math.max(0, totalCharges - commission) : 0;
      const amount = Number(r.tot_ccld_amt || 0);
      results.push({
        date: isoFromKisDate(r.ord_dt),
        code,
        stockName: r.prdt_name || '',
        action: isBuy ? '매수' : '매도',
        qty,
        price,
        fee,
        tax,
        amount,
        orderNo: r.odno || '',
      });
    });
    ctxFk = (data.ctx_area_fk100 || '').trim();
    ctxNk = (data.ctx_area_nk100 || '').trim();
    if (!ctxNk) break;
  }
  return results;
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
    const url = new URL(request.url);
    const qCano = (url.searchParams.get('cano') || '').trim();
    const qPrdt = (url.searchParams.get('prdt') || '').trim();
    // ?year=YYYY 가 있으면 해당 연도 전체, 없으면 from/to 또는 기본 90일
    const yearParam = (url.searchParams.get('year') || '').trim();
    let fromYmd, toYmd;
    if (/^\d{4}$/.test(yearParam)) {
      fromYmd = yearParam + '0101';
      const today = new Date();
      const yearEnd = parseInt(yearParam, 10) === today.getFullYear() ? ymd(today) : (yearParam + '1231');
      toYmd = yearEnd;
    } else {
      const today = new Date();
      const defFrom = new Date(today);
      defFrom.setDate(defFrom.getDate() - 89);
      fromYmd = (url.searchParams.get('from') || ymd(defFrom)).replace(/-/g, '');
      toYmd = (url.searchParams.get('to') || ymd(today)).replace(/-/g, '');
    }
    try {
      let payload;
      if (qCano) {
        // 단일 계좌 override (기본 env 키 사용)
        const items = await fetchTransactionsChunked(env, fromYmd, toYmd, { cano: qCano, prdt: qPrdt });
        payload = { items, errors: [] };
      } else {
        // 고정된 2개 계좌 모두 조회 (각 계좌 청크 분할)
        payload = await fetchAllTransactions(env, fromYmd, toYmd);
      }
      return new Response(JSON.stringify({ ...payload, from: fromYmd, to: toYmd }), {
        headers: { ...corsHeaders(request, env, METHODS), 'Content-Type': 'application/json' },
      });
    } catch (apiErr) {
      console.error('KIS transactions fetch failed', apiErr);
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
