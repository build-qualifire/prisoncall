# Prisoncall — Backend Automation Layer

Backend automation for Prisoncall Australia: a Cloudflare Worker that proxies VoipLine's
internal API, plus n8n Workflows 1–7. This is the Phase 1C backend build.

> The website (`prisoncall-v5/`) is **finalised**. Nothing in this build touches the static
> site, its pages, styles, assets, or the existing Pages Functions under `functions/api/`.
> The Worker lives at `functions/voipline-proxy.js`, **outside** the Pages output directory
> (`prisoncall-v5/`), so it is **not** part of the static-site deploy.

## What's here

| File | Purpose |
| --- | --- |
| `functions/voipline-proxy.js` | Cloudflare Worker — proxies all VoipLine API calls (session-cookie auth) |
| `n8n-workflows/workflow-1-new-subscriber.json` | New subscriber provisioning (Path A / B / C) |
| `n8n-workflows/workflow-2-payment-failure-cancellation.json` | Payment failure, cancellation, recovery |
| `n8n-workflows/workflow-3-did-change.json` | DID change / prison transfer (15-day overlap) |
| `n8n-workflows/workflow-4-voipline-email-monitor.json` | Watches voipline@ inbox for Request Numbers replies |
| `n8n-workflows/workflow-5-monthly-admin.json` | Monthly subscriber + MRR summary |
| `n8n-workflows/workflow-6-support-enquiry.json` | Retention coupon + Claude AI auto-reply |
| `n8n-workflows/workflow-7-sip-capacity-monitor.json` | Hourly SIP channel capacity advisory |

---

## Architecture in one line

```
Stripe / Portal / Contact form ─▶ n8n (build-qualifire.app.n8n.cloud, PRISONCALL folder)
        │
        ├─ VoipLine calls ─▶ Cloudflare Worker proxy ─▶ https://au.voipcloud.online  (session cookie)
        ├─ 3CX calls ─▶ MOCKED during this build (return success)
        ├─ SMS ─▶ ClickSend
        ├─ Email ─▶ Microsoft Outlook (voipline@prisoncall.com.au)
        └─ AI ─▶ Anthropic Claude (Workflow 6)
```

**Why the proxy:** VoipLine's `/api/customer/*` endpoints authenticate with a browser
session cookie. n8n cloud cannot hold/send that cookie reliably, and VoipLine login is
gated by CAPTCHA + mandatory TOTP 2FA. The Worker holds the live cookie as an encrypted
secret and forwards n8n's requests as a logged-in browser would.

---

## Part 1 — Deploy the Cloudflare Worker

The Worker is a standard module Worker (it also exports a Pages-Functions `onRequest`
handler, so it runs unmodified either way). Deploy it as a **standalone Worker**.

### 1. Deploy with Wrangler

```bash
# from the repo root
npx wrangler deploy functions/voipline-proxy.js \
  --name voipline-proxy \
  --compatibility-date 2024-11-01
```

### 2. Set the two secrets

```bash
# Full Cookie header value, both tokens, in this exact format:
#   customer_token=VALUE; two_factor_auth_token=VALUE
npx wrangler secret put VOIPLINE_SESSION_COOKIE --name voipline-proxy

# Shared secret between the Worker and n8n (any long random string)
npx wrangler secret put VOIPLINE_PROXY_SECRET --name voipline-proxy
```

### 3. Map the route

Point a route at the Worker so n8n can reach it at the expected URL:

```
https://workers.prisoncall.com.au/voipline-proxy
```

In the Cloudflare dashboard: **Workers & Pages → voipline-proxy → Settings → Domains & Routes**,
add a custom domain/route on the `prisoncall.com.au` zone (e.g. the `workers` subdomain).

### 4. Smoke test

```bash
# Wrong/missing secret -> 401
curl -s -X POST https://workers.prisoncall.com.au/voipline-proxy \
  -H "X-VoipLine-Path: /api/customer/core/balance" -H "X-VoipLine-Method: GET"

# Correct secret -> forwards to VoipLine and relays the response
curl -s -X POST https://workers.prisoncall.com.au/voipline-proxy \
  -H "X-Proxy-Secret: <VOIPLINE_PROXY_SECRET>" \
  -H "X-VoipLine-Path: /api/customer/core/balance" \
  -H "X-VoipLine-Method: GET"
```

### Worker request contract

| Header | Required | Notes |
| --- | --- | --- |
| `X-Proxy-Secret` | yes | Must equal `VOIPLINE_PROXY_SECRET`, else `401` |
| `X-VoipLine-Path` | yes | e.g. `/api/customer/core/balance` (must start with `/`) |
| `X-VoipLine-Method` | yes | `GET`, `POST`, or `PUT` |
| Body | POST/PUT only | JSON, forwarded verbatim |

### Refreshing the session cookie (~2 min, no code change)

When VoipLine logs out / the session expires:
1. Log into VoipLine in a browser.
2. DevTools → Network → copy fresh `customer_token` and `two_factor_auth_token`.
3. `npx wrangler secret put VOIPLINE_SESSION_COOKIE --name voipline-proxy` and paste the new
   `customer_token=...; two_factor_auth_token=...` value.

---

## Part 2 — Import the n8n workflows

In n8n cloud (`build-qualifire.app.n8n.cloud`), **PRISONCALL folder only — never touch QUALIFIRE**:

1. **Workflows → Import from File** for each `n8n-workflows/*.json`.
2. Build order matters: import **1 + 4 together first** (tightly coupled), then **2**, then **3**,
   then **5, 6, 7**.
3. Set credentials and environment variables (below).
4. Keep all workflows **inactive** until live integration; the Stripe keys are still in TEST mode.

### Credentials to create in n8n

| Credential | Used by | Notes |
| --- | --- | --- |
| Microsoft Outlook OAuth2 | WF1, WF3, WF4, WF5, WF6 | Connect the `voipline@prisoncall.com.au` mailbox. After import, open each Outlook node and select this credential (placeholder id `REPLACE_OUTLOOK_CRED`). |

Everything else (VoipLine via proxy, ClickSend, Stripe, Anthropic) is called from **Code nodes
using environment variables** — no stored credential needed.

### Environment variables to set in n8n

| Variable | Value / source |
| --- | --- |
| `VOIPLINE_PROXY_SECRET` | Same shared secret set on the Worker |
| `STRIPE_SECRET_KEY` | Stripe secret key (TEST mode for now; swap to live at go-live) |
| `CLICKSEND_USERNAME` | ClickSend account username |
| `CLICKSEND_API_KEY` | ClickSend API key |
| `CLICKSEND_DEDICATED_NUMBER` | ClickSend dedicated AU number (two-way SMS — support, reminders, owner alerts) |
| `ANTHROPIC_API_KEY` | Anthropic API key (Workflow 6) |
| `OWNER_MOBILE` | `+61413598815` |
| `OWNER_EMAIL` | `guness@prisoncall.com.au` |

> `CLICKSEND_DEDICATED_NUMBER` is required in addition to the variables in the brief: the
> `PRISONCALL` alphanumeric sender is **one-way** (order confirmations only, per the handoff),
> so every two-way / owner-alert / reminder SMS sends from the dedicated number instead.

### Register Stripe webhooks (after workflows imported)

Point Stripe webhooks at the n8n production webhook URLs:

| n8n webhook path | Stripe events |
| --- | --- |
| `/webhook/new-subscriber` (WF1) | `checkout.session.completed` |
| `/webhook/stripe-billing` (WF2) | `invoice.payment_failed`, `invoice.payment_succeeded`, `customer.subscription.deleted` |

(WF3 `/webhook/did-change` and WF6 `/webhook/contact-form` are called by the customer portal
and the website contact form respectively.)

---

## How each workflow works

### WF1 — New Subscriber  (`checkout.session.completed`)
Extract checkout data → Prison DID Lookup (embedded `Prison_DID_Lookup_v3_0` table) → order a DID
via the proxy trying **primary → fallback_1 → fallback_2 → fallback_3** in order.
- **Path A** (DID found): mock 3CX setup → ClickSend confirmation (sender `PRISONCALL`) → Outlook email.
- **Path B** (all exchanges out of stock): submit Request Numbers → notify owner → WF4 watches the
  inbox; 24h with no response → owner alert + pause.
- **Path C** (bundle / existing-customer second plan): **placeholder only** — the bundle flag is
  captured; full handling builds after the sign-in flow.

### WF2 — Payment Failure / Cancellation
Grace periods: **Weekly 1d, Fortnightly 2d, Monthly 3d, Quarterly 5d.**
- `invoice.payment_failed`: mock pause 3CX → SMS → daily reminder loop until grace ends → mock
  delete 3CX → release DID (**2-step**) → cancel Stripe subscription.
- `customer.subscription.deleted`: mock pause → SMS (5-day reactivation) → wait 5 days → mock delete
  3CX → release DID (2-step).
- `invoice.payment_succeeded` after a failure: mock re-enable 3CX → SMS "active again".

### WF3 — DID Change / Prison Transfer
Order the new DID (same logic as WF1) → mock-add to the existing extension → **Day 0** both DIDs
live → **Day 14** SMS + email to confirm → **Day 15** mock remove old DID + release old DID (2-step).
The **15-day overlap is non-negotiable**.

### WF4 — VoipLine Email Monitor
Outlook trigger polls `voipline@` every 5 minutes. Confirmation email → extract DID → resume WF1
Path B from 3CX setup → notify owner. Counter-suggestion → auto-reply accepting → keep monitoring.
(24h-no-response alert lives in WF1 Path B; WF1 + WF4 are tightly coupled.)

### WF5 — Monthly Admin
1st of each month, 08:00 Australia/Sydney. Lists active Stripe subscriptions, counts by plan,
computes MRR → SMS owner + email owner (with a fixed-cost verification reminder).

### WF6 — Support Enquiry
Contact-form webhook. Retention keywords (`cancel, cancelling, leaving, switching, cheaper,
competitor, too expensive, not worth`) → apply `10%_LOYALTY` coupon `keZywUSF` via Stripe → loyalty
SMS → flag owner. Otherwise Claude (`claude-sonnet-4-20250514`) answers from the KB: high confidence
→ auto-reply email; low confidence → flag owner.

### WF7 — SIP Channel Capacity Monitor
Hourly. Balance/channel usage via the proxy. `>= 3` concurrent (>75% of 4) → scale-up advisory SMS;
`< 2` (<50%) → scale-down-possible advisory. **Never auto-purchases** — owner decision only.

---

## Mocks & assumptions to revisit at live integration (Phase 1C connect)

These are intentional, clearly commented in the Code nodes, and consistent with the handoff:

1. **All 3CX calls are mocked** and return success. Replace the `Mock 3CX …` Code nodes with real
   3CX REST calls once the PBX is purchased (confirm endpoints via DevTools per the spec).
2. **3CX extension numbering** is mocked at `103`. Live integration should query 3CX for the next
   free extension.
3. **VoipLine response field names** (`id`, `number`, `order_id`, balance/channel usage) are mapped
   defensively in the DID-ordering and capacity Code nodes — confirm against live responses.
4. **Request Numbers** uses `POST /api/customer/numbers/request` with `{quantity, prefix, postcode}`.
   Confirm the exact path/body with VoipLine. **Postcodes are still outstanding** in the DID lookup
   (per the handoff) — `request_postcode` is currently empty.
5. **Subscriber correlation** (mobile / email / VoipLine order+number ids) for WF2/WF3/WF4 should be
   read from a persistent store (n8n Data Table / DB) keyed by Stripe subscription id. Where missing,
   the workflows fall back to owner alerts and log a clear reason.
6. **WF7 de-duplication**: persist the last advisory and only send on change to avoid hourly repeats.

## Guardrails honoured

- No existing site/page/style/asset/Pages-Function modified.
- No credentials or secrets hardcoded — everything via env vars / Worker secrets.
- All VoipLine calls go through the Worker proxy; none call VoipLine directly.
- All 3CX calls mocked; no live 3CX calls.
- DID release is always the **2-step** sequence (remove from PBX first, then release).
