import { patchApp } from '../backup.js';
import * as db from '../db.js';
import { esc } from './common.js';
import { on } from './bus.js';

// Geführte Kurztour. Schritte mit `tab` wechseln zuerst die Ansicht und warten, bis
// sie gerendert ist. `target` kann eine Liste sein: das erste vorhandene Element
// wird hervorgehoben (z.B. die Rubrik, solange noch keine Trefferkarte existiert).
// Kein Schritt wird übersprungen, sonst springt der Zähler und die Tour wirkt kaputt.
const PROFILE_STEP = {
  tab: 'einstellungen',
  target: '#p-load-profile',
  title: 'Zuerst: Profil laden',
  text: 'Noch sind keine Stichwörter eingerichtet, deshalb bleibt der Eingang leer. Lade nach der Tour hier eine Profildatei, zum Beispiel eines der Beispielprofile oder das Profil deiner Organisation, oder trage weiter unten eigene Themen und Begriffe ein. Danach sucht die App automatisch nach passenden Geschäften.',
};

const STEPS = [
  {
    title: 'Willkommen im Polit-Monitor',
    text: 'Die App überwacht politische Geschäfte von Stadt Zürich, Kanton und Bund, die deine Organisationseinheit betreffen könnten. Das geschieht rein regelbasiert über Stichwörter, ohne KI. Diese Kurztour zeigt in einer Minute die wichtigsten Funktionen.',
  },
  {
    tab: 'eingang',
    target: 'nav .tab[data-tab="eingang"]',
    title: 'Eingang',
    text: 'Hier landet alles Neue: frisch gefundene Treffer und Änderungen an Geschäften, die du beobachtest, jeweils seit deinem letzten Besuch.',
  },
  {
    tab: 'eingang',
    target: ['#view .card', '#view section'],
    title: 'Treffer einstufen',
    text: 'Beurteile jeden Treffer einmal: «Beobachten» nimmt ihn in die Beobachtungsliste auf, «Irrelevant» blendet ihn dauerhaft aus. Einmal Beurteiltes taucht nicht wieder im Eingang auf.',
  },
  {
    tab: 'eingang',
    target: ['#view .badge-score', '#view section'],
    title: 'Punkte zeigen das Warum',
    text: 'Die Punktzahl sagt, wie stark ein Geschäft zu deinen Stichwörtern passt. Fahre mit der Maus darüber oder öffne das Geschäft, dann siehst du genau, welche Begriffe gezogen haben.',
  },
  {
    tab: 'eingang',
    target: '#view details.borderline',
    title: 'Grenzfälle',
    text: 'Schwache Treffer (z.B. nur ein einzelnes Stichwort) sammeln sich eingeklappt hier unten. Lohnt sich, gelegentlich durchzuschauen.',
  },
  {
    tab: 'beobachtung',
    target: 'nav .tab[data-tab="beobachtung"]',
    title: 'Beobachtung',
    text: 'Deine Merkliste mit Fristen: Wann muss der Stadtrat antworten oder berichten, was ist abgelaufen. Ändert sich der Status eines beobachteten Geschäfts, meldet es der Eingang. Von hier exportierst du die Liste als Excel oder als gestaltetes PDF (über den Druckdialog).',
  },
  {
    tab: 'suche',
    target: 'nav .tab[data-tab="suche"]',
    title: 'Suche & Archiv',
    text: 'Suche und Filter über den gesamten lokalen Bestand. Bei der Stadt Zürich reicht er zurück bis 2009 und umfasst auch Geschäfte, die nie Treffer waren.',
  },
  {
    tab: 'einstellungen',
    target: '#p-themes',
    title: 'Stichwörter anpassen',
    text: 'Das Herzstück: Themen und Begriffe bestimmen, was als Treffer gilt. Jede Begriffszeile zeigt live, wie viele Geschäfte sie im Bestand träfe. Nach dem Übernehmen wird alles neu bewertet, ohne neuen Datenabruf.',
  },
  {
    tab: 'einstellungen',
    target: ['#b-save', '#b-download'],
    title: 'Speichern',
    text: 'Alle Daten der App liegen im Browserspeicher dieses Geräts. Speichere sie hier in eine Datei an einem Ort deiner Wahl; die Datei wird danach automatisch aktuell gehalten und lässt sich auch auf einem anderen Gerät wieder laden. Wichtig, falls die IT Browserdaten löscht.',
  },
  {
    target: '#tour-btn',
    title: 'Das war die Tour',
    text: 'Beim Öffnen aktualisiert die App automatisch, mit «Aktualisieren» jederzeit manuell. Und diese Tour startest du hier mit dem Knopf «Tour» beliebig oft neu.',
  },
];

let steps = STEPS;
let root = null;
let idx = 0;
let busy = false;
let shownAt = 0;
let currentEl = null;
let renderedTab = null;
let renderWaiter = null;

// app.js meldet jeden fertigen Tab-Render. Rendert ein Abgleich die Ansicht unter
// der offenen Tour neu, zeigt der Spot sonst auf ein entferntes Element.
on('rendered', (tab) => {
  renderedTab = tab;
  if (renderWaiter?.tab === tab) renderWaiter.resolve();
  if (root && !busy && steps[idx]?.target) {
    currentEl = findTarget(steps[idx].target);
    reposition();
  }
});

function waitForTab(tab) {
  if (location.hash === `#/${tab}` && renderedTab === tab) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      renderWaiter = null;
      resolve();
    };
    const timer = setTimeout(done, 3000);
    renderWaiter = { tab, resolve: done };
    location.hash = `#/${tab}`;
  });
}

function findTarget(target) {
  for (const sel of [].concat(target)) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function close() {
  root?.remove();
  root = null;
  window.removeEventListener('resize', reposition);
  window.removeEventListener('keydown', onKey);
  patchApp({ tourDone: true });
}

// Enter löst der fokussierte «Weiter»-Knopf selbst aus; zusätzlich hier behandelt,
// würde ein Tastendruck zwei Schritte weiterschalten.
function onKey(e) {
  if (e.key === 'Escape') close();
  if (e.key === 'ArrowRight') next(1);
  if (e.key === 'ArrowLeft') next(-1);
}

function reposition() {
  if (!root) return;
  const spot = root.querySelector('.tour-spot');
  const card = root.querySelector('.tour-card');
  if (currentEl) {
    const r = currentEl.getBoundingClientRect();
    const pad = 6;
    Object.assign(spot.style, {
      left: `${r.left - pad}px`,
      top: `${r.top - pad}px`,
      width: `${r.width + 2 * pad}px`,
      height: `${r.height + 2 * pad}px`,
    });
    card.classList.remove('centered');
    // unterhalb des Ziels, sonst oberhalb — und immer in den Viewport geklemmt
    // (Ziele können höher als der Bildschirm sein, z.B. der Themen-Block)
    const ch = card.offsetHeight || 220;
    let top = r.bottom + 14;
    if (top + ch > window.innerHeight - 16) top = r.top - ch - 14;
    top = Math.max(16, Math.min(top, window.innerHeight - ch - 16));
    card.style.top = `${top}px`;
    card.style.bottom = '';
    const left = Math.min(Math.max(r.left, 16), window.innerWidth - 376);
    card.style.left = `${left}px`;
  } else {
    Object.assign(spot.style, { left: '50vw', top: '50vh', width: '0', height: '0' });
    card.classList.add('centered');
    card.style.top = card.style.bottom = card.style.left = '';
  }
}

async function show() {
  busy = true;
  root.querySelectorAll('.tour-card button[data-nav]').forEach((b) => (b.disabled = true));
  const step = steps[idx];
  if (step.tab) await waitForTab(step.tab);
  if (!root) return; // Tour wurde währenddessen geschlossen
  currentEl = step.target ? findTarget(step.target) : null;
  currentEl?.scrollIntoView({ block: 'center', behavior: 'instant' });

  root.querySelector('.tour-card').innerHTML = `
    <button class="tour-close" title="Tour beenden">×</button>
    <h3>${esc(step.title)}</h3>
    <p>${esc(step.text)}</p>
    <div class="tour-nav">
      <span class="muted">${idx + 1}/${steps.length}</span>
      <span class="spacer"></span>
      ${idx > 0 ? '<button class="btn" data-nav="-1">Zurück</button>' : ''}
      <button class="btn btn-primary" data-nav="1">${idx === steps.length - 1 ? 'Fertig' : 'Weiter'}</button>
    </div>`;
  root.querySelector('.tour-close').addEventListener('click', close);
  root.querySelectorAll('button[data-nav]').forEach((b) => b.addEventListener('click', () => next(Number(b.dataset.nav))));
  reposition();
  root.querySelector('button[data-nav="1"]').focus();
  shownAt = Date.now();
  busy = false;
}

// Die Sperrzeit fängt Doppelklicks ab, die sonst einen Schritt ungesehen überspringen.
function next(d) {
  if (busy || !root || Date.now() - shownAt < 400) return;
  idx += d;
  if (idx < 0 || idx >= steps.length) return close();
  show();
}

export async function startTour() {
  if (root) return;
  const profile = await db.getConfig('profile');
  if (root) return;
  const noTerms = !(profile?.orgTerms?.length || profile?.themes?.length);
  steps = noTerms ? [STEPS[0], PROFILE_STEP, ...STEPS.slice(1)] : STEPS;
  idx = 0;
  root = document.createElement('div');
  root.id = 'tour-root';
  root.innerHTML = '<div class="tour-block"></div><div class="tour-spot"></div><div class="tour-card"></div>';
  document.body.appendChild(root);
  window.addEventListener('resize', reposition);
  window.addEventListener('keydown', onKey);
  show();
}

export function tourOpen() {
  return !!root;
}
