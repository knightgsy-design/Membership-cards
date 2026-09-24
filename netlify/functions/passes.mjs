// Server side of the online version (public/index.html). Holds the Passcreator API key so it
// never reaches the browser, and reuses the same Passcreator logic as import.js.
//
// POST /api/passes  {"action": "status"}
//   -> {"templateName": "..."}      which template the site is set up to write to
// POST /api/passes  {"action": "run", "live": false|true, "members": [row, ...]}   (max 10 rows)
//   -> {"results": [{"memberNumber", "action", "reason"}, ...]}
// POST /api/passes  {"action": "list", "next": optional}     issued cards, 100 per page
//   -> {"cards": [...], "next": "..." | null}      uses GET /api/v3/pass with a query on the template
// POST /api/passes  {"action": "email", "memberNumber", "email"}
//   -> {"ok": true}      uses POST /api/pass/deliver/{userProvidedId}/email/{address} (V1 "Send a Pass via Email")
// Errors: {"error": "...", "fatal": true} when the whole run must stop (settings or key problem).
//
// Netlify site settings needed: PASSCREATOR_API_KEY, PASSCREATOR_TEMPLATE_ID.
// The site itself is password protected in Netlify, which covers this function too.

import cli from '../../import.js';

const { validateRows, makeClient, processRow, FatalError, FIELD_KEYS } = cli;
const MAX_BATCH = 10;
const COLUMNS = ['memberNumber', 'memberName', 'email', 'membershipType', 'validTo', 'passExpiry', 'season'];

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fatal = (status, error) => reply(status, { error, fatal: true });

function cleanMember(m) {
  const row = {};
  for (const c of COLUMNS) row[c] = String((m && m[c]) ?? '').trim().slice(0, 200);
  return row;
}

async function templateName(client, templateId) {
  const r = await client.request('GET', '/api/pass-template');
  if (r.error) return { error: `couldn't read the template list from Passcreator (${r.error})` };
  const list = Array.isArray(r.json) ? r.json : [];
  const t = list.find(t => t.identifier === templateId);
  if (!t) {
    const seen = list.map(t => `"${t.name}" = ${t.identifier}`).join('; ') || 'none';
    return { error: `${templateId ? `the template ID "${templateId}" was not found` : 'PASSCREATOR_TEMPLATE_ID is not set'}. Templates this API key can see: ${seen}. Copy the right ID into PASSCREATOR_TEMPLATE_ID in the Netlify settings and redeploy` };
  }
  return { name: t.name };
}

const API_BASE = 'https://app.passcreator.com';
const EMAIL_RE = /^[^\s@\/]+@[^\s@\/]+\.[^\s@\/]+$/;

async function listCards(client, templateId, next) {
  let path;
  if (next) {
    // Only follow Passcreator's own "next page" links.
    if (typeof next !== 'string' || !next.startsWith(API_BASE + '/api/v3/pass')) return { error: 'bad page link' };
    path = next.slice(API_BASE.length);
  } else {
    // Every card this site makes has userProvidedId = member number, so "notEmpty" matches them all.
    const query = { templateId, groups: [[{ field: 'userProvidedId', operator: 'notEmpty', value: [] }]] };
    path = '/api/v3/pass?pageSize=100&formatKeyAdditionalProperties=name&query=' + Buffer.from(JSON.stringify(query)).toString('base64url');
  }
  const r = await client.request('GET', path);
  if (r.error) return { error: `couldn't list cards (${r.error})` };
  const data = (r.json && Array.isArray(r.json.data)) ? r.json.data : [];
  const cards = data.map(p => ({
    memberNumber: p.userProvidedId || p.barcodeValue || '',
    memberName: p[FIELD_KEYS.memberName] ?? '',
    validTo: p[FIELD_KEYS.validTo] ?? '',
    createdOn: p.createdOn || '',
    onApple: Number(p.noOfActiveRegistrationsAppleWallet) || 0,
    onGoogle: Number(p.noOfActiveRegistrationsGoogleWallet) || 0,
    onOther: (Number(p.noOfRegistrations) || 0) > 0,
    firstDownloadedAt: p.firstDownloadedAt || '',
    voided: Boolean(p.voided),
    link: p.linkToPassPage || '',
  }));
  return { cards, next: (r.json && r.json.page && r.json.page.next) || null, total: r.json && r.json.responseMetaData && r.json.responseMetaData.resultsTotal };
}

async function emailCard(client, templateId, memberNumber, email) {
  memberNumber = String(memberNumber || '').trim();
  email = String(email || '').trim();
  if (!memberNumber) return { error: 'no member number' };
  if (!EMAIL_RE.test(email)) return { error: `"${email}" doesn't look like an email address` };
  // Make sure the card is on our template before sending anything.
  const r = await client.request('GET', `/api/pass/${encodeURIComponent(memberNumber)}`);
  if (r.status === 404) return { error: `no card found for member ${memberNumber}` };
  if (r.error) return { error: `couldn't find the card (${r.error})` };
  const pass = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!pass || (pass.passTemplateGuid && pass.passTemplateGuid !== templateId)) return { error: 'that card is on a different template' };
  const s = await client.request('POST', `/api/pass/deliver/${encodeURIComponent(pass.identifier)}/email/${encodeURIComponent(email)}`);
  if (s.error) return { error: `Passcreator didn't send it: ${s.error}` };
  return { ok: true };
}

export default async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  // Forgive common paste slips: the variable name pasted too, surrounding quotes, a "Bearer " prefix (Passcreator wants the bare key).
  const apiKey = (Netlify.env.get('PASSCREATOR_API_KEY') || '').trim().replace(/^PASSCREATOR_API_KEY\s*=\s*/i, '').replace(/^(['"])(.*)\1$/, '$2').replace(/^Bearer\s+/i, '').trim();
  const templateId = (Netlify.env.get('PASSCREATOR_TEMPLATE_ID') || '').trim();
  if (!apiKey) return fatal(500, 'The site is not set up yet: PASSCREATOR_API_KEY must be set in the Netlify site settings.');

  let body;
  try { body = await req.json(); } catch { return reply(400, { error: 'Bad request' }); }
  // Without a template ID only "status" works, so it can list the templates to choose from.
  if (!templateId && body.action !== 'status') return fatal(500, 'PASSCREATOR_TEMPLATE_ID must be set in the Netlify site settings.');

  // Short retries here: a Netlify function has about 10 seconds. The page retries whole batches.
  const client = makeClient({ apiKey, retryDelays: [1000, 2000] });

  try {
    if (body.action === 'status') {
      const t = await templateName(client, templateId);
      return t.error ? fatal(502, `Passcreator: ${t.error}.`) : reply(200, { templateName: t.name });
    }

    if (body.action === 'run') {
      const members = Array.isArray(body.members) ? body.members : [];
      if (!members.length || members.length > MAX_BATCH) return reply(400, { error: `Send 1 to ${MAX_BATCH} members at a time.` });
      const live = body.live === true;
      const checked = validateRows(members.map(cleanMember), new Date().toISOString().slice(0, 10));
      const results = [];
      for (const { row, error } of checked) {
        const outcome = error ? { action: 'failed', reason: error } : await processRow(client, templateId, row, live);
        results.push({ memberNumber: row.memberNumber, ...outcome });
      }
      return reply(200, { results });
    }

    if (body.action === 'list') {
      const l = await listCards(client, templateId, body.next);
      return l.error ? reply(502, { error: l.error }) : reply(200, l);
    }

    if (body.action === 'email') {
      const e = await emailCard(client, templateId, body.memberNumber, body.email);
      return e.error ? reply(400, { error: e.error }) : reply(200, { ok: true });
    }

    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    if (e instanceof FatalError) return fatal(502, e.message);
    throw e;
  }
};

export const config = { path: '/api/passes' };
