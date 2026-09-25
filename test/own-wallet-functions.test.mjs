// Tests for the own-wallet Netlify functions themselves (own-wallet.mjs, apple-passkit.mjs,
// apple-pkpass.mjs): routing, the passphrase gate, and the Apple PassKit protocol. Google Wallet is
// stubbed via a fake fetch; Apple uses a self-signed test certificate. Run with: npm test
'use strict';
import test from 'node:test';
import assert from 'node:assert';
import forge from 'node-forge';
import { default as ownWallet } from '../netlify/functions/own-wallet.mjs';
import { default as pkpassFn } from '../netlify/functions/apple-pkpass.mjs';
import { default as passkit } from '../netlify/functions/apple-passkit.mjs';
import store from '../own-wallet/lib/store.js';

// A fresh fake Netlify Blobs backend per test, assigned to the global seam store.js checks for.
function useFakeBlobs() {
  const backing = new Map();
  globalThis.__ownWalletFakeGetStore = name => {
    if (!backing.has(name)) backing.set(name, new Map());
    const data = backing.get(name);
    return {
      async get(key, opts) { const v = data.get(key); if (v === undefined) return null; return opts && opts.type === 'json' ? JSON.parse(v) : v; },
      async setJSON(key, value) { data.set(key, JSON.stringify(value)); },
      async delete(key) { data.delete(key); },
      async list({ prefix = '', cursor } = {}) { return { blobs: [...data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), cursor: undefined }; },
    };
  };
}

function makeCert(cn, issuerKeys, issuerCert) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(issuerCert ? issuerCert.subject.attributes : attrs);
  cert.sign(issuerKeys ? issuerKeys.privateKey : keys.privateKey, forge.md.sha256.create());
  return { cert, keys };
}

function useTestEnv(overrides = {}) {
  const wwdr = makeCert('Test WWDR');
  const leaf = makeCert('pass.test.gyc', wwdr.keys, wwdr.cert);
  const values = {
    APPLE_PASS_TYPE_ID: 'pass.test.gyc',
    APPLE_TEAM_ID: 'TEAMID1234',
    APPLE_PASS_CERT_PEM_BASE64: Buffer.from(forge.pki.certificateToPem(leaf.cert)).toString('base64'),
    APPLE_PASS_KEY_PEM_BASE64: Buffer.from(forge.pki.privateKeyToPem(leaf.keys.privateKey)).toString('base64'),
    APPLE_WWDR_PEM_BASE64: Buffer.from(forge.pki.certificateToPem(wwdr.cert)).toString('base64'),
    URL: 'https://site.test',
    OWN_WALLET_PASSPHRASE: 'letmein',
    ...overrides,
  };
  globalThis.Netlify = { env: { get: k => values[k] } };
}

const MEMBER = { memberNumber: '01234', memberName: 'Alex Sample', email: 'alex@example.com', membershipType: 'Full sailing', validTo: '31 Mar 2027', passExpiry: '2027-03-31', season: '2026/27' };
const post = (body, headers = {}) => ownWallet(new Request('https://site.test/api/own-wallet', { method: 'POST', body: JSON.stringify(body), headers }));
const withKey = { 'x-own-wallet-passphrase': 'letmein' };

test('own-wallet.mjs: status needs no passphrase; everything else does', async () => {
  useFakeBlobs(); useTestEnv();
  const status = await (await post({ action: 'status' })).json();
  assert.strictEqual(status.apple.ready, true);
  assert.strictEqual(status.google.ready, false);
  assert.strictEqual(status.passphraseSet, true);
  assert.strictEqual(status.unlocked, undefined, 'no passphrase sent yet, so unlocked must stay unset');

  const wrongStatus = await (await post({ action: 'status' }, { 'x-own-wallet-passphrase': 'nope' })).json();
  assert.strictEqual(wrongStatus.unlocked, false);
  const rightStatus = await (await post({ action: 'status' }, withKey)).json();
  assert.strictEqual(rightStatus.unlocked, true);

  const denied = await post({ action: 'list' });
  assert.strictEqual(denied.status, 401);
  assert.match((await denied.json()).error, /Wrong passphrase/);

  const allowed = await post({ action: 'list' }, withKey);
  assert.strictEqual(allowed.status, 200);
  assert.deepStrictEqual((await allowed.json()).members, []);
});

test('own-wallet.mjs: refuses everything but status when no passphrase is set at all', async () => {
  useFakeBlobs(); useTestEnv({ OWN_WALLET_PASSPHRASE: '' });
  const res = await post({ action: 'list' });
  assert.strictEqual(res.status, 401);
  assert.match((await res.json()).error, /OWN_WALLET_PASSPHRASE is not set/);
});

test('own-wallet.mjs: run (live) creates a card; list and links then see it; delete removes it', async () => {
  useFakeBlobs(); useTestEnv();
  const dry = await (await post({ action: 'run', live: false, members: [MEMBER] }, withKey)).json();
  assert.strictEqual(dry.results[0].action, 'would create/update');

  const live = await (await post({ action: 'run', live: true, members: [MEMBER] }, withKey)).json();
  assert.strictEqual(live.results[0].action, 'created');

  const list = await (await post({ action: 'list' }, withKey)).json();
  assert.strictEqual(list.members.length, 1);
  assert.strictEqual(list.members[0].memberNumber, '01234');
  assert.strictEqual(list.members[0].apple, true);

  const links = await (await post({ action: 'links', memberNumber: '01234' }, withKey)).json();
  assert.match(links.appleUrl, /\/\.netlify\/functions\/apple-pkpass\?member=01234$/);
  assert.strictEqual(links.googleUrl, undefined); // Google not configured in this test env

  const del = await (await post({ action: 'delete', memberNumber: '01234' }, withKey)).json();
  assert.deepStrictEqual(del, { ok: true });
  const after = await (await post({ action: 'list' }, withKey)).json();
  assert.strictEqual(after.members.length, 0);
});

test('own-wallet.mjs: a bad row in a batch fails without touching Apple/Google', async () => {
  useFakeBlobs(); useTestEnv();
  const bad = { ...MEMBER, memberNumber: '' };
  const j = await (await post({ action: 'run', live: true, members: [bad] }, withKey)).json();
  assert.strictEqual(j.results[0].action, 'failed');
  const list = await (await post({ action: 'list' }, withKey)).json();
  assert.strictEqual(list.members.length, 0);
});

test('apple-pkpass.mjs: streams a real .pkpass for an existing member, 404s for an unknown one', async () => {
  useFakeBlobs(); useTestEnv();
  await post({ action: 'run', live: true, members: [{ ...MEMBER, memberNumber: '05555' }] }, withKey);

  const ok = await pkpassFn(new Request('https://site.test/pass/apple?member=05555'));
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.headers.get('content-type'), 'application/vnd.apple.pkpass');
  const buf = Buffer.from(await ok.arrayBuffer());
  assert.strictEqual(buf.slice(0, 4).toString('hex'), '504b0304'); // zip local file header magic

  const missing = await pkpassFn(new Request('https://site.test/pass/apple?member=99999'));
  assert.strictEqual(missing.status, 404);
});

test('apple-passkit.mjs: register, list-for-device, get-pass, and unregister, with per-pass auth', async () => {
  useFakeBlobs(); useTestEnv();
  await post({ action: 'run', live: true, members: [{ ...MEMBER, memberNumber: '07777' }] }, withKey);
  const record = await store.getMember('07777');
  assert.ok(record.authToken);

  const base = 'https://site.test/apple/v1/devices/DEVICE-A/registrations/pass.test.gyc/07777';
  const unauth = await passkit(new Request(base, { method: 'POST', body: JSON.stringify({ pushToken: 'PT1' }) }));
  assert.strictEqual(unauth.status, 401);

  const reg1 = await passkit(new Request(base, { method: 'POST', body: JSON.stringify({ pushToken: 'PT1' }), headers: { authorization: `ApplePass ${record.authToken}` } }));
  assert.strictEqual(reg1.status, 201);
  const reg2 = await passkit(new Request(base, { method: 'POST', body: JSON.stringify({ pushToken: 'PT1' }), headers: { authorization: `ApplePass ${record.authToken}` } }));
  assert.strictEqual(reg2.status, 200);

  const listUrl = 'https://site.test/apple/v1/devices/DEVICE-A/registrations/pass.test.gyc';
  const noneUpdated = await passkit(new Request(`${listUrl}?passesUpdatedSince=${encodeURIComponent('9999-01-01')}`));
  assert.strictEqual(noneUpdated.status, 204);
  const allUpdated = await passkit(new Request(listUrl));
  const updated = await allUpdated.json();
  assert.deepStrictEqual(updated.serialNumbers, ['07777']);

  const passUrl = 'https://site.test/apple/v1/passes/pass.test.gyc/07777';
  const passRes = await passkit(new Request(passUrl, { headers: { authorization: `ApplePass ${record.authToken}` } }));
  assert.strictEqual(passRes.status, 200);
  assert.strictEqual(passRes.headers.get('content-type'), 'application/vnd.apple.pkpass');
  const lastMod = passRes.headers.get('last-modified');
  const notModified = await passkit(new Request(passUrl, { headers: { authorization: `ApplePass ${record.authToken}`, 'if-modified-since': lastMod } }));
  assert.strictEqual(notModified.status, 304);

  const unreg = await passkit(new Request(base, { method: 'DELETE', headers: { authorization: `ApplePass ${record.authToken}` } }));
  assert.strictEqual(unreg.status, 200);
  const unregAgain = await passkit(new Request(base, { method: 'DELETE', headers: { authorization: `ApplePass ${record.authToken}` } }));
  assert.strictEqual(unregAgain.status, 404);
});
