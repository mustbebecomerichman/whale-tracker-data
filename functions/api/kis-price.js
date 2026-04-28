/**
 * Cloudflare Pages Function — KIS 현재가 조회
 * POST /api/kis-price
 *
 * Cloudflare Pages → Settings → Environment variables:
 *   KIS_APP_KEY    : 한국투자증권 App Key
 *   KIS_APP_SECRET : 한국투자증권 App Secret
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

async function clearStoredToken(env) {
  _cachedToken = null;
  _tokenExpiry = 0;
  const store = getTokenStore(env);
  if (store && typeof store.delete === 'function') {
    try { await store.delete(TOKEN_KEY); } catch (e) {}
  }
}

async function getKisToken(env) {
  const stored = await readStoredToken(env);
  if (stored) return stored;
  const { appKey, appSecret } = getKisCreds(env);
  const base = env.KIS_MOCK === 'true'
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const res = await fetch(`${base}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type:'client_credentials', appkey:appKey, appsecret:appSecret }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('KIS 토큰 발급 실패: ' + JSON.stringify(data));
  await writeStoredToken(env, data.access_token, parseKisTokenExpiry(data));
  return _cachedToken;
}

async function fetchDomesticPrice(code, token, env) {
  const { appKey, appSecret } = getKisCreds(env);
  const base = env.KIS_MOCK === 'true'
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const res = await fetch(
    `${base}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
    { headers: { 'Content-Type':'application/json', authorization:`Bearer ${token}`, appkey:appKey, appsecret:appSecret, tr_id:'FHKST01010100', custtype:'P' } }
  );
  const data = await res.json();
  const out = data.output || {};
  const price = parseInt(out.stck_prpr) || 0;
  const change = parseInt(out.prdy_vrss) || 0;
  const changeRate = parseFloat(out.prdy_ctrt) || 0;
  const name = out.prdt_abrv_name || out.stck_kor_isnm || '';
  if (!price) throw new Error(data.msg1 || out.msg1 || `데이터 없음 (${data.rt_cd || res.status})`);
  return { price, change, changeRate, name, source:'KIS', code };
}

async function fetchOverseasPrice(code, market, token, env) {
  const { appKey, appSecret } = getKisCreds(env);
  const base = env.KIS_MOCK === 'true'
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const exch = { NAS:'NAS', NYS:'NYS', AMS:'AMS', HKS:'HKS', TSE:'TSE', SHS:'SHS' }[market] || 'NAS';
  const res = await fetch(
    `${base}/uapi/overseas-price/v1/quotations/price?AUTH=&EXCD=${exch}&SYMB=${code}`,
    { headers: { 'Content-Type':'application/json', authorization:`Bearer ${token}`, appkey:appKey, appsecret:appSecret, tr_id:'HHDFS00000300', custtype:'P' } }
  );
  const data = await res.json();
  const out = data.output || {};
  const price = parseFloat(out.last) || 0;
  const change = parseFloat(out.diff) || 0;
  const changeRate = parseFloat(out.rate) || 0;
  if (!price) throw new Error(data.msg1 || out.msg1 || `데이터 없음 (${data.rt_cd || res.status})`);
  return { price, change, changeRate, source:'KIS', code };
}

function isTokenError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('token') || msg.includes('토큰') || msg.includes('oauth') || msg.includes('인증');
}

async function handlePriceRequest(request, env) {
  const { appKey, appSecret } = getKisCreds(env);
  if (!appKey || !appSecret)
    throw new Error('KIS_APP_KEY/KIS_APP_SECRET 환경변수가 설정되지 않았습니다.');

  let items = [];
  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (url.searchParams.get('debug') === '1') {
      const store = getTokenStore(env);
      return {
        debug: true,
        hasKvBinding: !!store,
        kvBindingName: store ? 'KIS_TOKEN_KV' : '',
        hasMemoryToken: !!(_cachedToken && Date.now() < _tokenExpiry),
        memoryTokenExpiresAt: _tokenExpiry ? new Date(_tokenExpiry).toISOString() : '',
        note: 'debug=1은 KIS 토큰을 발급하지 않습니다.',
      };
    }
    const code = url.searchParams.get('code');
    const market = url.searchParams.get('market') || 'J';
    if (code) items = [{ code, market }];
  } else {
    const body = await request.json();
    items = body.items;
  }
  if (!Array.isArray(items) || !items.length) throw new Error('items 배열 또는 ?code=005930 값이 필요합니다.');

  let token = await getKisToken(env);
  const results = {};
  for (const item of items) {
    const code = String(item.code || '').trim().toUpperCase();
    const market = item.market || 'J';
    const key = `${market}:${code}`;
    try {
      const isOverseas = ['NAS','NYS','AMS','HKS','TSE','SHS'].includes(market);
      try {
        results[key] = isOverseas
          ? await fetchOverseasPrice(code, market, token, env)
          : await fetchDomesticPrice(code, token, env);
      } catch (e) {
        if (!isTokenError(e)) throw e;
        await clearStoredToken(env);
        token = await getKisToken(env);
        results[key] = isOverseas
          ? await fetchOverseasPrice(code, market, token, env)
          : await fetchDomesticPrice(code, token, env);
      }
    } catch(e) {
      results[key] = { error: e.message, code, market };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const results = await handlePriceRequest(request, env);
    return new Response(JSON.stringify(results), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const results = await handlePriceRequest(request, env);
    return new Response(JSON.stringify(results), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}
