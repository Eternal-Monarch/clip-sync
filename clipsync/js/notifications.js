// Toasts, unseen badge, chime, and browser notifications (shown through the service worker,
// because Android Chrome does not support the `new Notification()` constructor).
import { loadPrefs } from './storage.js';

let toastRoot = null, audioCtx = null, unseen = 0;

export function initNotifications() {
  toastRoot = document.getElementById('toasts');
  const unlock = () => {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* none */ } }
    audioCtx?.state === 'suspended' && audioCtx.resume();
  };
  // Browsers only allow audio after a user gesture.
  addEventListener('pointerdown', unlock, { once: true, passive: true });
  addEventListener('keydown', unlock, { once: true });
}

export function announce(msg) {
  const live = document.getElementById('live');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 30);
}

export function toast(message, { type = 'info', timeout = 3600, action = null } = {}) {
  if (!toastRoot) return;
  while (toastRoot.children.length >= 3) toastRoot.firstChild.remove();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = message;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-action'; b.textContent = action.label;
    b.addEventListener('click', () => { action.onClick(); dismiss(); });
    el.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'toast-close'; x.setAttribute('aria-label', 'Dismiss notification');
  x.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-x"/></svg>';
  x.addEventListener('click', () => dismiss());
  el.appendChild(x);
  toastRoot.appendChild(el);
  let timer = setTimeout(dismiss, timeout);
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => { timer = setTimeout(dismiss, 1500); });
  function dismiss() {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 180);
  }
}

// ---- unseen badge ----
export function bumpUnseen() { setUnseen(unseen + 1); }
export function clearUnseen() { if (unseen) setUnseen(0); }
function setUnseen(n) {
  unseen = n;
  document.querySelectorAll('[data-badge]').forEach((b) => { b.textContent = n > 99 ? '99+' : String(n); b.hidden = n === 0; });
  document.title = n ? `(${n}) ClipSync` : 'ClipSync';
}

function chime() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(740, t);
  osc.frequency.exponentialRampToValueAtTime(1110, t + 0.12);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t); osc.stop(t + 0.3);
}

export const browserNotificationsSupported = () => 'Notification' in window && 'serviceWorker' in navigator;

export async function requestBrowserPermission() {
  if (!browserNotificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

export async function notifyIncoming(clip, label, { onCopy } = {}) {
  const prefs = loadPrefs();
  if (prefs.notifyInApp) {
    toast(`New clipboard received from ${label}`, { type: 'incoming', timeout: 5000, action: onCopy ? { label: 'Copy', onClick: onCopy } : null });
  }
  if (prefs.notifySound) chime();
  if (prefs.notifyBrowser && browserNotificationsSupported() && Notification.permission === 'granted' && document.hidden) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const body = clip.content.length > 90 ? clip.content.slice(0, 90) + '…' : clip.content;
      await reg.showNotification('ClipSync', {
        body: `${label}: ${body}`, tag: 'clipsync-incoming', renotify: true,
        icon: 'assets/icons/icon-192.png', badge: 'assets/icons/icon-192.png', data: { id: clip.id },
      });
    } catch { /* ignore */ }
  }
}
