export async function onRequestPost(context) {
  const { request, env } = context;

  let mobile, cleanCode;
  try {
    const body = await request.json();
    mobile    = (body.mobile || '').replace(/\D/g, '');
    cleanCode = (body.code   || '').replace(/\D/g, '');
  } catch {
    return jsonResponse({ success: false, error: 'Invalid request body' }, 400);
  }

  if (!/^04\d{8}$/.test(mobile)) {
    return jsonResponse({ success: false, error: 'Invalid Australian mobile number' }, 400);
  }
  if (!/^\d{6}$/.test(cleanCode)) {
    return jsonResponse({ success: false, error: 'Invalid code format' }, 400);
  }

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken  = env.TWILIO_AUTH_TOKEN;
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;

  if (!accountSid || !authToken || !serviceSid) {
    return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);
  }

  const e164 = '+61' + mobile.slice(1); // strip leading 0, prepend +61

  const twilioUrl = `https://verify.twilio.com/v2/Services/${serviceSid}/VerificationChecks`;
  const credentials = btoa(`${accountSid}:${authToken}`);

  let twilioRes;
  try {
    twilioRes = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `To=${encodeURIComponent(e164)}&Code=${encodeURIComponent(cleanCode)}`,
    });
  } catch {
    return jsonResponse({ success: false, error: 'Failed to reach Twilio' }, 502);
  }

  let twilioData;
  try {
    twilioData = await twilioRes.json();
  } catch {
    return jsonResponse({ success: false, error: 'Incorrect code. Please try again.' });
  }

  // Twilio 20404 means no pending verification exists (expired or already consumed)
  if (twilioRes.status === 404 || (twilioData && twilioData.code === 20404)) {
    return jsonResponse({ success: false, error: 'Code expired. Please request a new code.' });
  }

  if (twilioData && twilioData.status === 'approved') {
    return jsonResponse({ success: true });
  }

  return jsonResponse({ success: false, error: 'Incorrect code. Please try again.' });
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
