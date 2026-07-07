// Routes GET /portal/verify-checkout to the verify-magic-link-checkout handler.
// Cloudflare Pages picks up this file as the function for /portal/verify-checkout.

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const token = url.searchParams.get('token') || '';
  const dest = `${url.origin}/api/verify-magic-link-checkout?token=${encodeURIComponent(token)}`;
  return Response.redirect(dest, 302);
}
