// Central Supabase handler for all portal operations.
// Customer identity is ALWAYS read from the pc_session HttpOnly cookie — never trusted from request body.

function parseCookieValue(header, name) {
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function getSession(request) {
  const raw = parseCookieValue(request.headers.get('Cookie') || '', 'pc_session');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSb(supabaseUrl, serviceKey) {
  return async function sb(path, opts = {}) {
    return fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': 'application/json',
        Prefer: opts.prefer || 'return=representation',
        ...(opts.headers || {}),
      },
      body: opts.body,
    });
  };
}

// ─── GET handler — read-only actions ───────────────────────────────────────

export async function onRequestGet(context) {
  const { env, request } = context;
  const sb = makeSb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'get-subscriptions') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    const mobile = session.mobile;

    const res = await sb(
      `subscriptions?customer_mobile=eq.${encodeURIComponent(mobile)}&order=created_at.desc`
    );
    if (!res.ok) return json({ error: 'db_error' }, 500);
    const rows = await res.json();
    return json(rows);
  }

  if (action === 'get-prisons') {
    const state = url.searchParams.get('state') || '';
    if (!state) return json({ error: 'state_required' }, 400);
    const res = await sb(
      `prison_did_lookup?prison_state=eq.${encodeURIComponent(state)}&order=prison_name.asc&select=prison_name,prison_state`
    );
    if (!res.ok) return json({ error: 'db_error' }, 500);
    const rows = await res.json();
    return json(rows);
  }

  return json({ error: 'unknown_action' }, 400);
}

// ─── POST handler — write actions ──────────────────────────────────────────

export async function onRequestPost(context) {
  const { env, request } = context;
  const sb = makeSb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'invalid_body' }, 400); }

  const action = body.action;

  // ── submit-transfer ──────────────────────────────────────────────────────
  if (action === 'submit-transfer') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    const mobile = session.mobile;

    const { subscription_id, new_prison_name, new_prison_state } = body;
    if (!subscription_id || !new_prison_name || !new_prison_state) {
      return json({ error: 'missing_fields' }, 400);
    }

    // Verify ownership
    const subRes = await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}&limit=1`);
    if (!subRes.ok) return json({ error: 'db_error' }, 500);
    const subRows = await subRes.json();
    if (!subRows.length) return json({ error: 'not_found' }, 404);
    const sub = subRows[0];
    if (sub.customer_mobile !== mobile) return json({ error: 'forbidden' }, 403);

    // Look up new prison exchange details
    const prisonRes = await sb(
      `prison_did_lookup?prison_name=eq.${encodeURIComponent(new_prison_name)}&limit=1`
    );
    let prison = {};
    if (prisonRes.ok) {
      const prisonRows = await prisonRes.json();
      if (prisonRows.length) prison = prisonRows[0];
    }

    // Insert transfer order
    const order = {
      order_type: 'TRANSFER',
      parent_order_id: sub.id,
      old_did_number: sub.current_did,
      customer_name: sub.customer_name,
      customer_mobile: sub.customer_mobile,
      customer_email: sub.customer_email,
      assigned_mobile: sub.assigned_mobile || null,
      prison_name: new_prison_name,
      prison_state: new_prison_state,
      primary_exchange: prison.primary_exchange_code || null,
      fallback_1: prison.fallback_1 || null,
      fallback_2: prison.fallback_2 || null,
      fallback_3: prison.fallback_3 || null,
      plan_interval: sub.plan_interval,
      plan_price: sub.plan_price,
      addon_48hr_cancel: sub.addon_48hr_cancel,
      addon_transfers: sub.addon_transfers,
      addon_post_renewal: sub.addon_post_renewal,
      addon_combo23: sub.addon_combo23,
      addon_lifetime: sub.addon_lifetime,
      order_date: new Date().toISOString(),
      stripe_subscription_id: sub.stripe_subscription_id,
      stripe_customer_id: sub.stripe_customer_id,
      status: 'PENDING',
    };

    const orderRes = await sb('orders', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify(order),
    });
    if (!orderRes.ok) {
      const err = await orderRes.text();
      console.error('Transfer order insert failed:', err);
      return json({ error: 'db_error' }, 500);
    }

    // Update subscription status
    await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ status: 'TRANSFER_PENDING', updated_at: new Date().toISOString() }),
    });

    // STUB: admin SMS
    console.log(
      `TRANSFER ADMIN SMS STUB — To: Guness + Dinisha — TRANSFER ORDER: ${sub.customer_name} / ${sub.prison_name} -> ${new_prison_name} / ${new_prison_state} / DID: ${sub.current_did} / Mobile: ${sub.customer_mobile} / Exchange: ${prison.primary_exchange_code || '-'} / Fallbacks: ${prison.fallback_1 || '-'} > ${prison.fallback_2 || '-'} > ${prison.fallback_3 || '-'}`
    );

    return json({ success: true });
  }

  // ── cancel-subscription ──────────────────────────────────────────────────
  if (action === 'cancel-subscription') {
    const session = getSession(request);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    const mobile = session.mobile;

    const { subscription_id } = body;
    if (!subscription_id) return json({ error: 'missing_fields' }, 400);

    const subRes = await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}&limit=1`);
    if (!subRes.ok) return json({ error: 'db_error' }, 500);
    const subRows = await subRes.json();
    if (!subRows.length) return json({ error: 'not_found' }, 404);
    const sub = subRows[0];
    if (sub.customer_mobile !== mobile) return json({ error: 'forbidden' }, 403);

    await sb(`subscriptions?id=eq.${encodeURIComponent(subscription_id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ status: 'CANCELLATION_PENDING', updated_at: new Date().toISOString() }),
    });

    // STUBS: admin SMS + 3CX deletion
    console.log(
      `CANCELLATION ADMIN SMS STUB — To: Guness + Dinisha — CANCELLATION: ${sub.customer_name} / ${sub.prison_name} / DID: ${sub.current_did} / Plan: ${sub.plan_interval} $${sub.plan_price} / Mobile: ${sub.customer_mobile}`
    );
    console.log(
      `3CX DELETION STUB — Extension: ${sub.current_extension} — Wire after 3CX licence purchased`
    );

    return json({ success: true });
  }

  // ── logout ───────────────────────────────────────────────────────────────
  if (action === 'logout') {
    const clearCookie = [
      'pc_session=',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=0',
    ].join('; ');
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': clearCookie,
      },
    });
  }

  // ── dev-bypass ───────────────────────────────────────────────────────────
  if (action === 'dev-bypass') {
    const sb2 = makeSb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const activeRes = await sb2(`subscriptions?status=eq.ACTIVE&limit=1`);
    let sessionPayload;

    if (activeRes.ok) {
      const rows = await activeRes.json();
      if (rows.length) {
        const row = rows[0];
        sessionPayload = JSON.stringify({
          mobile: row.customer_mobile,
          stripe_customer_id: row.stripe_customer_id || '',
          email: row.customer_email || '',
        });
      }
    }

    if (!sessionPayload) {
      sessionPayload = JSON.stringify({
        mobile: '0400000001',
        stripe_customer_id: 'cus_test',
        email: 'test@prisoncall.com.au',
      });
    }

    const cookieHeader = [
      `pc_session=${encodeURIComponent(sessionPayload)}`,
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=2592000',
    ].join('; ');

    return new Response(JSON.stringify({ success: true, redirect: '/portal/dashboard.html' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieHeader,
      },
    });
  }

  return json({ error: 'unknown_action' }, 400);
}
