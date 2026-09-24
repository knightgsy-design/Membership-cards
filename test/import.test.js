// Run with: npm test   (uses a fake Passcreator; no network, no API key needed)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCsv, validateRows, run } = require('../import.js');

const TEMPLATE = 'tmpl-test';
const HEADER = 'memberNumber,memberName,email,membershipType,validTo,passExpiry,season';

// In-memory stand-in for the endpoints import.js uses.
function fakePasscreator({ failFirst = 0, status = null } = {}) {
  const passes = new Map(); // userProvidedId -> pass
  const calls = [];
  let failures = failFirst;
  const fieldIds = { memberNumber: 'id1', memberName: 'id2', membershipType: 'id3', validTo: 'id4', season: 'id5' };
  const reply = (code, body) => ({ ok: code < 300, status: code, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  async function fetch(url, init) {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, body: init.body && JSON.parse(init.body), auth: init.headers.Authorization });
    if (failures > 0) { failures--; throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); }
    if (status) return reply(status, { errors: ['nope'] });
    let m;
    if (init.method === 'GET' && (m = u.pathname.match(/^\/api\/pass\/([^/]+)$/))) {
      const p = passes.get(decodeURIComponent(m[1]));
      return p ? reply(200, p) : reply(404, { ErrorMessage: 'not found' });
    }
    if (init.method === 'POST' && u.pathname === '/api/v3/pass') {
      const d = init.body && JSON.parse(init.body).data;
      const pass = { identifier: 'uid-' + d.userProvidedId, userProvidedId: d.userProvidedId, passTemplateGuid: d.templateId,
        barcodeValue: d.barcodeValue, expirationDate: d.expirationDate + ':00', fieldMapping: fieldIds, passFieldData: {} };
      for (const [k, id] of Object.entries(fieldIds)) pass.passFieldData[id] = d[k];
      passes.set(d.userProvidedId, pass);
      return reply(200, { success: true, data: { identifier: pass.identifier } });
    }
    if (init.method === 'PATCH' && (m = u.pathname.match(/^\/api\/v3\/pass\/(.+)$/))) {
      const pass = [...passes.values()].find(p => p.identifier === decodeURIComponent(m[1]));
      const d = JSON.parse(init.body).data;
      for (const [k, v] of Object.entries(d)) {
        if (fieldIds[k]) pass.passFieldData[fieldIds[k]] = v;
        else if (k === 'expirationDate') pass.expirationDate = v + ':00';
        else pass[k] = v;
      }
      return reply(200, { success: true });
    }
    return reply(404, {});
  }
  return { fetch, passes, calls };
}

function setup(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyc-'));
  const file = path.join(dir, 'in.csv');
  fs.writeFileSync(file, [HEADER, ...rows].join('\n'));
  return { dir, file };
}

const now = new Date('2026-09-24T10:00:00');
const env = { PASSCREATOR_API_KEY: 'secret-key', PASSCREATOR_TEMPLATE_ID: TEMPLATE };
const quiet = () => {};
const opts = (api, dir) => ({ env, now, outDir: dir, log: quiet, client: { fetchImpl: api.fetch, sleep: async () => {}, minGap: 0 } });

test('parseCsv handles quotes, commas and BOM', () => {
  const { headers, records } = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n');
  assert.deepStrictEqual(headers, ['a', 'b']);
  assert.deepStrictEqual(records, [{ a: 'x, y', b: 'say "hi"' }]);
});

test('validateRows flags duplicates, bad dates, expired and missing fields', () => {
  const { records } = parseCsv([HEADER,
    '01234,Alex,a@x.com,Full,31 Mar 2027,2027-03-31,2026/27',
    '01234,Dup,d@x.com,Full,31 Mar 2027,2027-03-31,2026/27',
    '01240,Old,o@x.com,Full,31 Mar 2026,2026-03-31,2025/26',
    '01241,Bad,b@x.com,Full,31 Mar 2027,31/03/2027,2026/27',
    ',NoNum,n@x.com,Full,31 Mar 2027,2027-03-31,2026/27',
  ].join('\n'));
  const r = validateRows(records, '2026-09-24');
  assert.strictEqual(r[0].error, null);
  assert.match(r[1].error, /duplicate member number \(first seen on row 2\)/);
  assert.match(r[2].error, /already expired/);
  assert.match(r[3].error, /not a date/);
  assert.match(r[4].error, /no member number/);
});

test('dry run without credentials only checks the file', async () => {
  const { dir, file } = setup(['01234,Alex,a@x.com,Full,31 Mar 2027,2027-03-31,2026/27']);
  const res = await run({ file, live: false }, { env: {}, now, outDir: dir, log: quiet });
  assert.deepStrictEqual(res.counts, { 'ok (not checked)': 1 });
  assert.ok(path.basename(res.file).startsWith('results-2026-09-24-dry-run'));
});

test('dry run with credentials looks up but never writes', async () => {
  const api = fakePasscreator();
  const { dir, file } = setup(['01234,Alex,a@x.com,Full,31 Mar 2027,2027-03-31,2026/27']);
  const res = await run({ file, live: false }, opts(api, dir));
  assert.deepStrictEqual(res.counts, { 'would create': 1 });
  assert.ok(api.calls.every(c => c.method === 'GET'));
  assert.strictEqual(api.calls[0].auth, 'secret-key');
});

test('live run creates, then a re-run is unchanged, then a renewal updates', async () => {
  const api = fakePasscreator();
  let s = setup(['01234,Alex,a@x.com,Full,31 Mar 2027,2027-03-31,2026/27', '01236,Jo,,Social,31 Mar 2027,2027-03-31,2026/27']);
  let res = await run({ file: s.file, live: true }, opts(api, s.dir));
  assert.deepStrictEqual(res.counts, { created: 2 });
  const create = api.calls.find(c => c.method === 'POST').body.data;
  assert.strictEqual(create.templateId, TEMPLATE);
  assert.strictEqual(create.userProvidedId, '01234');
  assert.strictEqual(create.barcodeValue, '01234');
  assert.strictEqual(create.expirationDate, '2027-03-31 23:59');
  assert.strictEqual(create.emailRecipient, 'a@x.com');
  assert.ok(!('emailRecipient' in api.calls.filter(c => c.method === 'POST')[1].body.data), 'no email, no emailRecipient');

  res = await run({ file: s.file, live: true }, opts(api, s.dir));
  assert.deepStrictEqual(res.counts, { unchanged: 2 });

  s = setup(['01234,Alex,a@x.com,Full,31 Mar 2028,2028-03-31,2027/28']);
  api.calls.length = 0;
  res = await run({ file: s.file, live: true }, opts(api, s.dir));
  assert.deepStrictEqual(res.counts, { updated: 1 });
  const patch = api.calls.find(c => c.method === 'PATCH');
  assert.strictEqual(patch.path, '/api/v3/pass/uid-01234');
  assert.deepStrictEqual(patch.body.data, { validTo: '31 Mar 2028', season: '2027/28', expirationDate: '2028-03-31 23:59' });
  assert.ok(!('emailRecipient' in patch.body.data), 'renewals do not re-send the email');
  assert.match(fs.readFileSync(res.file, 'utf8'), /01234,updated,"changed: validTo, season, pass expiry"/);
});

test('pass on another template is not touched', async () => {
  const api = fakePasscreator();
  api.passes.set('01234', { identifier: 'x', passTemplateGuid: 'other', passTemplateName: 'Gift card', fieldMapping: {}, passFieldData: {} });
  const { dir, file } = setup(['01234,Alex,a@x.com,Full,31 Mar 2027,2027-03-31,2026/27']);
  const res = await run({ file, live: true }, opts(api, dir));
  assert.strictEqual(res.results[0].action, 'failed');
  assert.match(res.results[0].reason, /another template/);
  assert.ok(!api.calls.some(c => c.method !== 'GET'));
});

test('network errors are retried, then logged as failed', async () => {
  let api = fakePasscreator({ failFirst: 2 });
  let s = setup(['01234,Alex,a@x.com,Full,31 Mar 2027,2027-03-31,2026/27']);
  let res = await run({ file: s.file, live: true }, opts(api, s.dir));
  assert.deepStrictEqual(res.counts, { created: 1 });

  api = fakePasscreator({ failFirst: 99 });
  s = setup(['01234,Alex,a@x.com,Full,31 Mar 2027,2027-03-31,2026/27']);
  res = await run({ file: s.file, live: true }, opts(api, s.dir));
  assert.deepStrictEqual(res.counts, { failed: 1 });
  assert.match(res.results[0].reason, /could not reach Passcreator \(ECONNRESET\)/);
  assert.strictEqual(api.calls.length, 5, 'one try plus four retries');
});

test('a rejected API key stops the run without printing the key', async () => {
  const api = fakePasscreator({ status: 401 });
  const { dir, file } = setup(['01234,Alex,a@x.com,Full,31 Mar 2027,2027-03-31,2026/27']);
  await assert.rejects(run({ file, live: true }, opts(api, dir)), e => /refused the API key/.test(e.message) && !e.message.includes('secret-key'));
});

test('live run without credentials refuses to start', async () => {
  const { dir, file } = setup(['01234,Alex,a@x.com,Full,31 Mar 2027,2027-03-31,2026/27']);
  await assert.rejects(run({ file, live: true }, { env: {}, now, outDir: dir, log: quiet }), /must both be set/);
});

test('raw Sailing Club Manager export is rejected with a pointer to the converter', async () => {
  await assert.rejects(run({ file: path.join(__dirname, '..', 'sample-data', 'scm-export-sample.csv'), live: false }, { env: {}, now, log: quiet }), /GYC Pass Converter/);
});
