import * as db from './db.js';
import { DEFAULT_PROFILE } from './profile-default.js';

// App-Zustand (letztes Backup, Eingang-Lesestand, Dateiverbindung) in config['app'].
export async function getApp() {
  return (await db.getConfig('app')) || {};
}

export async function patchApp(patch) {
  const app = await getApp();
  Object.assign(app, patch);
  await db.setConfig('app', app);
  return app;
}

export async function buildExport() {
  const [affairs, annotations, changelog, syncState, profile, app] = await Promise.all([
    db.getAll('affairs'),
    db.getAll('annotations'),
    db.getAll('changelog'),
    db.getAll('syncState'),
    db.getConfig('profile'),
    getApp(),
  ]);
  // fileHandle NIE exportieren — FileSystemFileHandle ist nicht JSON-serialisierbar.
  const { lastBackupAt, lastInboxSeenAt, tourDone } = app;
  return {
    format: 'polit-monitor-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    profile,
    app: { lastBackupAt, lastInboxSeenAt, tourDone },
    data: { affairs, annotations, changelog, syncState },
  };
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Fallback für Browser ohne File-System-Access-API: Sicherung als Download.
export async function downloadBackup() {
  const data = await buildExport();
  downloadJson(data, `polit-monitor-daten-${new Date().toISOString().slice(0, 10)}.json`);
  await patchApp({ lastBackupAt: new Date().toISOString() });
}

const BACKUP_STORES = ['affairs', 'annotations', 'changelog', 'syncState'];

export async function importBackup(json) {
  if (json.format !== 'polit-monitor-export') throw new Error('Keine gültige Polit-Monitor-Datei.');
  // Vor jeder Schreiboperation vollständig validieren — sonst leert ein Store,
  // dessen Schlüssel in der Datei fehlt oder kaputt ist, den Bestand still.
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const dataOk =
    json.data &&
    typeof json.data === 'object' &&
    BACKUP_STORES.every((name) => Array.isArray(json.data[name])) &&
    json.data.affairs.every((a) => isPlainObject(a) && Number.isFinite(a.id)) &&
    json.data.annotations.every((a) => isPlainObject(a) && Number.isFinite(a.affairId)) &&
    json.data.changelog.every((c) => isPlainObject(c)) &&
    json.data.syncState.every((s) => isPlainObject(s) && typeof s.scope === 'string');
  if (!dataOk) throw new Error('Datei unvollständig oder beschädigt. Es wurde nichts verändert.');

  await db.replaceAllStores({
    affairs: json.data.affairs,
    annotations: json.data.annotations,
    changelog: json.data.changelog,
    syncState: json.data.syncState,
  });

  if (json.profile) await db.setConfig('profile', sanitizeProfile(json.profile));

  // App-Zustand (Lesestand/Tour) übernehmen, falls vorhanden — ältere Sicherungen ohne
  // app-Feld bleiben gültig. fileHandle-Bindung bleibt unangetastet (nicht im Patch enthalten).
  const appPatch = {};
  if (json.app && typeof json.app === 'object') {
    for (const key of ['lastInboxSeenAt', 'tourDone']) {
      if (key in json.app) appPatch[key] = json.app[key];
    }
  }
  appPatch.lastBackupAt = new Date().toISOString(); // Bestand entspricht ab jetzt der Sicherungsdatei
  await patchApp(appPatch);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function toStringArray(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : null;
}

// Fremde/ältere Profildateien defensiv mit DEFAULT_PROFILE mergen — ein Profil ohne
// thresholds/bodies/commissionBonus darf Neubewertung und Einstellungsseite nicht crashen.
export function sanitizeProfile(p) {
  const src = p && typeof p === 'object' ? p : {};
  // Bewusst KEIN Spread von src auf DEFAULT_PROFILE: jedes Feld wird unten
  // explizit geprüft und übernommen — sonst würden unbekannte Fremdschlüssel
  // aus einer beliebigen Datei ungeprüft ins gespeicherte Profil durchgereicht.
  const profile = {};

  profile.name = isNonEmptyString(src.name) ? src.name : DEFAULT_PROFILE.name;
  profile.orgBonus = typeof src.orgBonus === 'number' ? src.orgBonus : DEFAULT_PROFILE.orgBonus;
  profile.orgTerms = toStringArray(src.orgTerms) ?? DEFAULT_PROFILE.orgTerms;
  profile.excludeTerms = toStringArray(src.excludeTerms) ?? [];

  profile.commissionBonus = {
    names: toStringArray(src.commissionBonus?.names) ?? DEFAULT_PROFILE.commissionBonus.names,
    points:
      typeof src.commissionBonus?.points === 'number'
        ? src.commissionBonus.points
        : DEFAULT_PROFILE.commissionBonus.points,
  };

  profile.thresholds = {
    hit: typeof src.thresholds?.hit === 'number' ? src.thresholds.hit : DEFAULT_PROFILE.thresholds.hit,
    borderline:
      typeof src.thresholds?.borderline === 'number'
        ? src.thresholds.borderline
        : DEFAULT_PROFILE.thresholds.borderline,
  };

  profile.bodies = {
    261: typeof src.bodies?.[261] === 'boolean' ? src.bodies[261] : DEFAULT_PROFILE.bodies[261],
    ZH: typeof src.bodies?.ZH === 'boolean' ? src.bodies.ZH : DEFAULT_PROFILE.bodies.ZH,
    CHE: typeof src.bodies?.CHE === 'boolean' ? src.bodies.CHE : DEFAULT_PROFILE.bodies.CHE,
  };

  profile.themes = Array.isArray(src.themes)
    ? src.themes
        .filter((t) => isNonEmptyString(t?.label))
        .map((t) => ({
          label: t.label,
          weight: typeof t.weight === 'number' ? t.weight : 10,
          terms: toStringArray(t.terms) ?? [],
        }))
    : DEFAULT_PROFILE.themes;

  return profile;
}

export function parseProfileImport(json) {
  if (json.format !== 'polit-monitor-profile' || !json.profile) throw new Error('Keine gültige Profildatei.');
  return sanitizeProfile(json.profile);
}

// --- Dateiverbindung (File System Access API, Progressive Enhancement) ---

export function fsSupported() {
  return typeof window.showSaveFilePicker === 'function';
}

// «Als Datei speichern»: Speicherort frei wählen, sofort schreiben und die
// Datei merken — ab dann hält autoSave() sie automatisch aktuell.
export async function saveAs() {
  const handle = await window.showSaveFilePicker({
    suggestedName: 'polit-monitor-daten.json',
    types: [{ description: 'Polit-Monitor Daten', accept: { 'application/json': ['.json'] } }],
  });
  // Eine neue Bindung überschreibt immer, unabhängig vom bisherigen fileModified.
  await patchApp({ fileHandle: handle, fileModified: null });
  await writeToHandle(handle);
}

export async function unbindFile() {
  await patchApp({ fileHandle: null });
}

// Innerhalb dieses Tabs seriell: zwei überlappende writeToHandle-Aufrufe auf
// demselben Handle dürfen nicht gleichzeitig je eine eigene Writable öffnen.
let writeChain = Promise.resolve();

async function writeToHandleSerialized(handle) {
  const app = await getApp();
  const current = await handle.getFile();
  // fileModified stammt vom letzten eigenen Schreibvorgang — weicht der aktuelle
  // Stand davon ab, hat jemand anders die Datei seither verändert.
  if (app.fileModified != null && current.lastModified !== app.fileModified) {
    throw new Error(
      'Die Speicherdatei wurde seit dem letzten Speichern ausserhalb dieser App verändert, zum Beispiel von einer anderen Person. Es wurde nicht gespeichert. Lade die Datei in den Einstellungen, oder wähle dort den Speicherort erneut, um sie zu überschreiben.'
    );
  }
  const data = await buildExport();
  const w = await handle.createWritable();
  await w.write(JSON.stringify(data));
  await w.close();
  const written = await handle.getFile();
  await patchApp({ lastBackupAt: new Date().toISOString(), fileModified: written.lastModified });
}

function writeToHandle(handle) {
  const run = writeChain.then(() => writeToHandleSerialized(handle));
  writeChain = run.catch(() => {});
  return run;
}

// Nach Sync/Triage aufrufen. Rückgabe 'needs-permission', wenn der Browser die
// gespeicherte Dateiverbindung erst nach einer Nutzeraktion wieder freigibt.
export async function autoSave() {
  const app = await getApp();
  if (!app.fileHandle) return 'unbound';
  const perm = await app.fileHandle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return 'needs-permission';
  await writeToHandle(app.fileHandle);
  return 'saved';
}

// Muss aus einem Klick-Handler heraus aufgerufen werden.
export async function grantAndSave() {
  const app = await getApp();
  if (!app.fileHandle) return 'unbound';
  const perm = await app.fileHandle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return 'denied';
  await writeToHandle(app.fileHandle);
  return 'saved';
}

export async function backupStatus() {
  const app = await getApp();
  const bound = !!app.fileHandle;
  const last = app.lastBackupAt ? new Date(app.lastBackupAt) : null;
  const stale = !last || Date.now() - last.getTime() > 7 * 864e5;
  return {
    bound,
    fileName: app.fileHandle?.name || null,
    lastBackupAt: app.lastBackupAt || null,
    warn: !bound && stale,
    neverSaved: !last,
  };
}
