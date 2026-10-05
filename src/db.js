// Eindeutiger DB-Name: unter file:// teilen alle lokalen HTML-Dateien denselben Origin.
// Bleibt trotz Umbenennung der App auf «polit-monitor» beim alten Wert — ein neuer
// Name würde bestehenden Pilotnutzern den kompletten IndexedDB-Bestand «verlieren».
const DB_NAME = 'polit-monitor-seb';
const DB_VERSION = 1;

let db;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDb() {
  const r = indexedDB.open(DB_NAME, DB_VERSION);
  r.onupgradeneeded = (e) => {
    const d = r.result;
    switch (e.oldVersion) {
      case 0: {
        const affairs = d.createObjectStore('affairs', { keyPath: 'id' });
        affairs.createIndex('body_key', 'body_key');
        affairs.createIndex('updated_at', 'updated_at');
        affairs.createIndex('category', 'category');
        const annotations = d.createObjectStore('annotations', { keyPath: 'affairId' });
        annotations.createIndex('triage', 'triage');
        const changelog = d.createObjectStore('changelog', { keyPath: 'seq', autoIncrement: true });
        changelog.createIndex('at', 'at');
        changelog.createIndex('affairId', 'affairId');
        d.createObjectStore('syncState', { keyPath: 'scope' });
        d.createObjectStore('config', { keyPath: 'key' });
      }
    }
  };
  return req(r).then((d) => {
    db = d;
    return d;
  });
}

function store(name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}

export function get(name, key) {
  return req(store(name).get(key));
}

export function getAll(name) {
  return req(store(name).getAll());
}

export function put(name, value) {
  return req(store(name, 'readwrite').put(value));
}

export function putAll(name, values) {
  const s = store(name, 'readwrite');
  values.forEach((v) => s.put(v));
  return new Promise((resolve, reject) => {
    s.transaction.oncomplete = resolve;
    s.transaction.onerror = () => reject(s.transaction.error);
  });
}

// Ersetzt den Inhalt mehrerer Stores atomar (eine Transaktion) — Import darf nie
// einen Store leeren, ohne die neuen Werte im selben Schritt zu schreiben.
export function replaceAllStores(storeData) {
  const names = Object.keys(storeData);
  const tx = db.transaction(names, 'readwrite');
  try {
    for (const name of names) {
      const s = tx.objectStore(name);
      s.clear();
      storeData[name].forEach((v) => s.put(v));
    }
  } catch (err) {
    // put() wirft synchron bei kaputten Schlüsseln — ohne Abbruch würde die
    // Transaktion sonst automatisch committen und Stores halb leer zurücklassen.
    tx.abort();
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Web-Locks-Mutex einheitlich: gibt { busy: true } zurück, wenn ein anderer
// Tab/Aufruf die DB gerade hält, sonst { busy: false, result } mit dem
// Rückgabewert von fn() (der selbst undefined sein darf).
export async function withDbLock(fn, onBusy) {
  if (!navigator.locks?.request) {
    return { busy: false, result: await fn() };
  }
  return navigator.locks.request('polit-monitor-db', { ifAvailable: true }, async (lock) => {
    if (!lock) {
      onBusy?.();
      return { busy: true };
    }
    return { busy: false, result: await fn() };
  });
}

export async function getConfig(key, fallback = null) {
  const row = await get('config', key);
  return row ? row.value : fallback;
}

export function setConfig(key, value) {
  return put('config', { key, value });
}
