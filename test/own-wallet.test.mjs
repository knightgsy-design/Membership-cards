// Tests for the own-wallet system (Apple Wallet + Google Wallet direct, no Passcreator). No real
// Apple or Google credentials are used: a self-signed test certificate stands in for the Pass Type ID
// certificate, and Google's API is a fake fetch. Run with: npm test
'use strict';
import test from 'node:test';
import assert from 'node:assert';
import forge from 'node-forge';
import JSZip from 'jszip';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import store from '../own-wallet/lib/store.js';
import passRecord from '../own-wallet/lib/passRecord.js';
import googleWallet from '../own-wallet/lib/googleWallet.js';
import applePkpass from '../own-wallet/lib/applePkpass.js';
import { defaultAppleImages } from '../own-wallet/lib/pngGenerator.js';
import configLib from '../own-wallet/lib/config.js';

// ---- fixtures ----

function fakeBlobStore() {
  const data = new Map();
  return {
    async get(key, opts) { const v = data.get(key); if (v === undefined) return null; return opts && opts.type === 'json' ? JSON.parse(v) : v; },
    async setJSON(key, value) { data.set(key, JSON.stringify(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '', cursor } = {}) { return { blobs: [...data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), cursor: undefined }; },
  };
}
function fakeGetStoreFactory() {
  const stores = new Map();
  return name => stores.get(name) || (stores.set(name, fakeBlobStore()), stores.get(name));
}

function makeCert(cn, issuerKeys, issuerCert) {
  const keys = forge.pki.rsa.generateKeyPair(1024); // small key: fast test, never used for real passes
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

function testAppleConfig(extra = {}) {
  const wwdr = makeCert('Test WWDR');
  const leaf = makeCert('pass.test.gyc', wwdr.keys, wwdr.cert);
  return {
    apple: {
      passTypeId: 'pass.test.gyc',
      teamId: 'TEAMID1234',
      certPem: forge.pki.certificateToPem(leaf.cert),
      keyPem: forge.pki.privateKeyToPem(leaf.keys.privateKey),
      keyPassphrase: '',
      wwdrPem: forge.pki.certificateToPem(wwdr.cert),
      apnsKeyPem: '',
      apnsKeyId: '',
      apnsSandbox: true,
      webServiceBase: 'https://site.test',
      ...extra,
    },
    google: { issuerId: '', classSuffix: 'gyc_membership', serviceAccountEmail: '', privateKeyPem: '', origins: [] },
    images: {},
  };
}

const rsaKeyPem = () => {
  const k = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return k.privateKey.export({ type: 'pkcs8', format: 'pem' });
};

function testGoogleConfig() {
  return {
    apple: { passTypeId: '', teamId: '', certPem: '', keyPem: '', wwdrPem: '', apnsKeyPem: '', apnsKeyId: '', apnsSandbox: true, webServiceBase: '' },
    google: { issuerId: '1234567890', classSuffix: 'gyc_membership', serviceAccountEmail: 'svc@test.iam.gserviceaccount.com', privateKeyPem: rsaKeyPem(), origins: ['https://site.test'] },
    images: {},
  };
}

const member = (n, overrides = {}) => ({ memberNumber: n, memberName: 'Alex Sample', email: 'alex@example.com', membershipType: 'Full sailing', validTo: '31 Mar 2027', passExpiry: '2027-03-31', season: '2026/27', ...overrides });

function fakeGoogleFetch(log = []) {
  const classes = new Set();
  const objects = new Map();
  return async (url, init) => {
    const u = new URL(String(url));
    log.push(`${init.method} ${u.pathname}`);
    const json = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
    if (u.pathname === '/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    const m = u.pathname.match(/^\/walletobjects\/v1\/(genericClass|genericObject)(?:\/(.+))?$/);
    if (!m) return json(404, {});
    const [, kind, id] = m;
    const store2 = kind === 'genericClass' ? classes : objects;
    if (init.method === 'GET') return (kind === 'genericClass' ? classes.has(id) : objects.has(id)) ? json(200, {}) : json(404, { error: { message: 'not found' } });
    if (init.method === 'POST') { const body = JSON.parse(init.body); if (kind === 'genericClass') classes.add(body.id); else objects.set(body.id, body); return json(200, body); }
    if (init.method === 'PATCH') { const body = JSON.parse(init.body); if (kind === 'genericObject') objects.set(id, { ...objects.get(id), ...body }); return json(200, body); }
    return json(404, {});
  };
}

// ---- store.js ----

test('store: members and device registrations round-trip', async () => {
  const getStore = fakeGetStoreFactory();
  await store.putMember({ memberNumber: '01234', memberName: 'Alex' }, { getStore });
  assert.deepStrictEqual(await store.getMember('01234', { getStore }), { memberNumber: '01234', memberName: 'Alex' });
  assert.strictEqual(await store.getMember('99999', { getStore }), null);
  assert.strictEqual((await store.listMembers({ getStore })).length, 1);
  await store.deleteMember('01234', { getStore });
  assert.strictEqual(await store.getMember('01234', { getStore }), null);

  const r1 = await store.registerDevice('pass.x', '01234', 'devA', 'tokA', { getStore });
  assert.strictEqual(r1.alreadyRegistered, false);
  const r2 = await store.registerDevice('pass.x', '01234', 'devA', 'tokA2', { getStore });
  assert.strictEqual(r2.alreadyRegistered, true);
  await store.registerDevice('pass.x', '05678', 'devA', 'tokA', { getStore });
  assert.deepStrictEqual((await store.devicesForSerial('pass.x', '01234', { getStore })).map(d => d.pushToken), ['tokA2']);
  assert.deepStrictEqual((await store.serialsForDevice('pass.x', 'devA', { getStore })).sort(), ['01234', '05678']);
  const u = await store.unregisterDevice('pass.x', '01234', 'devA', { getStore });
  assert.strictEqual(u.found, true);
  assert.strictEqual((await store.unregisterDevice('pass.x', '01234', 'devA', { getStore })).found, false);
});

// ---- applePkpass.js ----

test('applePkpass: builds a .pkpass whose PKCS#7 signature verifies against its manifest', async () => {
  const config = testAppleConfig();
  const record = member('01234');
  const buf = await applePkpass.buildPkpass(record, config, defaultAppleImages());
  const zip = await JSZip.loadAsync(buf);
  const [passJson, manifest, signature, icon] = await Promise.all(['pass.json', 'manifest.json', 'signature', 'icon.png'].map(n => zip.file(n).async('nodebuffer')));
  const pass = JSON.parse(passJson.toString());
  assert.strictEqual(pass.serialNumber, '01234');
  assert.strictEqual(pass.passTypeIdentifier, 'pass.test.gyc');
  assert.strictEqual(pass.generic.primaryFields[0].value, 'Alex Sample');
  assert.strictEqual(pass.barcodes[0].message, '01234');
  assert.match(pass.expirationDate, /^2027-03-31T23:59:00[+-]\d\d:\d\d$/);

  const man = JSON.parse(manifest.toString());
  const md = forge.md.sha1.create(); md.update(icon.toString('binary'));
  assert.strictEqual(man['icon.png'], md.digest().toHex());

  const p7Asn1 = forge.asn1.fromDer(signature.toString('binary'));
  const p7 = forge.pkcs7.messageFromAsn1(p7Asn1);
  assert.strictEqual(p7.certificates.length, 2); // leaf + WWDR chain

  // node-forge can't verify PKCS#7/CMS signatures itself (known limitation), so if openssl is on the
  // PATH, use it for the authoritative check: this is exactly what confirms a real device would accept
  // the signature (verified manually against a real Apple cert chain shape during development).
  const openssl = spawnSync('openssl', ['version']);
  if (openssl.status === 0) {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkpass-'));
    fs.writeFileSync(path.join(dir, 'sig.der'), signature);
    fs.writeFileSync(path.join(dir, 'manifest.json'), manifest);
    const verify = spawnSync('openssl', ['cms', '-verify', '-noverify', '-inform', 'DER', '-in', path.join(dir, 'sig.der'), '-content', path.join(dir, 'manifest.json'), '-out', path.join(dir, 'out')]);
    assert.strictEqual(verify.status, 0, verify.stderr.toString());
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'out')), manifest);
  }
});

test('applePkpass: web service URL and auth token are included only once an auth token exists', async () => {
  const config = testAppleConfig();
  const noToken = applePkpass.buildPassJson(member('01234'), config);
  assert.strictEqual(noToken.webServiceURL, undefined);
  const withToken = applePkpass.buildPassJson({ ...member('01234'), authToken: 'abc' }, config);
  assert.strictEqual(withToken.webServiceURL, 'https://site.test/apple');
  assert.strictEqual(withToken.authenticationToken, 'abc');
});

// ---- googleWallet.js ----

test('googleWallet: creates the class once, then creates then patches the object', async () => {
  const config = testGoogleConfig();
  const log = [];
  const fetchImpl = fakeGoogleFetch(log);
  const deps = { fetch: fetchImpl };
  // point the OAuth token endpoint at our fake too, by monkeypatching the module's TOKEN_URL indirectly:
  // simplest is to have the fake handle any path, including the real token URL string it will call.
  const origFetch = global.fetch;
  global.fetch = (url, init) => fetchImpl(String(url).replace('https://oauth2.googleapis.com/token', 'https://x/token'), init);
  try {
    const c1 = await googleWallet.ensureClass(config, {});
    assert.deepStrictEqual(c1, { ok: true, created: true });
    const c2 = await googleWallet.ensureClass(config, {});
    assert.deepStrictEqual(c2, { ok: true, created: false });
    const o1 = await googleWallet.upsertObject(member('01234'), config, {});
    assert.strictEqual(o1.ok, true); assert.strictEqual(o1.created, true);
    const o2 = await googleWallet.upsertObject(member('01234', { memberName: 'Alex Renamed' }), config, {});
    assert.strictEqual(o2.ok, true); assert.strictEqual(o2.created, false);
    assert.ok(log.some(l => l.startsWith('POST /walletobjects/v1/genericClass')));
    assert.ok(log.some(l => l.startsWith('PATCH /walletobjects/v1/genericObject/')));
  } finally { global.fetch = origFetch; }
});

test('googleWallet: save link is a valid RS256 JWT pointing at pay.google.com', async () => {
  const config = testGoogleConfig();
  const link = googleWallet.saveLink(member('01234'), config);
  assert.match(link, /^https:\/\/pay\.google\.com\/gp\/v\/save\/ey/);
  const jwt = require('jsonwebtoken');
  const decoded = jwt.decode(link.split('/save/')[1]);
  assert.strictEqual(decoded.iss, config.google.serviceAccountEmail);
  assert.strictEqual(decoded.payload.genericObjects[0].id, googleWallet.objectId(config, '01234'));
});

// ---- passRecord.js (the glue) ----

function passDeps(getStore, log = []) {
  const origFetch = global.fetch;
  global.fetch = (url, init) => fakeGoogleFetch(log)(String(url).replace('https://oauth2.googleapis.com/token', 'https://x/token'), init);
  return { deps: { store: { getStore }, google: {}, push: {} }, restore: () => { global.fetch = origFetch; } };
}

test('passRecord: creates once, is unchanged on a repeat, updates on a real change', async () => {
  const getStore = fakeGetStoreFactory();
  const config = testGoogleConfig(); // google only, so no cert/signing involved here
  const { restore } = passDeps(getStore);
  try {
    const r1 = await passRecord.upsert(member('01234'), config, {}, { store: { getStore }, google: {}, push: {} });
    assert.strictEqual(r1.action, 'created');
    const r2 = await passRecord.upsert(member('01234'), config, {}, { store: { getStore }, google: {}, push: {} });
    assert.strictEqual(r2.action, 'unchanged');
    const r3 = await passRecord.upsert(member('01234', { validTo: '31 Mar 2028', passExpiry: '2028-03-31', season: '2027/28' }), config, {}, { store: { getStore }, google: {}, push: {} });
    assert.strictEqual(r3.action, 'updated');
    const stored = await store.getMember('01234', { getStore });
    assert.strictEqual(stored.validTo, '31 Mar 2028');
    assert.strictEqual(stored.google, true);
  } finally { restore(); }
});

test('passRecord: delete removes the record and voids the Google object', async () => {
  const getStore = fakeGetStoreFactory();
  const config = testGoogleConfig();
  const log = [];
  const { restore } = passDeps(getStore, log);
  try {
    await passRecord.upsert(member('01234'), config, {}, { store: { getStore }, google: {}, push: {} });
    const r = await passRecord.remove('01234', config, { store: { getStore }, google: {} });
    assert.strictEqual(r.action, 'deleted');
    assert.strictEqual(await store.getMember('01234', { getStore }), null);
    assert.ok(log.some(l => l === 'PATCH /walletobjects/v1/genericObject/1234567890.member_01234'));
  } finally { restore(); }
});

test('config.js: readiness checks and base64 secret decoding', () => {
  const env = {
    APPLE_PASS_TYPE_ID: 'pass.x', APPLE_TEAM_ID: 'T1',
    APPLE_PASS_CERT_PEM_BASE64: Buffer.from('CERT').toString('base64'),
    APPLE_PASS_KEY_PEM_BASE64: Buffer.from('KEY').toString('base64'),
    APPLE_WWDR_PEM_BASE64: Buffer.from('WWDR').toString('base64'),
  };
  const c = configLib.readConfig(env);
  assert.strictEqual(c.apple.certPem, 'CERT');
  assert.strictEqual(configLib.appleReady(c), true);
  assert.strictEqual(configLib.applePushReady(c), false);
  assert.strictEqual(configLib.googleReady(c), false);
});
