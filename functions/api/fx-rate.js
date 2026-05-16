import { corsHeaders, rejectUntrustedOrigin, requireApprovedFirebaseUser, safeErrorResponse } from '../_shared/firebase-auth.js';

const METHODS = 'GET, OPTIONS';

const HANA_URL = 'https://www.kebhana.com/cms/rate/wpfxd651_01i_01.do';
const ONE_DAY = 24 * 60 * 60 * 1000;
let memoryCache = null;

function json(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request, env, METHODS), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function kstDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return { y: parts.year, m: parts.month, d: parts.day };
}

function ymd(date = new Date()) {
  const p = kstDateParts(date);
  return `${p.y}${p.m}${p.d}`;
}

function displayDate(raw) {
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function cleanText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(raw) {
  const n = Number(String(raw || '').replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/)?.[0] || 0);
  return Number.isFinite(n) ? n : 0;
}

function parseHanaFx(html, requestedDate) {
  const row = String(html || '').match(/<tbody>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>[\s\S]*?<\/tbody>/i)?.[1] || '';
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => cleanText(m[1]));
  const usdRow = cells[0] && /USD/i.test(cells[0]);
  const tts = usdRow ? parseNumber(cells[5]) : 0; // Hana: remittance sending, aka TTS.
  const ttb = usdRow ? parseNumber(cells[6]) : 0;
  const baseRate = usdRow ? parseNumber(cells[8]) : 0;
  if (!tts) return null;

  const text = cleanText(html);
  const announced = text.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s+(\d{1,2})시\s*(\d{1,2})분\s*(\d{1,2})초\s*\((\d+)회차\)/);
  const sourceDate = announced
    ? `${announced[1]}-${String(announced[2]).padStart(2, '0')}-${String(announced[3]).padStart(2, '0')}`
    : displayDate(requestedDate);
  const announcedAt = announced
    ? `${sourceDate} ${String(announced[4]).padStart(2, '0')}:${String(announced[5]).padStart(2, '0')}:${String(announced[6]).padStart(2, '0')}`
    : '';
  const round = announced ? Number(announced[7]) : 1;

  return {
    currency: 'USD',
    rate: tts,
    tts,
    ttb,
    baseRate,
    requestedDate: displayDate(requestedDate),
    sourceDate,
    announcedAt,
    round,
    source: 'Hana Bank first announcement TTS',
    stale: displayDate(requestedDate) !== sourceDate,
  };
}

async function fetchHanaFirstTts(dateYmd) {
  const dateDash = displayDate(dateYmd);
  const body = new URLSearchParams({
    ajax: 'true',
    curCd: 'USD',
    tmpInqStrDt: dateDash,
    pbldDvCd: '1',
    pbldSqn: '',
    hid_key_data: '',
    inqStrDt: dateYmd,
    inqKindCd: '1',
    hid_enc_data: '',
    requestTarget: 'searchContentDiv',
  });
  const res = await fetch(HANA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 WhaleTrackerPro',
      'Referer': 'https://www.kebhana.com/cms/rate/index.do?contentUrl=/cms/rate/wpfxd651_01i.do',
    },
    body,
  });
  if (!res.ok) throw new Error(`Hana FX HTTP ${res.status}`);
  return parseHanaFx(await res.text(), dateYmd);
}

export async function onRequest(context) {
  const { request, env } = context;
  const blocked = rejectUntrustedOrigin(request, env, METHODS);
  if (blocked) return blocked;
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request, env, METHODS) });
  if (request.method !== 'GET') return json(request, env, { error: 'GET only' }, 405);
  const auth = await requireApprovedFirebaseUser(request, env);
  if (!auth.ok) return auth.response;

  const today = ymd();
  if (memoryCache?.requestedDateRaw === today && Date.now() - memoryCache.cachedAt < 6 * 60 * 60 * 1000) {
    return json(request, env, memoryCache.data);
  }

  const start = new Date(`${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}T12:00:00+09:00`);
  const errors = [];
  for (let i = 0; i < 14; i += 1) {
    const target = ymd(new Date(start.getTime() - i * ONE_DAY));
    try {
      const data = await fetchHanaFirstTts(target);
      if (data?.rate) {
        data.requestedDate = displayDate(today);
        data.stale = target !== today || data.sourceDate !== displayDate(today);
        memoryCache = { requestedDateRaw: today, cachedAt: Date.now(), data };
        return json(request, env, data);
      }
    } catch (e) {
      errors.push(`${target}: ${e.message}`);
    }
  }
  return safeErrorResponse(request, env, new Error(`No USD TTS rate found: ${errors.join(' | ')}`), 502, METHODS);
}
