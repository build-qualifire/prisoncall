/* POST /api/check-did
   Body: { did: "0312345678" }
   Looks up subscriptions table by current_did.
   Tries all common storage formats one at a time using the same simple
   column=eq.value pattern used by all other functions in this repo.
   Returns { success, currentPrison, state } or { success: false, error }.
*/

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* Build the 4 format variants for a 10-digit Australian local number.
   DIDs are stored in Supabase as 11-digit strings starting with 61 (no plus,
   no leading zero) — e.g. "61361540567".  The other three variants are tried
   as fallbacks in case of historical data inconsistencies.

   Query order for "0361540567":
     1. "61361540567"  — country code without +  (stored format — most likely)
     2. "+61361540567" — E.164 with +
     3. "0361540567"   — local format as entered
     4. "361540567"    — without leading zero
*/
function didFormats(digits) {
  const withoutLeadingZero = digits.startsWith('0') ? digits.slice(1) : digits;
  return [
    '61'  + withoutLeadingZero,   // stored format — try first
    '+61' + withoutLeadingZero,
    digits,
    withoutLeadingZero,
  ];
}

/* Single-format lookup — identical pattern to check-existing-customer.js */
async function queryOneFmt(supabaseUrl, supabaseKey, fmt) {
  const url =
    supabaseUrl +
    '/rest/v1/subscriptions?current_did=eq.' +
    encodeURIComponent(fmt) +
    '&status=eq.ACTIVE&select=prison_name,prison_state,status&limit=1';

  console.log('[check-did] querying URL:', url);

  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + supabaseKey,
      apikey:        supabaseKey,
      'Content-Type': 'application/json',
      Prefer:        'return=representation',
    },
  });

  const text = await res.text();
  console.log('[check-did] response status:', res.status, '| body:', text);
  return { ok: res.ok, body: text };
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
  console.log('[check-did] RAW input received:', JSON.stringify(body.did));
  console.log('[check-did] Cleaned (digits only):', did, '| length:', did.length);
  if (!did) {
    return jsonResponse({ success: false, error: 'Missing DID' });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('[check-did] ERROR: missing env vars — SUPABASE_URL:', !!SUPABASE_URL, '| SUPABASE_SERVICE_ROLE_KEY:', !!SUPABASE_KEY);
    return jsonResponse({ success: false, error: 'Server misconfiguration' });
  }

  const formats = didFormats(did);
  console.log('[check-did] Format variants to try:', formats.join(' | '));

  for (const fmt of formats) {
    console.log('[check-did] Trying format:', fmt);
    let result;
    try {
      result = await queryOneFmt(SUPABASE_URL, SUPABASE_KEY, fmt);
    } catch (err) {
      console.log('[check-did] fetch threw for format', fmt, ':', err.message);
      continue;
    }

    if (!result.ok) {
      console.log('[check-did] Non-OK response for format', fmt, '— skipping');
      continue;
    }

    let rows;
    try { rows = JSON.parse(result.body); } catch { rows = null; }
    console.log('[check-did] Parsed rows for format', fmt, ':', JSON.stringify(rows));

    if (Array.isArray(rows) && rows.length > 0) {
      const row = rows[0];
      if (row.status === 'ACTIVE') {
        console.log('[check-did] MATCH found with format:', fmt, '| prison:', row.prison_name, '| state:', row.prison_state);
        return jsonResponse({
          success: true,
          currentPrison: row.prison_name,
          state: row.prison_state,
        });
      } else {
        console.log('[check-did] Row found but status is not ACTIVE:', row.status);
      }
    }
  }

  console.log('[check-did] No match found across all format variants');
  return jsonResponse({ success: false });
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
