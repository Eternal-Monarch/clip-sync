// Clipboard helpers: validation, copy (with fallback), and creating new clip records.
import { uuid } from './storage.js';

export const MAX_LEN = 100000;

export function validate(text) {
  if (!text || !text.trim()) return { ok: false, error: 'Nothing to send. Paste some text first.' };
  if (text.length > MAX_LEN) {
    return { ok: false, error: `Too long: ${text.length.toLocaleString()} characters. The limit is ${MAX_LEN.toLocaleString()}.` };
  }
  return { ok: true };
}

// Uses the async Clipboard API on secure contexts; falls back to a temporary textarea + execCommand.
export async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  return legacyCopy(text);
}

function legacyCopy(text) {
  const prev = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  prev?.focus?.({ preventScroll: true });
  return ok;
}

// Content is stored byte-for-byte as submitted (never trimmed or altered).
export function createClip({ content, deviceId, deviceName }) {
  const now = new Date().toISOString();
  return {
    id: uuid(), content, device_id: deviceId, device_name: deviceName,
    pinned: false, favorite: false, tags: [],
    created_at: now, updated_at: now, deleted_at: null,
    _dirty: 1, _new: true, _patch: {},
  };
}
