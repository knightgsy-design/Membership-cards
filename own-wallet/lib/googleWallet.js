// Issues and updates membership cards directly on Google Wallet, using the club's own Google Cloud
// service account — no third party involved. API reference:
// https://developers.google.com/wallet/generic/rest/v1/genericclass
// https://developers.google.com/wallet/generic/rest/v1/genericobject
// https://developers.google.com/wallet/generic/use-cases/jwt  (save link)
'use strict';

const jwt = require('jsonwebtoken');

const API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
const COLOR = '#13294B';

function classId(config) { return `${config.google.issuerId}.${config.google.classSuffix}`; }
function objectId(config, memberNumber) {
  // Google requires the object id to start with the class's issuer id and use only [A-Za-z0-9._-].
  return `${config.google.issuerId}.member_${String(memberNumber).replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

// ---- auth: exchange the service account key for a short-lived OAuth access token ----

let cachedToken = null;

async function getAccessToken(config, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  if (cachedToken && cachedToken.expires > Date.now() + 5000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: config.google.serviceAccountEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
    config.google.privateKeyPem,
    { algorithm: 'RS256' },
  );
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.access_token) throw new Error(`Google sign-in failed: ${(json && (json.error_description || json.error)) || res.status}`);
  cachedToken = { token: json.access_token, expires: Date.now() + (json.expires_in || 3600) * 1000 - 60000 };
  return cachedToken.token;
}

async function callApi(path, method, body, config, deps) {
  const fetchImpl = deps.fetch || fetch;
  const token = await getAccessToken(config, deps);
  const res = await fetchImpl(`${API_BASE}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, json, error: res.ok ? null : ((json && json.error && json.error.message) || text || `HTTP ${res.status}`) };
}

// ---- the class: one shared "template" describing the card's look, created/updated once ----

function buildClass(config) {
  return {
    id: classId(config),
    issuerName: 'Guernsey Yacht Club',
    reviewStatus: 'UNDER_REVIEW', // Google reviews new classes before they go live; see README.
    hexBackgroundColor: COLOR,
    classTemplateInfo: {
      cardTemplateOverride: {
        cardRowTemplateInfos: [
          { twoItems: { startItem: { firstValue: { fields: [{ fieldPath: "object.textModulesData['membershipType']" }] } }, endItem: { firstValue: { fields: [{ fieldPath: "object.textModulesData['validTo']" }] } } } },
        ],
      },
    },
  };
}

async function ensureClass(config, deps) {
  const id = classId(config);
  const get = await callApi(`genericClass/${encodeURIComponent(id)}`, 'GET', undefined, config, deps);
  if (get.ok) return { ok: true, created: false };
  const ins = await callApi('genericClass', 'POST', buildClass(config), config, deps);
  return ins.ok ? { ok: true, created: true } : { ok: false, error: ins.error };
}

// ---- the object: one per member ----

function buildObject(record, config) {
  return {
    id: objectId(config, record.memberNumber),
    classId: classId(config),
    state: 'ACTIVE',
    cardTitle: { defaultValue: { language: 'en-US', value: 'Guernsey Yacht Club' } },
    subheader: { defaultValue: { language: 'en-US', value: 'Membership' } },
    header: { defaultValue: { language: 'en-US', value: record.memberName } },
    hexBackgroundColor: COLOR,
    textModulesData: [
      { id: 'membershipType', header: 'Membership', body: record.membershipType || '' },
      { id: 'validTo', header: 'Valid to', body: record.validTo || '' },
      { id: 'season', header: 'Season', body: record.season || '' },
      { id: 'memberNumber', header: 'Member no.', body: record.memberNumber },
    ],
    barcode: { type: 'QR_CODE', value: record.memberNumber, alternateText: record.memberNumber },
    linksModuleData: {
      uris: [
        { uri: 'https://members.gyc.org.gg/portal', description: 'Manage my membership' },
        { uri: 'https://members.gyc.org.gg/events', description: 'Book club events' },
        { uri: 'https://www.gyc.org.gg', description: 'Club website' },
      ],
    },
  };
}

// Creates the object if it doesn't exist, or patches it (only the fields buildObject sets) if it does.
async function upsertObject(record, config, deps) {
  const id = objectId(config, record.memberNumber);
  const body = buildObject(record, config);
  const get = await callApi(`genericObject/${encodeURIComponent(id)}`, 'GET', undefined, config, deps);
  if (get.status === 404) {
    const ins = await callApi('genericObject', 'POST', body, config, deps);
    return ins.ok ? { ok: true, created: true, objectId: id } : { ok: false, error: ins.error };
  }
  if (!get.ok) return { ok: false, error: get.error };
  const patch = await callApi(`genericObject/${encodeURIComponent(id)}`, 'PATCH', body, config, deps);
  return patch.ok ? { ok: true, created: false, objectId: id } : { ok: false, error: patch.error };
}

async function voidObject(record, config, deps) {
  const id = objectId(config, record.memberNumber);
  const patch = await callApi(`genericObject/${encodeURIComponent(id)}`, 'PATCH', { state: 'EXPIRED' }, config, deps);
  return patch.ok ? { ok: true } : { ok: false, error: patch.error };
}

// The "Add to Google Wallet" link for one member's object (no API call needed to build this).
function saveLink(record, config) {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      iss: config.google.serviceAccountEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: now,
      origins: config.google.origins,
      payload: { genericObjects: [{ id: objectId(config, record.memberNumber) }] },
    },
    config.google.privateKeyPem,
    { algorithm: 'RS256' },
  );
  return `https://pay.google.com/gp/v/save/${token}`;
}

module.exports = { classId, objectId, buildClass, buildObject, ensureClass, upsertObject, voidObject, saveLink, getAccessToken };
