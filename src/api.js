const BASE = 'https://api.openparldata.ch/v1';

// Bewusst ohne Custom-Header: der CORS-Preflight der API beantwortet OPTIONS
// ohne Access-Control-Allow-Origin (live getestet 2026-07-23) — einfache
// GET-Requests ohne Zusatzheader brauchen keinen Preflight und funktionieren.
//
// Retry nur bei Netzwerkfehlern (inkl. Timeout), 5xx und 429 (transiente
// Probleme) — ein 4xx (z.B. 404 bei einem serverseitig gelöschten Geschäft)
// ist dauerhaft und wird durch Wiederholen nicht besser, kostet aber bei
// mehreren betroffenen Geschäften unnötig mehrere Minuten sequenzielles
// Warten (3 Versuche à 1/2/4s, je Treffer).
async function apiFetch(url, attempt = 0) {
  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return apiFetch(url, attempt + 1);
    }
    console.error('Netzwerkfehler bei', url, err);
    throw new Error('keine Verbindung zu OpenParlData, bitte Internetverbindung prüfen');
  }
  if (!res.ok) {
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return apiFetch(url, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} für ${url}`);
  }
  return await res.json();
}

export function affairsUrl(params) {
  const u = new URL(`${BASE}/affairs/`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set('lang', 'de');
  u.searchParams.set('lang_format', 'flat');
  u.searchParams.set('hide_null', 'true');
  return u.toString();
}

export function fetchPage(url) {
  return apiFetch(url);
}

// Einzelnes Geschäft per ID — die API liefert das Objekt direkt (kein data-Wrapper).
export async function fetchAffair(id) {
  const u = new URL(`${BASE}/affairs/${id}`);
  u.searchParams.set('lang', 'de');
  u.searchParams.set('lang_format', 'flat');
  u.searchParams.set('hide_null', 'true');
  return apiFetch(u.toString());
}

export async function fetchSub(affairId, sub) {
  const u = new URL(`${BASE}/affairs/${affairId}/${sub}`);
  u.searchParams.set('limit', '100');
  u.searchParams.set('lang', 'de');
  u.searchParams.set('lang_format', 'flat');
  u.searchParams.set('hide_null', 'true');
  const json = await apiFetch(u.toString());
  return json.data ?? [];
}
