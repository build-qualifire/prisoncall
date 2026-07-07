// GET /api/check-existing-customer
// Reads the pc_session HttpOnly cookie. If valid and mobile is present,
// queries Supabase subscriptions for an ACTIVE record. Returns
// { recognised: true, stripe_customer_id } or { recognised: false }.
// Never throws — always returns valid JSON.

function parseCookieValue(header, name) {
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;

  try {
    const cookieHeader = request.headers.get('Cookie') || '';
    const raw = parseCookieValue(cookieHeader, 'pc_session');
    if (!raw) return json({ recognised: false });

    let session;
    try {
      session = JSON.parse(raw);
    } catch (_) {
      return json({ recognised: false });
    }

    if (!session || !session.mobile) return json({ recognised: false });

    const mobile = session.mobile;
    const SUPABASE_URL = env.SUPABASE_URL;
    const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) return json({ recognised: false });

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?customer_mobile=eq.${encodeURIComponent(mobile)}&status=eq.ACTIVE&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          apikey: SUPABASE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
      }
    );

    if (!res.ok) return json({ recognised: false });
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return json({ recognised: false });

    return json({ recognised: true, stripe_customer_id: rows[0].stripe_customer_id || null });
  } catch (_) {
    return json({ recognised: false });
  }
}
