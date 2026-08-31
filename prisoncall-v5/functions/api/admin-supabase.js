/**
 * Prisoncall Admin - Cloudflare Pages Function
 * All Supabase operations via SUPABASE_SERVICE_ROLE_KEY
 * POST { action, token, params } -> JSON
 *
 * Roles (derived from email at login):
 *   super_admin - guness@prisoncall.com.au
 *   admin       - all other users
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405);
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SERVICE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON_KEY     = env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    return json({ success: false, error: 'Server misconfiguration: missing Supabase credentials' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid request body' });
  }

  const { action, token, params = {} } = body;

  if (!action) return json({ success: false, error: 'Missing action' });

  // ── Auth actions (no token required) ─────────────────────────────────────

  if (action === 'login') {
    const { email, password } = params;
    if (!email || !password) return json({ success: false, error: 'Email and password required' });

    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      const msg = data.error_description || data.message || 'Invalid email or password';
      return json({ success: false, error: msg });
    }

    const userEmail = data.user?.email || '';
    const role = userEmail.toLowerCase() === 'guness@prisoncall.com.au' ? 'super_admin' : 'admin';

    return json({
      success: true,
      data: {
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at || (data.expires_in ? Math.floor(Date.now() / 1000) + Number(data.expires_in) : null),
        user: { email: userEmail, id: data.user.id, role },
      },
    });
  }

  if (action === 'refresh') {
    const { refresh_token } = params;
    if (!refresh_token) return json({ success: false, error: 'Missing refresh_token', code: 'UNAUTHORIZED' }, 401);

    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
      body: JSON.stringify({ refresh_token }),
    });
    const data = await res.json();

    if (!res.ok) {
      return json({ success: false, error: 'Session expired. Please log in again.', code: 'UNAUTHORIZED' }, 401);
    }

    const userEmail = data.user?.email || '';
    const role = userEmail.toLowerCase() === 'guness@prisoncall.com.au' ? 'super_admin' : 'admin';

    return json({
      success: true,
      data: {
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at || (data.expires_in ? Math.floor(Date.now() / 1000) + Number(data.expires_in) : null),
        user: { email: userEmail, id: data.user.id, role },
      },
    });
  }

  // ── Verify token for all data actions ────────────────────────────────────

  if (!token) return json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': ANON_KEY },
  });

  if (!userRes.ok) {
    return json({ success: false, error: 'Invalid or expired session. Please log in again.', code: 'UNAUTHORIZED' }, 401);
  }

  const userInfo  = await userRes.json();
  const userEmail = userInfo.email || '';
  const userRole  = userEmail.toLowerCase() === 'guness@prisoncall.com.au' ? 'super_admin' : 'admin';

  const SUPER_ADMIN_ONLY = [
    'replacePrisonLookup', 'getPrisonLookupAll', 'upload_pdp', 'getTableStatus',
    'get_users', 'create_user', 'update_user_role', 'delete_user',
  ];

  if (SUPER_ADMIN_ONLY.includes(action) && userRole !== 'super_admin') {
    return json({ success: false, error: 'Access denied: super_admin role required', code: 'FORBIDDEN' }, 403);
  }

  // ── Supabase REST helper ──────────────────────────────────────────────────

  async function sb(path, opts = {}) {
    const url = `${SUPABASE_URL}/rest/v1/${path}`;
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'apikey': SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': opts.prefer || 'return=representation',
        ...(opts.headers || {}),
      },
      body: opts.body,
    });
    return res;
  }

  // ── Supabase Auth Admin helper ────────────────────────────────────────────

  async function sbAdmin(path, opts = {}) {
    const url = `${SUPABASE_URL}/auth/v1/admin/${path}`;
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'apikey': SERVICE_KEY,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      body: opts.body,
    });
    return res;
  }

  // ── Route actions ─────────────────────────────────────────────────────────

  try {
    switch (action) {

      // ── Role ─────────────────────────────────────────────────────────────
      case 'getRole': {
        return json({ success: true, data: { role: userRole, email: userEmail } });
      }

      // ── NAV COUNTS ───────────────────────────────────────────────────────

      case 'get_nav_counts': {
        const [jobsRes, txRes, suspRes, cancRes] = await Promise.all([
          sb('subscriptions?status=in.(PENDING,ACTIVATING,ACTIVATION_FAILED)&select=id'),
          sb('orders?order_type=eq.TRANSFER&status=in.(PENDING,PENDING_SMS_CONFIRM)&select=id'),
          sb('subscriptions?status=eq.SUSPENDED&select=id'),
          sb('subscriptions?status=eq.CANCELLED&select=id,subscription_attributes'),
        ]);

        const jobs      = await jobsRes.json();
        const transfers = await txRes.json();
        const suspended = await suspRes.json();
        const cancelled = await cancRes.json();

        const pendingCancellations = Array.isArray(cancelled)
          ? cancelled.filter(s => {
              try {
                const attrs = s.subscription_attributes
                  ? (typeof s.subscription_attributes === 'string' ? JSON.parse(s.subscription_attributes) : s.subscription_attributes)
                  : {};
                return !attrs.voipline_cancelled;
              } catch { return true; }
            }).length
          : 0;

        // Also count FULFILLED transfers older than 7 days (old DID release reminder)
        let releaseCount = 0;
        try {
          const fulfilledRes = await sb('orders?order_type=eq.TRANSFER&status=eq.FULFILLED&select=id,updated_at');
          const fulfilled = await fulfilledRes.json();
          const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
          if (Array.isArray(fulfilled)) {
            releaseCount = fulfilled.filter(t => (Date.now() - new Date(t.updated_at).getTime()) >= sevenDaysMs).length;
          }
        } catch {}

        return json({
          success: true,
          data: {
            pending_jobs:          Array.isArray(jobs)      ? jobs.length      : 0,
            pending_transfers:     (Array.isArray(transfers) ? transfers.length : 0) + releaseCount,
            suspended_count:       Array.isArray(suspended)  ? suspended.length : 0,
            pending_cancellations: pendingCancellations,
          },
        });
      }

      // ── JOBS (new subscription orders) ───────────────────────────────────

      case 'get_jobs': {
        const res = await sb('subscriptions?status=in.(PENDING,ACTIVATING,ACTIVATION_FAILED,ACTIVE)&order=created_at.desc&select=*');
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      case 'fulfil_job': {
        const { id, current_did } = params;
        if (!id || !current_did) return json({ success: false, error: 'Missing id or current_did' });

        const res = await sb(`subscriptions?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'ACTIVE', current_did, updated_at: new Date().toISOString() }),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      // ── TRANSFERS ────────────────────────────────────────────────────────

      case 'get_transfers': {
        let qs = 'orders?order_type=eq.TRANSFER&order=created_at.desc&select=*,subscriptions(customer_name,customer_mobile,customer_email,current_did,seal_subscription_id)';
        if (params.search) {
          const s = encodeURIComponent(`*${params.search}*`);
          qs += `&or=(prison_name.ilike.${s},customer_mobile.ilike.${s})`;
        }
        const res = await sb(qs);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      case 'fulfil_transfer': {
        const { id, did_number } = params;
        if (!id || !did_number) return json({ success: false, error: 'Missing id or did_number' });

        const res = await sb(`orders?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ did_number, status: 'FULFILLED', updated_at: new Date().toISOString() }),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      case 'confirm_old_did_released': {
        const { id } = params;
        if (!id) return json({ success: false, error: 'Missing id' });

        // Fetch the order to get subscription_id and new DID
        const orderRes = await sb(`orders?id=eq.${encodeURIComponent(id)}&select=id,subscription_id,did_number`);
        const orders = await orderRes.json();
        const order = Array.isArray(orders) ? orders[0] : null;

        if (!order) return json({ success: false, error: 'Transfer order not found' });

        // Update the subscription current_did to the new DID
        if (order.subscription_id && order.did_number) {
          await sb(`subscriptions?id=eq.${encodeURIComponent(order.subscription_id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ current_did: order.did_number, updated_at: new Date().toISOString() }),
          });
        }

        // Mark the order as COMPLETED
        const res = await sb(`orders?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'COMPLETED', updated_at: new Date().toISOString() }),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      // ── SUSPENDED ────────────────────────────────────────────────────────

      case 'get_suspended': {
        const res = await sb('subscriptions?status=eq.SUSPENDED&order=updated_at.desc&select=*');
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      case 'confirm_voipline_paused': {
        const { id } = params;
        if (!id) return json({ success: false, error: 'Missing id' });
        const now = new Date().toISOString();
        const res = await sb(`subscriptions?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ sms_day_count: 1, last_sms_sent_at: now, updated_at: now }),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      case 'confirm_voipline_resumed': {
        const { id } = params;
        if (!id) return json({ success: false, error: 'Missing id' });
        const now = new Date().toISOString();
        const res = await sb(`subscriptions?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'ACTIVE', sms_day_count: 0, last_sms_sent_at: null, updated_at: now }),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      // ── CANCELLATIONS ────────────────────────────────────────────────────

      case 'get_cancellations': {
        const res = await sb('subscriptions?status=eq.CANCELLED&order=updated_at.desc&select=*');
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      case 'confirm_voipline_done': {
        const { id } = params;
        if (!id) return json({ success: false, error: 'Missing id' });

        const fetchRes = await sb(`subscriptions?id=eq.${encodeURIComponent(id)}&select=subscription_attributes`);
        const rows = await fetchRes.json();
        let existing = {};
        try {
          const raw = Array.isArray(rows) && rows[0] ? rows[0].subscription_attributes : null;
          existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        } catch { existing = {}; }

        const merged = { ...existing, voipline_cancelled: true, voipline_cancelled_at: new Date().toISOString() };

        const res = await sb(`subscriptions?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ subscription_attributes: merged, updated_at: new Date().toISOString() }),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        return json({ success: true, data: merged });
      }

      // ── ALL SUBSCRIBERS (read-only reference) ────────────────────────────

      case 'get_all_subscribers': {
        let qs = 'subscriptions?order=created_at.desc&select=*';
        if (params.status) qs += `&status=eq.${encodeURIComponent(params.status)}`;
        if (params.search) {
          const s = encodeURIComponent(`*${params.search}*`);
          qs += `&or=(customer_name.ilike.${s},customer_mobile.ilike.${s},current_did.ilike.${s},prison_name.ilike.${s})`;
        }
        const res = await sb(qs);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      // ── LEGACY SUBSCRIBER ACTIONS (kept for safety) ──────────────────────

      case 'get_subscribers': {
        let qs = 'subscriptions?status=in.(ACTIVE,SUSPENDED,PENDING,ACTIVATING,ACTIVATION_FAILED)&order=status.desc,customer_name.asc&select=*';
        if (params.status === 'SUSPENDED') qs = 'subscriptions?status=eq.SUSPENDED&order=customer_name.asc&select=*';
        if (params.search) {
          const s = encodeURIComponent(`*${params.search}*`);
          qs += `&or=(customer_name.ilike.${s},customer_mobile.ilike.${s},current_did.ilike.${s},prison_name.ilike.${s})`;
        }
        const res = await sb(qs);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      case 'get_subscriber': {
        if (!params.id) return json({ success: false, error: 'Missing id' });
        const res = await sb(`subscriptions?id=eq.${encodeURIComponent(params.id)}&select=*`);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : null });
      }

      case 'update_subscriber_status': {
        const { id, status } = params;
        if (!id || !status) return json({ success: false, error: 'Missing id or status' });
        const res = await sb(`subscriptions?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      case 'update_subscriber_did': {
        const { id, current_did, status } = params;
        if (!id || !current_did) return json({ success: false, error: 'Missing id or current_did' });
        const fields = { current_did, updated_at: new Date().toISOString() };
        if (status) fields.status = status;
        const res = await sb(`subscriptions?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(fields),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      case 'update_subscriber_sms': {
        const { id, sms_day_count, last_sms_sent_at } = params;
        if (!id) return json({ success: false, error: 'Missing id' });
        const fields = { updated_at: new Date().toISOString() };
        if (sms_day_count !== undefined) fields.sms_day_count = sms_day_count;
        if (last_sms_sent_at !== undefined) fields.last_sms_sent_at = last_sms_sent_at;
        const res = await sb(`subscriptions?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(fields),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      case 'update_subscriber_flags': {
        const { id, flags } = params;
        if (!id || !flags) return json({ success: false, error: 'Missing id or flags' });

        const fetchRes = await sb(`subscriptions?id=eq.${encodeURIComponent(id)}&select=subscription_attributes`);
        const rows = await fetchRes.json();
        let existing = {};
        try {
          const raw = Array.isArray(rows) && rows[0] ? rows[0].subscription_attributes : null;
          existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        } catch { existing = {}; }

        const merged = { ...existing, ...flags };
        const res = await sb(`subscriptions?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ subscription_attributes: merged, updated_at: new Date().toISOString() }),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        return json({ success: true, data: merged });
      }

      // Legacy transfer update actions
      case 'update_transfer_did': {
        const { id, did_number, status } = params;
        if (!id || !did_number) return json({ success: false, error: 'Missing id or did_number' });
        const fields = { did_number, updated_at: new Date().toISOString() };
        if (status) fields.status = status;
        const res = await sb(`orders?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(fields),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      case 'update_transfer_status': {
        const { id, status } = params;
        if (!id || !status) return json({ success: false, error: 'Missing id or status' });
        const res = await sb(`orders?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
        });
        if (!res.ok) return json({ success: false, error: `Update failed: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      // ── USER MANAGEMENT (super_admin only) ───────────────────────────────

      case 'get_users': {
        const res = await sbAdmin('users?per_page=100');
        if (!res.ok) return json({ success: false, error: `Failed to list users: ${await res.text()}` });
        const data = await res.json();
        const users = (data.users || []).map(u => ({
          id:              u.id,
          email:           u.email,
          role:            (u.user_metadata && u.user_metadata.role) || 'admin',
          created_at:      u.created_at,
          last_sign_in_at: u.last_sign_in_at,
        }));
        return json({ success: true, data: users });
      }

      case 'create_user': {
        const { email, password, role } = params;
        if (!email || !password) return json({ success: false, error: 'Email and password required' });
        const allowedRoles  = ['admin', 'staff'];
        const assignedRole  = allowedRoles.includes(role) ? role : 'admin';
        const res = await sbAdmin('users', {
          method: 'POST',
          body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { role: assignedRole } }),
        });
        if (!res.ok) return json({ success: false, error: `Failed to create user: ${await res.text()}` });
        const data = await res.json();
        return json({ success: true, data: { id: data.id, email: data.email, role: assignedRole } });
      }

      case 'update_user_role': {
        const { id, role } = params;
        if (!id || !role) return json({ success: false, error: 'Missing id or role' });
        const allowedRoles = ['admin', 'staff'];
        if (!allowedRoles.includes(role)) return json({ success: false, error: 'Invalid role' });
        const res = await sbAdmin(`users/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({ user_metadata: { role } }),
        });
        if (!res.ok) return json({ success: false, error: `Failed to update role: ${await res.text()}` });
        return json({ success: true, data: { id, role } });
      }

      case 'delete_user': {
        const { id } = params;
        if (!id) return json({ success: false, error: 'Missing id' });
        const res = await sbAdmin(`users/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) return json({ success: false, error: `Failed to delete user: ${await res.text()}` });
        return json({ success: true, data: { deleted: true } });
      }

      // ── PRISON DID LOOKUP (Settings - super_admin only) ──────────────────

      case 'getPrisonLookup':
      case 'get_prison_lookup': {
        if (!params.prison_name || !params.prison_state) return json({ success: false, error: 'Missing prison_name or prison_state' });
        const res = await sb(`prison_did_lookup?prison_name=eq.${encodeURIComponent(params.prison_name)}&prison_state=eq.${encodeURIComponent(params.prison_state)}&select=*`);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : null });
      }

      case 'getPrisonLookupAll': {
        const res = await sb('prison_did_lookup?select=*&order=prison_state.asc,prison_name.asc');
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      case 'replacePrisonLookup':
      case 'upload_pdp': {
        const { rows } = params;
        if (!Array.isArray(rows) || rows.length === 0) return json({ success: false, error: 'No rows provided' });

        const EXCEL_TO_DB   = { primary: 'primary_exchange_code' };
        const SUPABASE_COLS = [
          'prison_name', 'prison_state', 'primary_exchange_code', 'primary_area',
          'fallback_1', 'fallback_1_area', 'fallback_2', 'fallback_2_area',
          'fallback_3', 'fallback_3_area', 'location', 'notes',
        ];

        const mappedRows = rows.map(row => {
          const r = {};
          for (const [k, v] of Object.entries(row)) {
            r[EXCEL_TO_DB[k] !== undefined ? EXCEL_TO_DB[k] : k] = v;
          }
          return r;
        });

        const rowCols = Object.keys(mappedRows[0]);
        const missing = SUPABASE_COLS.filter(c => !rowCols.includes(c));
        if (missing.length > 0) return json({ success: false, error: `Missing columns: ${missing.join(', ')}` });

        const cleanRows = mappedRows.map(row => {
          const r = {};
          SUPABASE_COLS.forEach(col => { r[col] = row[col] !== undefined ? row[col] : ''; });
          return r;
        });

        const delRes = await sb('prison_did_lookup?prison_name=not.is.null', {
          method: 'DELETE',
          prefer: 'return=minimal',
          headers: { 'Prefer': 'return=minimal' },
        });
        if (!delRes.ok && delRes.status !== 204 && delRes.status !== 200) {
          return json({ success: false, error: `Failed to clear existing data (status ${delRes.status})` });
        }

        const BATCH = 200;
        for (let i = 0; i < cleanRows.length; i += BATCH) {
          const batch  = cleanRows.slice(i, i + BATCH);
          const insRes = await sb('prison_did_lookup', {
            method: 'POST',
            body: JSON.stringify(batch),
            prefer: 'return=minimal',
            headers: { 'Prefer': 'return=minimal' },
          });
          if (!insRes.ok) return json({ success: false, error: `Insert failed at row ${i + 1}: ${await insRes.text()}` });
        }

        return json({ success: true, data: { rowsInserted: cleanRows.length } });
      }

      case 'getTableStatus': {
        const { table } = params;
        if (!['prison_did_lookup', 'scaling_model_new'].includes(table)) {
          return json({ success: false, error: 'Invalid table name' });
        }
        const countRes = await sb(`${table}?select=*&limit=1`, { prefer: 'count=exact' });
        const cr    = countRes.headers.get('content-range');
        const count = (cr && cr.includes('/')) ? (parseInt(cr.split('/')[1]) || 0) : 0;

        let lastUpdated = null;
        for (const col of ['updated_at', 'created_at']) {
          const tsRes = await sb(`${table}?select=${col}&order=${col}.desc&limit=1`);
          if (tsRes.ok) {
            const tsRows = await tsRes.json();
            if (Array.isArray(tsRows) && tsRows.length > 0 && tsRows[0][col]) {
              lastUpdated = tsRows[0][col];
              break;
            }
          }
        }

        return json({ success: true, data: { count, lastUpdated } });
      }

      default:
        return json({ success: false, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    return json({ success: false, error: err.message || 'Internal server error' }, 500);
  }
}
