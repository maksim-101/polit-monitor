import { esc, fmtDate, loadJoined, bodyBadge, scoreBadge, TRIAGE_LABELS, triageOf, deadlineCell, deadlineFilterSelect, passesDeadlineFilter } from './common.js';
import { deadlineOf, deadlineSortKey } from '../deadline.js';
import { normalize } from '../matcher.js';
import { exportXlsx, openPrintReport } from '../export.js';
import * as db from '../db.js';

const SORTS = {
  eingereicht: { label: 'Neuste zuerst', fn: (a, b) => (b.begin_date || '').localeCompare(a.begin_date || '') },
  frist: { label: 'Frist (nächste zuerst)', fn: (a, b) => deadlineSortKey(deadlineOf(a)).localeCompare(deadlineSortKey(deadlineOf(b))) },
};

const state = { q: '', body: '', typ: '', status: '', triage: '', frist: '', von: '', bis: '', sort: 'eingereicht' };
let debounceTimer = null;

function applyFilters(affairs, annotations) {
  const qn = normalize(state.q);
  return affairs
    .filter((a) => {
      if (state.body && a.body_key !== state.body) return false;
      if (state.typ && (a.type_name_de || '') !== state.typ) return false;
      if (state.status && (a.state_name_de || '') !== state.status) return false;
      if (state.triage && triageOf(annotations, a.id) !== state.triage) return false;
      if (state.von && (a.begin_date || '') < state.von) return false;
      if (state.bis && (a.begin_date || '9999') > `${state.bis}T23:59:59`) return false;
      if (qn && !normalize(`${a.title_de || ''} ${a.number || ''}`).includes(qn)) return false;
      if (state.frist && !passesDeadlineFilter(a, state.frist)) return false;
      return true;
    })
    .sort(SORTS[state.sort].fn);
}

export async function renderSearch(el) {
  const { affairs, annotations } = await loadJoined();
  const statuses = [...new Set(affairs.map((a) => a.state_name_de).filter(Boolean))].sort();
  const types = [...new Set(affairs.map((a) => a.type_name_de).filter(Boolean))].sort();
  const list = applyFilters(affairs, annotations);

  el.innerHTML = `
    <div class="toolbar toolbar-wrap">
      <input type="search" id="s-q" placeholder="Suche in Titel und Nummer" value="${esc(state.q)}" class="grow" />
      <select id="s-body">
        <option value="">Alle Ebenen</option>
        <option value="261" ${state.body === '261' ? 'selected' : ''}>Stadt Zürich</option>
        <option value="ZH" ${state.body === 'ZH' ? 'selected' : ''}>Kanton Zürich</option>
        <option value="CHE" ${state.body === 'CHE' ? 'selected' : ''}>Bund</option>
      </select>
      <select id="s-typ">
        <option value="">Alle Typen</option>
        ${types.map((t) => `<option value="${esc(t)}" ${state.typ === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
      <select id="s-status">
        <option value="">Alle Status</option>
        ${statuses.map((s) => `<option value="${esc(s)}" ${state.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <select id="s-triage">
        <option value="">Alle Einstufungen</option>
        ${Object.entries(TRIAGE_LABELS)
          .map(([k, v]) => `<option value="${k}" ${state.triage === k ? 'selected' : ''}>${k === 'neu' ? 'Unbeurteilt' : v}</option>`)
          .join('')}
      </select>
      ${deadlineFilterSelect('s-frist', state.frist)}
      <div class="date-range">
        <label>von <input type="date" id="s-von" value="${esc(state.von)}" /></label>
        <label>bis <input type="date" id="s-bis" value="${esc(state.bis)}" /></label>
      </div>
    </div>
    <div class="toolbar">
      <span class="muted">${list.length} von ${affairs.length} gespeicherten Geschäften</span>
      <label>Sortierung
        <select id="s-sort">
          ${Object.entries(SORTS)
            .map(([k, s]) => `<option value="${k}" ${k === state.sort ? 'selected' : ''}>${s.label}</option>`)
            .join('')}
        </select>
      </label>
      <span class="spacer"></span>
      <button class="btn" id="s-xlsx" ${list.length ? '' : 'disabled'}>Excel exportieren</button>
      <button class="btn" id="s-pdf" ${list.length ? '' : 'disabled'}>PDF exportieren</button>
    </div>
    <div class="table-wrap">
      <table class="list">
        <thead><tr><th>Ebene</th><th>Nummer</th><th>Typ</th><th>Titel</th><th>Status</th><th>Eingereicht</th><th>Frist</th><th></th></tr></thead>
        <tbody>
          ${list
            .slice(0, 500)
            .map(
              (a) => `<tr>
                <td>${bodyBadge(a.body_key)}</td>
                <td class="nowrap">${esc(a.number || '')}</td>
                <td>${esc(a.type_name_de || '')}</td>
                <td><a href="#/geschaeft/${a.id}">${esc(a.title_de || '')}</a></td>
                <td>${esc(a.state_name_de || 'unbekannt')}</td>
                <td class="nowrap">${fmtDate(a.begin_date)}</td>
                <td class="nowrap">${deadlineCell(a)}</td>
                <td>${scoreBadge(a)}</td>
              </tr>`
            )
            .join('')}
          ${list.length ? '' : '<tr><td colspan="8" class="muted">Keine Geschäfte passen zu den Filtern.</td></tr>'}
        </tbody>
      </table>
    </div>
    ${list.length > 500 ? '<p class="muted">Nur die ersten 500 Resultate werden angezeigt, bitte Filter verfeinern.</p>' : ''}
    <p class="muted">Fristen sind nur bekannt, wo der Statusverlauf geladen ist (Treffer, Grenzfälle, Beobachtete, geöffnete Detailansichten) oder sich aus der Geschäftsart ergibt (Schriftliche Anfrage, Interpellation). Die Suche selbst prüft nur Titel und Nummer, nicht den Volltext der Dokumente.</p>
  `;

  // renderSearch ersetzt das komplette Panel inkl. Sucheingabe — ohne Fokus-
  // Wiederherstellung verliert das Suchfeld bei jedem (debounced) Re-Render
  // den Fokus samt Cursor-Position, sobald man beim Tippen kurz pausiert.
  const rerender = async () => {
    const active = document.activeElement;
    const focusId = el.contains(active) ? active.id : null;
    const selStart = active?.selectionStart;
    const selEnd = active?.selectionEnd;
    await renderSearch(el);
    const restored = focusId && document.getElementById(focusId);
    if (restored) {
      restored.focus();
      if (selStart != null && restored.setSelectionRange) {
        try {
          restored.setSelectionRange(selStart, selEnd);
        } catch {
          /* nicht bei allen Input-Typen unterstützt (z.B. type=date) */
        }
      }
    }
  };
  el.querySelector('#s-q').addEventListener('input', (e) => {
    state.q = e.target.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(rerender, 300);
  });
  for (const [id, key] of [['s-body', 'body'], ['s-typ', 'typ'], ['s-status', 'status'], ['s-triage', 'triage'], ['s-frist', 'frist'], ['s-von', 'von'], ['s-bis', 'bis'], ['s-sort', 'sort']]) {
    el.querySelector(`#${id}`).addEventListener('change', (e) => {
      state[key] = e.target.value;
      rerender();
    });
  }
  el.querySelector('#s-xlsx')?.addEventListener('click', async () => {
    const profile = await db.getConfig('profile');
    exportXlsx(list, annotations, profile.name);
  });
  el.querySelector('#s-pdf')?.addEventListener('click', async () => {
    const profile = await db.getConfig('profile');
    openPrintReport(list, annotations, profile, 'Suchergebnis');
  });
}
