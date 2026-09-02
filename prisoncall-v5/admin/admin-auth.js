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
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', params: { email, password } }),
  });
  const body = await res.json();

  if (!res.ok || body.error) {
    throw new Error(body.error || 'Login failed. Check your email and password.');
  }

  // body.data is the Supabase session object
  const session = body.data;
  saveSession(session, remember);
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
