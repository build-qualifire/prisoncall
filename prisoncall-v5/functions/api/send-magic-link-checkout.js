// POST /api/send-magic-link-checkout
// Body: { mobile }
// Validates mobile, generates a magic link token, inserts into Supabase magic_links,
// and stubs the SMS send (console.log only — Twilio wiring in a later session).

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  try {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ success: false, error: 'Invalid request body' });
    }

    const rawMobile = (body.mobile || '').replace(/\s/g, '');

    if (!/^04\d{8}$/.test(rawMobile)) {
      return json({ success: false, error: 'Enter a valid Australian mobile number' });
    }

    // Normalise to E.164: +614xxxxxxxx
    const e164 = '+61' + rawMobile.slice(1);

    // 32-char cryptographically random hex token
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    const token = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');

    // Expiry: 15 minutes from now
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const SUPABASE_URL = env.SUPABASE_URL;
    const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return json({ success: false, error: 'Something went wrong. Please try again.' });
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/magic_links`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        mobile: e164,
        token,
        expires_at: expiresAt,
        used: false,
        redirect_to: 'choose-plan',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[send-magic-link-checkout] Supabase insert failed:', err.slice(0, 200));
      return json({ success: false, error: 'Something went wrong. Please try again.' });
    }

    // STUB: log magic link URL only — Twilio wiring happens in a later session
    console.log('Checkout magic link:', `https://prisoncall.pages.dev/api/verify-magic-link-checkout?token=${token}`);

    return json({ success: true });
  } catch (err) {
    console.error('[send-magic-link-checkout] Error:', err.message);
    return json({ success: false, error: 'Something went wrong. Please try again.' });
  }
}
