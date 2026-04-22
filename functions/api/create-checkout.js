export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': new URL(request.url).origin,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { plans } = body;
  if (!Array.isArray(plans) || plans.length === 0) {
    return new Response(JSON.stringify({ error: 'plans must be a non-empty array' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const intervalPriceMap = {
    weekly:      env.STRIPE_PRICE_WEEKLY,
    fortnightly: env.STRIPE_PRICE_FORTNIGHTLY,
    monthly:     env.STRIPE_PRICE_MONTHLY,
    quarterly:   env.STRIPE_PRICE_QUARTERLY,
  };

  try {
    const origin = new URL(request.url).origin;
    const isBundle = plans.some(function(p) { return p.bundle === true; });

    const line_items = plans.map(function(plan) {
      const priceId = intervalPriceMap[plan.plan_interval];
      if (!priceId) throw new Error('Unknown plan_interval: ' + plan.plan_interval);
      return { price: priceId, quantity: 1 };
    });

    const metadata = {
      bundle: String(isBundle),
      plan_count: String(plans.length),
    };
    plans.forEach(function(plan, i) {
      const n = i + 1;
      metadata['plan_' + n + '_prison']   = plan.prison_name;
      metadata['plan_' + n + '_state']    = plan.prison_state;
      metadata['plan_' + n + '_mobile']   = plan.mobile_number;
      metadata['plan_' + n + '_interval'] = plan.plan_interval;
    });

    const sessionParams = new URLSearchParams();
    sessionParams.append('mode', 'subscription');
    sessionParams.append('currency', 'aud');
    sessionParams.append('success_url', origin + '/thank-you.html?session_id={CHECKOUT_SESSION_ID}');
    sessionParams.append('cancel_url', origin + '/choose-plan.html');

    line_items.forEach(function(item, i) {
      sessionParams.append('line_items[' + i + '][price]', item.price);
      sessionParams.append('line_items[' + i + '][quantity]', String(item.quantity));
    });

    Object.entries(metadata).forEach(function([key, value]) {
      sessionParams.append('metadata[' + key + ']', value);
    });

    if (isBundle && env.STRIPE_BUNDLE_COUPON_ID) {
      sessionParams.append('discounts[0][coupon]', env.STRIPE_BUNDLE_COUPON_ID);
    }

    console.log('Stripe session params:', sessionParams.toString());
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(env.STRIPE_SECRET_KEY + ':'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: sessionParams.toString(),
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      throw new Error(session.error ? session.error.message : 'Stripe error ' + stripeRes.status);
    }

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Stripe API error:', err.message, JSON.stringify(err));
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
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
