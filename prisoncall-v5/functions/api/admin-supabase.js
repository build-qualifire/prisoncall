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
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON_KEY = env.SUPABASE_ANON_KEY;

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

  if (!action) {
    return json({ success: false, error: 'Missing action' });
  }

  // ── Auth actions (no token required) ──────────────────────────────────────

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

    const role =
      data.user?.user_metadata?.role ||
      data.user?.raw_user_meta_data?.role ||
      data.user?.app_metadata?.role ||
      null;
    const VALID_ROLES = ['super_admin', 'admin', 'staff'];
    if (!role || !VALID_ROLES.includes(role)) {
      return json({ success: false, error: 'Access denied: no admin role assigned to this account.' });
    }

    return json({
      success: true,
      data: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at || (data.expires_in ? Math.floor(Date.now() / 1000) + Number(data.expires_in) : null),
        user: { email: data.user.email, id: data.user.id, role },
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

    return json({
      success: true,
      data: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at || (data.expires_in ? Math.floor(Date.now() / 1000) + Number(data.expires_in) : null),
        user: {
          email: data.user.email,
          id: data.user.id,
          role:
            data.user?.user_metadata?.role ||
            data.user?.raw_user_meta_data?.role ||
            data.user?.app_metadata?.role ||
            null,
        },
      },
    });
  }

  // ── Verify token for all data actions ─────────────────────────────────────

  if (!token) {
    return json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': ANON_KEY },
  });

  if (!userRes.ok) {
    return json({ success: false, error: 'Invalid or expired session. Please log in again.', code: 'UNAUTHORIZED' }, 401);
  }

  const userInfo = await userRes.json();
  // Supabase can return the role under user_metadata, raw_user_meta_data, or app_metadata
  // depending on the GoTrue version and how the metadata was originally set.
  const userRole =
    userInfo.user_metadata?.role ||
    userInfo.raw_user_meta_data?.role ||
    userInfo.app_metadata?.role ||
    null;

  const VALID_ROLES = ['super_admin', 'admin', 'staff'];
  const SUPER_ADMIN_ONLY = ['getProducts', 'updateProduct', 'replacePrisonLookup', 'getPrisonLookupAll', 'replaceScalingTables'];
  const ADMIN_PLUS = ['getSubscriptions', 'getSubscription', 'getOrdersBySubscription'];

  if (!VALID_ROLES.includes(userRole)) {
    return json({ success: false, error: 'Access denied: no valid admin role assigned', code: 'FORBIDDEN' }, 403);
  }

  if (SUPER_ADMIN_ONLY.includes(action) && userRole !== 'super_admin') {
    return json({ success: false, error: 'Access denied: super_admin role required', code: 'FORBIDDEN' }, 403);
  }

  if (ADMIN_PLUS.includes(action) && userRole === 'staff') {
    return json({ success: false, error: 'Access denied: admin role required', code: 'FORBIDDEN' }, 403);
  }

  // ── Supabase REST helper ───────────────────────────────────────────────────

  async function sb(path, opts = {}) {
    const url = `${SUPABASE_URL}/rest/v1/${path}`;
    const preferHeader = opts.prefer || 'return=representation';
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'apikey': SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': preferHeader,
        ...(opts.headers || {}),
      },
      body: opts.body,
    });
    return res;
  }

  // ── Route actions ──────────────────────────────────────────────────────────

  try {
    switch (action) {

      // Return the current user's role (used by client to recover missing role from stored session)
      case 'getRole': {
        return json({ success: true, data: { role: userRole, email: userInfo.email } });
      }

      // Dashboard metrics
      case 'getDashboardMetrics': {
        const [activeRes, pendingRes, overdueRes] = await Promise.all([
          sb('subscriptions?status=eq.ACTIVE&select=id,plan_interval,plan_price'),
          sb('orders?status=eq.PENDING&select=id'),
          sb('orders?status=eq.OVERDUE&select=id'),
        ]);
        const active = await activeRes.json();
        const pending = await pendingRes.json();
        const overdue = await overdueRes.json();

        let monthlyRevenue = 0;
        if (Array.isArray(active)) {
          for (const sub of active) {
            const price = parseFloat(sub.plan_price) || 0;
            if (sub.plan_interval === 'weekly') monthlyRevenue += price * 4.33;
            else if (sub.plan_interval === 'fortnightly') monthlyRevenue += price * 2.17;
            else if (sub.plan_interval === 'monthly') monthlyRevenue += price;
            else if (sub.plan_interval === 'annual') monthlyRevenue += price / 12;
          }
        }

        return json({
          success: true,
          data: {
            activeSubscribers: Array.isArray(active) ? active.length : 0,
            pendingOrders: Array.isArray(pending) ? pending.length : 0,
            overdueOrders: Array.isArray(overdue) ? overdue.length : 0,
            monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
          },
        });
      }

      // Recent activity (last 10 orders)
      case 'getRecentActivity': {
        const res = await sb('orders?order=order_date.desc&limit=10&select=id,order_type,customer_name,customer_mobile,prison_name,prison_state,plan_interval,plan_price,addon_total,status,order_date');
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      // Orders list with optional status filter and search
      case 'getOrders': {
        let qs = 'orders?order=order_date.desc&select=*';
        if (params.status) qs += `&status=eq.${encodeURIComponent(params.status)}`;
        if (params.search) {
          const s = encodeURIComponent(`*${params.search}*`);
          qs += `&or=(customer_name.ilike.${s},customer_mobile.ilike.${s})`;
        }
        const res = await sb(qs);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      // Single order
      case 'getOrder': {
        if (!params.id) return json({ success: false, error: 'Missing id' });
        const res = await sb(`orders?id=eq.${encodeURIComponent(params.id)}&select=*`);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : null });
      }

      // Update order fields
      case 'updateOrder': {
        const { id, fields } = params;
        if (!id || !fields) return json({ success: false, error: 'Missing id or fields' });
        fields.updated_at = new Date().toISOString();
        const res = await sb(`orders?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(fields),
        });
        if (!res.ok) {
          const err = await res.text();
          return json({ success: false, error: `Update failed: ${err}` });
        }
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      // Subscriptions list with optional status filter and search
      case 'getSubscriptions': {
        let qs = 'subscriptions?order=created_at.desc&select=*';
        if (params.status) qs += `&status=eq.${encodeURIComponent(params.status)}`;
        if (params.search) {
          const s = encodeURIComponent(`*${params.search}*`);
          qs += `&or=(customer_name.ilike.${s},customer_mobile.ilike.${s})`;
        }
        const res = await sb(qs);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      // Single subscription
      case 'getSubscription': {
        if (!params.id) return json({ success: false, error: 'Missing id' });
        const res = await sb(`subscriptions?id=eq.${encodeURIComponent(params.id)}&select=*`);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : null });
      }

      // Orders for a subscription
      case 'getOrdersBySubscription': {
        if (!params.stripe_subscription_id) return json({ success: false, error: 'Missing stripe_subscription_id' });
        const res = await sb(`orders?stripe_subscription_id=eq.${encodeURIComponent(params.stripe_subscription_id)}&order=order_date.desc&select=*`);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      // Prison DID lookup for a specific prison
      case 'getPrisonLookup': {
        if (!params.prison_name || !params.prison_state) return json({ success: false, error: 'Missing prison_name or prison_state' });
        const res = await sb(`prison_did_lookup?prison_name=eq.${encodeURIComponent(params.prison_name)}&prison_state=eq.${encodeURIComponent(params.prison_state)}&select=*`);
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : null });
      }

      // All prison DID lookup rows (super_admin only)
      case 'getPrisonLookupAll': {
        const res = await sb('prison_did_lookup?select=*&order=prison_state.asc,prison_name.asc');
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      // Products list
      case 'getProducts': {
        const res = await sb('products?select=*&order=product_type.asc,interval.asc');
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? data : [] });
      }

      // Update a product row (super_admin only)
      case 'updateProduct': {
        const { id, fields } = params;
        if (!id || !fields) return json({ success: false, error: 'Missing id or fields' });
        const res = await sb(`products?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(fields),
        });
        if (!res.ok) {
          const err = await res.text();
          return json({ success: false, error: `Update failed: ${err}` });
        }
        const data = await res.json();
        return json({ success: true, data: Array.isArray(data) ? (data[0] || null) : data });
      }

      // Replace entire prison_did_lookup table (super_admin only)
      case 'replacePrisonLookup': {
        const { rows } = params;
        if (!Array.isArray(rows) || rows.length === 0) return json({ success: false, error: 'No rows provided' });

        // Validate expected columns
        const EXPECTED_COLS = ['prison_name', 'prison_state', 'primary_exchange_code', 'primary_area', 'fallback_1', 'fallback_1_area', 'fallback_2', 'fallback_2_area', 'fallback_3', 'fallback_3_area', 'location', 'notes'];
        const rowCols = Object.keys(rows[0]);
        const missing = EXPECTED_COLS.filter(c => !rowCols.includes(c));
        if (missing.length > 0) {
          return json({ success: false, error: `Missing columns: ${missing.join(', ')}` });
        }

        // Delete all existing rows using a filter that matches all
        const delRes = await sb('prison_did_lookup?prison_name=not.is.null', {
          method: 'DELETE',
          prefer: 'return=minimal',
          headers: { 'Prefer': 'return=minimal' },
        });
        // 204 or 200 both acceptable
        if (!delRes.ok && delRes.status !== 204 && delRes.status !== 200) {
          return json({ success: false, error: `Failed to clear existing data (status ${delRes.status})` });
        }

        // Insert in batches of 200
        const BATCH = 200;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const insRes = await sb('prison_did_lookup', {
            method: 'POST',
            body: JSON.stringify(batch),
            prefer: 'return=minimal',
            headers: { 'Prefer': 'return=minimal' },
          });
          if (!insRes.ok) {
            const err = await insRes.text();
            return json({ success: false, error: `Insert failed at row ${i + 1}: ${err}` });
          }
        }

        return json({ success: true, data: { rowsInserted: rows.length } });
      }

      // Replace all scaling tables atomically (super_admin only)
      case 'replaceScalingTables': {
        const { scaling_model_new, scaling_model_old_fallback, scaling_assumptions } = params;
        if (!Array.isArray(scaling_model_new)) return json({ success: false, error: 'Missing scaling_model_new data' });
        if (!Array.isArray(scaling_model_old_fallback)) return json({ success: false, error: 'Missing scaling_model_old_fallback data' });
        if (!Array.isArray(scaling_assumptions)) return json({ success: false, error: 'Missing scaling_assumptions data' });

        // Delete all rows from each table (use id=not.is.null assuming standard id columns)
        for (const table of ['scaling_model_new', 'scaling_model_old_fallback', 'scaling_assumptions']) {
          const delRes = await sb(`${table}?id=not.is.null`, {
            method: 'DELETE',
            prefer: 'return=minimal',
            headers: { 'Prefer': 'return=minimal' },
          });
          if (!delRes.ok && delRes.status !== 204 && delRes.status !== 200) {
            return json({ success: false, error: `Failed to clear table ${table} (status ${delRes.status})` });
          }
        }

        // Insert new data
        const inserts = [
          { table: 'scaling_model_new', rows: scaling_model_new },
          { table: 'scaling_model_old_fallback', rows: scaling_model_old_fallback },
          { table: 'scaling_assumptions', rows: scaling_assumptions },
        ];

        for (const { table, rows } of inserts) {
          if (!rows || rows.length === 0) continue;
          const BATCH = 200;
          for (let i = 0; i < rows.length; i += BATCH) {
            const batch = rows.slice(i, i + BATCH);
            const insRes = await sb(table, {
              method: 'POST',
              body: JSON.stringify(batch),
              prefer: 'return=minimal',
              headers: { 'Prefer': 'return=minimal' },
            });
            if (!insRes.ok) {
              const err = await insRes.text();
              return json({ success: false, error: `Insert into ${table} failed: ${err}` });
            }
          }
        }

        return json({
          success: true,
          data: {
            scaling_model_new: scaling_model_new.length,
            scaling_model_old_fallback: scaling_model_old_fallback.length,
            scaling_assumptions: scaling_assumptions.length,
          },
        });
      }

      default:
        return json({ success: false, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    return json({ success: false, error: err.message || 'Internal server error' }, 500);
  }
}
