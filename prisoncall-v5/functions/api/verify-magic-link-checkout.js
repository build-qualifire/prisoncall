// GET /api/verify-magic-link-checkout?token=
// Validates the token against Supabase magic_links.
// On success: marks the link used, sets pc_session cookie, redirects to /choose-plan?auth=success.
// On failure: redirects to /choose-plan?auth=expired.

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const origin = url.origin;

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const nowIso = new Date().toISOString();

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/magic_links?token=eq.${encodeURIComponent(token)}&used=eq.false&expires_at=gt.${encodeURIComponent(nowIso)}&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          apikey: SUPABASE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
      }
    );

    if (!res.ok) {
      return Response.redirect(`${origin}/choose-plan?auth=expired`, 302);
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) {
      return Response.redirect(`${origin}/choose-plan?auth=expired`, 302);
    }

    const row = rows[0];

    // Mark the link as used
    await fetch(`${SUPABASE_URL}/rest/v1/magic_links?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ used: true }),
    });

    // Set pc_session cookie with the mobile from the magic link row
    const sessionValue = encodeURIComponent(JSON.stringify({ mobile: row.mobile }));
    const cookieHeader = [
      `pc_session=${sessionValue}`,
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Max-Age=2592000',
      'Path=/',
    ].join('; ');

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${origin}/choose-plan?auth=success`,
        'Set-Cookie': cookieHeader,
      },
    });
  } catch (err) {
    console.error('[verify-magic-link-checkout] Error:', err.message);
    return Response.redirect(`${origin}/choose-plan?auth=expired`, 302);
  }
}
