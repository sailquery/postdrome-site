// /api/subscribe — host-site Vercel Edge function.
//
// PURPOSE
// Add a contact's email to the Postdrome — Beta Waitlist Resend audience.
// Called by the inline form rendered into every article by SQMarketer's
// publish-to-site agent. The form posts JSON: { email, source } where
// `source` is the article slug that drove the signup.
//
// SAFETY
// Treats already-subscribed (Resend 422 / "already exists") as success
// so retries don't surface as errors to the user. Never returns the
// upstream Resend error body to the client (avoids leaking API state).
//
// Source: SQMarketer/docs/handoffs/templates/subscribe-api.template.ts
// Handoff: SQMarketer/docs/handoffs/postdrome-subscribe-api.md

export const config = { runtime: "edge" };

const AUDIENCE_ID = "94a47f5f-c686-47a5-b087-e3f9f51d2fb4";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[subscribe] RESEND_API_KEY missing in env");
    return json({ error: "server misconfigured" }, 500);
  }

  let body: { email?: unknown; source?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const source =
    typeof body.source === "string" ? body.source.trim().slice(0, 200) : "";

  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: "invalid email" }, 400);
  }

  const resp = await fetch(
    `https://api.resend.com/audiences/${AUDIENCE_ID}/contacts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, unsubscribed: false }),
    },
  );

  if (resp.ok) {
    console.log(`[subscribe] added ${email} (source=${source})`);
    return json({ ok: true }, 200);
  }

  const text = await resp.text().catch(() => "");
  if (resp.status === 422 || /already.*exist/i.test(text)) {
    console.log(`[subscribe] already-subscribed ${email}`);
    return json({ ok: true, note: "already subscribed" }, 200);
  }

  console.error(`[subscribe] resend ${resp.status}: ${text.slice(0, 200)}`);
  return json({ error: "subscribe failed" }, 500);
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
