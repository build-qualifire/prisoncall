/**
 * Prisoncall Admin - Shared Auth + API Client
 * All Supabase data calls routed through /api/admin-supabase (CF Pages Function)
 *
 * Roles (derived from email):
 *   super_admin - guness@prisoncall.com.au - full access
 *   admin       - all others - Dashboard, Subscribers, Transfers
 */

const ADMIN_API = '/api/admin-supabase';
const SESSION_KEY = 'pc_admin_session';

// -- Session helpers --

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(session, persistent = true) {
  const str = JSON.stringify(session);
  if (persistent) {
    localStorage.setItem(SESSION_KEY, str);
  } else {
    sessionStorage.setItem(SESSION_KEY, str);
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem('pc_admin_email');
  localStorage.removeItem('pc_admin_role');
}

function isSessionValid(session) {
  if (!session || !session.access_token) return false;
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
      const isPersistent = !!localStorage.getItem(SESSION_KEY);
      saveSession(refreshed, isPersistent);
      return refreshed;
    }
  } catch {
    // ignore network errors during refresh
  }
  return null;
}

// -- Role helpers --

export function getUserRole() {
  return getSession()?.user?.role || null;
}

export function isSuperAdmin() {
  return getUserRole() === 'super_admin';
}

// -- Page initialisation --

/**
 * Call at the top of every protected page.
 * Redirects to login if no valid session.
 * Returns session or null.
 */
export async function initAdminPage(requiredRole = null) {
  let session = getSession();

  if (!session) {
    redirectToLogin();
    return null;
  }

  if (!isSessionValid(session)) {
    session = await tryRefresh(session);
    if (!session) {
      clearSession();
      redirectToLogin();
      return null;
    }
  }

  const role = session.user?.role || null;

  if (!role) {
    clearSession();
    redirectToLogin();
    return null;
  }

  // Role-based page guard
  if (requiredRole === 'super_admin' && role !== 'super_admin') {
    window.location.href = '/admin/dashboard.html';
    return null;
  }

  // Populate sidebar user email
  document.querySelectorAll('[data-user-email]').forEach(el => {
    el.textContent = session.user?.email || '';
  });

  // Hide nav items requiring higher role
  document.querySelectorAll('[data-role-min]').forEach(el => {
    if (el.dataset.roleMin === 'super_admin' && role !== 'super_admin') {
      el.remove();
    }
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

// -- API client --

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

// -- Login --

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

  saveSession(body.data, !!remember);
  return body.data;
}

// -- Formatting helpers --

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

export function fmtTimeAgo(iso) {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Format 0XXXXXXXXX mobile -> 04XX XXX XXX */
export function formatMobile(mobile) {
  if (!mobile) return '-';
  const m = String(mobile).replace(/\D/g, '');
  if (m.length === 10 && m.startsWith('0')) {
    return `${m.slice(0, 4)} ${m.slice(4, 7)} ${m.slice(7)}`;
  }
  return mobile;
}

// Alias for older code
export const fmtMobile = formatMobile;

export function fmtCurrency(val) {
  if (val == null || val === '') return '-';
  const n = parseFloat(val);
  if (isNaN(n)) return '-';
  return '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Status badge HTML - solid color, white text per spec */
export function statusBadge(status) {
  const map = {
    PENDING:              'badge--pending',
    PENDING_SMS_CONFIRM:  'badge--purple',
    ACTIVATING:           'badge--purple',
    ACTIVATION_FAILED:    'badge--red',
    ACTIVE:               'badge--active',
    FULFILLED:            'badge--fulfilled',
    SUSPENDED:            'badge--orange',
    CANCELLED:            'badge--grey',
    // legacy statuses kept for dashboard recent activity
    DID_ORDERED:          'badge--blue',
    SOURCING:             'badge--blue',
    OVERDUE:              'badge--red',
    TRANSFER:             'badge--indigo',
  };
  const labels = {
    PENDING:              'Pending',
    PENDING_SMS_CONFIRM:  'Pending SMS Confirm',
    ACTIVATING:           'Activating',
    ACTIVATION_FAILED:    'Activation Failed',
    ACTIVE:               'Active',
    FULFILLED:            'Fulfilled',
    SUSPENDED:            'Suspended',
    CANCELLED:            'Cancelled',
    DID_ORDERED:          'DID Ordered',
    SOURCING:             'Sourcing',
    OVERDUE:              'Overdue',
    TRANSFER:             'Transfer',
  };
  const cls = map[status] || 'badge--grey';
  const label = labels[status] || (status || 'Unknown');
  return `<span class="badge ${cls}">${label}</span>`;
}

export function orderTypeBadge(type) {
  if (type === 'TRANSFER') return '<span class="badge badge--transfer">TRANSFER</span>';
  return '<span class="badge badge--new">NEW</span>';
}

/** Add-on badges for subscriptions table columns */
export function addonBadges(sub) {
  if (!sub) return '';
  const parts = [];
  if (sub.addon_transfer_guarantee)     parts.push('TG');
  if (sub.addon_renewal_guarantee)      parts.push('RG');
  if (sub.addon_combo)                  parts.push('Combo');
  if (sub.addon_cancellation_guarantee) parts.push('CG');
  if (sub.addon_lifetime_protection)    parts.push('LP');
  return parts.map(p => `<span class="badge badge--addon">${p}</span>`).join(' ');
}

/** Add-on text list for subscriptions table columns */
export function addonsList(sub) {
  if (!sub) return '-';
  const parts = [];
  if (sub.addon_transfer_guarantee)     parts.push('Transfer Guarantee');
  if (sub.addon_renewal_guarantee)      parts.push('Renewal Guarantee');
  if (sub.addon_combo)                  parts.push('Transfer + Renewal Combo');
  if (sub.addon_cancellation_guarantee) parts.push('Cancellation Guarantee');
  if (sub.addon_lifetime_protection)    parts.push('Lifetime Protection');
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
  }).catch(() => {});
}

// -- Toast system (bottom right, slides in) --

let toastContainer = null;

function getToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

export function showToast(message, type = 'success', duration = 4000) {
  const container = getToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { toast.classList.add('show'); });
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 350);
  }, duration);
}

export function showSmsToast(recipient, message) {
  console.log('[SMS STUB]', recipient, message);
  const container = getToastContainer();
  const toast = document.createElement('div');
  toast.className = 'toast toast--sms';
  toast.innerHTML = `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#666;margin-bottom:6px">SMS STUB - ${recipient}</div>${escapeHtml(message)}`;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => { toast.classList.add('show'); });
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 350);
  }, 8000);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/** Check if progressive SMS button is unlocked (7am the day after last send) */
export function isSmsUnlocked(lastSmsSentAt) {
  if (!lastSmsSentAt) return false;
  const lastSent = new Date(lastSmsSentAt);
  const now = new Date();

  // Must be a different calendar day
  const lastDay = new Date(lastSent);
  lastDay.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (lastDay >= today) return false;

  // And current time must be >= 7am local
  return now.getHours() >= 7;
}
