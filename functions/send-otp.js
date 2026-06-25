export async function onRequestPost(context) {
  const { request, env } = context;

  let mobile;
  try {
    const body = await request.json();
    mobile = (body.mobile || '').replace(/\D/g, '');
  } catch {
    return jsonResponse({ success: false, error: 'Invalid request body' }, 400);
  }

  if (!/^04\d{8}$/.test(mobile)) {
    return jsonResponse({ success: false, error: 'Invalid Australian mobile number' }, 400);
  }

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken  = env.TWILIO_AUTH_TOKEN;
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;

  if (!accountSid || !authToken || !serviceSid) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Server misconfiguration',
      debug: {
        hasAccountSid: !!accountSid,
        hasAuthToken: !!authToken,
        hasServiceSid: !!serviceSid,
        envKeys: Object.keys(env || {})
      }
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const e164 = '+61' + mobile.slice(1); // strip leading 0, prepend +61

  const twilioUrl = `https://verify.twilio.com/v2/Services/${serviceSid}/Verifications`;
  const credentials = btoa(`${accountSid}:${authToken}`);

  let twilioRes;
  try {
    twilioRes = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `To=${encodeURIComponent(e164)}&Channel=sms`,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: 'Failed to reach Twilio' }, 502);
  }

  if (!twilioRes.ok) {
    let msg = 'Failed to send code';
    try {
      const errBody = await twilioRes.json();
      if (errBody && errBody.message) msg = errBody.message;
    } catch {}
    return jsonResponse({ success: false, error: msg }, twilioRes.status >= 500 ? 502 : 400);
  }

  return jsonResponse({ success: true });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  return jsonResponse({ error: 'Method not allowed' }, 405);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
