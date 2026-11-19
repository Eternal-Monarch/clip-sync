// ClipSync — application wiring: state, events, rendering orchestration.
import { loadPrefs, savePrefs, storageEstimate, isPersistent } from './storage.js';
import { validate, copyText, createClip, MAX_LEN } from './clipboard.js';
import * as sync from './sync.js';
import { isConfigured, signIn, signUp } from './supabase.js';
import * as ui from './ui.js';
import * as notify from './notifications.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['clips', 'favorites', 'pinned', 'devices', 'settings'];
const TITLES = { clips: 'All clips', favorites: 'Favorites', pinned: 'Pinned', devices: 'Devices', settings: 'Settings' };
const CLIP_VIEWS = new Set(['clips', 'favorites', 'pinned']);

const prefs = loadPrefs();
const st = {
  view: 'clips', query: '', device: 'all', sort: prefs.sort === 'oldest' ? 'oldest' : 'newest',
  limit: 40, selectMode: false, selected: new Set(), expanded: new Set(), fresh: new Set(),
  activity: [], lc: new Map(), sending: false, filterSig: '', lastStatus: '',
};

// ---------------------------------------------------------------- device detection
function detectDevice() {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || navigator.userAgentData?.mobile;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  if (mobile) {
    const tablet = /iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua));
    return { type: tablet ? 'tablet' : 'phone', name: `${os} ${tablet ? 'Tablet' : 'Smartphone'}` };
  }
  return { type: 'desktop', name: `${os} Laptop` };
}

// ---------------------------------------------------------------- helpers
const devMap = () => new Map(sync.state.devices.map((d) => [d.id, d]));
function clipLabel(c) {
  if (c.device_id === sync.state.deviceId) return sync.state.deviceName || c.device_name || 'This device';
  return devMap().get(c.device_id)?.name || c.device_name || 'Unknown device';
}
function clipIcon(c) {
  const type = c.device_id === sync.state.deviceId ? sync.state.deviceType : devMap().get(c.device_id)?.type;
  return type === 'phone' || type === 'tablet' ? 'phone' : type === 'desktop' ? 'laptop' : 'globe';
}
function logActivity(text) {
  st.activity.unshift({ text, ts: Date.now() });
  st.activity.length = Math.min(st.activity.length, 8);
  renderActivity();
}

function visibleClips() {
  const q = st.query.trim().toLowerCase();
  const out = [];
  for (const c of sync.cache.values()) {
    if (c.deleted_at) continue;
    if (st.view === 'favorites' && !c.favorite) continue;
    if (st.view === 'pinned' && !c.pinned) continue;
    if (st.device !== 'all' && c.device_id !== st.device) continue;
    if (q) {
      let lc = st.lc.get(c.id);
      if (lc === undefined) { lc = c.content.toLowerCase(); st.lc.set(c.id, lc); }
      if (!lc.includes(q) && !c.tags.some((t) => t.toLowerCase().includes(q)) && !clipLabel(c).toLowerCase().includes(q)) continue;
    }
    out.push(c);
  }
  const dir = st.sort === 'oldest' ? 1 : -1;
  out.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || dir * (Date.parse(a.created_at) - Date.parse(b.created_at)));
  return out;
}

// ---------------------------------------------------------------- rendering
let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}
function render() {
  renderStatus();
  if (CLIP_VIEWS.has(st.view)) renderClips();
  renderDevices();
  if (st.view === 'settings') renderSettings();
}

function emptyFor() {
  if (st.query.trim() || st.device !== 'all') return { title: 'No matches', sub: 'Try a different search or clear the filters.' };
  if (st.view === 'favorites') return { title: 'No favorites yet', sub: 'Tap the star on any clip to keep it here.' };
  if (st.view === 'pinned') return { title: 'Nothing pinned', sub: 'Pin a clip to keep it at the top of your list.' };
  return { title: 'No clips yet', sub: 'Paste text above and send it. It appears on all your signed-in devices.' };
}

function renderClips() {
  const clips = visibleClips();
  const ctx = { fresh: st.fresh, selected: st.selected, expanded: st.expanded, selectMode: st.selectMode, label: clipLabel, deviceIcon: clipIcon, showPending: sync.state.status !== 'local' };
  ui.renderList($('list'), clips, ctx, { limit: st.limit, emptyMessage: emptyFor() });
  st.fresh.clear();
  renderDeviceFilter();
  $('bulkCount').textContent = `${st.selected.size} selected`;
  $('bulkDelete').disabled = st.selected.size === 0;
}

function renderDeviceFilter() {
  const seen = new Map();
  for (const c of sync.cache.values()) if (!c.deleted_at && c.device_id && !seen.has(c.device_id)) seen.set(c.device_id, clipLabel(c));
  const sig = JSON.stringify([...seen]) + st.device;
  if (sig === st.filterSig) return;
  st.filterSig = sig;
  const sel = $('deviceFilter');
  sel.replaceChildren(new Option('All devices', 'all'));
  seen.forEach((name, id) => sel.appendChild(new Option(name, id)));
  if (!seen.has(st.device)) st.device = 'all';
  sel.value = st.device;
}

const STATUS_TEXT = {
  local: 'Local only', offline: 'Offline', syncing: 'Syncing…', synced: 'Synced', error: 'Sync error', auth: 'Sign in needed',
};
function renderStatus() {
  const s = sync.state;
  const conn = $('conn');
  conn.dataset.state = s.status;
  let label = STATUS_TEXT[s.status];
  if (s.pending > 0 && ['offline', 'error', 'syncing', 'auth'].includes(s.status)) label += ` · ${s.pending} pending`;
  conn.querySelector('.conn-label').textContent = label;
  conn.title = s.lastSync ? `Last synchronized ${new Date(s.lastSync).toLocaleString()}` : 'Not synchronized yet';

  if (st.lastStatus !== s.status) {
    if (st.lastStatus && s.status === 'offline') logActivity('Went offline');
    else if (st.lastStatus === 'offline' && s.status !== 'offline') logActivity('Back online');
    st.lastStatus = s.status;
  }

  const banner = $('banner');
  let msg = null, btn = null;
  if (!isConfigured()) msg = 'Cloud sync is not set up yet. Add your Supabase URL and key in js/config.js. Until then ClipSync works on this device only.';
  else if (s.status === 'local') { msg = 'Local only. Sign in to share clips between your devices.'; btn = ['Sign in', 'signin']; }
  else if (s.status === 'auth') { msg = 'Your session expired. Sign in again to resume syncing. Nothing is lost.'; btn = ['Sign in', 'signin']; }
  else if (s.status === 'error') { msg = `Sync problem: ${s.lastError || 'unknown error'}.`; btn = ['Retry', 'retry']; }
  banner.hidden = !msg;
  if (msg) {
    banner.replaceChildren(ui.el('span', null, msg));
    if (btn) { const b = ui.el('button', 'btn btn-sm', btn[0]); b.type = 'button'; b.dataset.act = btn[1]; banner.appendChild(b); }
  }
  $('accountLine').textContent = s.user ? s.user.email : 'Not signed in';
}

function renderDevices() {
  const s = sync.state;
  let devices = s.devices.slice();
  if (!devices.some((d) => d.id === s.deviceId)) {
    devices.unshift({ id: s.deviceId, name: s.deviceName, type: s.deviceType, last_seen_at: new Date().toISOString() });
  }
  devices.sort((a, b) => (b.id === s.deviceId) - (a.id === s.deviceId)
    || Number(sync.isDeviceOnline(b)) - Number(sync.isDeviceOnline(a))
    || Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at));

  const list = $('deviceList');
  list.replaceChildren(...devices.map((d) => ui.buildDeviceRow(d, {
    self: d.id === s.deviceId,
    online: d.id === s.deviceId && !s.user ? navigator.onLine : sync.isDeviceOnline(d),
    onlineLabel: s.user ? 'Online' : 'Local only',
  })));

  const mini = $('devMini');
  mini.replaceChildren(...devices.map((d) => {
    const on = d.id === s.deviceId && !s.user ? navigator.onLine : sync.isDeviceOnline(d);
    const li = ui.el('li', 'mini');
    li.appendChild(ui.el('span', 'dot ' + (on ? 'on' : 'off')));
    li.appendChild(ui.el('span', 'mini-name', d.name));
    li.appendChild(ui.el('span', 'mini-state', on ? 'Online' : 'Offline'));
    return li;
  }));
  renderDeviceFilter();
}

function renderActivity() {
  const ul = $('activity');
  if (!st.activity.length) { ul.replaceChildren(ui.el('li', 'muted', 'Nothing yet')); return; }
  ul.replaceChildren(...st.activity.map((a) => {
    const li = ui.el('li');
    li.appendChild(ui.el('span', 'act-text', a.text));
    const t = ui.el('time', 'act-time', ui.relTime(a.ts)); t.dataset.ts = String(a.ts);
    li.appendChild(t);
    return li;
  }));
}

function kv(dl, rows) {
  dl.replaceChildren();
  rows.forEach(([k, v]) => { dl.appendChild(ui.el('dt', null, k)); dl.appendChild(ui.el('dd', null, v)); });
}

async function renderSettings() {
  const s = sync.state;
  document.querySelectorAll('[data-theme-opt]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeOpt === prefs.theme)));
  $('setInApp').checked = prefs.notifyInApp;
  $('setSound').checked = prefs.notifySound;
  const supported = notify.browserNotificationsSupported();
  $('setBrowser').disabled = !supported;
  $('setBrowser').checked = supported && prefs.notifyBrowser && Notification.permission === 'granted';
  if (supported && Notification.permission === 'denied') $('browserNote').textContent = 'Blocked in your browser settings for this site. Allow notifications there to turn this on.';
  if (document.activeElement !== $('setDeviceName')) $('setDeviceName').value = s.deviceName;

  kv($('deviceInfo'), [['Type', s.deviceType], ['Identifier', s.deviceId], ['Browser', navigator.userAgent.slice(0, 90)]]);
  kv($('syncInfo'), [
    ['Connection', STATUS_TEXT[s.status]],
    ['Realtime', s.user ? ({ connected: 'Connected', closed: 'Disconnected', error: 'Reconnecting…', idle: 'Starting…' }[s.realtime]) : 'Not signed in'],
    ['Last synchronization', s.lastSync ? `${ui.relTime(s.lastSync)} (${new Date(s.lastSync).toLocaleString()})` : 'Never'],
    ['Pending clips', String(s.pending)],
    ['Account', s.user ? s.user.email : 'Not signed in'],
  ]);
  $('signInBtn').hidden = !!s.user || !isConfigured();
  $('retryBtn').hidden = !s.user;
  $('signOutBtn').hidden = !s.user;

  const count = [...sync.cache.values()].filter((c) => !c.deleted_at).length;
  const persistent = await isPersistent();
  const est = await storageEstimate();
  kv($('storageInfo'), [
    ['Clipboard history', `${count.toLocaleString()} ${count === 1 ? 'clip' : 'clips'}`],
    ['Local storage', persistent ? 'IndexedDB' : 'Memory only (this browser blocks IndexedDB)'],
    ['Space used', est ? `${(est.usage / 1048576).toFixed(2)} MB` : 'Unknown'],
  ]);
}

// ---------------------------------------------------------------- views
function setView(v, { updateHash = true } = {}) {
  if (!VIEWS.includes(v)) v = 'clips';
  st.view = v; st.limit = 40;
  if (!CLIP_VIEWS.has(v)) exitSelect(false);
  $('v-clips').hidden = !CLIP_VIEWS.has(v);
  $('v-devices').hidden = v !== 'devices';
  $('v-settings').hidden = v !== 'settings';
  $('composer').hidden = v !== 'clips';
  $('viewTitle').textContent = TITLES[v];
  document.querySelectorAll('[data-view]').forEach((b) => {
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const section = $(`v-${CLIP_VIEWS.has(v) ? 'clips' : v}`);
  section.classList.remove('view-in'); void section.offsetWidth; section.classList.add('view-in');
  if (updateHash && location.hash.slice(1) !== v) history.pushState(null, '', `#${v}`);
  if (v === 'clips') notify.clearUnseen();
  render();
}
const viewFromHash = () => (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'clips');

// ---------------------------------------------------------------- composer
function updateComposer() {
  const inp = $('input'), n = inp.value.length;
  $('counter').textContent = `${n.toLocaleString()} / ${MAX_LEN.toLocaleString()}`;
  $('counter').classList.toggle('over', n > MAX_LEN);
  $('clearBtn').disabled = n === 0 || st.sending;
  $('sendBtn').disabled = !inp.value.trim() || n > MAX_LEN || st.sending;
  inp.style.height = 'auto';
  inp.style.height = `${Math.min(inp.scrollHeight, 280)}px`;
}

async function send() {
  if (st.sending) return;
  const text = $('input').value;
  const v = validate(text);
  if (!v.ok) { notify.toast(v.error, { type: 'error' }); return; }
  st.sending = true; $('sendBtn').classList.add('loading'); updateComposer();
  try {
    const clip = createClip({ content: text, deviceId: sync.state.deviceId, deviceName: sync.state.deviceName });
    await sync.saveNew(clip);          // saved locally first: never lost, even if the cloud is down
    st.fresh.add(clip.id);
    $('input').value = '';
    const s = sync.state.status;
    notify.toast(
      s === 'local' ? 'Saved on this device. Sign in to share it.'
        : s === 'offline' ? 'Saved. It will sync when you are back online.'
          : s === 'auth' ? 'Saved. Sign in again to sync it.'
            : 'Saved. Syncing to your devices…',
      { type: 'success' });
    logActivity('You saved a clip');
    scheduleRender();
  } catch (e) {
    console.error(e);
    notify.toast("Couldn't save this clip. Your text is still in the box.", { type: 'error', timeout: 6000 });
  } finally {
    st.sending = false; $('sendBtn').classList.remove('loading'); updateComposer();
  }
}

// ---------------------------------------------------------------- clip actions
async function doCopy(clip, btn) {
  const ok = await copyText(clip.content);
  if (!ok) { notify.toast('Copy was blocked by the browser. Press and hold the text to copy it manually.', { type: 'error', timeout: 6000 }); return; }
  notify.announce('Copied to clipboard');
  if (btn?.isConnected) {
    btn.classList.add('done');
    btn.querySelector('use')?.setAttribute('href', '#i-check');
    btn.querySelector('.copy-label').textContent = 'Copied';
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.classList.remove('done');
      btn.querySelector('use')?.setAttribute('href', '#i-copy');
      btn.querySelector('.copy-label').textContent = 'Copy';
    }, 1400);
  }
}

function parseTags(str) {
  const out = [];
  for (const t of str.split(',')) {
    const x = t.trim().slice(0, 30);
    if (x && !out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x);
  }
  return out.slice(0, 20);
}

function enterSelect(id) {
  st.selectMode = true; if (id) st.selected.add(id);
  $('selectBtn').setAttribute('aria-pressed', 'true'); $('bulkbar').hidden = false;
  renderClips();
}
function exitSelect(rerender = true) {
  st.selectMode = false; st.selected.clear();
  $('selectBtn').setAttribute('aria-pressed', 'false'); $('bulkbar').hidden = true;
  if (rerender) renderClips();
}

async function onListClick(e) {
  const t = e.target.closest('[data-act]');
  const card = e.target.closest('.card');
  const id = card?.dataset.id;
  if (!t) {
    if (st.selectMode && card && !e.target.closest('a')) { toggleSelected(id); }
    return;
  }
  const act = t.dataset.act;
  const clip = id ? sync.cache.get(id) : null;
  if (act === 'more-items') { st.limit += 40; renderClips(); return; }
  if (!clip) return;
  switch (act) {
    case 'copy': await doCopy(clip, t); break;
    case 'fav': await sync.updateClip(id, { favorite: !clip.favorite }); break;
    case 'pin': await sync.updateClip(id, { pinned: !clip.pinned }); break;
    case 'toggle': st.expanded.has(id) ? st.expanded.delete(id) : st.expanded.add(id); renderClips(); break;
    case 'select': toggleSelected(id, t.checked); break;
    case 'more':
      ui.openMenu(t, [
        { icon: 'select', label: 'Select', onClick: () => enterSelect(id) },
        { icon: 'tag', label: 'Edit tags', onClick: () => editTags(id) },
        { icon: 'trash', label: 'Delete', danger: true, onClick: () => deleteOne(id) },
      ]);
      break;
    default: break;
  }
}

function toggleSelected(id, force) {
  const on = force ?? !st.selected.has(id);
  on ? st.selected.add(id) : st.selected.delete(id);
  renderClips();
}

async function editTags(id) {
  const clip = sync.cache.get(id);
  if (!clip) return;
  const val = await ui.promptDialog({ title: 'Edit tags', message: 'Separate tags with commas.', input: { label: 'Tags', value: clip.tags.join(', '), placeholder: 'work, link, code', maxLength: 300 } });
  if (val === null) return;
  await sync.updateClip(id, { tags: parseTags(val) });
}

async function deleteOne(id) {
  const ok = await ui.confirmDialog({ title: 'Delete this clip?', message: 'It will be removed from all your devices. This can’t be undone.', confirmText: 'Delete', danger: true });
  if (ok) { await sync.deleteClips([id]); notify.toast('Clip deleted'); }
}

// ---------------------------------------------------------------- sync events
function handleIncoming({ clip }) {
  const label = clipLabel(clip);
  st.fresh.add(clip.id);
  logActivity(`Received a clip from ${label}`);
  if (!(document.visibilityState === 'visible' && st.view === 'clips')) notify.bumpUnseen();
  notify.notifyIncoming(clip, label, {
    onCopy: async () => { const ok = await copyText(clip.content); notify.toast(ok ? 'Copied to clipboard' : 'Copy was blocked by the browser', { type: ok ? 'success' : 'error', timeout: 2000 }); },
  });
}

// ---------------------------------------------------------------- auth dialog
function openAuth() {
  $('authError').hidden = true;
  if (!$('authDlg').open) $('authDlg').showModal();
  $('authEmail').focus();
}
function authFail(e) {
  const m = String(e?.message || e);
  let text = m;
  if (/invalid login credentials/i.test(m)) text = 'Email or password is incorrect.';
  else if (/signups? (are )?(not allowed|disabled)/i.test(m)) text = 'New sign-ups are turned off for this project. Sign in with your existing account.';
  else if (/failed to fetch|network/i.test(m)) text = 'Can’t reach the server. Check your connection and try again.';
  else if (/email not confirmed/i.test(m)) text = 'Confirm your email address first, then sign in.';
  $('authError').textContent = text; $('authError').hidden = false;
}
async function doAuth(mode) {
  const email = $('authEmail').value.trim(), pass = $('authPass').value;
  if (!/^\S+@\S+\.\S+$/.test(email)) return authFail('Enter a valid email address.');
  if (pass.length < 8) return authFail('Use a password with at least 8 characters.');
  const btns = [$('authSignIn'), $('authSignUp')];
  btns.forEach((b) => { b.disabled = true; });
  try {
    if (mode === 'in') { await signIn(email, pass); }
    else {
      const session = await signUp(email, pass);
      if (!session) { $('authError').textContent = 'Account created. Confirm it from the email we sent, then sign in.'; $('authError').hidden = false; return; }
    }
    $('authPass').value = '';
    $('authDlg').close();
    notify.toast('Signed in', { type: 'success', timeout: 2200 });
  } catch (e) { authFail(e); }
  finally { btns.forEach((b) => { b.disabled = false; }); }
}

// ---------------------------------------------------------------- event binding
function bind() {
  // navigation
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { setView(b.dataset.view); $('main').scrollTo?.(0, 0); window.scrollTo(0, 0); }));
  $('newBtn').addEventListener('click', () => { setView('clips'); window.scrollTo(0, 0); $('input').focus(); });
  $('navSearch').addEventListener('click', () => { setView('clips'); $('search').focus(); });
  $('conn').addEventListener('click', () => setView('settings'));
  addEventListener('hashchange', () => setView(viewFromHash(), { updateHash: false }));

  // composer
  const inp = $('input');
  inp.addEventListener('input', updateComposer);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { if (inp.value) { inp.value = ''; updateComposer(); } else inp.blur(); e.stopPropagation(); }
  });
  $('sendBtn').addEventListener('click', send);
  $('clearBtn').addEventListener('click', () => { inp.value = ''; updateComposer(); inp.focus(); });
  inp.addEventListener('focus', () => document.body.classList.add('kb'));
  inp.addEventListener('blur', () => setTimeout(() => document.body.classList.remove('kb'), 120));
  $('hint').textContent = /Mac/.test(navigator.platform) ? '⌘ + Enter to send' : 'Ctrl + Enter to send';

  // toolbar
  let t;
  $('search').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.query = e.target.value; st.limit = 40; renderClips(); }, 120); });
  $('deviceFilter').addEventListener('change', (e) => { st.device = e.target.value; st.limit = 40; st.filterSig = ''; renderClips(); });
  $('sortSel').value = st.sort;
  $('sortSel').addEventListener('change', (e) => { st.sort = e.target.value; prefs.sort = st.sort; savePrefs(prefs); renderClips(); });
  $('selectBtn').addEventListener('click', () => (st.selectMode ? exitSelect() : enterSelect()));
  $('bulkCancel').addEventListener('click', () => exitSelect());
  $('bulkAll').addEventListener('click', () => { visibleClips().forEach((c) => st.selected.add(c.id)); renderClips(); });
  $('bulkDelete').addEventListener('click', async () => {
    const n = st.selected.size; if (!n) return;
    const ok = await ui.confirmDialog({ title: `Delete ${n} ${n === 1 ? 'clip' : 'clips'}?`, message: 'They will be removed from all your devices. This can’t be undone.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    await sync.deleteClips([...st.selected]);
    exitSelect(); notify.toast(`${n} ${n === 1 ? 'clip' : 'clips'} deleted`);
  });

  $('list').addEventListener('click', onListClick);

  // banner
  $('banner').addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'signin') openAuth(); else if (a === 'retry') sync.retryNow();
  });

  // devices
  $('deviceList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.closest('.dev').dataset.id;
    const dev = sync.state.devices.find((d) => d.id === id) || { id, name: sync.state.deviceName };
    try {
      if (b.dataset.act === 'dev-rename') {
        const name = await ui.promptDialog({ title: 'Rename device', input: { label: 'Device name', value: dev.name, maxLength: 60 } });
        if (name === null || !name.trim()) return;
        await sync.renameDevice(id, name.trim());
        if (id === sync.state.deviceId) { prefs.deviceName = name.trim(); savePrefs(prefs); }
        scheduleRender();
      } else if (b.dataset.act === 'dev-remove') {
        const ok = await ui.confirmDialog({ title: `Remove “${dev.name}”?`, message: 'The device is removed from this list. If it is still signed in, it will register again the next time it opens ClipSync.', confirmText: 'Remove', danger: true });
        if (ok) await sync.removeDevice(id);
      }
    } catch (err) { notify.toast(err.message || 'That didn’t work. Try again.', { type: 'error', timeout: 5000 }); }
  });

  // settings
  document.querySelectorAll('[data-theme-opt]').forEach((b) => b.addEventListener('click', () => {
    prefs.theme = b.dataset.themeOpt; savePrefs(prefs); ui.applyTheme(prefs.theme, true); renderSettings();
  }));
  $('setInApp').addEventListener('change', (e) => { prefs.notifyInApp = e.target.checked; savePrefs(prefs); });
  $('setSound').addEventListener('change', (e) => { prefs.notifySound = e.target.checked; savePrefs(prefs); });
  $('setBrowser').addEventListener('change', async (e) => {
    if (!e.target.checked) { prefs.notifyBrowser = false; savePrefs(prefs); return; }
    const perm = await notify.requestBrowserPermission();
    prefs.notifyBrowser = perm === 'granted'; savePrefs(prefs);
    if (perm !== 'granted') { e.target.checked = false; notify.toast('Browser notifications were not allowed.', { type: 'error' }); renderSettings(); }
  });
  $('setDeviceName').addEventListener('change', async (e) => {
    const name = e.target.value.trim() || detectDevice().name;
    e.target.value = name; prefs.deviceName = name; savePrefs(prefs);
    try { await sync.renameDevice(sync.state.deviceId, name); }
    catch { notify.toast('Saved on this device. Couldn’t update the cloud copy yet.', { type: 'error' }); }
    scheduleRender();
  });
  $('retryBtn').addEventListener('click', async () => { notify.toast('Retrying synchronization…', { timeout: 1800 }); await sync.retryNow(); renderSettings(); });
  $('signInBtn').addEventListener('click', openAuth);
  $('clearCacheBtn').addEventListener('click', async () => {
    const pending = sync.state.pending;
    const ok = await ui.confirmDialog({
      title: 'Clear local cache?',
      message: pending ? `${pending} unsynced ${pending === 1 ? 'clip' : 'clips'} will be lost. Everything already synced is re-downloaded when you are signed in.` : 'Synced clips are downloaded again when you are signed in. Clips on this device that were never synced are lost.',
      confirmText: 'Clear cache', danger: true });
    if (ok) { st.lc.clear(); await sync.clearLocalCache(); notify.toast('Local cache cleared'); }
  });
  $('clearHistoryBtn').addEventListener('click', async () => {
    const ok = await ui.confirmDialog({ title: 'Clear all clipboard history?', message: 'Every clip is deleted from all your devices. This can’t be undone.', confirmText: 'Clear history', danger: true });
    if (ok) { await sync.clearAll(); notify.toast('Clipboard history cleared'); }
  });
  $('signOutBtn').addEventListener('click', async () => {
    const ok = await ui.confirmDialog({ title: 'Sign out of this device?', message: 'Clips stay on this device. Sync stops until you sign in again.', confirmText: 'Sign out' });
    if (ok) { await sync.disconnect(); notify.toast('Signed out'); }
  });

  // auth dialog
  $('authForm').addEventListener('submit', (e) => { e.preventDefault(); doAuth('in'); });
  $('authSignUp').addEventListener('click', () => doAuth('up'));
  $('authCancel').addEventListener('click', () => $('authDlg').close());

  // global keys / menu
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (ui.closeMenu()) { e.preventDefault(); return; }
      if (st.selectMode && !document.querySelector('dialog[open]')) { exitSelect(); return; }
    }
    if (ui.menuKeydown(e)) return;
    const tag = document.activeElement?.tagName;
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !document.querySelector('dialog[open]')) {
      e.preventDefault(); setView('clips'); $('search').focus();
    }
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#menu') && !e.target.closest('[data-act="more"]')) ui.closeMenu(false); });
  addEventListener('scroll', () => ui.closeMenu(false), { passive: true, capture: true });

  // sync bus
  sync.bus.addEventListener('clips', scheduleRender);
  sync.bus.addEventListener('status', scheduleRender);
  sync.bus.addEventListener('devices', scheduleRender);
  sync.bus.addEventListener('devicename', (e) => { prefs.deviceName = e.detail; savePrefs(prefs); scheduleRender(); });
  sync.bus.addEventListener('incoming', (e) => handleIncoming(e.detail));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && st.view === 'clips') notify.clearUnseen();
    ui.refreshTimes();
  });
  setInterval(() => { if (!document.hidden) ui.refreshTimes(); }, 30000);

  // install prompt
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('installBtn').hidden = false; });
  $('installBtn').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('installBtn').hidden = true; });
  addEventListener('appinstalled', () => { $('installBtn').hidden = true; });
}

// ---------------------------------------------------------------- boot
async function main() {
  ui.applyTheme(prefs.theme);
  notify.initNotifications();
  bind();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('service-worker.js').catch((e) => console.warn('[ClipSync] service worker failed', e));
  }
  const dev = detectDevice();
  await sync.initLocal({ deviceName: prefs.deviceName || dev.name, deviceType: dev.type });
  updateComposer();
  setView(viewFromHash(), { updateHash: false });
  sync.initCloud().catch((e) => console.error('[ClipSync] cloud init failed', e));
}
main().catch((e) => {
  console.error(e);
  document.getElementById('list').textContent = 'ClipSync failed to start. Reload the page.';
});
