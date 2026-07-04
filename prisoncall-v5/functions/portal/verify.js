// Routes GET /portal/verify?token=xxx to the verify-magic-link handler.
// Cloudflare Pages picks up this file as the function for /portal/verify.

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const token = url.searchParams.get('token') || '';
  const dest = `${url.origin}/api/verify-magic-link?token=${encodeURIComponent(token)}`;
  return Response.redirect(dest, 302);
}
