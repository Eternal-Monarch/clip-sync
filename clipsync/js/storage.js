// IndexedDB (clips + meta) with an in-memory fallback, plus localStorage preferences.
const DB_NAME = 'clipsync';
const DB_VERSION = 1;
let dbPromise = null;
let useMemory = false;
const mem = { clips: new Map(), meta: new Map() };

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('clips')) {
        const s = db.createObjectStore('clips', { keyPath: 'id' });
        s.createIndex('created_at', 'created_at');
        s.createIndex('dirty', '_dirty'); // 1 = has unsynced changes (this is the outbox)
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  }).catch((err) => {
    console.warn('[ClipSync] IndexedDB failed, using memory only:', err);
    useMemory = true;
    return null;
  });
  return dbPromise;
}

export const isPersistent = async () => { await open(); return !useMemory; };

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let req;
    try { req = fn(tx.objectStore(store)); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function getAllClips() {
  await open();
  return useMemory ? [...mem.clips.values()] : run('clips', 'readonly', (s) => s.getAll());
}
export async function getClip(id) {
  await open();
  return useMemory ? mem.clips.get(id) : run('clips', 'readonly', (s) => s.get(id));
}
export async function putClip(clip) { return putClips([clip]); }
export async function putClips(list) {
  await open();
  if (useMemory) { list.forEach((c) => mem.clips.set(c.id, c)); return; }
  await run('clips', 'readwrite', (s) => { list.forEach((c) => s.put(c)); });
}
export async function deleteClips(ids) {
  await open();
  if (useMemory) { ids.forEach((id) => mem.clips.delete(id)); return; }
  await run('clips', 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); });
}
export async function clearClips() {
  await open();
  if (useMemory) { mem.clips.clear(); return; }
  await run('clips', 'readwrite', (s) => s.clear());
}
export async function pendingClips() {
  await open();
  if (useMemory) return [...mem.clips.values()].filter((c) => c._dirty === 1);
  return run('clips', 'readonly', (s) => s.index('dirty').getAll(1));
}

export async function getMeta(key, fallback = null) {
  await open();
  if (useMemory) return mem.meta.has(key) ? mem.meta.get(key) : fallback;
  const row = await run('meta', 'readonly', (s) => s.get(key));
  return row ? row.value : fallback;
}
export async function setMeta(key, value) {
  await open();
  if (useMemory) { mem.meta.set(key, value); return; }
  await run('meta', 'readwrite', (s) => s.put({ key, value }));
}
export async function deleteMeta(key) {
  await open();
  if (useMemory) { mem.meta.delete(key); return; }
  await run('meta', 'readwrite', (s) => s.delete(key));
}

// ---------- Preferences (localStorage; lightweight settings only) ----------
const PREFS_KEY = 'clipsync.prefs.v1';
const DEFAULT_PREFS = { theme: 'system', notifyInApp: true, notifyBrowser: false, notifySound: false, deviceName: '', sort: 'newest' };

export function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage full/blocked */ }
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function getDeviceId() {
  let id = null;
  try { id = localStorage.getItem('clipsync.deviceId'); } catch { /* ignore */ }
  if (!id) {
    id = uuid();
    try { localStorage.setItem('clipsync.deviceId', id); } catch { /* ignore */ }
  }
  return id;
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage || 0, quota: e.quota || 0 } : null;
  } catch { return null; }
}
