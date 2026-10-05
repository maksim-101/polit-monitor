import * as db from '../db.js';
import { getApp, patchApp } from '../backup.js';
import { needsTriageInInbox } from '../sync.js';
import { esc, fmtDateTime, loadJoined, affairCard, wireTriage, triageOf } from './common.js';
import { emit, getLastStatus, isSyncing } from './bus.js';

const FIELD_LABELS = { state_name_de: 'Status', title_de: 'Titel', number: 'Nummer', end_date: 'Enddatum' };

// Überlebt den kompletten Re-Render nach jedem Triage-Klick — sonst klappt
// "Grenzfälle" bei jeder Einstufung wieder zu, weil <details> frisch gebaut wird.
let borderlineOpen = false;

export async function renderInbox(el) {
  const { affairs, annotations } = await loadJoined();
  const app = await getApp();
  const byId = new Map(affairs.map((a) => [a.id, a]));

  // Erststart: leerer Bestand → prominente Erstimport-Anzeige statt leerem Eingang.
  // Solange ein Sync läuft, wird der Text zusätzlich live über 'status'-Events
  // (app.js) direkt ins DOM gepatcht, ohne diesen Render erneut anzustossen.
  // Läuft KEIN Sync (Offline-Start, Fehler, oder Erfolg ohne Treffer), zeigt
  // dieser Render den letzten bekannten Status statt eines fest verdrahteten
  // "läuft noch"-Texts — sonst widerspricht das Panel der Statuszeile.
  if (!affairs.length) {
    const s = getLastStatus();
    // Beim allerersten Start rendert diese Ansicht oft, BEVOR runSync() den
    // Web-Lock gewonnen und 'sync-start' gefeuert hat — online und ohne jede
    // Statusmeldung steht der Erstimport aber unmittelbar bevor: Lauf-Panel
    // zeigen statt fälschlich «Noch keine Daten geladen» mit Retry-Knopf.
    const running = isSyncing() || (navigator.onLine && !s);
    const text = (typeof s === 'string' ? s : s?.text) || 'Verbinde mit OpenParlData';
    el.innerHTML = running
      ? `
      <div class="firstrun">
        <div class="spinner"></div>
        <h2>Erstimport läuft</h2>
        <p>Die App lädt einmalig den Bestand an politischen Geschäften: Stadt Zürich
        vollständig, Kanton Zürich und Bund per Stichwortsuche, sobald Stichwörter
        eingerichtet sind. Das dauert einige
        Minuten und passiert nur beim ersten Öffnen. Danach werden bei jedem Start
        nur noch Änderungen geholt (Sekundensache).</p>
        <div class="firstrun-track"><div class="firstrun-fill indeterminate" id="firstrun-bar"></div></div>
        <p class="muted" id="firstrun-status">${esc(text)}</p>
      </div>`
      : `
      <div class="firstrun">
        <h2>Noch keine Daten geladen</h2>
        <p class="muted" id="firstrun-status">${esc(text)}</p>
        <button class="btn btn-primary" id="firstrun-retry">Erneut versuchen</button>
      </div>`;
    el.querySelector('#firstrun-retry')?.addEventListener('click', () => emit('retry-sync'));
    return;
  }

  const fresh = affairs
    .filter((a) => a.category === 'treffer' && triageOf(annotations, a.id) === 'neu' && needsTriageInInbox(a))
    .sort((x, y) => (y.begin_date || '').localeCompare(x.begin_date || ''));
  const border = affairs
    .filter((a) => a.category === 'grenzfall' && triageOf(annotations, a.id) === 'neu' && needsTriageInInbox(a))
    .sort((x, y) => (y.begin_date || '').localeCompare(x.begin_date || ''));

  const since = app.lastInboxSeenAt || '';
  const changelog = (await db.getAll('changelog'))
    .filter((c) => c.type === 'update' && c.at > since && annotations.get(c.affairId)?.triage === 'beobachten')
    .sort((x, y) => y.at.localeCompare(x.at));

  // Neutral ausgelieferte App ohne Stichwörter: ohne Hinweis bliebe der Eingang
  // einfach für immer leer, und niemand wüsste warum.
  const profile = await db.getConfig('profile');
  const noTerms = !(profile.orgTerms?.length || profile.themes?.length);

  el.innerHTML = `
    ${
      noTerms
        ? `<section><p class="muted">Noch keine Stichwörter eingerichtet. Lege in den Einstellungen
           Themen und Begriffe an oder lade dort eine mitgelieferte Profildatei. Erst danach
           erscheinen hier Treffer.</p></section>`
        : ''
    }
    <section>
      <h2>Neue Treffer <span class="count">${fresh.length}</span></h2>
      ${fresh.length ? fresh.map((a) => affairCard(a, annotations)).join('') : '<p class="muted">Keine neuen Treffer, alles beurteilt.</p>'}
    </section>
    <section>
      <h2>Änderungen an beobachteten Geschäften <span class="count">${changelog.length}</span>
        ${changelog.length ? '<button class="btn btn-small" id="mark-seen">Als gelesen markieren</button>' : ''}
      </h2>
      ${
        changelog.length
          ? changelog
              .map((c) => {
                const a = byId.get(c.affairId);
                if (!a) return '';
                return `<div class="change-row">
                  <span class="muted">${fmtDateTime(c.at)}</span>
                  <a href="#/geschaeft/${a.id}">${esc(a.title_de || '')}</a>
                  <div class="change-detail">${(c.changes || [])
                    .map((ch) => `${FIELD_LABELS[ch.field] || esc(ch.field)}: «${esc(ch.alt ?? 'leer')}» → «${esc(ch.neu ?? 'leer')}»`)
                    .join(' · ')}</div>
                </div>`;
              })
              .join('')
          : '<p class="muted">Keine Änderungen seit dem letzten Besuch.</p>'
      }
    </section>
    <details class="borderline" ${borderlineOpen ? 'open' : ''}>
      <summary>Grenzfälle <span class="count">${border.length}</span> (schwache Treffer, zur Sicherheit prüfen)</summary>
      ${border.map((a) => affairCard(a, annotations)).join('') || '<p class="muted">Keine offenen Grenzfälle.</p>'}
    </details>
  `;

  wireTriage(el, () => emit('data'));
  el.querySelector('#mark-seen')?.addEventListener('click', async () => {
    await patchApp({ lastInboxSeenAt: new Date().toISOString() });
    emit('data');
  });
  el.querySelector('.borderline').addEventListener('toggle', (e) => {
    borderlineOpen = e.target.open;
  });
}

export async function inboxCount() {
  const { affairs, annotations } = await loadJoined();
  return affairs.filter((a) => a.category === 'treffer' && triageOf(annotations, a.id) === 'neu' && needsTriageInInbox(a)).length;
}
