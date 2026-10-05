import { esc, fmtDateTime } from './common.js';
import { on, emit } from './bus.js';
import { renderInbox, inboxCount } from './inbox.js';
import { renderWatchlist } from './watchlist.js';
import { renderSearch } from './search.js';
import { renderSettings, settingsDirty } from './settings.js';
import { renderDetail } from './detail.js';
import { backupStatus, grantAndSave, getApp } from '../backup.js';
import { startTour, tourOpen } from './tour.js';
import * as db from '../db.js';

const TABS = [
  { id: 'eingang', label: 'Eingang', render: renderInbox },
  { id: 'beobachtung', label: 'Beobachtung', render: renderWatchlist },
  { id: 'suche', label: 'Suche & Archiv', render: renderSearch },
  { id: 'einstellungen', label: 'Einstellungen', render: renderSettings },
];

let currentTab = 'eingang';
let profileName = '';

function route() {
  const h = location.hash || '#/eingang';
  const detail = h.match(/^#\/geschaeft\/(\d+)$/);
  const overlay = document.getElementById('overlay');
  if (detail) {
    overlay.hidden = false;
    renderDetail(overlay, Number(detail[1]));
    return;
  }
  overlay.hidden = true;
  overlay.innerHTML = '';
  const tab = h.replace('#/', '');
  if (TABS.some((t) => t.id === tab)) currentTab = tab;
  renderTab();
}

async function renderTab() {
  const tab = currentTab;
  document.querySelectorAll('nav .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const view = document.getElementById('view');
  await TABS.find((t) => t.id === tab).render(view);
  emit('rendered', tab);
  updateBadge();
}

async function updateBadge() {
  const n = await inboxCount();
  const badge = document.querySelector('nav .tab[data-tab="eingang"] .tab-badge');
  badge.textContent = n || '';
  badge.hidden = !n;
}

export async function initApp({ onRefresh }) {
  const profile = await db.getConfig('profile');
  profileName = profile.name;

  document.getElementById('app').innerHTML = `
    <header>
      <div class="brand">Polit-Monitor <span class="brand-profile" ${profileName ? '' : 'hidden'}>${esc(profileName)}</span></div>
      <span class="spacer"></span>
      <button class="btn" id="tour-btn" title="Kurztour durch die App">Tour</button>
      <button class="btn" id="refresh">Aktualisieren</button>
    </header>
    <nav>
      ${TABS.map((t) => `<button class="tab" data-tab="${t.id}">${t.label}${t.id === 'eingang' ? ' <span class="tab-badge" hidden></span>' : ''}</button>`).join('')}
    </nav>
    <main id="view"></main>
    <footer id="statusbar">
      <span id="status-text"></span>
      <span class="spacer"></span>
      <span id="status-backup"></span>
      <span id="status-sync" class="muted"></span>
    </footer>
    <div id="overlay" hidden></div>
  `;

  document.querySelector('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) location.hash = `#/${btn.dataset.tab}`;
  });
  document.getElementById('refresh').addEventListener('click', onRefresh);
  document.getElementById('tour-btn').addEventListener('click', startTour);
  window.addEventListener('hashchange', route);

  // Tour beim allerersten Mal automatisch starten — sobald Daten da sind
  // (nicht während der Erstimport-Anzeige).
  const maybeAutoTour = async () => {
    if (tourOpen()) return;
    const app = await getApp();
    if (app.tourDone) return;
    const affairs = await db.getAll('affairs');
    if (affairs.length) startTour();
  };
  on('data', maybeAutoTour);
  maybeAutoTour();

  on('status', (d) => {
    const { text, frac } = typeof d === 'string' ? { text: d } : d || {};
    document.getElementById('status-text').textContent = text || '';
    // Erstimport-Panel (falls sichtbar) mit demselben Signal füttern
    const fs = document.getElementById('firstrun-status');
    if (fs) fs.textContent = text || '';
    const bar = document.getElementById('firstrun-bar');
    if (bar) {
      if (frac != null) {
        bar.classList.remove('indeterminate');
        bar.style.width = `${Math.round(frac * 100)}%`;
      } else {
        bar.classList.add('indeterminate');
        bar.style.width = '';
      }
    }
  });
  on('data', () => {
    // Ein Abgleich endet oft, während jemand gerade Stichwörter bearbeitet; ein
    // Re-Render der Einstellungen würde die noch nicht übernommenen Eingaben verwerfen.
    if (!(currentTab === 'einstellungen' && settingsDirty())) renderTab();
    updateStatusbar();
  });
  on('profile', async () => {
    const p = await db.getConfig('profile');
    const badge = document.querySelector('.brand-profile');
    badge.textContent = p.name;
    badge.hidden = !p.name;
  });
  // Debounced Auto-Save nach Triage/Notiz (common.js) meldet fehlende
  // Datei-Berechtigung über den Bus statt per direktem Import — vermeidet
  // einen Zirkelbezug common.js → ui/app.js → ui/inbox.js → common.js.
  on('backup-needs-permission', showPermissionBanner);

  route();
  updateStatusbar();
}

// Dateiverbindung braucht nach Neustart eine Nutzeraktion. Der Zustand lebt hier
// als Flag, damit updateStatusbar() den Knopf nicht wieder überschreibt — jeder
// Statusbar-Render zeichnet aus demselben Zustand.
let permissionNeeded = false;

export async function updateStatusbar() {
  const bs = await backupStatus();
  const states = await db.getAll('syncState');
  // Vor dem allerersten erfolgreichen Sync gibt es nichts zu sichern — die
  // Warnung würde sonst schon beim Erstimport-Ladebildschirm aufblitzen.
  const hasData = states.some((s) => s.initialImportDone);
  const elB = document.getElementById('status-backup');
  if (permissionNeeded) {
    elB.innerHTML =
      '<span>Der Browser verlangt nach jedem Öffnen eine Freigabe, um wieder automatisch in die Speicherdatei zu sichern. Bis dahin bleiben Änderungen nur in diesem Browser.</span> ' +
      '<button class="btn btn-small" id="regrant">Freigeben und speichern</button>';
    document.getElementById('regrant').addEventListener('click', async () => {
      const r = await grantAndSave();
      if (r === 'saved') permissionNeeded = false;
      updateStatusbar();
    });
  } else if (bs.warn && hasData) {
    elB.innerHTML = bs.neverSaved
      ? '<span class="warn">⚠ Noch nie in eine Datei gespeichert. In den Einstellungen als Datei speichern.</span>'
      : '<span class="warn">⚠ Seit über einer Woche nicht gespeichert. In den Einstellungen als Datei speichern.</span>';
  } else {
    elB.textContent = '';
  }
  const last = states.map((s) => s.lastSyncAt).filter(Boolean).sort().pop();
  document.getElementById('status-sync').textContent = last ? `Letzter Abgleich: ${fmtDateTime(last)}` : '';
}

export function showPermissionBanner() {
  permissionNeeded = true;
  updateStatusbar();
}
