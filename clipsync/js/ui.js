// Rendering and small UI primitives. Clipboard text is ALWAYS inserted via textContent/text nodes
// (never innerHTML) so submitted content can never execute as HTML.
const SVGNS = 'http://www.w3.org/2000/svg';

export function icon(name) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', `#i-${name}`);
  s.appendChild(u);
  return s;
}

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- theme
let themePref = 'system';
const mq = matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(pref, animate = false) {
  themePref = pref;
  const root = document.documentElement;
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('theme-anim');
    setTimeout(() => root.classList.remove('theme-anim'), 350);
  }
  const resolved = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
  root.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#0e0f13' : '#f6f6f8');
}
mq.addEventListener?.('change', () => { if (themePref === 'system') applyTheme('system'); });

// ---------------------------------------------------------------- time
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
export function relTime(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!t) return '';
  const s = Math.round((t - Date.now()) / 1000), a = Math.abs(s);
  if (a < 45) return 'just now';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 7 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: a > 300 * 86400 ? 'numeric' : undefined });
}
export const absTime = (iso) => new Date(iso).toLocaleString();
export function refreshTimes(root = document) {
  root.querySelectorAll('time[data-ts]').forEach((t) => { t.textContent = (t.dataset.prefix || '') + relTime(t.dataset.ts); });
}

// ---------------------------------------------------------------- linkify (display only)
const TOKEN = /(https?:\/\/[^\s<>"']+)|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(\+?\d[\d\s().-]{7,}\d)/g;
function safeUrl(u) { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; } }

export function linkify(text) {
  const frag = document.createDocumentFragment();
  let last = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    let [tok] = m, href = null;
    if (m[1]) { // strip trailing punctuation that is rarely part of the URL
      const trimmed = tok.replace(/[.,;:!?)\]}'"]+$/, '');
      tok = trimmed; href = safeUrl(trimmed);
    } else if (m[2]) href = `mailto:${tok}`;
    else if (m[3]) { const d = tok.replace(/[^\d+]/g, ''); if (d.replace('+', '').length >= 10 && d.length <= 16) href = `tel:${d}`; }
    if (!href) { continue; }
    if (m.index > last) frag.append(text.slice(last, m.index));
    const a = el('a', 'lnk', tok);
    a.href = href; a.rel = 'noopener noreferrer';
    if (m[1]) a.target = '_blank';
    frag.append(a);
    last = m.index + tok.length;
    TOKEN.lastIndex = last;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function safeSlice(s, n) {
  let out = s.slice(0, n);
  const c = out.charCodeAt(out.length - 1);
  if (c >= 0xd800 && c <= 0xdbff) out = out.slice(0, -1); // don't split a surrogate pair
  return out;
}

// ---------------------------------------------------------------- cards
const PREVIEW_CHARS = 600;
export const isLong = (t) => t.length > 320 || t.split('\n', 8).length > 6;

function iconBtn(act, name, label, pressed) {
  const b = el('button', 'icon-btn');
  b.type = 'button'; b.dataset.act = act; b.setAttribute('aria-label', label);
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
  b.appendChild(icon(name));
  return b;
}

export function buildCard(c, ctx) {
  const card = el('article', 'card' + (ctx.fresh.has(c.id) ? ' enter' : '') + (ctx.selected.has(c.id) ? ' selected' : ''));
  card.dataset.id = c.id;

  const head = el('div', 'card-head');
  if (ctx.selectMode) {
    const cb = el('input', 'sel'); cb.type = 'checkbox'; cb.checked = ctx.selected.has(c.id);
    cb.dataset.act = 'select'; cb.setAttribute('aria-label', 'Select clip');
    head.appendChild(cb);
  }
  const src = el('span', 'src');
  src.appendChild(icon(ctx.deviceIcon(c)));
  src.appendChild(el('span', 'src-name', ctx.label(c)));
  head.appendChild(src);
  const t = el('time', 'when', relTime(c.created_at));
  t.dataset.ts = c.created_at; t.dateTime = c.created_at; t.title = absTime(c.created_at);
  head.appendChild(t);
  if (c._error) {
    const ch = el('span', 'chip chip-err', 'Not synced'); ch.title = c._error; head.appendChild(ch);
  } else if (c._dirty && ctx.showPending) {
    const ch = el('span', 'chip chip-pend'); ch.appendChild(icon('clock')); ch.append('Pending'); head.appendChild(ch);
  }
  card.appendChild(head);

  const long = isLong(c.content), expanded = ctx.expanded.has(c.id);
  const body = el('div', 'card-body' + (long && !expanded ? ' clamp' : ''));
  const shown = long && !expanded && c.content.length > PREVIEW_CHARS ? safeSlice(c.content, PREVIEW_CHARS) + '…' : c.content;
  body.appendChild(linkify(shown));
  card.appendChild(body);
  if (long) {
    const tg = el('button', 'link-btn', expanded ? 'Show less' : 'Show more');
    tg.type = 'button'; tg.dataset.act = 'toggle'; tg.setAttribute('aria-expanded', String(expanded));
    card.appendChild(tg);
  }

  if (c.tags?.length) {
    const tags = el('div', 'tags');
    c.tags.forEach((x) => tags.appendChild(el('span', 'tag', x)));
    card.appendChild(tags);
  }

  const acts = el('div', 'card-actions');
  const copy = el('button', 'btn btn-primary copy-btn');
  copy.type = 'button'; copy.dataset.act = 'copy';
  copy.appendChild(icon('copy')); copy.appendChild(el('span', 'copy-label', 'Copy'));
  acts.appendChild(copy);
  const spacer = el('span', 'grow'); acts.appendChild(spacer);
  acts.appendChild(iconBtn('fav', 'star', c.favorite ? 'Remove from favorites' : 'Add to favorites', c.favorite));
  acts.appendChild(iconBtn('pin', 'pin', c.pinned ? 'Unpin' : 'Pin', c.pinned));
  const more = iconBtn('more', 'more', 'More options'); more.setAttribute('aria-haspopup', 'menu');
  acts.appendChild(more);
  card.appendChild(acts);
  return card;
}

export function renderList(container, clips, ctx, { limit, emptyMessage }) {
  const frag = document.createDocumentFragment();
  const slice = clips.slice(0, limit);
  for (const c of slice) frag.appendChild(buildCard(c, ctx));
  if (clips.length > limit) {
    const more = el('button', 'btn btn-ghost more-btn', `Show ${Math.min(40, clips.length - limit)} more`);
    more.type = 'button'; more.dataset.act = 'more-items';
    frag.appendChild(more);
  }
  if (!clips.length) {
    const e = el('div', 'empty');
    e.appendChild(icon('clipboard'));
    e.appendChild(el('p', 'empty-title', emptyMessage.title));
    e.appendChild(el('p', 'empty-sub', emptyMessage.sub));
    frag.appendChild(e);
  }
  container.replaceChildren(frag);
}

// ---------------------------------------------------------------- devices
export function buildDeviceRow(d, { self, online, onlineLabel }) {
  const row = el('li', 'dev');
  row.dataset.id = d.id;
  const ic = el('span', 'dev-ic'); ic.appendChild(icon(d.type === 'phone' || d.type === 'tablet' ? 'phone' : d.type === 'desktop' ? 'laptop' : 'globe'));
  row.appendChild(ic);
  const info = el('div', 'dev-info');
  const name = el('div', 'dev-name', d.name);
  if (self) name.appendChild(el('span', 'chip', 'This device'));
  info.appendChild(name);
  const meta = el('div', 'dev-meta');
  const st = el('span', 'dev-status ' + (online ? 'on' : 'off'));
  st.appendChild(el('span', 'dot')); st.append(online ? onlineLabel : 'Offline');
  meta.appendChild(st);
  const t = el('time', null, `Active ${relTime(d.last_seen_at)}`); t.dataset.ts = d.last_seen_at; t.dataset.prefix = 'Active ';
  meta.appendChild(t);
  meta.appendChild(el('span', 'dev-id', `ID ${d.id.slice(0, 8)}`));
  info.appendChild(meta);
  row.appendChild(info);
  const acts = el('div', 'dev-actions');
  const r = el('button', 'btn btn-ghost btn-sm', 'Rename'); r.type = 'button'; r.dataset.act = 'dev-rename';
  acts.appendChild(r);
  if (!self) { const x = el('button', 'btn btn-ghost btn-sm danger', 'Remove'); x.type = 'button'; x.dataset.act = 'dev-remove'; acts.appendChild(x); }
  row.appendChild(acts);
  return row;
}

// ---------------------------------------------------------------- dialogs
const dlg = () => document.getElementById('dlg');

function openDialog({ title, message, input, confirmText, danger }) {
  return new Promise((resolve) => {
    const d = dlg();
    d.querySelector('.dlg-title').textContent = title;
    d.querySelector('.dlg-msg').textContent = message || '';
    d.querySelector('.dlg-msg').hidden = !message;
    const field = d.querySelector('.dlg-field'), inp = d.querySelector('.dlg-input');
    field.hidden = !input;
    if (input) { d.querySelector('.dlg-label').textContent = input.label; inp.value = input.value || ''; inp.placeholder = input.placeholder || ''; inp.maxLength = input.maxLength || 80; }
    const ok = d.querySelector('.dlg-ok'), cancel = d.querySelector('.dlg-cancel');
    ok.textContent = confirmText; ok.className = 'btn dlg-ok ' + (danger ? 'btn-danger' : 'btn-primary');
    let result = null;
    const done = () => { d.removeEventListener('close', onClose); ok.onclick = null; cancel.onclick = null; resolve(result); };
    const onClose = () => done();
    d.addEventListener('close', onClose);
    ok.onclick = (e) => { e.preventDefault(); result = input ? inp.value : true; d.close(); };
    cancel.onclick = (e) => { e.preventDefault(); result = input ? null : false; d.close(); };
    d.querySelector('form').onsubmit = (e) => { e.preventDefault(); ok.click(); };
    d.showModal();
    if (input) { inp.focus(); inp.select(); } else cancel.focus();
  });
}
export const confirmDialog = (o) => openDialog({ confirmText: 'Confirm', ...o });
export const promptDialog = (o) => openDialog({ confirmText: 'Save', ...o });

// ---------------------------------------------------------------- context menu
let menuEl = null, menuReturn = null;
export function openMenu(anchor, items) {
  closeMenu();
  menuEl = document.getElementById('menu');
  menuEl.replaceChildren();
  items.forEach((it) => {
    const b = el('button', 'menu-item' + (it.danger ? ' danger' : ''));
    b.type = 'button'; b.setAttribute('role', 'menuitem');
    b.appendChild(icon(it.icon)); b.append(it.label);
    b.addEventListener('click', () => { closeMenu(false); it.onClick(); });
    menuEl.appendChild(b);
  });
  menuEl.hidden = false;
  const r = anchor.getBoundingClientRect(), w = menuEl.offsetWidth, h = menuEl.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
  const top = r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  menuEl.style.left = `${left}px`; menuEl.style.top = `${top}px`;
  menuReturn = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  menuEl.querySelector('button')?.focus();
}
export function closeMenu(restoreFocus = true) {
  if (!menuEl || menuEl.hidden) return false;
  menuEl.hidden = true;
  if (menuReturn) { menuReturn.setAttribute('aria-expanded', 'false'); if (restoreFocus) menuReturn.focus(); }
  menuReturn = null;
  return true;
}
export function menuKeydown(e) {
  if (!menuEl || menuEl.hidden) return false;
  const items = [...menuEl.querySelectorAll('button')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); e.preventDefault(); return true; }
  if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); e.preventDefault(); return true; }
  if (e.key === 'Tab') { closeMenu(false); return false; }
  return false;
}
