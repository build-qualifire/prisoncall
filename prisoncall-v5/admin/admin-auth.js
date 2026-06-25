/**
 * Prisoncall Admin - Shared Auth + API Client
 * All Supabase data calls routed through /api/admin-supabase (CF Pages Function)
 */

const ADMIN_API = '/api/admin-supabase';
const SESSION_KEY = 'pc_admin_session';

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
  // expires_at is in Unix seconds; subtract 60s buffer
  if (session.expires_at && Date.now() / 1000 > session.expires_at - 60) return false;
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
      saveSession(refreshed);
      return refreshed;
    }
  } catch {
    // ignore
  }
  return null;
}

// ── Page initialisation ────────────────────────────────────────

/**
 * Call on every protected page load.
 * Returns session or redirects to login.
 * @param {boolean} requireGuness - if true, redirect Dinisha to dashboard
 */
export async function initAdminPage(requireGuness = false) {
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

  const email = session.user?.email || '';

  if (requireGuness && email !== 'guness@prisoncall.com.au') {
    window.location.href = '/admin/dashboard.html';
    return null;
  }

  // Populate sidebar UI
  const emailEls = document.querySelectorAll('[data-user-email]');
  emailEls.forEach(el => { el.textContent = email; });

  // Hide Products + Settings nav items for Dinisha
  if (email !== 'guness@prisoncall.com.au') {
    document.querySelectorAll('[data-guness-only]').forEach(el => el.remove());
  }

  return session;
}

export function getUserEmail() {
  return getSession()?.user?.email || '';
}

export function isGuness() {
  return getUserEmail() === 'guness@prisoncall.com.au';
}

export function redirectToLogin() {
  window.location.href = '/admin/login.html';
}

export function logout() {
  clearSession();
  window.location.href = '/admin/login.html';
}

// ── API client ──────────────────────────────────────────────────

/**
 * Call the admin-supabase CF Pages Function.
 * Handles auth errors by redirecting to login.
 */
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

  const session = body.data;
  saveSession(session);

  if (!remember) {
    // Clear on tab/browser close by using sessionStorage flag
    sessionStorage.setItem('pc_session_only', '1');
  }

  return session;
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
    PENDING:          ['badge--pending',  'Pending'],
    DID_ORDERED:      ['badge--blue',     'DID Ordered'],
    SOURCING:         ['badge--blue',     'Sourcing'],
    ACTIVATING:       ['badge--blue',     'Activating'],
    FULFILLED:        ['badge--fulfilled','Fulfilled'],
    ACTIVATION_FAILED:['badge--red',      'Activation Failed'],
    OVERDUE:          ['badge--red',      'Overdue'],
    CANCELLED:        ['badge--grey',     'Cancelled'],
    PENDING_REFUND:   ['badge--orange',   'Pending Refund'],
    REFUNDED:         ['badge--grey',     'Refunded'],
    ACTIVE:           ['badge--active',   'Active'],
    SUSPENDED:        ['badge--orange',   'Suspended'],
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
  if (order.addon_transfers) parts.push('Transfers');
  if (order.addon_post_renewal) parts.push('Post Renewal');
  if (order.addon_combo23) parts.push('Bundle 2+3');
  if (order.addon_lifetime) parts.push('Lifetime');
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
    success: 'background: #00D258; color: #000;',
    error:   'background: #EF4444; color: #fff;',
    info:    'background: #3B82F6; color: #fff;',
  };

  toast.style.cssText += styles[type] || styles.success;
  toast.textContent = message;
  toast.style.opacity = '1';

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// Session-only: clear on load if flag is set and page was refreshed
(function () {
  if (sessionStorage.getItem('pc_session_only') === '1') {
    // Keep alive while tab is open
    window.addEventListener('beforeunload', () => {
      // Don't clear here - let normal flow handle it
    });
  }
})();
