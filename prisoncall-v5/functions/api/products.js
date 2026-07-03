/**
 * GET /api/products
 * Returns active rows from the Supabase products table.
 * Uses the service role key server-side so RLS never blocks the read.
 * Credentials never reach the browser.
 */
export async function onRequestGet(context) {
  const { env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  /* Prefer service role key (bypasses RLS); fall back to anon key */
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing Supabase credentials' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/products?active=eq.true&select=*&order=product_type.asc,interval.asc`, {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept':        'application/json',
      },
    });

    const body = await res.text();

    if (!res.ok) {
      console.error('[products] Supabase error', res.status, body);
      return new Response(JSON.stringify({ error: `Supabase responded with ${res.status}` }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    console.error('[products] Fetch error:', err && err.message);
    return new Response(JSON.stringify({ error: 'Failed to reach Supabase' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
