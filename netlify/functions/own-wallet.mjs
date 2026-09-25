// Own-wallet system: issues and updates GYC membership cards directly on Apple Wallet and Google
// Wallet, using the club's own Apple Developer and Google Cloud accounts. No Passcreator involved —
// see own-wallet/README.md for what this needs and what it costs compared to Passcreator.
//
// POST /api/own-wallet  {"action": "status"}
//   -> {"apple": {"ready": bool, "push": bool}, "google": {"ready": bool}}
// POST /api/own-wallet  {"action": "run", "live": false|true, "members": [row, ...]}   (max 10 rows)
//   -> {"results": [{"memberNumber", "action", "reason"}, ...]}
// POST /api/own-wallet  {"action": "list"}
//   -> {"members": [...]}
// POST /api/own-wallet  {"action": "delete", "memberNumber"}
//   -> {"ok": true}
// POST /api/own-wallet  {"action": "links", "memberNumber"}
//   -> {"appleUrl": "...", "googleUrl": "..." | null}
'use strict';

import cli from '../../import.js';
import configLib from '../../own-wallet/lib/config.js';
import passRecord from '../../own-wallet/lib/passRecord.js';
import store from '../../own-wallet/lib/store.js';
import imagesLib from '../../own-wallet/lib/images.js';
import googleWallet from '../../own-wallet/lib/googleWallet.js';

const { validateRows } = cli;
const { readConfig, appleReady, applePushReady, googleReady } = configLib;
const MAX_BATCH = 10;
const COLUMNS = ['memberNumber', 'memberName', 'email', 'membershipType', 'validTo', 'passExpiry', 'season'];

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function cleanMember(m) {
  const row = {};
  for (const c of COLUMNS) row[c] = String((m && m[c]) ?? '').trim().slice(0, 200);
  return row;
}

// Everything except "status" touches member data, so it needs the site passphrase (set
// OWN_WALLET_PASSPHRASE in the Netlify site settings; the page asks for it once and remembers it).
// This site is deliberately NOT put behind Netlify's own site password, because the PassKit web
// service and the pass-download link must stay reachable by members' phones and Apple's servers.
function passphraseOk(req) {
  const want = (Netlify.env.get('OWN_WALLET_PASSPHRASE') || '').trim();
  if (!want) return false;
  const got = req.headers.get('x-own-wallet-passphrase') || '';
  return got === want;
}

export default async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });
  let body;
  try { body = await req.json(); } catch { return reply(400, { error: 'Bad request' }); }

  const config = readConfig(Netlify.env);
  const apple = { ready: appleReady(config), push: applePushReady(config) };
  const google = { ready: googleReady(config) };

  if (body.action === 'status') {
    // Only report "unlocked" when a passphrase was actually sent and it matched — the page uses this
    // to decide whether to show the form. Without a header, this stays undefined either way, so a page
    // load (before the user has typed anything) never reads as "wrong".
    const out = { apple, google, webServiceBase: config.apple.webServiceBase, passphraseSet: Boolean((Netlify.env.get('OWN_WALLET_PASSPHRASE') || '').trim()) };
    if (req.headers.get('x-own-wallet-passphrase')) out.unlocked = passphraseOk(req);
    return reply(200, out);
  }

  if (!passphraseOk(req)) {
    return reply(401, { error: (Netlify.env.get('OWN_WALLET_PASSPHRASE') || '').trim() ? 'Wrong passphrase.' : 'OWN_WALLET_PASSPHRASE is not set in the Netlify site settings yet, so this site is locked. See own-wallet/README.md.' });
  }

  if (!apple.ready && !google.ready) {
    return reply(500, { error: 'Neither Apple Wallet nor Google Wallet is set up yet. See own-wallet/README.md and set the environment variables in the Netlify site settings.' });
  }

  if (body.action === 'run') {
    const members = Array.isArray(body.members) ? body.members : [];
    if (!members.length || members.length > MAX_BATCH) return reply(400, { error: `Send 1 to ${MAX_BATCH} members at a time.` });
    const live = body.live === true;
    const checked = validateRows(members.map(cleanMember), new Date().toISOString().slice(0, 10));
    const results = [];
    for (const { row, error } of checked) {
      if (error) { results.push({ memberNumber: row.memberNumber, action: 'failed', reason: error }); continue; }
      if (!live) { results.push({ memberNumber: row.memberNumber, action: 'would create/update', reason: 'checked, nothing changed yet' }); continue; }
      const r = await passRecord.upsert(row, config, imagesLib.appleImages(config)).catch(e => ({ action: 'failed', reason: e.message }));
      results.push({ memberNumber: row.memberNumber, ...r });
    }
    return reply(200, { results });
  }

  if (body.action === 'list') {
    let members;
    try { members = await store.listMembers(); } catch (e) { return reply(502, { error: `couldn't list members: ${e.message}` }); }
    members.sort((a, b) => a.memberNumber.localeCompare(b.memberNumber));
    return reply(200, { members: members.map(m => ({ memberNumber: m.memberNumber, memberName: m.memberName, membershipType: m.membershipType, validTo: m.validTo, season: m.season, email: m.email, createdOn: m.createdOn, modifiedOn: m.modifiedOn, apple: Boolean(m.apple), google: Boolean(m.google) })) });
  }

  if (body.action === 'delete') {
    const r = await passRecord.remove(String(body.memberNumber || '').trim(), config).catch(e => ({ action: 'failed', reason: e.message }));
    return r.action === 'failed' ? reply(400, { error: r.reason }) : reply(200, { ok: true });
  }

  if (body.action === 'links') {
    const memberNumber = String(body.memberNumber || '').trim();
    const record = await store.getMember(memberNumber);
    if (!record) return reply(404, { error: 'no card for that member' });
    const out = {};
    if (apple.ready) out.appleUrl = `${config.apple.webServiceBase.replace(/\/$/, '')}/.netlify/functions/apple-pkpass?member=${encodeURIComponent(memberNumber)}`;
    if (google.ready) out.googleUrl = googleWallet.saveLink(record, config);
    return reply(200, out);
  }

  return reply(400, { error: 'Unknown action' });
};

export const config = { path: '/api/own-wallet' };
