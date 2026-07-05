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
    priceMap = {};
    products.forEach(p => {
      if (!p.product_key) return;
      /* In test mode use stripe_price_id_test; in live mode use stripe_price_id */
      const priceId = isTestMode ? p.stripe_price_id_test : p.stripe_price_id;
      if (priceId) priceMap[p.product_key] = priceId;
    });
    console.log('[create-checkout] Loaded', Object.keys(priceMap).length, 'price IDs from Supabase (mode:', isTestMode ? 'test' : 'live', ')');
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
    const line_items    = []; /* recurring prices — plan + recurring add-ons */
    const invoice_items = []; /* one-time prices — charged on first invoice only */
    const subMeta = {}; /* flattened for subscription_data[metadata][...] */

    plans.forEach(function(plan, idx) {
      /* Normalise field names — frontend currently sends plan_interval / mobile_number;
         spec uses plan_key / mobile. Accept either. */
      const interval         = plan.plan_key        || plan.plan_interval || '';
      const assigned_mobile  = plan.assigned_mobile || plan.mobile_number || plan.mobile || '';
      const prison   = plan.prison_name   || '';
      const state    = plan.prison_state  || '';
      /* Per-plan addons take priority; fall back to top-level body.addons */
      const addons   = plan.addons        || topLevelAddons;

      if (!interval) throw new Error(`Plan ${idx + 1} is missing plan_key / plan_interval`);

      /* Plan line item (always recurring) */
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
         STRIPE RULE: in mode=subscription, line_items must all be recurring prices.
         One-time prices (addon1, lifetimeAll) must go into subscription_data[invoice_items].

         SERVER-SIDE DEDUPLICATION:
         - If lifetimeAll selected → only charge lifetime (covers everything else)
         - If combo23 selected → only charge combo (covers addon2 + addon3)
         - addon2 and addon3 are never charged individually alongside combo23 */

      const addonProductKeys = {
        addon1:      { key: 'addon_48hr_cancel',            oneTime: true  },
        addon2:      { key: `addon_transfers_${interval}`,  oneTime: false },
        addon3:      { key: `addon_post_renewal_${interval}`, oneTime: false },
        combo23:     { key: `addon_combo23_${interval}`,    oneTime: false },
        lifetimeAll: { key: 'addon_lifetime',               oneTime: true  },
      };

      /* Build effective addon set — deduplicate per business rules */
      const effectiveAddons = {};
      if (addons.lifetimeAll) {
        /* Lifetime replaces everything */
        effectiveAddons.lifetimeAll = true;
      } else if (addons.combo23) {
        /* Bundle deal replaces individual addon2/addon3 */
        if (addons.addon1) effectiveAddons.addon1 = true;
        effectiveAddons.combo23 = true;
      } else {
        if (addons.addon1) effectiveAddons.addon1 = true;
        if (addons.addon2) effectiveAddons.addon2 = true;
        if (addons.addon3) effectiveAddons.addon3 = true;
      }

      Object.entries(addonProductKeys).forEach(function([addonKey, addonDef]) {
        if (!effectiveAddons[addonKey]) return;
        const addonPriceId = priceMap[addonDef.key];
        if (!addonPriceId) {
          throw new Error(isTestMode
            ? `Test price ID not configured for product: ${addonDef.key}. Add it in the admin portal Products page.`
            : `No Stripe price ID for product_key "${addonDef.key}" — check Supabase products table`
          );
        }
        /* Route to correct bucket: one-time → invoice_items, recurring → line_items */
        if (addonDef.oneTime) {
          invoice_items.push({ price: addonPriceId, quantity: 1 });
        } else {
          line_items.push({ price: addonPriceId, quantity: 1 });
        }
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

    /* ── 4. Create Stripe Checkout Session ───────────────────────────── */
    /* Stripe subscription mode supports mixing recurring + one-time line items.
       One-time prices are charged on the first invoice only. */
    const sessionParams = new URLSearchParams();
    sessionParams.append('mode',        'subscription');
    sessionParams.append('currency',    'aud');
    sessionParams.append('success_url', 'https://prisoncall.pages.dev/thank-you.html?session_id={CHECKOUT_SESSION_ID}');
    sessionParams.append('cancel_url',  'https://prisoncall.pages.dev/choose-plan');

    /* Recurring prices → line_items */
    line_items.forEach(function(item, i) {
      sessionParams.append(`line_items[${i}][price]`,    item.price);
      sessionParams.append(`line_items[${i}][quantity]`, String(item.quantity));
    });

    /* One-time prices → subscription_data[invoice_items] (charged on first invoice only) */
    invoice_items.forEach(function(item, i) {
      sessionParams.append(`subscription_data[invoice_items][${i}][price]`,    item.price);
      sessionParams.append(`subscription_data[invoice_items][${i}][quantity]`, String(item.quantity));
    });

    Object.entries(subMeta).forEach(function([key, value]) {
      sessionParams.append(`subscription_data[metadata][${key}]`, String(value ?? ''));
    });

    console.log('[create-checkout] Creating Stripe session — line_items:', line_items.length, '| invoice_items:', invoice_items.length, '| metadata keys:', Object.keys(subMeta).length);

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
      throw new Error(session.error ? session.error.message : `Stripe error ${stripeRes.status}`);
    }

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
