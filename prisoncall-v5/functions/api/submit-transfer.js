/* POST /api/submit-transfer
   Body: { did, currentPrison, newPrison, mobile }
   Inserts a PENDING_SMS_CONFIRM row into the orders table.
   WF3 in n8n fires when the customer replies YES to the confirmation SMS.
   Returns { success: true } or { success: false, error }.
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

  const did           = (body.did           || '').toString().trim();
  const currentPrison = (body.currentPrison || '').toString().trim();
  const newPrison     = (body.newPrison      || '').toString().trim();
  const mobile        = (body.mobile         || '').replace(/\D/g, '');

  if (!did || !currentPrison || !newPrison || !mobile) {
    return jsonResponse({ success: false, error: 'Missing required fields' });
  }

  const SUPABASE_URL      = env.SUPABASE_URL;
  const SUPABASE_KEY      = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ success: false, error: 'Server misconfiguration' });
  }

  const payload = {
    order_type:       'TRANSFER',
    current_did:      did,
    prison_name:      currentPrison,
    new_prison:       newPrison,
    customer_mobile:  mobile,
    status:           'PENDING_SMS_CONFIRM',
    created_at:       new Date().toISOString(),
  };

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + SUPABASE_KEY,
        apikey:        SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer:        'return=minimal',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let detail = '';
      try { const d = await res.json(); detail = d.message || d.error || ''; } catch {}
      return jsonResponse({ success: false, error: detail || 'Insert failed' });
    }

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, error: 'Insert failed' });
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
