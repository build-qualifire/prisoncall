/**
 * GET /api/get-session?session_id=cs_xxx
 *
 * Retrieves a Stripe Checkout Session, extracts order metadata from the
 * subscription, sets a secure HttpOnly session cookie (pc_session), and
 * returns all order details as JSON.
 *
 * Metadata was written to subscription_data[metadata] by create-checkout.js,
 * so we expand `subscription` to read it here.
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  const url        = new URL(request.url);
  const session_id = url.searchParams.get('session_id');

  function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
  }

  if (!session_id) {
    return jsonResponse({ error: 'session_id is required' }, 400);
  }

  /* ── Select Stripe key based on APP_ENV ──────────────────────────────── */
  const isTestMode    = env.APP_ENV === 'test';
  const STRIPE_KEY    = isTestMode ? env.STRIPE_SECRET_KEY_TEST : env.STRIPE_SECRET_KEY;

  if (!STRIPE_KEY) {
    console.error('[get-session] Missing Stripe key for mode:', isTestMode ? 'TEST' : 'LIVE');
    return jsonResponse({
      error: isTestMode
        ? 'Server misconfiguration: missing STRIPE_SECRET_KEY_TEST'
        : 'Server misconfiguration: missing STRIPE_SECRET_KEY',
    }, 500);
  }

  /* ── Fetch session from Stripe, expanding subscription for metadata ──── */
  let session;
  try {
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session_id)}?expand[]=subscription`,
      {
        headers: { 'Authorization': 'Basic ' + btoa(STRIPE_KEY + ':') },
      }
    );

    const stripeBody = await stripeRes.json();
    if (!stripeRes.ok) {
      throw new Error(stripeBody.error?.message || `Stripe error ${stripeRes.status}`);
    }
    session = stripeBody;
  } catch (err) {
    console.error('[get-session] Stripe fetch failed:', err.message);
    return jsonResponse({ error: 'Failed to retrieve session: ' + err.message }, 500);
  }

  /* ── Extract customer details ─────────────────────────────────────────── */
  const customer_email     = session.customer_details?.email || null;
  const stripe_customer_id = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id || null;

  /* Metadata is on the subscription (written via subscription_data[metadata]) */
  const subMeta     = session.subscription?.metadata || {};
  /* Also merge any session-level metadata as a fallback */
  const sessionMeta = session.metadata || {};
  const meta        = Object.assign({}, sessionMeta, subMeta);

  /* ── Build cookie — pc_session (HttpOnly, read server-side only) ──────── */
  /* Use plan_1_mobile for bundles, mobile for single plans */
  const cookieMobile = meta.plan_1_mobile || meta.mobile || null;

  const cookiePayload = JSON.stringify({
    mobile:              cookieMobile,
    stripe_customer_id,
    email:               customer_email,
  });

  const cookieHeader = [
    'pc_session=' + encodeURIComponent(cookiePayload),
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=2592000', /* 30 days */
  ].join('; ');

  /* ── Return all extracted data ─────────────────────────────────────────── */
  const responseData = {
    is_authenticated:  true,
    customer_email,
    stripe_customer_id,
    ...meta,
  };

  console.log(
    '[get-session] Returning session data —',
    'email:', !!customer_email,
    '| meta keys:', Object.keys(meta).length
  );

  return jsonResponse(responseData, 200, { 'Set-Cookie': cookieHeader });
}
