const PROJECT_ID = 'whaletracker-pro';
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://whale-tracker-data.pages.dev',
  'https://whaletracker-pro.web.app',
  'https://whaletracker-pro.firebaseapp.com',
];

let jwksCache = null;
let jwksExpiry = 0;

function b64urlToBytes(value) {
  const text = String(value || '');
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function decodePart(value) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(value)));
}

async function getJwks() {
  if (jwksCache && Date.now() < jwksExpiry) return jwksCache;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] || 3600);
  jwksCache = await res.json();
  jwksExpiry = Date.now() + Math.max(300, maxAge - 60) * 1000;
  return jwksCache;
}

async function verifyJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (header.alg !== 'RS256') throw new Error('Unsupported token algorithm');

  const jwks = await getJwks();
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown token key');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) throw new Error('Invalid token signature');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error('Expired token');
  if (payload.iat > now + 300) throw new Error('Token issued in the future');
  if (payload.aud !== PROJECT_ID) throw new Error('Wrong token audience');
  if (payload.iss !== ISSUER) throw new Error('Wrong token issuer');
  if (!payload.sub || String(payload.sub).length > 128) throw new Error('Invalid token subject');
  return payload;
}

function configuredOrigins(env = {}) {
  const raw = env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '';
  const extra = String(raw)
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

function isLocalDevOrigin(origin) {
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch (e) {
    return false;
  }
}

export function isAllowedOrigin(origin, env = {}) {
  if (!origin) return true;
  if (configuredOrigins(env).has(origin)) return true;
  return env.ALLOW_LOCAL_ORIGINS === 'true' && isLocalDevOrigin(origin);
}

export function corsHeaders(request, env = {}, methods = 'GET, POST, OPTIONS') {
  const origin = request.headers.get('origin') || '';
  const allowOrigin = isAllowedOrigin(origin, env) && origin
    ? origin
    : DEFAULT_ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

export function rejectUntrustedOrigin(request, env = {}, methods = 'GET, POST, OPTIONS') {
  const origin = request.headers.get('origin') || '';
  if (isAllowedOrigin(origin, env)) return null;
  return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
    status: 403,
    headers: { ...corsHeaders(request, env, methods), 'Content-Type': 'application/json' },
  });
}

export function safeErrorResponse(request, env, error, status = 500, methods = 'GET, POST, OPTIONS') {
  console.error(error);
  return new Response(JSON.stringify({ error: 'Request failed. Please try again later.' }), {
    status,
    headers: { ...corsHeaders(request, env, methods), 'Content-Type': 'application/json' },
  });
}

function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  return header.match(/^Bearer\s+(.+)$/i)?.[1] || '';
}

function envList(value = '') {
  return new Set(String(value).split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
}

function isApprovedClaim(user, env = {}) {
  const email = String(user.email || '').toLowerCase();
  const uid = String(user.sub || user.user_id || '');
  const adminEmails = envList(`smmoon2030@gmail.com,${env.ADMIN_EMAILS || env.ADMIN_EMAIL || ''}`);
  const approvedEmails = envList(env.APPROVED_EMAILS || env.APPROVED_EMAIL || '');
  const approvedUids = envList(env.APPROVED_UIDS || env.APPROVED_UID || '');
  return user.admin === true
    || user.approved === true
    || adminEmails.has(email)
    || approvedEmails.has(email)
    || approvedUids.has(uid.toLowerCase());
}

function isGoogleAuthUser(user = {}) {
  return user.firebase?.sign_in_provider === 'google.com';
}

async function firestoreDocExists(path, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return false;
  if (res.status === 200) return true;
  throw new Error(`Firestore approval check HTTP ${res.status}`);
}

async function isApprovedInFirestore(user, token) {
  const email = String(user.email || '').trim().toLowerCase();
  const uid = String(user.sub || user.user_id || '').trim();
  if (uid && await firestoreDocExists(`admins/${encodeURIComponent(uid)}`, token)) return true;
  if (email && await firestoreDocExists(`approved_users/${encodeURIComponent(email)}`, token)) return true;
  if (uid && await firestoreDocExists(`approved_uids/${encodeURIComponent(uid)}`, token)) return true;
  return false;
}

export async function requireFirebaseUser(request, env = {}) {
  const token = bearerToken(request);
  if (!token) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: {
          ...corsHeaders(request, env),
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Content-Type': 'application/json',
        },
      }),
    };
  }
  try {
    return { ok: true, user: await verifyJwt(token) };
  } catch (e) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'Invalid authentication token' }), {
        status: 401,
        headers: {
          ...corsHeaders(request, env),
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Content-Type': 'application/json',
        },
      }),
    };
  }
}

export async function requireApprovedFirebaseUser(request, env = {}) {
  const auth = await requireFirebaseUser(request, env);
  if (!auth.ok) return auth;
  if (!isGoogleAuthUser(auth.user)) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'Google sign-in required' }), {
        status: 403,
        headers: {
          ...corsHeaders(request, env),
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Content-Type': 'application/json',
        },
      }),
    };
  }
  const token = bearerToken(request);
  try {
    if (isApprovedClaim(auth.user, env) || await isApprovedInFirestore(auth.user, token)) {
      return auth;
    }
  } catch (e) {
    console.warn('Approval check failed:', e.message);
  }
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: 'Approval required' }), {
      status: 403,
      headers: {
        ...corsHeaders(request, env),
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json',
      },
    }),
  };
}
