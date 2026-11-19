// Offline-first sync engine.
//  - IndexedDB (via storage.js) is the source of truth for the UI; `cache` mirrors it in memory.
//  - Any clip with _dirty=1 is "in the outbox". New clips are upserted whole; existing clips send
//    only the fields that changed (_patch), so concurrent edits on different fields both survive.
//  - Supabase Realtime is the fast path; a catch-up pull (updated_at cursor) is the guarantee.
import * as store from './storage.js';
import { getClient, getSession, onAuthChange, isConfigured, signOut } from './supabase.js';

export const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export const cache = new Map(); // id -> clip (all local rows, including tombstones)

const FIELDS = ['content', 'pinned', 'favorite', 'tags', 'deleted_at']; // mutable after creation
const PULL_OVERLAP_MS = 2 * 60 * 1000;   // re-read a small window to survive out-of-order commits
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
const HEARTBEAT_MS = 45 * 1000;
const ONLINE_WINDOW_MS = 90 * 1000;

export const state = {
  deviceId: '', deviceName: '', deviceType: 'other',
  user: null, online: navigator.onLine,
  syncing: false, authProblem: false, lastError: null,
  realtime: 'idle', pending: 0, lastSync: null,
  devices: [], presence: new Set(), status: 'local',
};

let retries = 0, retryTimer = null, heartbeatTimer = null, pushing = false, pulling = false;
let chClips = null, chPresence = null;
const db = () => getClient();

// ---------------------------------------------------------------- status
export function canSync() { return !!(state.user && navigator.onLine && !state.authProblem); }

function computeStatus() {
  if (!isConfigured() || !state.user) return 'local';
  if (state.authProblem) return 'auth';
  if (!navigator.onLine) return 'offline';
  if (state.syncing) return 'syncing';
  if (state.lastError) return 'error';
  return 'synced';
}
function refreshStatus() {
  state.status = computeStatus();
  emit('status', state);
}
async function refreshPending() {
  state.pending = (await store.pendingClips()).length;
  refreshStatus();
}

// ---------------------------------------------------------------- init
export async function initLocal({ deviceName, deviceType }) {
  state.deviceId = store.getDeviceId();
  state.deviceName = deviceName;
  state.deviceType = deviceType;
  for (const c of await store.getAllClips()) cache.set(c.id, c);
  state.lastSync = await store.getMeta('lastSync', null);
  await purgeLocalTombstones();
  await refreshPending();

  addEventListener('online', () => { state.online = true; state.lastError = null; refreshStatus(); kick(); pull(); });
  addEventListener('offline', () => { state.online = false; refreshStatus(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.user) return;
    getClient()?.realtime?.connect?.();
    pull(); kick(); heartbeat();
  });
}

export async function initCloud() {
  if (!isConfigured()) { refreshStatus(); return; }
  let session = null;
  try { session = await getSession(); } catch { /* offline with expired token */ }
  if (session) await startSession(session);
  onAuthChange((event, s) => {
    setTimeout(() => {
      if (event === 'SIGNED_IN' && s && !state.user) startSession(s);
      else if (event === 'SIGNED_OUT') stopSession();
      else if (event === 'TOKEN_REFRESHED' && s) { state.authProblem = false; refreshStatus(); kick(); }
    }, 0);
  });
}

async function startSession(session) {
  state.user = session.user;
  state.authProblem = false;
  // If another account used this browser before, drop its cache so we never upload foreign data.
  const owner = await store.getMeta('owner', null);
  if (owner && owner !== session.user.id) {
    cache.clear();
    await store.clearClips();
    await store.deleteMeta('cursor');
  }
  await store.setMeta('owner', session.user.id);
  refreshStatus();
  subscribe();
  await ensureDevice();
  await loadDevices();
  await pull();
  await push();
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  dailyPurge();
}

function stopSession() {
  unsubscribe();
  clearInterval(heartbeatTimer);
  clearTimeout(retryTimer);
  state.user = null; state.devices = []; state.presence = new Set(); state.realtime = 'idle';
  state.lastError = null; state.authProblem = false;
  refreshStatus(); emit('devices');
}

export async function disconnect() {
  await signOut();
  stopSession();
}

// ---------------------------------------------------------------- realtime
function subscribe() {
  unsubscribe();
  const c = db(); const uid = state.user.id;

  chClips = c.channel(`clipsync-rows:${uid}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'clips', filter: `user_id=eq.${uid}` }, onClipChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'devices', filter: `user_id=eq.${uid}` }, () => loadDevices())
    .subscribe((status) => {
      state.realtime = status === 'SUBSCRIBED' ? 'connected' : status === 'CLOSED' ? 'closed' : 'error';
      if (status === 'SUBSCRIBED') pull(); // catch up on anything missed while disconnected
      emit('status', state);
    });

  // Presence is on a separate private channel so a presence problem can never break clip sync.
  chPresence = c.channel(`clipsync:${uid}`, { config: { private: true, presence: { key: state.deviceId } } })
    .on('presence', { event: 'sync' }, () => {
      state.presence = new Set(Object.keys(chPresence.presenceState()));
      emit('devices');
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await chPresence.track({ name: state.deviceName, at: Date.now() });
    });
}

function unsubscribe() {
  const c = db();
  if (chClips) { c?.removeChannel(chClips); chClips = null; }
  if (chPresence) { c?.removeChannel(chPresence); chPresence = null; }
}

function onClipChange(payload) {
  if (payload.eventType === 'DELETE') {
    const id = payload.old?.id;
    if (id && cache.has(id)) { cache.delete(id); store.deleteClips([id]); emit('clips'); }
    return;
  }
  mergeRemote(payload.new, { notify: true });
}

// ---------------------------------------------------------------- merge
function cleanRow(r) {
  return {
    id: r.id, content: r.content ?? '', device_id: r.device_id, device_name: r.device_name || '',
    pinned: !!r.pinned, favorite: !!r.favorite, tags: r.tags || [],
    created_at: r.created_at, updated_at: r.updated_at, deleted_at: r.deleted_at,
  };
}
const synced = (row) => ({ ...cleanRow(row), _dirty: 0, _new: false, _patch: {} });
const ts = (s) => (s ? Date.parse(s) : 0);

async function putLocal(clip) {
  cache.set(clip.id, clip);
  await store.putClip(clip);
}

async function mergeRemote(row, { notify = false } = {}) {
  const local = cache.get(row.id) || await store.getClip(row.id);
  let next;
  if (!local || local._new) {
    next = synced(row);
  } else if (!local._dirty) {
    if (ts(row.updated_at) <= ts(local.updated_at)) return; // echo of our own write / stale event
    next = synced(row);
  } else {
    // Local unsynced edits win for the fields we changed; everything else follows the server.
    next = { ...local };
    for (const k of FIELDS) if (!(k in local._patch)) next[k] = row[k] ?? next[k];
    next.updated_at = row.updated_at;
    if (row.deleted_at) { next.deleted_at = row.deleted_at; next.content = ''; next._patch = {}; next._dirty = 0; }
  }
  await putLocal(next);
  emit('clips');
  // Notify only for clips this device has never seen, from another device.
  if (!local && notify && !row.deleted_at && row.device_id !== state.deviceId) emit('incoming', { clip: next });
}

// ---------------------------------------------------------------- local mutations
export async function saveNew(clip) {
  await putLocal(clip);
  emit('clips');
  await refreshPending();
  kick();
}

export async function updateClip(id, fields) {
  const c = cache.get(id);
  if (!c) return;
  const next = { ...c, ...fields, _dirty: 1 };
  if (!c._new) next._patch = { ...c._patch, ...fields };
  await putLocal(next);
  emit('clips');
  await refreshPending();
  kick();
}

export async function deleteClips(ids) {
  const now = new Date().toISOString();
  const drop = [], keep = [];
  for (const id of ids) {
    const c = cache.get(id);
    if (!c) continue;
    if (c._new) { drop.push(id); continue; } // never reached the cloud: just forget it
    const f = { deleted_at: now, content: '' };
    keep.push({ ...c, ...f, _dirty: 1, _patch: { ...c._patch, ...f } });
  }
  drop.forEach((id) => cache.delete(id));
  keep.forEach((c) => cache.set(c.id, c));
  if (drop.length) await store.deleteClips(drop);
  if (keep.length) await store.putClips(keep);
  emit('clips');
  await refreshPending();
  kick();
}

export async function clearAll() {
  await deleteClips([...cache.values()].filter((c) => !c.deleted_at).map((c) => c.id));
}

export async function clearLocalCache() {
  cache.clear();
  await store.clearClips();
  await store.deleteMeta('cursor');
  await store.deleteMeta('lastSync');
  state.lastSync = null;
  emit('clips');
  await refreshPending();
  if (canSync()) await pull();
}

export function pendingCount() { return state.pending; }

// ---------------------------------------------------------------- push (outbox → cloud)
function classify(e) {
  const msg = String(e?.message || e);
  if (!navigator.onLine || /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) return 'network';
  if (e?.status === 401 || e?.code === 'PGRST301' || /jwt/i.test(msg)) return 'auth';
  return 'other';
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function toRow(c) {
  return { id: c.id, content: c.content, device_id: c.device_id, device_name: c.device_name,
    pinned: c.pinned, favorite: c.favorite, tags: c.tags, created_at: c.created_at, deleted_at: c.deleted_at };
}

// After a successful write: adopt the server's values, but keep anything the user changed mid-flight.
async function applyPushed(id, server, sent) {
  const local = cache.get(id);
  if (!local) return;
  const remaining = FIELDS.filter((k) => !same(local[k], sent[k]));
  const next = { ...local };
  for (const k of FIELDS) if (!remaining.includes(k)) next[k] = server[k] ?? local[k];
  next.updated_at = server.updated_at;
  next._new = false;
  next._patch = pick(local, remaining);
  next._dirty = remaining.length ? 1 : 0;
  delete next._error;
  await putLocal(next);
}

async function push() {
  if (pushing || !canSync()) return;
  pushing = true; state.syncing = true; refreshStatus();
  try {
    const pend = (await store.pendingClips()).filter((c) => !c._error)
      .sort((a, b) => ts(a.created_at) - ts(b.created_at));

    // 1) brand-new clips: idempotent upsert of the full row
    for (const c of pend.filter((x) => x._new)) {
      const sent = pick(c, FIELDS);
      const { data, error } = await db().from('clips').upsert(toRow(c), { onConflict: 'id' }).select().single();
      if (error) { if (await handlePushError(error, c)) continue; throw error; }
      await applyPushed(c.id, data, sent);
    }

    // 2) changes to existing clips: group identical patches so "clear all" is a few requests
    const groups = new Map();
    for (const c of pend.filter((x) => !x._new)) {
      const key = JSON.stringify(c._patch);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const [key, items] of groups) {
      const patch = JSON.parse(key);
      for (let i = 0; i < items.length; i += 100) {
        const chunk = items.slice(i, i + 100);
        const { data, error } = await db().from('clips').update(patch).in('id', chunk.map((c) => c.id)).select();
        if (error) { if (await handlePushError(error, chunk[0])) continue; throw error; }
        const byId = new Map(data.map((r) => [r.id, r]));
        for (const c of chunk) {
          const r = byId.get(c.id);
          if (r) await applyPushed(c.id, r, patch);
          else await putLocal({ ...cache.get(c.id), _dirty: 0, _patch: {} }); // row gone remotely
        }
      }
    }

    retries = 0; state.lastError = null;
    await markSynced();
  } catch (e) {
    const kind = classify(e);
    if (kind === 'auth') await handleAuthProblem();
    else if (kind !== 'network') state.lastError = e.message || String(e);
    scheduleRetry();
  } finally {
    pushing = false; state.syncing = false;
    await refreshPending();
    emit('clips');
  }
}

// Permanent per-item failure (e.g. constraint violation): park the item so it can't block the queue.
async function handlePushError(error, clip) {
  const kind = classify(error);
  if (kind !== 'other') return false;
  if (error.code && /^(23|42|22)/.test(error.code)) {
    await putLocal({ ...cache.get(clip.id), _error: error.message });
    state.lastError = error.message;
    return true;
  }
  return false;
}

async function handleAuthProblem() {
  try {
    const { error } = await db().auth.refreshSession();
    if (!error) { kick(); return; }
  } catch { /* ignore */ }
  state.authProblem = true;
  refreshStatus();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (!state.user) return;
  retryTimer = setTimeout(() => { kick(); }, Math.min(60000, 2000 * 2 ** retries++));
}

let kickTimer = null;
export function kick() {
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => { push(); }, 0);
}

async function markSynced() {
  state.lastSync = Date.now();
  await store.setMeta('lastSync', state.lastSync);
}

export async function retryNow() {
  state.lastError = null;
  retries = 0;
  const parked = [...cache.values()].filter((c) => c._error);
  for (const c of parked) { const n = { ...c }; delete n._error; await putLocal(n); }
  if (state.authProblem) { try { await db().auth.refreshSession(); state.authProblem = false; } catch { /* stays */ } }
  refreshStatus();
  await pull();
  await push();
}

// ---------------------------------------------------------------- pull (cloud → local)
async function pull() {
  if (pulling || !canSync()) return;
  pulling = true; state.syncing = true; refreshStatus();
  try {
    const cursor = await store.getMeta('cursor', null);
    const first = !cursor;
    const since = cursor ? new Date(Date.parse(cursor) - PULL_OVERLAP_MS).toISOString() : null;
    let maxTs = cursor, from = 0;
    for (;;) {
      let q = db().from('clips').select('*').order('updated_at', { ascending: true }).order('id').range(from, from + 499);
      if (since) q = q.gt('updated_at', since);
      const { data, error } = await q;
      if (error) throw error;
      for (const row of data) {
        await mergeRemote(row, { notify: !first });
        if (!maxTs || ts(row.updated_at) > ts(maxTs)) maxTs = row.updated_at;
      }
      if (data.length < 500) break;
      from += 500;
    }
    if (maxTs) await store.setMeta('cursor', maxTs);
    if (cursor && Date.now() - ts(cursor) > 25 * 24 * 3600 * 1000) await reconcile();
    state.lastError = null;
    await markSynced();
  } catch (e) {
    const kind = classify(e);
    if (kind === 'auth') await handleAuthProblem();
    else if (kind !== 'network') state.lastError = e.message || String(e);
  } finally {
    pulling = false; state.syncing = false;
    refreshStatus();
  }
}

// A device offline longer than the tombstone TTL may have missed purged deletions: compare id lists.
async function reconcile() {
  const ids = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from('clips').select('id').range(from, from + 999);
    if (error) throw error;
    data.forEach((r) => ids.add(r.id));
    if (data.length < 1000) break;
  }
  const stale = [...cache.values()].filter((c) => !c._dirty && !ids.has(c.id)).map((c) => c.id);
  if (stale.length) { stale.forEach((id) => cache.delete(id)); await store.deleteClips(stale); emit('clips'); }
}

// ---------------------------------------------------------------- housekeeping
async function purgeLocalTombstones() {
  const old = [...cache.values()].filter((c) => c.deleted_at && !c._dirty && Date.now() - ts(c.deleted_at) > TOMBSTONE_TTL_MS);
  if (!old.length) return;
  old.forEach((c) => cache.delete(c.id));
  await store.deleteClips(old.map((c) => c.id));
}

async function dailyPurge() {
  const last = await store.getMeta('lastPurge', 0);
  if (Date.now() - last < 24 * 3600 * 1000) return;
  try {
    const { error } = await db().rpc('purge_old_deleted');
    if (!error) await store.setMeta('lastPurge', Date.now());
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------- devices
async function ensureDevice() {
  const row = { id: state.deviceId, name: state.deviceName, type: state.deviceType, user_agent: navigator.userAgent.slice(0, 300) };
  try { await db().from('devices').upsert(row, { onConflict: 'id', ignoreDuplicates: true }); } catch { /* retried by heartbeat */ }
  await heartbeat();
}

async function heartbeat() {
  if (!canSync() || document.visibilityState === 'hidden') return;
  try {
    const { data, error } = await db().from('devices').update({ last_seen_at: new Date().toISOString() })
      .eq('id', state.deviceId).select('id');
    if (!error && data && !data.length) await ensureDevice(); // our row was removed from another device
  } catch { /* offline */ }
}

export async function loadDevices() {
  if (!canSync()) return;
  try {
    const { data, error } = await db().from('devices').select('*').order('last_seen_at', { ascending: false });
    if (error) throw error;
    state.devices = data;
    const me = data.find((d) => d.id === state.deviceId);
    if (me && me.name !== state.deviceName) { state.deviceName = me.name; emit('devicename', me.name); }
    emit('devices');
  } catch { /* keep previous list */ }
}

export function isDeviceOnline(dev) {
  if (dev.id === state.deviceId) return navigator.onLine && !!state.user;
  return state.presence.has(dev.id) || Date.now() - ts(dev.last_seen_at) < ONLINE_WINDOW_MS;
}

export async function renameDevice(id, name) {
  if (id === state.deviceId) state.deviceName = name;
  if (!canSync()) { if (id !== state.deviceId) throw new Error('You need to be online and signed in to rename other devices.'); return; }
  const { error } = await db().from('devices').update({ name }).eq('id', id);
  if (error) throw error;
  if (id === state.deviceId && chPresence) chPresence.track({ name, at: Date.now() });
  await loadDevices();
}

export async function removeDevice(id) {
  if (!canSync()) throw new Error('You need to be online and signed in to remove a device.');
  const { error } = await db().from('devices').delete().eq('id', id);
  if (error) throw error;
  await loadDevices();
}
