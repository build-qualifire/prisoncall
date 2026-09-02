/**
 * admin-auth.js — Session storage + login
 * Only handles authentication. No data queries here.
 */

const SESSION_KEY = 'pc_admin_v2';
const API_URL     = '/api/admin-api';

// ── Session storage ────────────────────────────────────────

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveSession(session, persist = true) {
  const str = JSON.stringify(session);
  if (persist) {
    localStorage.setItem(SESSION_KEY, str);
  } else {
    sessionStorage.setItem(SESSION_KEY, str);
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

export function getAccessToken() {
  return getSession()?.access_token || null;
}

// ── Login / Logout ─────────────────────────────────────────

export async function adminLogin(email, password, remember = true) {
  console.log('[adminLogin] Starting login for:', email);

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', params: { email, password } }),
  });

  console.log('[adminLogin] Fetch complete — status:', res.status, 'ok:', res.ok);

  const rawText = await res.text();
  console.log('[adminLogin] Raw response text:', rawText);

  let body;
  try {
    body = JSON.parse(rawText);
  } catch (e) {
    console.error('[adminLogin] Failed to parse JSON:', e);
    throw new Error('Server returned invalid response. Check console.');
  }

  console.log('[adminLogin] Parsed body:', JSON.stringify(body, null, 2));

  if (!res.ok || body.error) {
    console.error('[adminLogin] Login error:', body.error);
    throw new Error(body.error || 'Login failed. Check your email and password.');
  }

  const session = body.data;
  console.log('[adminLogin] Session object:', JSON.stringify(session, null, 2));
  console.log('[adminLogin] access_token present:', !!session?.access_token);

  saveSession(session, remember);

  const saved = getSession();
  console.log('[adminLogin] Session after save — access_token present:', !!saved?.access_token);
  console.log('[adminLogin] Storage key used:', SESSION_KEY, '| persist:', remember);

  return session;
}

export function adminLogout() {
  clearSession();
  window.location.href = '/admin/login.html';
}

// ── Auth redirect helpers ──────────────────────────────────

export function redirectToLogin(reason) {
  clearSession();
  const url = '/admin/login.html' + (reason ? `?reason=${encodeURIComponent(reason)}` : '');
  window.location.replace(url);
}
