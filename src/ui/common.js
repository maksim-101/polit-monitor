import * as db from '../db.js';
import { BODY_LABELS } from '../sync.js';
import { autoSave } from '../backup.js';
import { emit } from './bus.js';
import { deadlineOf, deadlineStatus, fmtDeadline, deadlineNote, deadlineSource, matchesDeadlineFilter, DEADLINE_FILTERS } from '../deadline.js';

// Jede Interpolation in Template-Literals MUSS durch esc() — Titel etc. sind Fremddaten.
export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Links aus API-Daten nur mit http(s)-Schema ausgeben (kein javascript: etc.).
export function safeUrl(u) {
  return /^https?:\/\//i.test(u || '') ? u : '';
}

// Datumswerte landen ungeescaped in HTML und können aus importierten Dateien
// stammen: nur echte ISO-Daten formatieren, alles andere ergibt ''.
export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

export function fmtDateTime(iso) {
  const t = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(iso || '');
  return t ? `${fmtDate(iso)} ${t[1]}` : fmtDate(iso);
}

export const TRIAGE_LABELS = { neu: 'Neu', beobachten: 'Beobachten', irrelevant: 'Irrelevant' };

export async function loadJoined() {
  const [affairs, annotations] = await Promise.all([db.getAll('affairs'), db.getAll('annotations')]);
  return { affairs, annotations: new Map(annotations.map((a) => [a.affairId, a])) };
}

export function triageOf(annotations, id) {
  return annotations.get(id)?.triage || 'neu';
}

// Alle Annotation-Schreibzugriffe laufen serialisiert über eine Kette:
// Notiz-Blur und Triage-Klick feuern sonst nebenläufige Read-Modify-Write-Zyklen
// auf demselben Datensatz, und der spätere überschreibt den früheren (Lost Update).
let annotationChain = Promise.resolve();

// Auto-Save nach Triage/Notiz debounced statt bei jedem einzelnen Klick:
// eine vollständige Sicherung (kompletter Store-Export + Datei-Schreibzugriff)
// bei jedem Klick würde eine Serie von Einstufungen spürbar verlangsamen.
let backupDebounce = null;
function scheduleAutoSave() {
  clearTimeout(backupDebounce);
  backupDebounce = setTimeout(async () => {
    try {
      const saved = await autoSave();
      if (saved === 'needs-permission') emit('backup-needs-permission');
    } catch (err) {
      // Datei gesperrt/verschoben/Platte voll: sichtbar melden statt als
      // unbehandelte Rejection zu versanden — die Datei bliebe sonst still veraltet.
      emit('status', `Automatisches Speichern in die Datei fehlgeschlagen: ${err.message}`);
    }
  }, 3000);
}

function updateAnnotation(id, patch) {
  const run = annotationChain.then(async () => {
    const existing = (await db.get('annotations', id)) || { affairId: id, triage: 'neu' };
    Object.assign(existing, patch, { updatedAt: new Date().toISOString() });
    await db.put('annotations', existing);
  });
  // Kette darf durch einen einzelnen Fehler nicht dauerhaft blockieren —
  // der Fehler geht trotzdem an den jeweiligen Aufrufer (run).
  annotationChain = run.catch(() => {});
  // Rejection-Handler: der Fehler gehört dem Aufrufer von run, nicht dieser
  // abgeleiteten Kette — ohne Handler endet sie als "Uncaught (in promise)".
  run.then(scheduleAutoSave, () => {});
  return run;
}

export function setTriage(id, triage) {
  return updateAnnotation(id, { triage });
}

export function setNote(id, note) {
  return updateAnnotation(id, { note });
}

export function bodyBadge(bodyKey) {
  return `<span class="badge badge-body body-${esc(bodyKey)}">${esc(BODY_LABELS[bodyKey] || bodyKey)}</span>`;
}

export function scoreBadge(a) {
  const detail = (a.matchDetails || [])
    .map((d) => {
      if (d.kind === 'thema') return `${d.theme}: «${d.term}» +${d.points}`;
      if (d.kind === 'organisation') return `Organisation: «${d.term}» +${d.points}`;
      if (d.kind === 'kommission') return `Kommission ${d.term} +${d.points}`;
      if (d.kind === 'ausschluss') return `Ausschlusswort «${d.term}»`;
      return '';
    })
    .join('\n');
  return `<span class="badge badge-score cat-${esc(a.category)}" title="${esc(detail || 'Keine Begriffs-Treffer')}">${esc(a.score ?? 0)} P.</span>`;
}

// Frist als Zelle/Chip: Datum plus Statuswort, Herkunft im Tooltip. Leer, wenn
// keine Frist bekannt ist (z.B. Statusverlauf noch nicht geladen).
export function deadlineCell(a) {
  const d = deadlineOf(a);
  const text = fmtDeadline(d);
  if (!text) return '';
  const note = deadlineNote(d);
  return `<span class="dl dl-${esc(deadlineStatus(d))}" title="${esc(deadlineSource(d))}">${esc(text)}${note ? ` <small>${esc(note)}</small>` : ''}</span>`;
}

export function deadlineFilterSelect(id, current) {
  return `<select id="${id}">${DEADLINE_FILTERS.map(([k, v]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
}

export function passesDeadlineFilter(a, key) {
  return matchesDeadlineFilter(deadlineOf(a), key);
}

export function affairCard(a, annotations, { showTriage = true } = {}) {
  const ann = annotations.get(a.id);
  return `
  <article class="card" data-id="${a.id}">
    <div class="card-top">
      ${bodyBadge(a.body_key)}
      <span class="muted">${esc(a.number || '')} · ${esc(a.type_name_de || 'Geschäft')}</span>
      ${scoreBadge(a)}
    </div>
    <a class="card-title" href="#/geschaeft/${a.id}">${esc(a.title_de || '(ohne Titel)')}</a>
    <div class="card-meta">
      <span>Status: <strong>${esc(a.state_name_de || 'unbekannt')}</strong></span>
      <span>Eingereicht: ${fmtDate(a.begin_date)}</span>
      ${deadlineCell(a) ? `<span>Frist: ${deadlineCell(a)}</span>` : ''}
      ${ann?.note ? `<span class="note-preview" title="${esc(ann.note)}">📝</span>` : ''}
    </div>
    ${
      showTriage
        ? `<div class="card-actions">
            <button class="btn btn-primary" data-triage="beobachten" data-id="${a.id}">Beobachten</button>
            <button class="btn" data-triage="irrelevant" data-id="${a.id}">Irrelevant</button>
          </div>`
        : ''
    }
  </article>`;
}

// Gemeinsamer Klick-Handler für Triage-Buttons in Listen. Wird EINMAL auf ein
// persistentes Container-Element registriert (nicht bei jedem Render neu) —
// sonst akkumulieren sich bei jedem Re-Render weitere Listener auf demselben
// Element. Alle Triage-Buttons im Container werden beim Klick sofort gesperrt,
// bis der Folge-Render (onDone) fertig ist: verhindert, dass ein zweiter Klick
// (z.B. Doppelklick) nach dem Reflow der Liste eine andere, inzwischen an
// dieselbe Stelle gerückte Karte trifft.
export function wireTriage(container, onDone) {
  if (container._triageWired) return;
  container._triageWired = true;
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-triage]');
    if (!btn || btn.disabled) return;
    const buttons = [...container.querySelectorAll('button[data-triage]')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await setTriage(Number(btn.dataset.id), btn.dataset.triage);
      onDone();
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      emit('status', `Einstufung konnte nicht gespeichert werden: ${err.message}`);
    }
  });
}
