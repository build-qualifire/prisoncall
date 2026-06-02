/**
 * Prisoncall — VoipLine API Proxy (Cloudflare Worker)
 *
 * WHY THIS EXISTS
 * VoipLine's internal customer API (https://au.voipcloud.online/api/customer/*)
 * authenticates via browser SESSION COOKIE, not an API key. n8n cloud cannot hold
 * or send that cookie reliably, and VoipLine's login is gated by CAPTCHA + mandatory
 * TOTP 2FA, so programmatic login is impossible. This Worker holds the live session
 * cookie as an encrypted environment variable and forwards n8n's requests to VoipLine
 * exactly as a logged-in browser would.
 *
 * REQUEST CONTRACT (from n8n)
 *   Method:  POST (always — the Worker decides the upstream method from a header)
 *   Headers:
 *     X-Proxy-Secret:   shared secret, must equal env.VOIPLINE_PROXY_SECRET (else 401)
 *     X-VoipLine-Path:  the VoipLine path, e.g. /api/customer/core/balance
 *     X-VoipLine-Method: GET | POST | PUT  (the method used against VoipLine)
 *   Body: JSON body to forward (only used when X-VoipLine-Method is POST or PUT)
 *
 * UPSTREAM
 *   Forwards to https://au.voipcloud.online + X-VoipLine-Path
 *   with Cookie: <env.VOIPLINE_SESSION_COOKIE>
 *   Cookie format: customer_token=VALUE; two_factor_auth_token=VALUE
 *
 * ENVIRONMENT VARIABLES (set as encrypted Worker secrets / vars)
 *   VOIPLINE_SESSION_COOKIE  — full Cookie header value (both tokens)
 *   VOIPLINE_PROXY_SECRET    — shared secret, also configured in n8n
 *
 * REFRESHING THE COOKIE
 *   When the VoipLine session expires: log into VoipLine in a browser, copy the fresh
 *   customer_token and two_factor_auth_token from DevTools > Network, then update the
 *   VOIPLINE_SESSION_COOKIE Worker secret. No code change required.
 *
 * DEPLOYMENT
 *   This file is OUTSIDE the Cloudflare Pages output dir (prisoncall-v5), so it is NOT
 *   part of the static site deploy. Deploy it as a standalone Worker — see README-backend.md.
 *   It exports both a Worker `fetch` handler and a Pages-Functions `onRequest` handler,
 *   so it runs unmodified under either deployment model.
 */

const VOIPLINE_BASE = 'https://au.voipcloud.online';
const ALLOWED_METHODS = ['GET', 'POST', 'PUT'];

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleProxy(request, env) {
  // Health check / accidental browser hit.
  if (request.method === 'GET' && !request.headers.get('X-VoipLine-Path')) {
    return jsonResponse({ ok: true, service: 'voipline-proxy' }, 200);
  }

  // 1. Authenticate the caller (n8n) against the shared secret.
  const providedSecret = request.headers.get('X-Proxy-Secret');
  if (!env.VOIPLINE_PROXY_SECRET || providedSecret !== env.VOIPLINE_PROXY_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // 2. Read routing headers.
  const path = request.headers.get('X-VoipLine-Path');
  if (!path || !path.startsWith('/')) {
    return jsonResponse({ error: 'Missing or invalid X-VoipLine-Path header' }, 400);
  }

  let method = (request.headers.get('X-VoipLine-Method') || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) {
    return jsonResponse({ error: 'Invalid X-VoipLine-Method (allowed: GET, POST, PUT)' }, 400);
  }

  if (!env.VOIPLINE_SESSION_COOKIE) {
    return jsonResponse({ error: 'Worker not configured: VOIPLINE_SESSION_COOKIE missing' }, 500);
  }

  // 3. Build the upstream request to VoipLine.
  const upstreamHeaders = {
    'Cookie': env.VOIPLINE_SESSION_COOKIE,
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };

  const init = { method: method, headers: upstreamHeaders };

  if (method === 'POST' || method === 'PUT') {
    const incomingBody = await request.text();
    if (incomingBody && incomingBody.length > 0) {
      init.body = incomingBody;
      upstreamHeaders['Content-Type'] =
        request.headers.get('Content-Type') || 'application/json';
    }
  }

  // 4. Forward and relay the response back to n8n.
  let upstream;
  try {
    upstream = await fetch(VOIPLINE_BASE + path, init);
  } catch (err) {
    return jsonResponse({ error: 'Upstream request failed', detail: String(err) }, 502);
  }

  const responseBody = await upstream.text();
  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
    },
  });
}

// --- Standalone Worker entrypoint ---
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }
    return handleProxy(request, env);
  },
};

// --- Cloudflare Pages Functions entrypoint (same handler) ---
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  return handleProxy(request, env);
}
