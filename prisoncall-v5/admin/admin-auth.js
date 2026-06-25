/**
 * Prisoncall Admin - Shared Auth + API Client
 * All Supabase data calls routed through /api/admin-supabase (CF Pages Function)
 *
 * Roles (read from Supabase user_metadata.role):
 *   super_admin - full access: Dashboard, Orders, Customers, Products, Settings
 *   admin       - Dashboard, Orders, Customers
 *   staff       - Dashboard, Orders only
 */

const ADMIN_API = '/api/admin-supabase';
const SESSION_KEY = 'pc_admin_session';

// Role hierarchy: higher index = more access
const ROLE_LEVELS = { staff: 0, admin: 1, super_admin: 2 };

// ── Session helpers ────────────────────────────────────────────

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function isSessionValid(session) {
  if (!session || !session.access_token) return false;
  // Only check expiry when expires_at is present (Unix seconds timestamp)
  if (session.expires_at) {
    const nowSec = Date.now() / 1000;
    if (nowSec > session.expires_at - 60) return false;
  }
  return true;
}

async function tryRefresh(session) {
  if (!session?.refresh_token) return null;
  try {
    const res = await fetch(ADMIN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh', params: { refresh_token: session.refresh_token } }),
    });
    const data = await res.json();
    if (data.success) {
      const refreshed = { ...session, ...data.data };
      // Preserve role from old session if refresh response didn't include it
      if (!refreshed.user?.role && session.user?.role) {
        refreshed.user = { ...(refreshed.user || {}), role: session.user.role };
      }
      saveSession(refreshed);
      return refreshed;
    }
  } catch {
    // ignore network errors during refresh
  }
  return null;
}

// ── Role helpers ───────────────────────────────────────────────

export function getUserRole() {
  return getSession()?.user?.role || null;
}

function roleLevel(role) {
  return ROLE_LEVELS[role] ?? -1;
}

function hasRole(userRole, requiredRole) {
  if (!requiredRole) return roleLevel(userRole) >= 0;
  return roleLevel(userRole) >= roleLevel(requiredRole);
}

/**
 * Fetch the authenticated user's role directly from the server.
 * Used when the stored session is missing the role field.
 * The CF function reads from user_metadata, raw_user_meta_data, and app_metadata.
 */
async function fetchRoleFromServer(accessToken) {
  try {
    const res = await fetch(ADMIN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getRole', token: accessToken }),
    });
    const body = await res.json();
    console.log('[AdminAuth] fetchRoleFromServer response:', body);
    if (body.success && body.data?.role) return body.data.role;
  } catch (err) {
    console.warn('[AdminAuth] fetchRoleFromServer error:', err);
  }
  return null;
}

// ── Page initialisation ────────────────────────────────────────

/**
 * Call at the top of every protected page.
 * Checks authentication only — redirects to login if no valid session exists.
 * Does NOT redirect based on role. Role-based UI is handled per-page.
 * Returns the session (including session.user.role) or null if unauthenticated.
 */
export async function initAdminPage() {
  let session = getSession();

  if (!session) {
    console.log('[AdminAuth] No session — redirecting to login');
    redirectToLogin();
    return null;
  }

  if (!isSessionValid(session)) {
    console.log('[AdminAuth] Session expired — attempting refresh');
    session = await tryRefresh(session);
    if (!session) {
      console.log('[AdminAuth] Refresh failed — redirecting to login');
      clearSession();
      redirectToLogin();
      return null;
    }
  }

  let role = session.user?.role || null;
  console.log('[AdminAuth] Cached role:', role);

  // Always verify the live role from the server so a stale cached role
  // (e.g. from before an admin updated it in Supabase) is corrected automatically.
  if (session.access_token) {
    const liveRole = await fetchRoleFromServer(session.access_token);
    console.log('[AdminAuth] Live role from server:', liveRole);
    if (liveRole) {
      if (liveRole !== role) {
        session = { ...session, user: { ...(session.user || {}), role: liveRole } };
        saveSession(session);
      }
      role = liveRole;
    }
  }

  console.log('[AdminAuth] Final role:', role);

  if (!role || roleLevel(role) < 0) {
    console.warn('[AdminAuth] No valid role — clearing session, redirecting to login');
    clearSession();
    redirectToLogin();
    return null;
  }

  // Populate sidebar user email
  document.querySelectorAll('[data-user-email]').forEach(el => {
    el.textContent = session.user?.email || '';
  });

  // Hide nav items the current role cannot access
  document.querySelectorAll('[data-role-min]').forEach(el => {
    if (!hasRole(role, el.dataset.roleMin)) el.remove();
  });

  return session;
}

export function redirectToLogin() {
  window.location.href = '/admin/login.html';
}

export function logout() {
  clearSession();
  window.location.href = '/admin/login.html';
}

// ── API client ──────────────────────────────────────────────────

export async function api(action, params = {}) {
  const session = getSession();

  let body;
  try {
    const res = await fetch(ADMIN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        token: session?.access_token || null,
        params,
      }),
    });
    body = await res.json();
  } catch (err) {
    throw new Error('Network error: ' + err.message);
  }

  if (body.code === 'UNAUTHORIZED') {
    clearSession();
    redirectToLogin();
    throw new Error('Session expired');
  }

  if (!body.success) {
    throw new Error(body.error || 'Unknown error');
  }

  return body.data;
}

// ── Login ───────────────────────────────────────────────────────

export async function login(email, password, remember) {
  const res = await fetch(ADMIN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', params: { email, password } }),
  });
  const body = await res.json();

  if (!body.success) {
    throw new Error(body.error || 'Login failed');
  }

  saveSession(body.data);

  if (!remember) {
    sessionStorage.setItem('pc_session_only', '1');
  }

  return body.data;
}

// ── Formatting helpers ──────────────────────────────────────────

export function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDatetime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
}

export function fmtMobile(mobile) {
  if (!mobile) return '-';
  const m = mobile.replace(/\D/g, '');
  if (m.length === 10) return `${m.slice(0,4)} ${m.slice(4,7)} ${m.slice(7)}`;
  return mobile;
}

export function maskMobile(mobile) {
  if (!mobile) return '-';
  const m = mobile.replace(/\D/g, '');
  if (m.length === 10) return `${m.slice(0,2)}xx xxx ${m.slice(7)}`;
  return mobile;
}

export function fmtCurrency(val) {
  if (val == null || val === '') return '-';
  return '$' + parseFloat(val).toFixed(2);
}

export function statusBadge(status) {
  const map = {
    PENDING:           ['badge--pending',   'Pending'],
    DID_ORDERED:       ['badge--blue',      'DID Ordered'],
    SOURCING:          ['badge--blue',      'Sourcing'],
    ACTIVATING:        ['badge--blue',      'Activating'],
    FULFILLED:         ['badge--fulfilled', 'Fulfilled'],
    ACTIVATION_FAILED: ['badge--red',       'Activation Failed'],
    OVERDUE:           ['badge--red',       'Overdue'],
    CANCELLED:         ['badge--grey',      'Cancelled'],
    PENDING_REFUND:    ['badge--orange',    'Pending Refund'],
    REFUNDED:          ['badge--grey',      'Refunded'],
    ACTIVE:            ['badge--active',    'Active'],
    SUSPENDED:         ['badge--orange',    'Suspended'],
  };
  const [cls, label] = map[status] || ['badge--grey', status || 'Unknown'];
  return `<span class="badge ${cls}">${label}</span>`;
}

export function orderTypeBadge(type) {
  if (type === 'TRANSFER') return '<span class="badge badge--transfer">TRANSFER</span>';
  return '<span class="badge badge--new">NEW</span>';
}

export function addonsLabel(order) {
  const parts = [];
  if (order.addon_48hr_cancel) parts.push('48hr Cancel');
  if (order.addon_transfers)   parts.push('Transfers');
  if (order.addon_post_renewal)parts.push('Post Renewal');
  if (order.addon_combo23)     parts.push('Bundle 2+3');
  if (order.addon_lifetime)    parts.push('Lifetime');
  return parts.length ? parts.join(', ') : '-';
}

export function copyToClipboard(text, el) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = el.textContent;
    el.textContent = 'Copied!';
    el.style.color = 'var(--color-green)';
    setTimeout(() => {
      el.textContent = orig;
      el.style.color = '';
    }, 1500);
  });
}

// ── Notification toast ──────────────────────────────────────────

let toastTimeout;

export function showToast(message, type = 'success') {
  let toast = document.getElementById('admin-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'admin-toast';
    toast.style.cssText = `
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      padding: 12px 20px; border-radius: 80px; font-family: var(--font-family);
      font-size: 14px; font-weight: 700; z-index: 9999;
      transition: opacity 0.2s ease; pointer-events: none;
      white-space: nowrap; box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    `;
    document.body.appendChild(toast);
  }

  const styles = {
    success: 'background:#00D258;color:#000;',
    error:   'background:#EF4444;color:#fff;',
    info:    'background:#3B82F6;color:#fff;',
  };

  toast.style.cssText += styles[type] || styles.success;
  toast.textContent = message;
  toast.style.opacity = '1';

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}
