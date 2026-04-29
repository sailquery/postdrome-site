// /api/care/[id] — read-only caregiver share viewer
//
// Per CaregiverShareService.swift: the iOS app POSTs an aggregate snapshot
// to Supabase and returns a URL of the form
//   https://postdrome.app/care/<uuid>
// to the user. The user shares the URL with a doctor or family member.
//
// This endpoint:
//   1. Validates the id is a UUID.
//   2. Fetches the row from Supabase via the anon key.
//   3. Returns "this link has been revoked" if revoked_at is set.
//   4. Returns "this link has expired" if expires_at < now.
//   5. Otherwise renders a read-only HTML page from the snapshot payload.
//
// PRIVACY: the snapshot only contains aggregate counts + patterns — never
// raw events, notes, voice memos, or anything that could be linked back
// to specific timestamps. The trade-off is documented in the iOS file.

const SUPABASE_URL = 'https://mkvcnoxoqijkkxcunppz.supabase.co';
// Public anon key — safe in client/server code by Supabase design. Row-level
// security policies on care_snapshots restrict reads to non-revoked,
// non-expired rows. Env var override available for staging/test deploys.
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rdmNub3hvcWlqa2t4Y3VucHB6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MzUxMjksImV4cCI6MjA5MzAxMTEyOX0.Z9eD01ydm0a4I0lMrDIcTplpQyat_FVkpHSuSFEjyJM';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function handler(req, res) {
  const id = String(req.query.id || '').toLowerCase().trim();

  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Snapshots are aggregate, not PHI — but we still don't want them indexed.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  if (!UUID_RE.test(id)) {
    return res.status(400).send(renderError({
      title: 'Invalid link',
      body: `<p>This care-share link doesn't look right. Ask the person who shared it to generate a new one in postdrome → Settings → Share with caregiver.</p>`,
    }));
  }

  if (!SUPABASE_ANON_KEY) {
    return res.status(500).send(renderError({
      title: 'Care viewer not configured',
      body: `<p>The verifier hasn't been set up yet on this deploy. (Calvin: paste SUPABASE_ANON_KEY into Vercel env vars and redeploy.)</p>`,
    }));
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/care_snapshots?id=eq.${id}&select=id,payload,expires_at,revoked_at,created_at&limit=1`;
    const apiRes = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!apiRes.ok) {
      return res.status(502).send(renderError({
        title: 'Couldn\'t load this report',
        body: `<p>Try refreshing in a moment. If this persists, email <a href="mailto:support@sailquery.com">support@sailquery.com</a>.</p>`,
      }));
    }
    const rows = await apiRes.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).send(renderError({
        title: 'Link not found',
        body: `<p>This care-share link doesn't exist, or has been deleted by the person who created it.</p>`,
      }));
    }
    const row = rows[0];
    if (row.revoked_at) {
      return res.status(410).send(renderError({
        title: 'Link revoked',
        body: `<p>The person who shared this link has revoked it. Ask them to generate a new one if you still need it.</p>`,
      }));
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return res.status(410).send(renderError({
        title: 'Link expired',
        body: `<p>Care-share links expire after 30 days for safety. Ask the person who shared it to generate a fresh one in postdrome → Settings → Share with caregiver.</p>`,
      }));
    }
    return res.status(200).send(renderSnapshot(row.payload, row.created_at, row.expires_at));
  } catch (err) {
    return res.status(500).send(renderError({
      title: 'Something broke',
      body: `<p>Unexpected error. Email <a href="mailto:support@sailquery.com">support@sailquery.com</a> if this keeps happening.</p>`,
    }));
  }
}

function renderSnapshot(payload, createdAt, expiresAt) {
  const period = payload.periodDays || 90;
  const counts = `${payload.attackCount} attacks · ${payload.severeAttackCount} severe (8+) · ${payload.totalEvents} total events`;
  const avg = payload.avgAttackIntensity > 0 ? payload.avgAttackIntensity.toFixed(1) : '—';

  const patterns = (payload.topPatterns || []).map(p => `
    <div class="card">
      <div class="stars">${'★'.repeat(Math.max(1, p.stars))}${'☆'.repeat(Math.max(0, 4 - p.stars))}</div>
      <h3>${escapeHtml(p.label)}</h3>
      <p>${escapeHtml(p.detail)}</p>
    </div>
  `).join('') || `<p class="muted">Not enough data yet to surface patterns.</p>`;

  const rescues = (payload.rescueSummary || []).map(r => `
    <div class="card">
      <h3>${escapeHtml(r.medicationName)} <span class="tag">rescue</span></h3>
      <p>${r.attemptCount} attempts · worked within 2 hours: ${Math.round((r.workedWithin2hRate || 0) * 100)}%</p>
    </div>
  `).join('');

  const preventives = (payload.preventiveSummary || []).map(p => {
    const reduction = p.reductionPercent > 0
      ? `<span class="reduction">↓ ${Math.round(p.reductionPercent)}% reduction</span>`
      : `<span class="muted">No reduction yet</span>`;
    return `
      <div class="card">
        <h3>${escapeHtml(p.medicationName)} <span class="tag">preventive</span></h3>
        <p>Started ${new Date(p.startedAt).toLocaleDateString()}</p>
        <p>${p.preAvgDaysPerMonth.toFixed(1)} days/month before  →  ${p.postAvgDaysPerMonth.toFixed(1)} days/month after  ${reduction}</p>
      </div>
    `;
  }).join('');

  const treatmentBlock = (rescues || preventives)
    ? `${rescues}${preventives}`
    : `<p class="muted">No medication data has been logged.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>postdrome — caregiver report</title>
  <link rel="stylesheet" href="/styles.css">
  <style>
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 24px 0; }
    .summary-grid .stat { background: #f4f6f8; padding: 20px; border-radius: 12px; text-align: center; }
    .summary-grid .stat .num { font-size: 32px; font-weight: 700; color: #1a2734; display: block; }
    .summary-grid .stat .label { font-size: 13px; color: #6a7681; margin-top: 4px; }
    .card { background: #fff; border: 1px solid #e3e7ea; border-radius: 12px; padding: 16px 20px; margin-bottom: 12px; }
    .card h3 { margin: 0 0 8px 0; font-size: 16px; }
    .card p { margin: 4px 0; font-size: 14px; color: #4a5560; }
    .stars { color: #b8862e; font-size: 14px; margin-bottom: 4px; }
    .tag { display: inline-block; background: #e6edf1; color: #4a6b7a; font-size: 11px; padding: 2px 8px; border-radius: 8px; margin-left: 8px; vertical-align: middle; text-transform: uppercase; }
    .reduction { color: #2d7a4d; font-weight: 600; }
    .muted { color: #8a949e; font-style: italic; }
    .disclaimer { background: #fff8e6; border-left: 4px solid #b8862e; padding: 16px; border-radius: 6px; margin-top: 32px; font-size: 14px; line-height: 1.6; color: #5a4a1a; }
  </style>
</head>
<body>
<header class="hero" style="padding-bottom: 24px;">
  <nav>
    <div class="logo">postdrome</div>
    <div class="nav-links">
      <a href="/about">About postdrome</a>
    </div>
  </nav>
</header>
<main class="legal">
  <h1>Caregiver report</h1>
  <p class="meta">Last ${period} days · generated ${new Date(createdAt).toLocaleDateString()} · expires ${new Date(expiresAt).toLocaleDateString()}</p>

  <div class="summary-grid">
    <div class="stat">
      <span class="num">${payload.attackCount}</span>
      <div class="label">attacks (intensity 6+)</div>
    </div>
    <div class="stat">
      <span class="num">${payload.severeAttackCount}</span>
      <div class="label">severe (intensity 8+)</div>
    </div>
    <div class="stat">
      <span class="num">${avg}</span>
      <div class="label">avg attack intensity</div>
    </div>
    <div class="stat">
      <span class="num">${payload.totalEvents}</span>
      <div class="label">total events logged</div>
    </div>
  </div>

  <h2>Patterns</h2>
  ${patterns}

  <h2>Treatment</h2>
  ${treatmentBlock}

  <div class="disclaimer">
    <strong>About this report.</strong> postdrome is a self-tracking tool, not a medical device, and we are not a healthcare provider. This page shows aggregate counts and patterns the user chose to share with you — never raw events, notes, or voice memos. Nothing here is medical advice. Don't make treatment decisions based solely on this page; always consult a qualified clinician.
  </div>

  <p style="margin-top: 32px; font-size: 13px; color: #8a949e;">
    Built by <a href="https://postdrome.app">postdrome</a> · <a href="mailto:support@sailquery.com">support@sailquery.com</a>
  </p>
</main>
</body>
</html>`;
}

function renderError({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — postdrome</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="hero" style="padding-bottom: 24px;">
  <nav>
    <div class="logo"><a href="/">postdrome</a></div>
  </nav>
</header>
<main class="legal">
  <h1>${escapeHtml(title)}</h1>
  ${body}
  <p style="margin-top: 32px;"><a href="/">← Back to postdrome.app</a></p>
</main>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
