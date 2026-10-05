import * as db from '../db.js';
import { rematchAll } from '../sync.js';
import { compileProfile, parseTerm, matchText, termRe } from '../matcher.js';
import {
  backupStatus,
  downloadBackup,
  importBackup,
  parseProfileImport,
  fsSupported,
  saveAs,
  unbindFile,
  autoSave,
} from '../backup.js';
import { esc, fmtDateTime, loadJoined } from './common.js';
import { emit } from './bus.js';

// Einmal-Meldung, die den durch emit('data') ausgelösten Re-Render der Seite
// überlebt (direktes Setzen von #p-msg würde sofort wieder weggerendert).
let flashMsg = '';
// Ungespeicherte Profil-Eingaben; app.js rendert die Seite dann nach einem Abgleich nicht neu.
let dirty = false;

export function settingsDirty() {
  return dirty;
}

function themeFieldset(th = { label: '', weight: 10, terms: [] }) {
  return `
  <fieldset class="theme">
    <div class="theme-head">
      <label>Thema <input type="text" class="th-label" value="${esc(th.label)}" placeholder="z.B. Parkanlagen" /></label>
      <label>Gewicht <input type="number" class="th-weight" value="${th.weight}" min="1" max="99" /></label>
      <button type="button" class="btn btn-small th-remove" title="Wirkt erst nach «Profil übernehmen»">Entfernen</button>
    </div>
    <textarea class="th-terms terms" rows="3" placeholder="Ein Begriff pro Zeile. Stern am Ende = Wortanfang (baum* trifft Baumschutz), mehrere Wörter = zusammenhängende Phrase.">${esc((th.terms || []).join('\n'))}</textarea>
    <div class="preview muted"></div>
  </fieldset>`;
}

export async function renderSettings(el) {
  const profile = await db.getConfig('profile');
  const { affairs } = await loadJoined();
  const texts = affairs.map((a) => matchText(a));
  const bs = await backupStatus();

  el.innerHTML = `
  <section class="panel" id="p-panel">
    <h2>Profil</h2>
    <p class="muted">Das Profil bestimmt, welche Geschäfte als Treffer gelten. «Übernehmen» wendet
    Änderungen sofort in der App an; in eine Datei gesichert wird das Profil zusammen mit allen
    Daten im Abschnitt «Alles speichern und weitergeben» unten.</p>
    <p class="muted">Statt alles einzutippen: <button type="button" class="btn btn-small" id="p-load-profile">Profildatei laden</button>, zum Beispiel das Profil deiner Organisation oder eines der Beispielprofile (Dateinamen beginnen mit polit-monitor-profil).</p>
    <label>Name der Organisationseinheit <input type="text" id="p-name" value="${esc(profile.name)}" placeholder="z.B. Grünflächenamt" /></label>

    <h3>Direkte Nennung der Organisation <span class="muted">(+${profile.orgBonus} Punkte)</span></h3>
    <textarea id="p-org" class="terms" rows="3" placeholder="Ein Begriff pro Zeile, zum Beispiel:&#10;grünflächenamt&#10;amt für stadtgrün&#10;gfa">${esc((profile.orgTerms || []).join('\n'))}</textarea>
    <div class="preview muted" id="p-org-preview"></div>

    <h3>Themen</h3>
    <div id="p-themes">${(profile.themes?.length ? profile.themes : [undefined]).map((th) => themeFieldset(th)).join('')}</div>
    <button type="button" class="btn" id="p-add-theme">Thema hinzufügen</button>

    <h3>Ausschlusswörter <span class="muted">(Treffer wird verworfen)</span></h3>
    <textarea id="p-exclude" class="terms" rows="3" placeholder="z.B. Begriffe, die regelmässig Fehltreffer erzeugen">${esc((profile.excludeTerms || []).join('\n'))}</textarea>

    <details class="advanced">
      <summary>Erweitert: Kommission und Schwellenwerte</summary>
      <label>Kommissions-Kürzel (Bonus, kommagetrennt)
        <input type="text" id="p-comm" value="${esc((profile.commissionBonus?.names || []).join(', '))}" />
      </label>
      <label>Kommissions-Bonus <input type="number" id="p-comm-pts" value="${profile.commissionBonus?.points ?? 15}" /></label>
      <label>Punkte für «Treffer» <input type="number" id="p-hit" value="${profile.thresholds.hit}" /></label>
      <label>Punkte für «Grenzfall» <input type="number" id="p-borderline" value="${profile.thresholds.borderline}" /></label>
    </details>

    <h3>Politische Ebenen</h3>
    <label class="check"><input type="checkbox" id="p-b261" ${profile.bodies['261'] ? 'checked' : ''} /> Gemeinderat Stadt Zürich (vollständig überwacht)</label>
    <label class="check"><input type="checkbox" id="p-bZH" ${profile.bodies.ZH ? 'checked' : ''} /> Kantonsrat Zürich (per Stichwortsuche)</label>
    <label class="check"><input type="checkbox" id="p-bCHE" ${profile.bodies.CHE ? 'checked' : ''} /> Bundesversammlung (per Stichwortsuche)</label>

    <div class="toolbar">
      <button class="btn btn-primary" id="p-save">Profil übernehmen und Bestand neu bewerten</button>
      <span id="p-msg" class="muted">${esc(flashMsg)}</span>
    </div>
  </section>

  <section class="panel">
    <h2>Alles speichern und weitergeben</h2>
    <p class="muted">Gespeichert wird immer alles zusammen in einer Datei: das Profil und sämtliche
    Daten (Einstufungen, Historie). Ohne Sicherung liegt beides nur im Browserspeicher dieses
    Geräts, den der Browser oder die IT löschen kann. Speichere deshalb regelmässig an einen Ort
    deiner Wahl, zum Beispiel auf einem Team-Laufwerk oder auf SharePoint. Eine gespeicherte Datei
    lässt sich hier auch wieder laden, etwa auf einem anderen Gerät. Beachte beim Weitergeben, dass
    die Datei auch die eigenen Einstufungen und Notizen enthält.</p>
    <p>Zuletzt gespeichert: <strong>${bs.lastBackupAt ? esc(fmtDateTime(bs.lastBackupAt)) : 'noch nie'}</strong>
    ${bs.bound ? ` · <span class="ok">wird automatisch in «${esc(bs.fileName || 'Datei')}» gespeichert</span>` : ''}</p>
    <div class="toolbar">
      ${
        fsSupported()
          ? bs.bound
            ? '<button class="btn" id="b-save">Anderen Speicherort wählen</button>'
            : '<button class="btn btn-primary" id="b-save">Als Datei speichern</button>'
          : '<button class="btn" id="b-download">Sicherung herunterladen</button>'
      }
      <button class="btn" id="b-load">Datei laden</button>
      ${fsSupported() && bs.bound ? '<button class="btn" id="b-unbind">Automatisches Speichern beenden</button>' : ''}
      ${fsSupported() ? '' : '<span class="muted">Dieser Browser kann nicht direkt in eine Datei speichern; die Sicherung landet im Download-Ordner.</span>'}
    </div>
  </section>

  <section class="panel">
    <h2>Über diese App</h2>
    <p class="muted">Polit-Monitor ${esc(__APP_VERSION__)} · <a href="https://github.com/maksim-101/polit-monitor" target="_blank" rel="noopener">Quellcode und neue Versionen</a></p>
    <p class="muted">Datenquelle: <a href="https://openparldata.ch" target="_blank" rel="noopener">OpenParlData.ch</a>
    (CC BY 4.0, «Source: OpenParlData.ch»), ein Projekt von Opendata.ch. Die App läuft vollständig
    lokal im Browser; ausser den Abfragen an OpenParlData werden keine Daten übertragen.</p>
  </section>
  <input type="file" id="file-input" accept=".json" hidden />
  `;
  flashMsg = '';
  dirty = false;
  const markDirty = () => (dirty = true);
  el.querySelector('#p-panel').addEventListener('input', markDirty);
  el.querySelector('#p-panel').addEventListener('change', markDirty);

  // --- Live-Vorschau: pro Begriffszeile die Trefferzahl im lokalen Bestand ---
  function previewFor(textarea, target) {
    const lines = textarea.value.split('\n').map((l) => l.trim()).filter(Boolean);
    target.innerHTML = lines
      .map((raw) => {
        const parsed = parseTerm(raw);
        if (!parsed.t) return '';
        const re = termRe(parsed);
        const n = texts.reduce((acc, x) => acc + (re.test(x) ? 1 : 0), 0);
        return `<span class="preview-term">«${esc(raw)}» → ${n}</span>`;
      })
      .join(' ');
  }
  function wirePreviews() {
    el.querySelectorAll('textarea.terms').forEach((ta) => {
      const target = ta.nextElementSibling?.classList?.contains('preview') ? ta.nextElementSibling : null;
      if (!target) return;
      previewFor(ta, target);
      ta.addEventListener('input', () => {
        clearTimeout(ta._t);
        ta._t = setTimeout(() => previewFor(ta, target), 400);
      });
    });
  }
  wirePreviews();

  el.querySelector('#p-add-theme').addEventListener('click', () => {
    el.querySelector('#p-themes').insertAdjacentHTML('beforeend', themeFieldset());
    markDirty();
    wirePreviews();
  });
  el.querySelector('#p-themes').addEventListener('click', (e) => {
    if (!e.target.classList.contains('th-remove')) return;
    e.target.closest('fieldset.theme').remove();
    markDirty();
  });

  const parseLines = (v) => v.split('\n').map((l) => l.trim()).filter(Boolean);

  el.querySelector('#p-save').addEventListener('click', async () => {
    const rawThemes = [...el.querySelectorAll('fieldset.theme')].map((fs) => ({
      label: fs.querySelector('.th-label').value.trim(),
      weight: Number(fs.querySelector('.th-weight').value) || 10,
      terms: parseLines(fs.querySelector('.th-terms').value),
    }));
    // Ein Thema ohne Namen ODER ohne Begriffe wird beim Speichern verworfen —
    // vorher fragen statt es kommentarlos verschwinden zu lassen.
    const incomplete = rawThemes.filter((t) => !(t.label && t.terms.length) && (t.label || t.terms.length));
    if (incomplete.length) {
      const names = incomplete.map((t) => t.label || '(ohne Namen)').join(', ');
      if (!confirm(`Diese Themen haben keinen Namen oder keine Begriffe und werden beim Übernehmen entfernt: ${names}. Trotzdem übernehmen?`)) return;
    }

    const updated = {
      ...profile,
      name: el.querySelector('#p-name').value.trim(),
      orgTerms: parseLines(el.querySelector('#p-org').value),
      themes: rawThemes.filter((t) => t.label && t.terms.length),
      excludeTerms: parseLines(el.querySelector('#p-exclude').value),
      commissionBonus: {
        names: el.querySelector('#p-comm').value.split(',').map((s) => s.trim()).filter(Boolean),
        points: Number(el.querySelector('#p-comm-pts').value) || 15,
      },
      thresholds: {
        hit: Number(el.querySelector('#p-hit').value) || 20,
        borderline: Number(el.querySelector('#p-borderline').value) || 10,
      },
      bodies: {
        261: el.querySelector('#p-b261').checked,
        ZH: el.querySelector('#p-bZH').checked,
        CHE: el.querySelector('#p-bCHE').checked,
      },
    };
    const allTermLines = [...updated.orgTerms, ...updated.themes.flatMap((t) => t.terms), ...updated.excludeTerms];
    const badStar = allTermLines.find((line) => line.slice(0, -1).includes('*'));
    if (badStar) {
      alert(`Stern nur am Wortende erlaubt: «${badStar}»`);
      return;
    }

    try {
      compileProfile(updated); // wirft bei kaputten Begriffen, bevor gespeichert wird
    } catch (err) {
      alert(`Profil konnte nicht übernommen werden. Begriffe prüfen: ${err.message}`);
      return;
    }

    // Derselbe Mutex wie bei Sync/Backup-Import: Profil speichern + Neubewertung
    // ist ein Read-Modify-Write über den gesamten affairs-Store — parallel zu
    // einem laufenden Abgleich würde das dessen Ergebnis teilweise überschreiben.
    const save = async () => {
      await db.setConfig('profile', updated);
      return rematchAll(updated);
    };
    // Kein Re-Render im Busy-Fall: er würde die noch nicht übernommenen Eingaben verwerfen.
    const { busy, result: n } = await db.withDbLock(save, () => {
      el.querySelector('#p-msg').textContent = 'Gerade läuft ein Abgleich. Bitte kurz warten und danach erneut übernehmen.';
    });
    if (busy) return;
    flashMsg = `Übernommen, ${n} Geschäfte neu eingestuft. Kanton und Bund werden mit den Stichwörtern neu abgefragt.`;
    dirty = false;
    emit('profile');
    emit('data');
    // Kanton und Bund kennt der Bestand nur per Stichwortsuche; neue Begriffe
    // brauchen deshalb einen Abgleich, nicht nur die lokale Neubewertung.
    emit('retry-sync');
    // Profiländerungen sofort in die verbundene Datei übernehmen — sonst hinkt
    // die Datei bis zum nächsten Sync/Triage-Klick hinter dem Profil her.
    try {
      if ((await autoSave()) === 'needs-permission') emit('backup-needs-permission');
    } catch (err) {
      emit('status', `Automatisches Speichern in die Datei fehlgeschlagen: ${err.message}`);
    }
  });

  // Ein Lade-Knopf für beides: vollständige Datendatei (Profil + Historie) und
  // reine Profildatei (Startpaket bzw. Export aus früheren Versionen).
  const fileInput = el.querySelector('#file-input');
  el.querySelector('#b-load').addEventListener('click', () => fileInput.click());
  el.querySelector('#p-load-profile').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      let apply;
      if (json.format === 'polit-monitor-profile') {
        const p = parseProfileImport(json);
        if (!confirm(`Profil «${p.name}» laden? Das aktuelle Profil wird ersetzt, die Historie bleibt.`)) return;
        apply = async () => {
          await db.setConfig('profile', p);
          await rematchAll(p);
        };
      } else {
        if (!confirm('Datei laden? Der GESAMTE aktuelle Bestand (Profil, Einstufungen, Historie) wird durch den Inhalt der Datei ersetzt.')) return;
        apply = () => importBackup(json);
      }
      // Derselbe Mutex wie beim Abgleich: ein Import darf nicht in einen
      // laufenden Sync (auch aus einem anderen Fenster) hineinschreiben.
      const { busy } = await db.withDbLock(apply, () =>
        alert('Gerade läuft ein Abgleich. Bitte kurz warten und die Datei danach erneut laden.')
      );
      if (busy) return;
      dirty = false;
      if (json.format === 'polit-monitor-profile') flashMsg = 'Profil geladen. Kanton und Bund werden jetzt mit den Stichwörtern abgefragt.';
      emit('profile');
      emit('data');
      emit('retry-sync');
    } catch (err) {
      alert(`Laden fehlgeschlagen: ${err.message}`);
    }
  });

  el.querySelector('#b-download')?.addEventListener('click', async () => {
    await downloadBackup();
    renderSettings(el);
  });
  el.querySelector('#b-save')?.addEventListener('click', async () => {
    try {
      await saveAs();
      renderSettings(el);
    } catch (err) {
      if (err.name !== 'AbortError') alert(`Speichern fehlgeschlagen: ${err.message}`);
    }
  });
  el.querySelector('#b-unbind')?.addEventListener('click', async () => {
    await unbindFile();
    renderSettings(el);
  });
}
