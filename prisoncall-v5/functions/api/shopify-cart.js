/**
 * Cloudflare Pages Function — POST /api/shopify-cart
 *
 * Receives cart line items built by doMainCheckout() in choose-plan.html,
 * calls Shopify Storefront API cartCreate, and returns the checkout URL.
 *
 * Required environment variables (set in Cloudflare Pages dashboard):
 *   SHOPIFY_STORE_DOMAIN            e.g. nq5ig1-5w.myshopify.com
 *   SHOPIFY_STOREFRONT_ACCESS_TOKEN  public Storefront API token
 *
 * Request body (JSON):
 *   {
 *     lineItems:     [ { merchandiseId, sellingPlanId?, quantity, attributes? } ],
 *     attributes:    [ { key, value } ],
 *     discountCodes: string[]
 *   }
 *
 * Response (JSON):
 *   Success: { success: true,  checkoutUrl: string }
 *   Failure: { success: false, error: string }
 */

const CART_CREATE_MUTATION = `
  mutation cartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart {
        id
        checkoutUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function onRequestPost(context) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const { lineItems, attributes, discountCodes } = await context.request.json();

    const STORE_DOMAIN  = context.env.SHOPIFY_STORE_DOMAIN;
    const ACCESS_TOKEN  = context.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;

    if (!STORE_DOMAIN || !ACCESS_TOKEN) {
      console.error('[shopify-cart] Missing environment variables');
      return new Response(
        JSON.stringify({ success: false, error: 'Server configuration error' }),
        { status: 500, headers: corsHeaders }
      );
    }

    const endpoint = `https://${STORE_DOMAIN}/api/2025-04/graphql.json`;

    const shopifyRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': ACCESS_TOKEN,
      },
      body: JSON.stringify({
        query: CART_CREATE_MUTATION,
        variables: {
          input: {
            lines:         lineItems,
            attributes:    attributes    || [],
            discountCodes: discountCodes || [],
          },
        },
      }),
    });

    if (!shopifyRes.ok) {
      console.error('[shopify-cart] Shopify returned HTTP', shopifyRes.status);
      return new Response(
        JSON.stringify({ success: false, error: 'Shopify API error: ' + shopifyRes.status }),
        { status: 502, headers: corsHeaders }
      );
    }

    const shopifyData = await shopifyRes.json();

    /* Surface any GraphQL-level errors */
    if (shopifyData.errors && shopifyData.errors.length > 0) {
      const msg = shopifyData.errors.map(function(e) { return e.message; }).join('; ');
      console.error('[shopify-cart] GraphQL errors:', msg);
      return new Response(
        JSON.stringify({ success: false, error: msg }),
        { status: 422, headers: corsHeaders }
      );
    }

    const cartCreate = shopifyData.data && shopifyData.data.cartCreate;

    if (!cartCreate) {
      return new Response(
        JSON.stringify({ success: false, error: 'Cart creation failed — no cartCreate in response' }),
        { status: 500, headers: corsHeaders }
      );
    }

    /* Surface Shopify userErrors (e.g. invalid variant, bad selling plan) */
    if (cartCreate.userErrors && cartCreate.userErrors.length > 0) {
      const msg = cartCreate.userErrors.map(function(e) {
        return (e.field ? e.field.join('.') + ': ' : '') + e.message;
      }).join('; ');
      console.error('[shopify-cart] userErrors:', msg);
      return new Response(
        JSON.stringify({ success: false, error: msg }),
        { status: 422, headers: corsHeaders }
      );
    }

    const checkoutUrl = cartCreate.cart && cartCreate.cart.checkoutUrl;

    if (!checkoutUrl) {
      return new Response(
        JSON.stringify({ success: false, error: 'Cart created but no checkoutUrl returned' }),
        { status: 500, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({ success: true, checkoutUrl: checkoutUrl }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    console.error('[shopify-cart] Unhandled error:', err && err.message ? err.message : String(err));
    return new Response(
      JSON.stringify({ success: false, error: 'Network error' }),
      { status: 500, headers: corsHeaders }
    );
  }
}

/* Handle pre-flight CORS requests */
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
