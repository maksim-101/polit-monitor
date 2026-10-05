import * as db from '../db.js';
import { fetchSub } from '../api.js';
import { compileProfile, scoreAffair } from '../matcher.js';
import { esc, fmtDate, bodyBadge, scoreBadge, setTriage, setNote, safeUrl, TRIAGE_LABELS, deadlineCell } from './common.js';
import { deadlineOf, deadlineSource } from '../deadline.js';
import { normalize } from '../matcher.js';
import { emit } from './bus.js';

// texts liefert rohes HTML einer externen Quelle — nie per innerHTML einbinden.
// Absätze/Zeilenumbrüche in Klartext wandeln, danach ganz normal esc()en.
function htmlToText(html) {
  return String(html || '')
    .replace(/<\/p\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function renderDetail(el, id) {
  const a = await db.get('affairs', id);
  if (!a) {
    el.innerHTML = '<div class="overlay-panel"><p>Geschäft nicht gefunden.</p></div>';
    return;
  }
  const ann = (await db.get('annotations', id)) || { triage: 'neu' };
  const profile = await db.getConfig('profile');
  const commissionNames = profile?.commissionBonus?.names || [];

  // Fehlende Details (Dokumente, Statusverlauf, Urheber — z.B. bei älteren
  // Archiv-Geschäften) bei Bedarf nachladen und am Geschäft cachen. Die Quellen
  // sind unabhängig: parallel laden, und ein einzelner Fehler (z.B. 404 bei
  // texts) darf die übrigen nicht verwerfen — Ansicht bleibt mit Cache nutzbar.
  const quiet = (p) => p.catch(() => null);
  const [docs, texts, eventsContribs] = await Promise.all([
    a.docs ? null : quiet(fetchSub(id, 'docs')),
    // texts: nur bei Bund bisher live beobachtet befüllt (Begründung/Eingereichter
    // Text) — bei Stadt/Kanton meist leer, steckt dort nur in den Dokumenten.
    a.texts ? null : quiet(fetchSub(id, 'texts')),
    a.events ? null : quiet(Promise.all([fetchSub(id, 'events'), fetchSub(id, 'contributors')])),
  ]);
  const patch = {};
  if (docs) patch.docs = docs;
  if (texts) patch.texts = texts;
  if (eventsContribs) [patch.events, patch.contributors] = eventsContribs;
  if (Object.keys(patch).length) {
    Object.assign(a, patch); // für die Anzeige unten
    try {
      // Nur die neu geladenen Felder auf den AKTUELLEN Datenbank-Stand anwenden
      // und DORT neu bewerten — nicht auf den zu Beginn gelesenen Snapshot: ein
      // zwischenzeitlicher Sync könnte Status/Score aktueller haben als oben.
      const fresh = (await db.get('affairs', id)) || a;
      Object.assign(fresh, patch);
      if (patch.events) {
        fresh.enrichedAt = fresh.updated_at;
        Object.assign(fresh, scoreAffair(fresh, compileProfile(profile)));
        Object.assign(a, { score: fresh.score, category: fresh.category, matchDetails: fresh.matchDetails });
      }
      await db.put('affairs', fresh);
    } catch {
      /* IndexedDB nicht schreibbar — Ansicht bleibt trotzdem nutzbar */
    }
  }

  const events = (a.events || []).slice().sort((x, y) => (x.position || 0) - (y.position || 0));
  const deadline = deadlineOf(a);
  const summaryText = (a.texts || []).find((t) => t.type_de === 'Begründung') || (a.texts || []).find((t) => t.type_de === 'Eingereichter Text');

  el.innerHTML = `
  <div class="overlay-bg"></div>
  <div class="overlay-panel" role="dialog" aria-modal="true" aria-labelledby="detail-title">
    <button class="overlay-close" title="Schliessen" aria-label="Schliessen">×</button>
    <div class="card-top">
      ${bodyBadge(a.body_key)}
      <span class="muted">${esc(a.number || '')} · ${esc(a.type_name_de || 'Geschäft')}</span>
      ${scoreBadge(a)}
    </div>
    <h2 class="detail-title" id="detail-title">${esc(a.title_de || '(ohne Titel)')}</h2>
    <div class="detail-meta">
      <span>Status: <strong>${esc(a.state_name_de || 'unbekannt')}</strong></span>
      <span>Eingereicht: ${fmtDate(a.begin_date)}</span>
      ${
        // Nur anzeigen, wenn wir selbst eine inhaltliche Änderung erkannt haben
        // (contentChangedAt) — das rohe API-updated_at springt auch bei reinen
        // Massen-Reimports ohne echte Änderung am Geschäft, siehe sync.js.
        a.contentChangedAt ? `<span>Letzte Änderung: ${fmtDate(a.contentChangedAt)}</span>` : ''
      }
      ${safeUrl(a.url_external_de) ? `<a href="${esc(safeUrl(a.url_external_de))}" target="_blank" rel="noopener">Originalquelle öffnen ↗</a>` : ''}
    </div>
    ${
      deadline
        ? `<p class="detail-deadline">Frist: ${deadlineCell(a)} <span class="muted">(${esc(deadlineSource(deadline))})</span></p>`
        : ''
    }

    ${
      // Nur Bund liefert das bisher live beobachtet — bei Stadt/Kanton bleibt
      // die Substanz in den PDF-Dokumenten unten, dafür gibt es dort nichts.
      summaryText
        ? `<div class="detail-summary">
            <h3>${esc(summaryText.type_de)}</h3>
            <p>${esc(htmlToText(summaryText.text_de)).replace(/\n/g, '<br>')}</p>
          </div>`
        : ''
    }

    <div class="detail-triage">
      ${['beobachten', 'irrelevant', 'neu']
        .map(
          (t) =>
            `<button class="btn ${ann.triage === t ? 'btn-primary' : ''}" data-triage="${t}">${t === 'neu' ? 'Unbeurteilt' : TRIAGE_LABELS[t]}</button>`
        )
        .join('')}
      <span class="muted">Aktuell: ${ann.triage === 'neu' ? 'Unbeurteilt' : TRIAGE_LABELS[ann.triage]}</span>
    </div>

    <h3>Warum dieser Treffer?</h3>
    ${
      (a.matchDetails || []).length
        ? `<ul class="match-list">${a.matchDetails
            .map((d) => {
              if (d.kind === 'thema') return `<li>Thema ${esc(d.theme)}: Begriff «${esc(d.term)}» (+${esc(d.points)})</li>`;
              if (d.kind === 'organisation') return `<li>Organisations-Nennung: «${esc(d.term)}» (+${esc(d.points)})</li>`;
              if (d.kind === 'kommission') return `<li>Läuft durch Kommission ${esc(d.term)} (+${esc(d.points)})</li>`;
              if (d.kind === 'ausschluss') return `<li>Ausschlusswort «${esc(d.term)}», Geschäft ausgeblendet</li>`;
              return '';
            })
            .join('')}</ul>`
        : '<p class="muted">Keine Stichwort-Treffer (z.B. über die Suche gefunden).</p>'
    }

    <h3>Statusverlauf</h3>
    ${
      events.length
        ? `<ol class="timeline">${events
            .map((e) => {
              const isCommission = commissionNames.some((n) => normalize(e.title_de).includes(normalize(n)));
              return `<li class="${isCommission ? 'tl-commission' : ''}">
                <span class="tl-date">${fmtDate(e.date)}</span>
                <span class="tl-title">${esc(e.title_de || e.title_harmonized || '')}</span>
              </li>`;
            })
            .join('')}</ol>`
        : '<p class="muted">Noch kein Statusverlauf geladen (wird beim nächsten Aktualisieren für Treffer nachgeladen).</p>'
    }

    <h3>Urheber und Mitunterzeichnende</h3>
    ${
      (a.contributors || []).length
        ? `<ul class="contributors">${a.contributors
            .map(
              (c) =>
                `<li>${esc(c.fullname || `${c.firstname || ''} ${c.lastname || ''}`.trim())}${c.party ? ` (${esc(c.party)})` : ''}${c.role ? `, ${esc(c.role)}` : ''}</li>`
            )
            .join('')}</ul>`
        : '<p class="muted">Keine Angaben geladen.</p>'
    }

    <h3>Dokumente</h3>
    ${
      (a.docs || []).length
        ? `<ul class="docs">${a.docs
            .map((d) => `<li><a href="${esc(safeUrl(d.url) || safeUrl(d.url_oparl) || '#')}" target="_blank" rel="noopener">${esc(d.name || 'Dokument')}</a> <span class="muted">${fmtDate(d.date)}</span></li>`)
            .join('')}</ul>`
        : '<p class="muted">Keine Dokumente gefunden.</p>'
    }

    <h3>Notiz</h3>
    <textarea id="detail-note" rows="3" placeholder="Eigene Notiz zu diesem Geschäft">${esc(ann.note || '')}</textarea>
  </div>`;

  el.querySelector('.overlay-close').addEventListener('click', () => history.back());
  el.querySelector('.overlay-bg').addEventListener('click', () => history.back());
  el.querySelector('.overlay-panel').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') history.back();
  });
  el.querySelector('.overlay-close').focus();
  el.querySelectorAll('button[data-triage]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await setTriage(id, btn.dataset.triage);
      emit('data');
      renderDetail(el, id);
    })
  );
  el.querySelector('#detail-note').addEventListener('change', async (e) => {
    await setNote(id, e.target.value.trim());
    emit('data');
  });
}
