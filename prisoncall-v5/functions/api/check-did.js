/* POST /api/check-did
   Body: { did: "0312345678" }
   Looks up subscriptions table by current_did.
   Tries all common storage formats in a single OR query so the lookup
   succeeds regardless of how the DID was originally saved.
   Returns { success, currentPrison, state } or { success: false, error }.
*/

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* Build all plausible storage formats for a 10-digit Australian number.
   e.g. "0361540567" produces:
     "0361540567"   - as entered
     "+61361540567" - E.164 with +
     "61361540567"  - country code without +
     "361540567"    - 9-digit without leading 0
*/
function didFormats(digits) {
  const withoutLeadingZero = digits.startsWith('0') ? digits.slice(1) : digits;
  return [
    digits,
    '+61' + withoutLeadingZero,
    '61'  + withoutLeadingZero,
    withoutLeadingZero,
  ];
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

  /* Build OR filter: current_did=eq.X,current_did=eq.Y,... */
  const orFilter = didFormats(did)
    .map(function (fmt) { return 'current_did.eq.' + encodeURIComponent(fmt); })
    .join(',');

  const url =
    SUPABASE_URL +
    '/rest/v1/subscriptions?or=(' + orFilter + ')' +
    '&select=prison_name,prison_state,status&limit=1';

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + SUPABASE_KEY,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
      },
    });

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
