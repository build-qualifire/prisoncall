export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': new URL(request.url).origin,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  /* ── 1. Parse request body ─────────────────────────────────────────── */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { plans } = body;
  if (!Array.isArray(plans) || plans.length === 0) {
    return jsonResponse({ error: 'plans must be a non-empty array' }, 400);
  }

  /* customer_mobile — account owner's login mobile, always from first plan's OTP verification */
  const customer_mobile = body.customer_mobile || '';

  /* Path C — bundle discount fields */
  const applyBundle        = body.bundle === true;
  const bundleCustomerId   = (typeof body.stripe_customer_id === 'string' && body.stripe_customer_id.trim())
    ? body.stripe_customer_id.trim()
    : null;

  /* ── 2. Detect mode from APP_ENV and select Stripe key ────────────── */
  const isTestMode = env.APP_ENV === 'test';
  console.log('[Checkout] Running in', isTestMode ? 'TEST' : 'LIVE', 'mode');

  const STRIPE_SECRET_KEY = isTestMode ? env.STRIPE_SECRET_KEY_TEST : env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    return jsonResponse({
      error: isTestMode
        ? 'Server misconfiguration: missing STRIPE_SECRET_KEY_TEST'
        : 'Server misconfiguration: missing STRIPE_SECRET_KEY',
    }, 500);
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ error: 'Server misconfiguration: missing Supabase credentials' }, 500);
  }

  let priceMap; /* product_key → stripe_price_id (live or test depending on mode) */
  try {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/products?active=eq.true&select=product_key,stripe_price_id,stripe_price_id_test`,
      {
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Accept':        'application/json',
        },
      }
    );
    if (!sbRes.ok) {
      const errText = await sbRes.text();
      throw new Error(`Supabase ${sbRes.status}: ${errText.slice(0, 200)}`);
    }
    const products = await sbRes.json();
    console.log('[create-checkout] Raw Supabase products count:', products.length);
    console.log('[create-checkout] Raw product rows:', JSON.stringify(products.map(p => ({
      product_key: p.product_key,
      has_live_price: !!p.stripe_price_id,
      has_test_price: !!p.stripe_price_id_test,
      test_price_id: p.stripe_price_id_test || null,
    }))));
    priceMap = {};
    products.forEach(p => {
      if (!p.product_key) return;
      /* In test mode use stripe_price_id_test; in live mode use stripe_price_id */
      const priceId = isTestMode ? p.stripe_price_id_test : p.stripe_price_id;
      if (priceId) priceMap[p.product_key] = priceId;
    });
    console.log('[create-checkout] Loaded', Object.keys(priceMap).length, 'price IDs from Supabase (mode:', isTestMode ? 'test' : 'live', ')');
    console.log('[create-checkout] Full priceMap keys:', JSON.stringify(Object.keys(priceMap)));
    console.log('[create-checkout] addon_48hr_cancel in priceMap:', 'addon_48hr_cancel' in priceMap, '| value:', priceMap['addon_48hr_cancel'] || 'MISSING');
    console.log('[create-checkout] addon_48hr in priceMap:', 'addon_48hr' in priceMap, '| value:', priceMap['addon_48hr'] || 'MISSING');
  } catch (err) {
    console.error('[create-checkout] Supabase fetch failed:', err.message);
    return jsonResponse({ error: 'Failed to load pricing data: ' + err.message }, 500);
  }

  /* ── 3. Build line items and subscription metadata ─────────────────── */

  /* Top-level addons field sent by the add-on checkout path in the frontend:
     { plans: [...], addons: { addon1, addon2, addon3, combo23, lifetimeAll } }
     The order-summary path sends { plans: [...] } with no addons field. */
  const topLevelAddons = body.addons || {};

  try {
    const line_items = []; /* all prices — Stripe Checkout accepts both recurring and one-time in line_items for subscription mode */
    const subMeta = {}; /* flattened for subscription_data[metadata][...] */

    console.log('[create-checkout] Request body plans count:', plans.length);
    console.log('[create-checkout] Request body addons (top-level):', JSON.stringify(body.addons || {}));
    console.log('[create-checkout] Plan addons (per-plan[0]):', JSON.stringify(plans[0] && plans[0].addons || 'none'));

    plans.forEach(function(plan, idx) {
      /* Normalise field names — frontend currently sends plan_interval / mobile_number;
         spec uses plan_key / mobile. Accept either. */
      const interval         = plan.plan_key        || plan.plan_interval || '';
      const assigned_mobile  = plan.assigned_mobile || plan.mobile_number || plan.mobile || '';
      const prison   = plan.prison_name   || '';
      const state    = plan.prison_state  || '';
      /* Per-plan addons take priority; fall back to top-level body.addons */
      const addons   = plan.addons        || topLevelAddons;

      console.log(`[create-checkout] Plan[${idx}] interval="${interval}" addons:`, JSON.stringify(addons));

      if (!interval) throw new Error(`Plan ${idx + 1} is missing plan_key / plan_interval`);

      /* Plan line item */
      const planProductKey = `plan_${interval}`;
      const planPriceId    = priceMap[planProductKey];
      if (!planPriceId) {
        throw new Error(isTestMode
          ? `Test price ID not configured for product: ${planProductKey}. Add it in the admin portal Products page.`
          : `No Stripe price ID for product_key "${planProductKey}" — check Supabase products table`
        );
      }
      line_items.push({ price: planPriceId, quantity: 1 });

      /* Add-on line items.
         All prices (recurring and one-time) go into line_items for Stripe Checkout subscription mode.
         Stripe charges one-time prices on the first invoice automatically.

         addon_48hr_cancel: dual-key fallback — Supabase product_key may be stored as either
         'addon_48hr_cancel' (from create-sandbox-products.js) or 'addon_48hr' (if set manually).

         SERVER-SIDE DEDUPLICATION:
         - If lifetimeAll selected → only charge lifetime (covers everything else)
         - If combo23 selected → only charge combo (covers addon2 + addon3 individually)
         - addon2 and addon3 are never charged individually alongside combo23 */

      /* Resolve addon_48hr price using dual-key fallback */
      const addon48hrKey      = priceMap['addon_48hr_cancel'] ? 'addon_48hr_cancel' : 'addon_48hr';
      console.log('[create-checkout] addon48hrKey resolved to:', addon48hrKey, '| priceMap["addon_48hr_cancel"]:', priceMap['addon_48hr_cancel'] || 'MISSING', '| priceMap["addon_48hr"]:', priceMap['addon_48hr'] || 'MISSING');

      const addonProductKeys = {
        addon1:      addon48hrKey,
        addon2:      `addon_transfers_${interval}`,
        addon3:      `addon_post_renewal_${interval}`,
        combo23:     `addon_combo23_${interval}`,
        lifetimeAll: 'addon_lifetime',
      };

      /* Build effective addon set — deduplicate per business rules */
      const effectiveAddons = {};
      if (addons.lifetimeAll) {
        effectiveAddons.lifetimeAll = true;
      } else if (addons.combo23) {
        if (addons.addon1) effectiveAddons.addon1 = true;
        effectiveAddons.combo23 = true;
      } else {
        if (addons.addon1) effectiveAddons.addon1 = true;
        if (addons.addon2) effectiveAddons.addon2 = true;
        if (addons.addon3) effectiveAddons.addon3 = true;
      }
      console.log('[create-checkout] effectiveAddons after deduplication:', JSON.stringify(effectiveAddons));

      Object.entries(addonProductKeys).forEach(function([addonKey, productKey]) {
        if (!effectiveAddons[addonKey]) return;
        const addonPriceId = priceMap[productKey];
        console.log(`[create-checkout] Addon lookup — addonKey="${addonKey}" productKey="${productKey}" priceId="${addonPriceId || 'MISSING'}"`);
        if (!addonPriceId) {
          console.error(`[create-checkout] MISSING PRICE: productKey="${productKey}" not in priceMap. Available keys:`, JSON.stringify(Object.keys(priceMap)));
          throw new Error(isTestMode
            ? `Test price ID not configured for product: ${productKey}. Add it in the admin portal Products page.`
            : `No Stripe price ID for product_key "${productKey}" — check Supabase products table`
          );
        }
        console.log(`[create-checkout] Adding line_item: price="${addonPriceId}" (addonKey="${addonKey}")`);
        line_items.push({ price: addonPriceId, quantity: 1 });
      });

      /* Metadata — prefix with plan index for bundles so all plans are represented */
      const pfx = plans.length > 1 ? `plan_${idx + 1}_` : '';
      subMeta[`${pfx}prison_name`]        = prison;
      subMeta[`${pfx}prison_state`]       = state;
      subMeta[`${pfx}assigned_mobile`]    = assigned_mobile;
      subMeta[`${pfx}plan_interval`]      = interval;
      subMeta[`${pfx}addon_48hr_cancel`]  = String(!!addons.addon1);
      subMeta[`${pfx}addon_transfers`]    = String(!!addons.addon2);
      subMeta[`${pfx}addon_post_renewal`] = String(!!addons.addon3);
      subMeta[`${pfx}addon_combo23`]      = String(!!addons.combo23);
      subMeta[`${pfx}addon_lifetime`]     = String(!!addons.lifetimeAll);
    });

    /* Top-level account owner identity — same for all plans in this order */
    subMeta['customer_mobile'] = customer_mobile;

    /* Path C — bundle flag in metadata so n8n WF1 can read it from the Stripe webhook */
    subMeta['bundle'] = applyBundle ? 'true' : 'false';

    /* ── 4. Create Stripe Checkout Session ───────────────────────────── */
    /* Stripe Checkout subscription mode accepts both recurring and one-time prices in
       line_items. One-time prices are charged on the first invoice automatically. */
    const sessionParams = new URLSearchParams();
    sessionParams.append('mode',        'subscription');
    sessionParams.append('currency',    'aud');
    sessionParams.append('success_url', 'https://prisoncall.pages.dev/thank-you.html?session_id={CHECKOUT_SESSION_ID}');
    sessionParams.append('cancel_url',  'https://prisoncall.pages.dev/choose-plan');

    /* Path C — attach existing Stripe customer and bundle coupon when recognised.
       customer and customer_email are mutually exclusive in Stripe Checkout. */
    if (applyBundle && bundleCustomerId) {
      sessionParams.append('customer',        bundleCustomerId);
      sessionParams.append('discounts[0][coupon]', '9beEKMmG');
      console.log('[create-checkout] Path C bundle discount applied — customer:', bundleCustomerId);
    } else {
      /* customer_email pre-fills the Checkout form for new customers */
      /* (not set here by default — left to Stripe to collect) */
    }

    line_items.forEach(function(item, i) {
      sessionParams.append(`line_items[${i}][price]`,    item.price);
      sessionParams.append(`line_items[${i}][quantity]`, String(item.quantity));
    });

    Object.entries(subMeta).forEach(function([key, value]) {
      sessionParams.append(`subscription_data[metadata][${key}]`, String(value ?? ''));
    });

    console.log('[create-checkout] Final line_items array:', JSON.stringify(line_items));
    console.log('[create-checkout] Creating Stripe session — line_items:', line_items.length, '| metadata keys:', Object.keys(subMeta).length);

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(STRIPE_SECRET_KEY + ':'),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: sessionParams.toString(),
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error('[create-checkout] Stripe API error status:', stripeRes.status);
      console.error('[create-checkout] Stripe API error body:', JSON.stringify(session));
      throw new Error(session.error ? session.error.message : `Stripe error ${stripeRes.status}`);
    }
    console.log('[create-checkout] Stripe session created successfully:', session.id);

    /* ── 5. Return Checkout Session URL ──────────────────────────────── */
    return jsonResponse({ url: session.url });

  } catch (err) {
    console.error('[create-checkout] Error:', err.message);
    return jsonResponse({ error: err.message }, 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': new URL(context.request.url).origin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}
