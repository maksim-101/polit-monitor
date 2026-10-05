import { affairsUrl, fetchPage, fetchSub, fetchAffair } from './api.js';
import * as db from './db.js';
import { compileProfile, scoreAffair, searchTerms } from './matcher.js';
import { isClosed } from './deadline.js';

export const BODY_LABELS = { 261: 'Stadt Zürich', ZH: 'Kanton Zürich', CHE: 'Bund' };

const WINDOW_DAYS = 730;
const INBOX_RECENT_DAYS = 90;

function nowIso() {
  return new Date().toISOString();
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

// Die API kennt keine Datumsbereichs-Filter (unbekannte Parameter werden
// ignoriert, live geprüft 2026-07-23) — das Zeitfenster wird clientseitig gezogen.
export function windowCutoff() {
  return isoDaysAgo(WINDOW_DAYS);
}

// API-Zeitstempel sind naive Strings ("2026-07-22T17:28:45") — für den
// Delta-Cutoff eine Stunde Überlappung abziehen, ohne Zeitzonen-Umrechnung.
function minusOneHour(naive) {
  const [d, t] = naive.split('T');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, m, s] = t.split(':').map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h - 1, m, s)).toISOString().slice(0, 19);
}

// «Noch laufend»-Kriterium ist Body-abhängig: nur Stadt Zürich (261) kennt
// den Statuswert 'InBearbeitung' — Kanton/Bund führen andere Vokabulare
// ('Erledigt', 'Überwiesen an den Bundesrat' …), dort zählt nur das Zeitfenster.
export function isCurrent(affair, cutoff) {
  const inWindow = (affair.begin_date || '') >= cutoff;
  return affair.body_key === '261' ? inWindow || affair.state_name_de === 'InBearbeitung' : inWindow;
}

// Eingang-spezifisch, enger als isCurrent(): ein "neuer Treffer" braucht nur
// dann eine Triage, wenn er (body-genau via isClosed) noch nicht abgeschlossen
// ist oder erst kürzlich eingereicht wurde. Ein vor Jahresfrist abgeschlossenes
// Geschäft, das (z.B. nach einer Profil-Änderung) zum ersten Mal matcht, taugt
// nicht mehr als "neu" — es bleibt über Suche & Archiv auffindbar, muss aber
// niemand mehr beurteilen.
export function needsTriageInInbox(affair) {
  if (!isClosed(affair)) return true;
  return (affair.begin_date || '') >= isoDaysAgo(INBOX_RECENT_DAYS);
}

async function getState(scope) {
  return (
    (await db.get('syncState', scope)) || {
      scope,
      initialImportDone: false,
      lastUpdatedAtSeen: null,
      lastSyncAt: null,
      resumeCursor: null,
    }
  );
}

async function loadCache() {
  const [affairs, annotations] = await Promise.all([db.getAll('affairs'), db.getAll('annotations')]);
  return {
    affairs: new Map(affairs.map((a) => [a.id, a])),
    annotations: new Map(annotations.map((a) => [a.affairId, a])),
  };
}

// Upsert einer API-Seite in den Bestand. onlyMatches: bei Kanton/Bund werden
// neue Nicht-Treffer nicht gespeichert (Suchresultate wären sonst Datenmüll) —
// bereits gespeicherte Geschäfte werden immer aktualisiert.
async function applyPage(data, cache, compiled, { onlyMatches = false } = {}) {
  const now = nowIso();
  const changed = [];
  const logs = [];
  let maxUpdated = '';
  let newCount = 0;

  for (const a of data) {
    if (a.updated_at && a.updated_at > maxUpdated) maxUpdated = a.updated_at;
    const existing = cache.affairs.get(a.id);
    const merged = existing
      ? {
          ...existing,
          ...a,
          events: existing.events,
          contributors: existing.contributors,
          docs: existing.docs,
          texts: existing.texts,
          enrichedAt: existing.enrichedAt,
        }
      : { ...a };
    Object.assign(merged, scoreAffair(merged, compiled));

    if (!existing) {
      if (onlyMatches && merged.category === 'kein') continue;
      if (merged.category !== 'kein') {
        logs.push({ affairId: a.id, at: now, type: 'neu' });
        // Zählt nur, was auch wirklich im Eingang auftaucht (needsTriageInInbox) —
        // sonst widerspricht die "X neue Treffer"-Meldung der tatsächlichen Anzahl.
        if (needsTriageInInbox(merged)) newCount++;
      }
      changed.push(merged);
      cache.affairs.set(a.id, merged);
      continue;
    }

    const diffs = [];
    if (existing.updated_at !== a.updated_at) {
      for (const f of ['state_name_de', 'title_de', 'number', 'end_date']) {
        if ((existing[f] ?? null) !== (a[f] ?? null)) diffs.push({ field: f, alt: existing[f] ?? null, neu: a[f] ?? null });
      }
    }
    // OpenParlData bumpt updated_at auch bei reinen Massen-Reimports ohne echte
    // Inhaltsänderung (live geprüft: >8'900 von ~9'500 Stadt-Geschäften mit
    // identischem Zeitstempel). contentChangedAt wird deshalb NUR bei einer
    // tatsächlichen Feld-Differenz aktualisiert — die Detailansicht zeigt so nie
    // ein Änderungsdatum, zu dem nichts im Verlauf sichtbar ist.
    if (diffs.length) merged.contentChangedAt = a.updated_at;
    const relevant = merged.category !== 'kein' || cache.annotations.get(a.id)?.triage === 'beobachten';
    if (diffs.length && relevant) logs.push({ affairId: a.id, at: now, type: 'update', changes: diffs });

    if (existing.updated_at !== a.updated_at || existing.score !== merged.score || existing.category !== merged.category) {
      changed.push(merged);
    }
    cache.affairs.set(a.id, merged);
  }

  if (changed.length) await db.putAll('affairs', changed);
  if (logs.length) await db.putAll('changelog', logs);
  return { maxUpdated, newCount };
}

// Delta-Scan: neueste Änderungen holen, bis die älteste auf der aktuellen
// Seite vor lastUpdatedAtSeen liegt. Nur für die Stadt sinnvoll (deshalb '261'
// fest verdrahtet statt als Parameter) — Kanton/Bund sind ungeeignet, deren
// nächtliche Massen-Reimporte stempeln zehntausende updated_at neu.
async function deltaScan(lastUpdatedAtSeen, compiled, cache, onStatus, label) {
  const cutoff = lastUpdatedAtSeen ? minusOneHour(lastUpdatedAtSeen) : '';
  let maxUpdated = lastUpdatedAtSeen || '';
  let newCount = 0;
  let offset = 0;
  let done = false;
  while (!done) {
    onStatus(`${label} (${offset} geprüft)`);
    const page = await fetchPage(affairsUrl({ body_key: '261', limit: 100, sort_by: '-updated_at', offset }));
    const data = page.data ?? [];
    const r = await applyPage(data, cache, compiled);
    if (r.maxUpdated > maxUpdated) maxUpdated = r.maxUpdated;
    newCount += r.newCount;
    offset += data.length;
    const oldest = data.length ? data[data.length - 1].updated_at : '';
    done = !page.meta?.has_more || data.length === 0 || (cutoff && oldest && oldest <= cutoff);
  }
  return { maxUpdated, newCount };
}

async function syncStadt(compiled, cache, onStatus) {
  const st = await getState('261');
  let maxUpdated = st.lastUpdatedAtSeen || '';
  let newCount = 0;

  if (!st.initialImportDone) {
    // Vollimport aller Stadt-Geschäfte (ab 2009): überschaubare Menge und
    // zugleich das Archiv für die Suche. Der Eingang zeigt trotzdem nur
    // Neues aus dem Zeitfenster bzw. Laufendes.
    let offset = st.resumeCursor?.offset ?? 0;
    let hasMore = true;
    let total = null;
    while (hasMore) {
      onStatus(
        `Stadt Zürich: Erstimport, ${offset}${total ? ` von ${total}` : ''} Geschäften geladen`,
        total ? offset / total : null
      );
      const page = await fetchPage(affairsUrl({ body_key: '261', limit: 500, sort_by: 'id', offset }));
      total = page.meta?.total_records ?? total;
      const data = page.data ?? [];
      const r = await applyPage(data, cache, compiled);
      if (r.maxUpdated > maxUpdated) maxUpdated = r.maxUpdated;
      newCount += r.newCount;
      offset += data.length;
      hasMore = page.meta?.has_more && data.length > 0;
      st.resumeCursor = { offset };
      await db.put('syncState', st);
    }
    st.initialImportDone = true;
    st.resumeCursor = null;
  } else {
    const r = await deltaScan(st.lastUpdatedAtSeen, compiled, cache, onStatus, 'Stadt Zürich: Änderungen prüfen');
    if (r.maxUpdated > maxUpdated) maxUpdated = r.maxUpdated;
    newCount += r.newCount;
  }

  st.lastUpdatedAtSeen = maxUpdated || st.lastUpdatedAtSeen;
  st.lastSyncAt = nowIso();
  await db.put('syncState', st);
  return newCount;
}

async function syncSearch(scope, compiled, cache, onStatus) {
  const st = await getState(scope);
  const terms = searchTerms(compiled.profile);
  const cutoff = windowCutoff();
  let maxUpdated = st.lastUpdatedAtSeen || '';
  let newCount = 0;
  const seen = new Set();

  for (let i = 0; i < terms.length; i++) {
    onStatus(`${BODY_LABELS[scope]}: Stichwortsuche «${terms[i]}» (${i + 1}/${terms.length})`, i / terms.length);
    let offset = 0;
    let hasMore = true;
    while (hasMore && offset < 1000) {
      const page = await fetchPage(
        affairsUrl({
          body_key: scope,
          search: terms[i],
          search_mode: 'partial',
          search_scope: 'metadata',
          search_language: 'de',
          sort_by: '-begin_date',
          limit: 100,
          offset,
        })
      );
      // Nur tatsächlich verarbeitete Treffer gelten als «gesehen» — ein
      // Suchtreffer ausserhalb des Fensters wird hier nicht aktualisiert und
      // muss deshalb für den Einzel-Refresh weiter als fehlend zählen.
      const data = page.data ?? [];
      const inWindow = data.filter((a) => (a.begin_date || '') >= cutoff);
      inWindow.forEach((a) => seen.add(a.id));
      const r = await applyPage(inWindow, cache, compiled, { onlyMatches: true });
      if (r.maxUpdated > maxUpdated) maxUpdated = r.maxUpdated;
      newCount += r.newCount;
      offset += data.length;
      const oldest = data.length ? data[data.length - 1].begin_date || '' : '';
      hasMore = page.meta?.has_more && data.length > 0 && (!oldest || oldest >= cutoff);
    }
  }

  // Gespeicherte Geschäfte, die die aktuelle Suche nicht mehr zurückgibt
  // (aus dem Fenster gefallen oder Suchbegriffe nach Profiländerung geändert),
  // einzeln per ID aktualisieren, damit sie nicht einfrieren. Ein Delta-Scan
  // wie bei der Stadt taugt hier nicht: die nächtlichen Massen-Reimporte von
  // Kanton/Bund stempeln zehntausende updated_at neu (live geprüft 2026-07-24).
  const toRefresh = [...cache.affairs.values()].filter(
    (a) =>
      a.body_key === scope &&
      !seen.has(a.id) &&
      (cache.annotations.get(a.id)?.triage === 'beobachten' || (a.category !== 'kein' && isCurrent(a, cutoff)))
  );
  for (let i = 0; i < toRefresh.length; i++) {
    onStatus(
      `${BODY_LABELS[scope]}: gespeicherte Geschäfte einzeln aktualisieren (${i + 1}/${toRefresh.length})`,
      i / toRefresh.length
    );
    try {
      const fresh = await fetchAffair(toRefresh[i].id);
      const r = await applyPage([fresh], cache, compiled);
      if (r.maxUpdated > maxUpdated) maxUpdated = r.maxUpdated;
    } catch {
      // Einzelnes Geschäft nicht erreichbar (z.B. serverseitig entfernt) —
      // Bestand bleibt stehen, nächster Sync versucht es erneut.
    }
  }

  st.initialImportDone = true;
  st.lastUpdatedAtSeen = maxUpdated || st.lastUpdatedAtSeen;
  st.lastSyncAt = nowIso();
  await db.put('syncState', st);
  return newCount;
}

// Details (Statusverlauf, Urheber) nur für Treffer/Grenzfälle nachladen.
// enrichedAt speichert das updated_at, für das angereichert wurde —
// zeitzonenfest: neu anreichern, sobald sich updated_at unterscheidet.
async function enrich(compiled, cache, onStatus) {
  const cutoff = windowCutoff();
  const cand = [...cache.affairs.values()].filter(
    (a) =>
      a.category !== 'kein' &&
      a.updated_at !== a.enrichedAt &&
      (isCurrent(a, cutoff) || cache.annotations.get(a.id)?.triage === 'beobachten')
  );
  let i = 0;
  let failed = 0;
  let succeeded = 0;
  let lastErr = null;
  const worker = async () => {
    while (i < cand.length) {
      const a = cand[i++];
      onStatus(`Details laden: ${i}/${cand.length}`, i / cand.length);
      let events, contributors;
      try {
        [events, contributors] = await Promise.all([fetchSub(a.id, 'events'), fetchSub(a.id, 'contributors')]);
      } catch (err) {
        if (/^HTTP 4(?!29)\d\d/.test(err.message)) {
          // Dauerhaft fehlende Unterressource: als «ohne Details» abschliessen,
          // sonst meldet jeder Abgleich denselben Fehler erneut.
          events = [];
          contributors = [];
        } else {
          // Ein einzelnes Geschäft ohne Details darf den Lauf nicht abbrechen; ohne
          // enrichedAt versucht der nächste Abgleich es erneut. Scheitern schon die
          // ersten Abrufe (offline), nicht jedes Geschäft einzeln durchprobieren.
          failed++;
          lastErr = err;
          if (!succeeded && failed >= 3) i = cand.length;
          continue;
        }
      }
      succeeded++;
      // Zwischen Seitenladen und hier kann derselbe Sync den Datensatz schon
      // erneut geschrieben haben (Delta-Scan/Einzel-Refresh) — auf dem
      // aktuellen Stand aufsetzen statt ihn zu überschreiben.
      const fresh = (await db.get('affairs', a.id)) || a;
      fresh.events = events;
      fresh.contributors = contributors;
      fresh.enrichedAt = a.updated_at;
      Object.assign(fresh, scoreAffair(fresh, compiled));
      await db.put('affairs', fresh);
      Object.assign(a, fresh);
    }
  };
  await Promise.all([worker(), worker()]);
  if (failed && !succeeded) throw new Error(`nicht geladen (${lastErr.message})`);
  if (failed) throw new Error(`${failed} ${failed === 1 ? 'Geschäft' : 'Geschäfte'} ohne Details (${lastErr.message})`);
}

export async function syncAll(profile, onStatus) {
  const compiled = compileProfile(profile);
  const cache = await loadCache();
  const errors = [];
  let newCount = 0;

  const run = async (label, fn) => {
    try {
      newCount += (await fn()) || 0;
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
    }
  };

  if (profile.bodies['261']) await run('Stadt Zürich', () => syncStadt(compiled, cache, onStatus));
  if (profile.bodies.ZH) await run('Kanton Zürich', () => syncSearch('ZH', compiled, cache, onStatus));
  if (profile.bodies.CHE) await run('Bund', () => syncSearch('CHE', compiled, cache, onStatus));
  await run('Details', () => enrich(compiled, cache, onStatus));

  return { errors, newCount };
}

// Nach Profiländerung: gesamten lokalen Bestand neu bewerten, ohne API.
export async function rematchAll(profile) {
  const compiled = compileProfile(profile);
  const affairs = await db.getAll('affairs');
  const changed = [];
  for (const a of affairs) {
    const r = scoreAffair(a, compiled);
    if (r.score !== a.score || r.category !== a.category) changed.push(Object.assign(a, r));
  }
  if (changed.length) await db.putAll('affairs', changed);
  return changed.length;
}
