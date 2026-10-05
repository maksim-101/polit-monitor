import { openDb, getConfig, setConfig, getAll as dbGetAll, withDbLock } from './db.js';
import { DEFAULT_PROFILE } from './profile-default.js';
import { syncAll } from './sync.js';
import { autoSave, sanitizeProfile } from './backup.js';
import { initApp, updateStatusbar, showPermissionBanner } from './ui/app.js';
import { emit, on } from './ui/bus.js';

let syncing = false;

async function doSync() {
  syncing = true;
  emit('sync-start');
  document.getElementById('refresh').disabled = true;
  try {
    const profile = await getConfig('profile');
    const { errors, newCount } = await syncAll(profile, (text, frac) => emit('status', { text, frac }));
    // Irgendein abgeschlossener Erstimport (egal welcher Ebene — die Stadt kann
    // im Profil abgewählt sein) als Indikator, ob schon Daten geladen wurden;
    // dieselbe Definition wie in ui/app.js (updateStatusbar).
    const states = await dbGetAll('syncState');
    const hasData = states.some((s) => s.initialImportDone);
    emit(
      'status',
      errors.length
        ? `Abgleich ${hasData ? 'unvollständig' : 'fehlgeschlagen'} (${errors.join(' · ')}). ` +
          (hasData ? 'Die gespeicherten Daten bleiben nutzbar.' : 'Es wurden noch keine Daten geladen.')
        : newCount
          ? `Abgleich fertig: ${newCount} neue Treffer/Grenzfälle.`
          : 'Abgleich fertig, nichts Neues.'
    );
    emit('sync-end');
    emit('data');
    try {
      if ((await autoSave()) === 'needs-permission') showPermissionBanner();
    } catch (err) {
      emit('status', `Automatisches Speichern in die Datei fehlgeschlagen: ${err.message}`);
    }
  } catch (err) {
    emit('status', `Abgleich fehlgeschlagen (${err.message}). Die gespeicherten Daten bleiben nutzbar.`);
    emit('sync-end');
    emit('data');
  } finally {
    syncing = false;
    document.getElementById('refresh').disabled = false;
    updateStatusbar();
  }
}

// Mehrere offene Fenster derselben Datei teilen sich die IndexedDB — der
// Web-Locks-Mutex verhindert, dass zwei Tabs gleichzeitig synchronisieren
// und sich gegenseitig mit veralteten Ständen überschreiben.
async function runSync() {
  if (syncing) return;
  await withDbLock(doSync, () => emit('status', 'Abgleich läuft bereits in einem anderen Fenster dieser App.'));
}

async function start() {
  await openDb();
  const stored = await getConfig('profile');
  if (!stored) {
    await setConfig('profile', DEFAULT_PROFILE);
  } else {
    // Selbstheilung: ein strukturell unvollständiges Profil (z.B. aus einem
    // früheren fehlerhaften Import) würde sonst App-weit crashen.
    const healed = sanitizeProfile(stored);
    if (JSON.stringify(healed) !== JSON.stringify(stored)) await setConfig('profile', healed);
  }
  navigator.storage?.persist?.().catch(() => {});
  on('retry-sync', runSync);
  await initApp({ onRefresh: runSync });
  if (navigator.onLine) {
    runSync();
  } else {
    // Dieselbe Definition wie in doSync/ui/app.js (updateStatusbar): irgendein
    // abgeschlossener Erstimport zählt als "es gibt schon Daten".
    const states = await dbGetAll('syncState');
    const hasData = states.some((s) => s.initialImportDone);
    emit(
      'status',
      hasData
        ? 'Offline. Es werden die gespeicherten Daten angezeigt.'
        : 'Offline und noch keine Daten geladen. Bitte mit Internetverbindung erneut öffnen.'
    );
  }
}

start();
