// Supabase client + auth helpers. The SDK is vendored (vendor/supabase.js) and exposes window.supabase.
import { CONFIG } from './config.js';

let client = null;

export function isConfigured() {
  return /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(CONFIG.SUPABASE_URL) &&
    !CONFIG.SUPABASE_URL.includes('YOUR-') &&
    CONFIG.SUPABASE_ANON_KEY.length > 40 && !CONFIG.SUPABASE_ANON_KEY.includes('YOUR-');
}

export function getClient() {
  if (client) return client;
  if (!isConfigured() || !window.supabase?.createClient) return null;
  client = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return client;
}

export async function getSession() {
  const c = getClient();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session;
}

export async function signIn(email, password) {
  const { data, error } = await getClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

// Returns null when the project requires email confirmation first.
export async function signUp(email, password) {
  const { data, error } = await getClient().auth.signUp({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  await getClient()?.auth.signOut();
}

// NOTE: never await Supabase calls inside this callback (deadlock risk) — callers defer work.
export function onAuthChange(cb) {
  const c = getClient();
  if (!c) return () => {};
  const { data } = c.auth.onAuthStateChange((event, session) => cb(event, session));
  return () => data.subscription.unsubscribe();
}
