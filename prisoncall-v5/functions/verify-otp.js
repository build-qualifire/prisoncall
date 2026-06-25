export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Invalid request body' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const mobile    = (body.mobile || '').replace(/\D/g, '');
  const cleanCode = (body.code   || '').replace(/\D/g, '');

  if (!/^04\d{8}$/.test(mobile)) {
    return new Response(JSON.stringify({ success: false, error: 'Invalid Australian mobile number' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!/^\d{6}$/.test(cleanCode)) {
    return new Response(JSON.stringify({ success: false, error: 'Invalid code format' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken  = env.TWILIO_AUTH_TOKEN;
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;

  if (!accountSid || !authToken || !serviceSid) {
    return new Response(JSON.stringify({ success: false, error: 'Server misconfiguration' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const e164 = '+61' + mobile.slice(1);

  try {
    const twilioRes = await fetch(
      'https://verify.twilio.com/v2/Services/' + serviceSid + '/VerificationCheck',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(accountSid + ':' + authToken),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'To=' + encodeURIComponent(e164) + '&Code=' + encodeURIComponent(cleanCode),
      }
    );

    const data = await twilioRes.json();

    if (data.code === 20404) {
      return new Response(JSON.stringify({ success: false, error: 'Code expired. Please request a new code.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!twilioRes.ok) {
      return new Response(JSON.stringify({ success: false, error: data.message || 'Verification failed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (data.status === 'approved') {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: false, error: 'Incorrect code. Please try again.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: 'Failed to reach Twilio' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}
