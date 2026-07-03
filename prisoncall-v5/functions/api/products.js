/**
 * GET /api/products
 * Returns active rows from the Supabase products table.
 * Uses the service role key server-side so RLS never blocks the read.
 * Credentials never reach the browser.
 */
export async function onRequestGet(context) {
  const { env } = context;

  const isTestMode = env.APP_ENV === 'test';
  console.log('[Products] Running in', isTestMode ? 'TEST' : 'LIVE', 'mode');

  const SUPABASE_URL = env.SUPABASE_URL;
  /* Prefer service role key (bypasses RLS); fall back to anon key */
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

  console.log('[products] SUPABASE_URL set:', !!SUPABASE_URL);
  console.log('[products] SUPABASE_SERVICE_ROLE_KEY set:', !!env.SUPABASE_SERVICE_ROLE_KEY);
  console.log('[products] SUPABASE_ANON_KEY set:', !!env.SUPABASE_ANON_KEY);

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[products] Missing credentials — cannot query Supabase');
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing Supabase credentials' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = `${SUPABASE_URL}/rest/v1/products?active=eq.true&select=*&order=product_type.asc,interval.asc`;
  console.log('[products] Querying:', url.replace(SUPABASE_URL, '<SUPABASE_URL>'));

  try {
    const res = await fetch(url, {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept':        'application/json',
      },
    });

    const body = await res.text();
    console.log('[products] Supabase status:', res.status, '— body length:', body.length, '— first 300 chars:', body.slice(0, 300));

    if (!res.ok) {
      console.error('[products] Supabase error', res.status, body);
      return new Response(JSON.stringify({ error: `Supabase responded with ${res.status}: ${body.slice(0, 200)}` }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    /* Parse rows to log count and apply test-mode price ID remapping */
    let responseBody = body;
    try {
      const rows = JSON.parse(body);
      console.log('[products] Returning', Array.isArray(rows) ? rows.length : '?', 'rows');
      if (Array.isArray(rows) && rows[0]) {
        console.log('[products] First row keys:', Object.keys(rows[0]).join(', '));
      }

      /* In test mode, replace stripe_price_id with stripe_price_id_test so
         choose-plan.html always reads stripe_price_id and gets the right value */
      if (isTestMode && Array.isArray(rows)) {
        const remapped = rows.map(function(row) {
          return Object.assign({}, row, { stripe_price_id: row.stripe_price_id_test || null });
        });
        responseBody = JSON.stringify(remapped);
        console.log('[products] Test mode: stripe_price_id remapped to stripe_price_id_test');
      }
    } catch (_) { /* non-fatal — raw body returned if parse fails */ }

    return new Response(responseBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    console.error('[products] Fetch error:', err && err.message);
    return new Response(JSON.stringify({ error: 'Failed to reach Supabase: ' + (err && err.message) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
