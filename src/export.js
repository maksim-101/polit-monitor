import { BODY_LABELS } from './sync.js';
import { esc, fmtDate } from './ui/common.js';
import { deadlineOf, fmtDeadline, deadlineNote, deadlineSource } from './deadline.js';

// Dieselben Wörter wie in den Ansichten: 'neu' heisst überall «Unbeurteilt».
const TRIAGE_LABELS = { neu: 'Unbeurteilt', beobachten: 'Beobachten', irrelevant: 'Irrelevant' };

function deadlineText(a) {
  const d = deadlineOf(a);
  const text = fmtDeadline(d);
  if (!text) return '';
  const note = deadlineNote(d);
  return note ? `${text} (${note})` : text;
}

function contributorsText(a) {
  return (a.contributors || [])
    .map((c) => c.fullname || `${c.firstname || ''} ${c.lastname || ''}`.trim())
    .filter(Boolean)
    .join(', ');
}

function rowsFor(affairs, annotations) {
  const header = ['Ebene', 'Nummer', 'Typ', 'Titel', 'Status', 'Eingereicht', 'Frist', 'Frist Herkunft', 'Letzte Änderung', 'Urheber', 'Punkte', 'Einstufung', 'Notiz', 'Link'];
  const rows = affairs.map((a) => {
    const ann = annotations.get(a.id) || {};
    return [
      BODY_LABELS[a.body_key] || a.body_key,
      a.number || '',
      a.type_name_de || '',
      a.title_de || '',
      a.state_name_de || '',
      fmtDate(a.begin_date),
      deadlineText(a),
      deadlineSource(deadlineOf(a)),
      // Wie in Detail/Beobachtung: nur echte Inhaltsänderungen, nicht das von
      // Massen-Reimports verstempelte updated_at.
      fmtDate(a.contentChangedAt),
      contributorsText(a),
      a.score ?? '',
      TRIAGE_LABELS[ann.triage] || 'Unbeurteilt',
      ann.note || '',
      a.url_external_de || '',
    ];
  });
  return [header, ...rows];
}

export function exportXlsx(affairs, annotations, profileName) {
  const data = rowsFor(affairs, annotations);
  const ws = window.XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 13 }, { wch: 10 }, { wch: 20 }, { wch: 80 }, { wch: 15 }, { wch: 11 }, { wch: 22 }, { wch: 40 }, { wch: 11 }, { wch: 30 }, { wch: 7 }, { wch: 12 }, { wch: 30 }, { wch: 50 }];
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Geschäfte');
  const name = ['polit-monitor', (profileName || '').toLowerCase(), new Date().toISOString().slice(0, 10)]
    .filter(Boolean)
    .join('-');
  window.XLSX.writeFile(wb, `${name}.xlsx`);
}

export function openPrintReport(affairs, annotations, profile, subtitle) {
  const el = document.getElementById('print-report');
  const today = fmtDate(new Date().toISOString());
  const groups = ['261', 'ZH', 'CHE']
    .map((key) => ({ key, list: affairs.filter((a) => a.body_key === key) }))
    .filter((g) => g.list.length);

  el.innerHTML = `
    <div class="report-head">
      <div class="report-title">Polit-Monitor${profile.name ? ` ${esc(profile.name)}` : ''}</div>
      <div class="report-sub">${esc(subtitle)} · Stand ${today} · ${affairs.length} Geschäfte</div>
    </div>
    ${groups
      .map(
        (g) => `
      <h2>${esc(BODY_LABELS[g.key])}</h2>
      <table>
        <thead><tr><th>Nummer</th><th>Typ</th><th>Titel</th><th>Status</th><th>Eingereicht</th><th>Frist</th><th>Urheber</th><th>Notiz</th></tr></thead>
        <tbody>
          ${g.list
            .map((a) => {
              const ann = annotations.get(a.id) || {};
              return `<tr>
                <td>${esc(a.number)}</td>
                <td>${esc(a.type_name_de)}</td>
                <td>${esc(a.title_de)}</td>
                <td>${esc(a.state_name_de)}</td>
                <td>${fmtDate(a.begin_date)}</td>
                <td>${esc(deadlineText(a))}</td>
                <td>${esc(contributorsText(a))}</td>
                <td>${esc(ann.note || '')}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>`
      )
      .join('')}
    <div class="report-foot">Quelle: OpenParlData.ch (CC BY 4.0) · erstellt mit Polit-Monitor</div>
  `;
  window.print();
}
