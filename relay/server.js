/**
 * Prisoncall — VoipLine Authentication Relay
 *
 * WHY THIS EXISTS
 * VoipLine's login endpoint triggers CAPTCHA for Cloudflare datacenter IPs.
 * This relay runs on a non-Cloudflare IP (any VPS, Fly.io, Railway, etc.)
 * and performs the full login + TOTP 2FA flow on behalf of the Cloudflare
 * Worker. The Worker calls this service when the session expires; it returns
 * a fresh session cookie that the Worker stores in KV and uses immediately.
 *
 * ZERO DEPENDENCIES — requires only Node.js 18+.
 *
 * ENVIRONMENT VARIABLES (set as secrets on your hosting platform)
 *   RELAY_SECRET          — shared secret, must match AUTH_RELAY_SECRET in Worker
 *   VOIPLINE_EMAIL        — VoipLine portal email address
 *   VOIPLINE_PASSWORD     — VoipLine portal password
 *   VOIPLINE_TOTP_SECRET  — base32 TOTP secret from authenticator app setup
 *   PORT                  — (optional) HTTP port, defaults to 3000
 *
 * ENDPOINTS
 *   GET  /health         — liveness check (no auth required)
 *   POST /authenticate   — perform login + 2FA, returns { cookie }
 *                          requires: Authorization: Bearer <RELAY_SECRET>
 *
 * DEPLOYMENT (choose one)
 *   Fly.io:    see README in this directory
 *   Docker:    docker build -t voipline-relay . && docker run -p 3000:3000 --env-file .env voipline-relay
 *   Bare Node: node server.js   (with env vars exported)
 */

import { createServer }      from 'node:http';
import { createHmac }        from 'node:crypto';

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT                 = process.env.PORT                 || 3000;
const RELAY_SECRET         = process.env.RELAY_SECRET;
const VOIPLINE_EMAIL       = process.env.VOIPLINE_EMAIL;
const VOIPLINE_PASSWORD    = process.env.VOIPLINE_PASSWORD;
const VOIPLINE_TOTP_SECRET = process.env.VOIPLINE_TOTP_SECRET;
const VOIPLINE_BASE        = 'https://au.voipcloud.online';

// Fail fast at startup if any required variable is missing.
const REQUIRED = ['RELAY_SECRET', 'VOIPLINE_EMAIL', 'VOIPLINE_PASSWORD', 'VOIPLINE_TOTP_SECRET'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── TOTP — RFC 6238 (pure Node.js crypto, no external packages) ──────────────

function base32Decode(input) {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const str   = input.toUpperCase().replace(/[\s=]/g, '');
  const bytes = [];
  let bits = 0, value = 0;
  for (const char of str) {
    const idx = CHARS.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function generateTOTP() {
  const key      = base32Decode(VOIPLINE_TOTP_SECRET);
  const timeStep = Math.floor(Date.now() / 1000 / 30);
  const counter  = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(timeStep / 0x100000000), 0);
  counter.writeUInt32BE(timeStep >>> 0, 4);

  const hash   = createHmac('sha1', key).update(counter).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const code   = (
    ((hash[offset]     & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) <<  8) |
     (hash[offset + 3] & 0xff)
  ) % 1_000_000;

  return code.toString().padStart(6, '0');
}

// ─── Cookie extraction helpers ────────────────────────────────────────────────

/**
 * Returns all Set-Cookie header values as an array.
 * Node 18.14+ exposes getSetCookie(); earlier builds need the raw() shim.
 */
function getSetCookies(resp) {
  if (typeof resp.headers.getSetCookie === 'function') {
    return resp.headers.getSetCookie();
  }
  // Fallback for environments without getSetCookie
  const raw = resp.headers.raw?.()?.['set-cookie'];
  return Array.isArray(raw) ? raw : [];
}

/** Parses Set-Cookie header lines into a name→value map (attributes stripped). */
function parseSetCookies(lines) {
  const map = {};
  for (const line of lines) {
    const pair = line.split(';')[0].trim();
    const eq   = pair.indexOf('=');
    if (eq !== -1) map[pair.substring(0, eq)] = pair.substring(eq + 1);
  }
  return map;
}

// ─── VoipLine authentication flow ────────────────────────────────────────────

async function authenticate() {
  // ── Step 1: POST /api/customer/auth/login ────────────────────────────────
  const loginBody = JSON.stringify({ email: VOIPLINE_EMAIL, password: VOIPLINE_PASSWORD });

  let loginResp;
  try {
    loginResp = await fetch(`${VOIPLINE_BASE}/api/customer/auth/login`, {
      method : 'POST',
      headers: {
        'Content-Type'    : 'application/json',
        'Accept'          : 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: loginBody,
    });
  } catch (err) {
    throw new RelayError('login_network_error', err.message);
  }

  // A non-JSON response means CAPTCHA or an unexpected HTML page.
  const loginCT = loginResp.headers.get('Content-Type') || '';
  if (!loginCT.includes('application/json')) {
    const preview = (await loginResp.text()).substring(0, 400);
    throw new RelayError('login_non_json_response', `HTTP ${loginResp.status}: ${preview}`);
  }

  const loginText = await loginResp.text();
  try { JSON.parse(loginText); } catch {
    throw new RelayError('login_invalid_json', loginText.substring(0, 400));
  }

  if (loginResp.status >= 400) {
    throw new RelayError(`login_http_${loginResp.status}`, loginText.substring(0, 400));
  }

  // Carry any session cookies the login endpoint sets into the 2FA request.
  const loginSetCookies = getSetCookies(loginResp);
  const loginCookieStr  = loginSetCookies
    .map(sc => sc.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');

  console.log(`[auth] Login OK (${loginResp.status}) — ${loginSetCookies.length} Set-Cookie header(s).`);

  // ── Step 2: POST /api/customer/auth/2fa ──────────────────────────────────
  const totpCode = generateTOTP();

  let twoFaResp;
  try {
    twoFaResp = await fetch(`${VOIPLINE_BASE}/api/customer/auth/2fa`, {
      method : 'POST',
      headers: {
        'Content-Type'    : 'application/json',
        'Accept'          : 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(loginCookieStr ? { Cookie: loginCookieStr } : {}),
      },
      body: JSON.stringify({ code: totpCode }),
    });
  } catch (err) {
    throw new RelayError('2fa_network_error', err.message);
  }

  const twoFaSetCookies = getSetCookies(twoFaResp);
  const twoFaCookies    = parseSetCookies(twoFaSetCookies);

  console.log(`[auth] 2FA response ${twoFaResp.status} — cookies received: ${Object.keys(twoFaCookies).join(', ') || 'none'}`);

  if (!twoFaCookies['customer_token'] || !twoFaCookies['two_factor_auth_token']) {
    const body = await twoFaResp.text().catch(() => '');
    throw new RelayError(
      `2fa_no_cookies_http_${twoFaResp.status}`,
      body.substring(0, 400),
    );
  }

  const cookie = `customer_token=${twoFaCookies['customer_token']}; two_factor_auth_token=${twoFaCookies['two_factor_auth_token']}`;
  console.log('[auth] Authentication complete — fresh cookie obtained.');
  return cookie;
}

// ─── Custom error type ────────────────────────────────────────────────────────

class RelayError extends Error {
  constructor(code, detail = '') {
    super(code);
    this.code   = code;
    this.detail = detail;
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type'  : 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  // Health check — no auth, used by hosting platforms and Worker keep-alive
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, service: 'voipline-auth-relay' });
  }

  // Authentication endpoint
  if (req.method === 'POST' && req.url === '/authenticate') {
    const authHeader = (req.headers['authorization'] || '').trim();
    if (authHeader !== `Bearer ${RELAY_SECRET}`) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    console.log('[relay] Received authentication request.');

    try {
      const cookie = await authenticate();
      return sendJson(res, 200, { cookie });
    } catch (err) {
      const code   = err instanceof RelayError ? err.code   : 'internal_error';
      const detail = err instanceof RelayError ? err.detail : err.message;
      console.error(`[relay] Authentication failed — ${code}: ${detail}`);
      return sendJson(res, 502, { error: code, detail });
    }
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`[relay] VoipLine auth relay listening on port ${PORT}`);
});
