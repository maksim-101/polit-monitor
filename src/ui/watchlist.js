import { esc, fmtDate, loadJoined, bodyBadge, scoreBadge, deadlineCell, deadlineFilterSelect, passesDeadlineFilter } from './common.js';
import { deadlineOf, deadlineSortKey } from '../deadline.js';
import { exportXlsx, openPrintReport } from '../export.js';
import * as db from '../db.js';

// «Letzte Änderung» nutzt contentChangedAt, nicht das rohe updated_at: die
// nächtlichen Massen-Reimports von OpenParlData stempeln updated_at bei fast
// allen Geschäften identisch neu, ohne echte Änderung (siehe sync.js/README).
const SORTS = {
  frist: { label: 'Frist (nächste zuerst)', fn: (a, b) => deadlineSortKey(deadlineOf(a)).localeCompare(deadlineSortKey(deadlineOf(b))) },
  aktualisiert: { label: 'Letzte Änderung', fn: (a, b) => (b.contentChangedAt || '').localeCompare(a.contentChangedAt || '') },
  eingereicht: { label: 'Einreichedatum', fn: (a, b) => (b.begin_date || '').localeCompare(a.begin_date || '') },
  status: { label: 'Status', fn: (a, b) => (a.state_name_de || '').localeCompare(b.state_name_de || '') },
  punkte: { label: 'Punkte', fn: (a, b) => (b.score || 0) - (a.score || 0) },
};

let sortKey = 'frist';
let deadlineFilter = '';

export async function renderWatchlist(el) {
  const { affairs, annotations } = await loadJoined();
  const watched = affairs.filter((a) => annotations.get(a.id)?.triage === 'beobachten');
  const list = watched.filter((a) => passesDeadlineFilter(a, deadlineFilter)).sort(SORTS[sortKey].fn);

  el.innerHTML = `
    <div class="toolbar">
      <h2>Beobachtete Geschäfte <span class="count">${list.length}${list.length !== watched.length ? ` von ${watched.length}` : ''}</span></h2>
      <label>Sortierung
        <select id="wl-sort">
          ${Object.entries(SORTS)
            .map(([k, s]) => `<option value="${k}" ${k === sortKey ? 'selected' : ''}>${s.label}</option>`)
            .join('')}
        </select>
      </label>
      <label>Frist ${deadlineFilterSelect('wl-frist', deadlineFilter)}</label>
      <span class="spacer"></span>
      <button class="btn" id="wl-xlsx" ${list.length ? '' : 'disabled'}>Excel exportieren</button>
      <button class="btn" id="wl-pdf" ${list.length ? '' : 'disabled'}>PDF exportieren</button>
    </div>
    ${
      list.length
        ? `<div class="table-wrap">
          <table class="list">
            <thead><tr><th>Ebene</th><th>Nummer</th><th>Typ</th><th>Titel</th><th>Status</th><th>Frist</th><th>Geändert</th><th></th></tr></thead>
            <tbody>
              ${list
                .map((a) => {
                  const ann = annotations.get(a.id);
                  return `<tr>
                    <td>${bodyBadge(a.body_key)}</td>
                    <td class="nowrap">${esc(a.number || '')}</td>
                    <td>${esc(a.type_name_de || '')}</td>
                    <td><a href="#/geschaeft/${a.id}">${esc(a.title_de || '')}</a>${ann?.note ? ` <span title="${esc(ann.note)}">📝</span>` : ''}</td>
                    <td>${esc(a.state_name_de || 'unbekannt')}</td>
                    <td class="nowrap">${deadlineCell(a)}</td>
                    <td class="nowrap">${fmtDate(a.contentChangedAt)}</td>
                    <td>${scoreBadge(a)}</td>
                  </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>`
        : watched.length
          ? '<p class="muted">Kein beobachtetes Geschäft passt zum Fristfilter.</p>'
          : '<p class="muted">Noch nichts beobachtet. Stufe Treffer im Eingang als «Beobachten» ein.</p>'
    }
    ${watched.length ? '<p class="muted">Fristen werden aus dem Statusverlauf abgeleitet (Stadt: Überweisung plus 24 Monate, Schriftliche Anfrage 3 und Interpellation 6 Monate ab Einreichung). Die Herkunft steht beim Überfahren mit der Maus und in der Detailansicht.</p>' : ''}
  `;

  el.querySelector('#wl-sort').addEventListener('change', (e) => {
    sortKey = e.target.value;
    renderWatchlist(el);
  });
  el.querySelector('#wl-frist').addEventListener('change', (e) => {
    deadlineFilter = e.target.value;
    renderWatchlist(el);
  });
  el.querySelector('#wl-xlsx')?.addEventListener('click', async () => {
    const profile = await db.getConfig('profile');
    exportXlsx(list, annotations, profile.name);
  });
  el.querySelector('#wl-pdf')?.addEventListener('click', async () => {
    const profile = await db.getConfig('profile');
    openPrintReport(list, annotations, profile, 'Beobachtete Geschäfte');
  });
}
