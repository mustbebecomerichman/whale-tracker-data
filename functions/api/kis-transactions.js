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
  return email && getAdminEmails(env).has(email);
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

async function fetchTransactions(env, fromYmd, toYmd) {
  const { appKey, appSecret } = getKisCreds(env);
  const cano = env.KIS_ACCOUNT_NUMBER || env.KIS_CANO || '';
  const prdt = env.KIS_ACCOUNT_PRODUCT || env.KIS_ACNT_PRDT_CD || '01';
  if (!cano) throw new Error('KIS_ACCOUNT_NUMBER 환경변수 누락');
  const token = await getKisToken(env);
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
      const code = String(r.pdno || '').padStart(6, '0');
      const isBuy = String(r.sll_buy_dvsn_cd || '').trim() === '02';
      const qty = Number(r.tot_ccld_qty || r.ord_qty || 0);
      const price = Number(r.avg_prvs || r.ord_unpr || 0);
      const fee = Number(r.tlex_smtl || 0);
      results.push({
        date: isoFromKisDate(r.ord_dt || r.exec_dt),
        code,
        stockName: r.prdt_name || '',
        action: isBuy ? '매수' : '매도',
        qty,
        price,
        fee,
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
    const { appKey, appSecret } = getKisCreds(env);
    const missing = [];
    if (!appKey) missing.push('KIS_APP_KEY');
    if (!appSecret) missing.push('KIS_APP_SECRET');
    if (!(env.KIS_ACCOUNT_NUMBER || env.KIS_CANO)) missing.push('KIS_ACCOUNT_NUMBER');
    if (missing.length) return adminError(request, env, '환경변수 누락: ' + missing.join(', '), 500);
    const url = new URL(request.url);
    const today = new Date();
    const defFrom = new Date(today);
    defFrom.setDate(defFrom.getDate() - 89);  // KIS는 90일 이내만 허용
    const fromYmd = (url.searchParams.get('from') || ymd(defFrom)).replace(/-/g, '');
    const toYmd = (url.searchParams.get('to') || ymd(today)).replace(/-/g, '');
    try {
      const items = await fetchTransactions(env, fromYmd, toYmd);
      return new Response(JSON.stringify({ items, from: fromYmd, to: toYmd }), {
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
