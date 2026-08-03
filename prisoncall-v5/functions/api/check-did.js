/* POST /api/check-did
   Body: { did: "0312345678" }
   Looks up subscriptions table by current_did.
   Returns { success, currentPrison, state } or { success: false, error }.
*/

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid request body' });
  }

  const did = (body.did || '').replace(/\D/g, '');
  if (!did) {
    return jsonResponse({ success: false, error: 'Missing DID' });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ success: false, error: 'Server misconfiguration' });
  }

  try {
    const res = await fetch(
      SUPABASE_URL +
        '/rest/v1/subscriptions?current_did=eq.' +
        encodeURIComponent(did) +
        '&select=prison_name,prison_state,status&limit=1',
      {
        headers: {
          Authorization: 'Bearer ' + SUPABASE_KEY,
          apikey: SUPABASE_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!res.ok) {
      return jsonResponse({ success: false, error: 'Lookup failed' });
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return jsonResponse({ success: false, error: 'Not found or not active' });
    }

    const row = rows[0];
    if (row.status !== 'ACTIVE') {
      return jsonResponse({ success: false, error: 'Not found or not active' });
    }

    return jsonResponse({
      success: true,
      currentPrison: row.prison_name,
      state: row.prison_state,
    });
  } catch {
    return jsonResponse({ success: false, error: 'Lookup failed' });
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}
