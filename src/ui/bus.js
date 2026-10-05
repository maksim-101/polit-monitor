export const bus = new EventTarget();

// Letzter Status/Sync-Zustand bleibt hier hängen, damit ein Panel, das erst NACH
// dem Event gerendert wird (z.B. Erstimport-Anzeige), trotzdem den aktuellen
// Stand zeigt statt eines veralteten Platzhaltertexts.
let lastStatus = null;
let syncing = false;

export function emit(type, detail) {
  if (type === 'status') lastStatus = detail;
  if (type === 'sync-start') syncing = true;
  if (type === 'sync-end') syncing = false;
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function on(type, fn) {
  bus.addEventListener(type, (e) => fn(e.detail));
}

export function getLastStatus() {
  return lastStatus;
}

export function isSyncing() {
  return syncing;
}
