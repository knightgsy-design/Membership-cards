// Server side of the online version (public/index.html). Holds the Passcreator API key so it
// never reaches the browser, and reuses the same Passcreator logic as import.js.
//
// POST /api/passes  {"action": "status"}
//   -> {"templateName": "..."}      which template the site is set up to write to
// POST /api/passes  {"action": "run", "live": false|true, "members": [row, ...]}   (max 10 rows)
//   -> {"results": [{"memberNumber", "action", "reason"}, ...]}
// POST /api/passes  {"action": "list", "next": optional}     issued cards, 100 per page
//   -> {"cards": [...], "next": "..." | null}      uses GET /api/v3/pass with a query on the template
// POST /api/passes  {"action": "design"}     create or update the "GYC Membership TEST" card design (card-design.js)
//   -> {"templateId", "templateName", "created": bool, "warnings": [...]}
// POST /api/passes  {"action": "email", "memberNumber", "email"}
//   -> {"ok": true}      uses POST /api/pass/deliver/{userProvidedId}/email/{address} (V1 "Send a Pass via Email")
// Errors: {"error": "...", "fatal": true} when the whole run must stop (settings or key problem).
//
// Netlify site settings needed: PASSCREATOR_API_KEY, PASSCREATOR_TEMPLATE_ID.
// The site itself is password protected in Netlify, which covers this function too.

import cli from '../../import.js';
import design from '../../card-design.js';

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
  const d = list.find(t => t.name === design.DESIGN_NAME);
  return { name: t.name, designId: d ? d.identifier : null };
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
  if (s.status === 400) return { error: 'Passcreator refused to send it (HTTP 400). The usual reason is that this template has no "ad hoc" email template chosen in its sendout (email) settings in Passcreator.', link: pass.linkToPassPage || null, canMailto: true };
  if (s.error) return { error: `Passcreator didn't send it: ${s.error}`, link: pass.linkToPassPage || null, canMailto: true };
  return { ok: true };
}

function londonNow() {
  // Passcreator's publish date is in the account's timezone; the club is in Guernsey (UK time).
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const v2error = (r, what) => `${what} failed: ${r.error || (r.json && Array.isArray(r.json.errors) && r.json.errors.join('; ')) || 'unknown error'}`;

async function findDesignTemplate(client) {
  const l = await client.request('GET', '/api/pass-template');
  if (l.error) return { error: v2error(l, 'Listing templates') };
  return { existing: (Array.isArray(l.json) ? l.json : []).find(t => t.name === design.DESIGN_NAME) || null };
}

// Creates the design template, or (unless createOnly) updates it and publishes to existing cards.
export async function applyDesign(client, sourceTemplateId, { createOnly = false } = {}) {
  const f = await findDesignTemplate(client);
  if (f.error) return f;
  if (f.existing && createOnly) return { templateId: f.existing.identifier, templateName: design.DESIGN_NAME, created: false, skipped: true, warnings: [] };

  // Copy the certificate, images, wallet and email settings from the source (never from the design itself,
  // unless the site already points at it).
  const d = await client.request('GET', `/api/v2/pass-template/${encodeURIComponent(sourceTemplateId)}/describe`);
  if (d.error || !d.json || !d.json.data) return { error: v2error(d, 'Reading the current template') };
  const source = d.json.data;
  if (!source.passTypeId || !(source.images && source.images.icon)) return { error: 'the current template has no Apple pass certificate or icon to copy' };
  const body = design.buildTemplate(source);
  const warnings = design.designWarnings(source);

  if (!f.existing) {
    const c = await client.request('POST', '/api/v2/pass-template', body);
    if (c.error || !c.json || c.json.success === false || !c.json.data) return { error: v2error(c, 'Creating the template') };
    return { templateId: c.json.data.identifier, templateName: design.DESIGN_NAME, created: true, warnings };
  }
  const u = await client.request('POST', `/api/v2/pass-template/${encodeURIComponent(f.existing.identifier)}`, body);
  if (u.error || (u.json && u.json.success === false)) return { error: v2error(u, 'Updating the template') };
  const p = await client.request('POST', `/api/v2/pass-template/${encodeURIComponent(f.existing.identifier)}/publish`, { publicationDate: londonNow() });
  if (p.error) warnings.unshift(`The design was saved but not pushed to existing cards (${p.error}). Publish it in Passcreator.`);
  return { templateId: f.existing.identifier, templateName: design.DESIGN_NAME, created: false, warnings };
}

export function readSettings() {
  // Forgive common paste slips: the variable name pasted too, surrounding quotes, a "Bearer " prefix (Passcreator wants the bare key).
  const apiKey = (Netlify.env.get('PASSCREATOR_API_KEY') || '').trim().replace(/^PASSCREATOR_API_KEY\s*=\s*/i, '').replace(/^(['"])(.*)\1$/, '$2').replace(/^Bearer\s+/i, '').trim();
  const templateId = (Netlify.env.get('PASSCREATOR_TEMPLATE_ID') || '').trim();
  return { apiKey, templateId };
}

export default async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  const { apiKey, templateId } = readSettings();
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
      if (t.error) return fatal(502, `Passcreator: ${t.error}.`);
      const out = { templateName: t.name };
      if (t.name !== design.DESIGN_NAME && t.designId) out.designTemplate = { name: design.DESIGN_NAME, id: t.designId };
      return reply(200, out);
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

    if (body.action === 'design') {
      const r = await applyDesign(client, templateId);
      return r.error ? reply(502, { error: r.error }) : reply(200, r);
    }

    if (body.action === 'email') {
      const e = await emailCard(client, templateId, body.memberNumber, body.email);
      return e.error ? reply(400, e) : reply(200, { ok: true });
    }

    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    if (e instanceof FatalError) return fatal(502, e.message);
    throw e;
  }
};

export const config = { path: '/api/passes' };
