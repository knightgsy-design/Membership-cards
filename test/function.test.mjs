// Tests for the Netlify function, with a fake Passcreator. Run with: npm test
import test from 'node:test';
import assert from 'node:assert';

const env = { PASSCREATOR_API_KEY: 'secret-key', PASSCREATOR_TEMPLATE_ID: 'tmpl-test' };
globalThis.Netlify = { env: { get: k => env[k] } };

const calls = [];
let mode = 'ok';
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  calls.push({ method: init.method, path: u.pathname, body: init.body && JSON.parse(init.body) });
  const reply = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  if (mode === 'badkey') return reply(401, {});
  if (u.pathname === '/api/pass-template') return reply(200, [{ identifier: 'tmpl-test', name: 'GYC Membership TEST' }]);
  if (u.pathname.startsWith('/api/pass/')) return reply(404, {});
  if (u.pathname === '/api/v3/pass') return reply(200, { success: true, data: { identifier: 'x' } });
  return reply(404, {});
};

const { default: handler, config } = await import('../netlify/functions/passes.mjs');
const post = body => handler(new Request('https://x/api/passes', { method: 'POST', body: JSON.stringify(body) }));
const member = n => ({ memberNumber: n, memberName: 'Alex', email: 'a@x.com', membershipType: 'Full', validTo: '31 Mar 2099', passExpiry: '2099-03-31', season: '2098/99' });

test('routes at /api/passes', () => assert.strictEqual(config.path, '/api/passes'));

test('status returns the template name', async () => {
  const r = await post({ action: 'status' });
  assert.deepStrictEqual(await r.json(), { templateName: 'GYC Membership TEST' });
});

test('practice run looks up but writes nothing', async () => {
  calls.length = 0;
  const j = await (await post({ action: 'run', live: false, members: [member('01234')] })).json();
  assert.deepStrictEqual(j.results, [{ memberNumber: '01234', action: 'would create', reason: 'new card, emailed to member' }]);
  assert.ok(calls.every(c => c.method === 'GET'));
});

test('live run creates, and only live === true counts as live', async () => {
  calls.length = 0;
  let j = await (await post({ action: 'run', live: 'yes', members: [member('01234')] })).json();
  assert.strictEqual(j.results[0].action, 'would create');
  j = await (await post({ action: 'run', live: true, members: [member('01234')] })).json();
  assert.strictEqual(j.results[0].action, 'created');
  assert.strictEqual(calls.find(c => c.method === 'POST').body.data.templateId, 'tmpl-test');
});

test('bad rows fail without calling Passcreator; batch size is capped', async () => {
  calls.length = 0;
  const j = await (await post({ action: 'run', live: true, members: [{ ...member(''), passExpiry: 'soon' }] })).json();
  assert.strictEqual(j.results[0].action, 'failed');
  assert.strictEqual(calls.length, 0);
  const big = await post({ action: 'run', live: false, members: Array.from({ length: 11 }, (_, i) => member(String(i))) });
  assert.strictEqual(big.status, 400);
});

test('rejected key is fatal and the key is never echoed', async () => {
  mode = 'badkey';
  const r = await post({ action: 'run', live: false, members: [member('01234')] });
  const text = await r.text();
  mode = 'ok';
  assert.strictEqual(r.status, 502);
  assert.match(text, /refused the API key/);
  assert.ok(!text.includes('secret-key'));
});

test('missing settings and wrong method are reported', async () => {
  delete env.PASSCREATOR_TEMPLATE_ID;
  let j = await (await post({ action: 'status' })).json();
  assert.ok(j.fatal && /not set\. Templates this API key can see: "GYC Membership TEST" = tmpl-test/.test(j.error), j.error);
  j = await (await post({ action: 'run', live: false, members: [member('1')] })).json();
  assert.ok(j.fatal && /TEMPLATE_ID must be set/.test(j.error));
  env.PASSCREATOR_TEMPLATE_ID = 'wrong';
  j = await (await post({ action: 'status' })).json();
  assert.match(j.error, /"wrong" was not found/);
  env.PASSCREATOR_TEMPLATE_ID = 'tmpl-test';
  delete env.PASSCREATOR_API_KEY;
  j = await (await post({ action: 'status' })).json();
  env.PASSCREATOR_API_KEY = 'secret-key';
  assert.match(j.error, /API_KEY must be set/);
  const g = await handler(new Request('https://x/api/passes'));
  assert.strictEqual(g.status, 405);
});

test('a pasted key with quotes or a Bearer prefix is cleaned', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push(init.headers.Authorization); return orig(url, init); };
  env.PASSCREATOR_API_KEY = ' PASSCREATOR_API_KEY="Bearer abc123" ';
  await post({ action: 'status' });
  env.PASSCREATOR_API_KEY = 'secret-key';
  globalThis.fetch = orig;
  assert.strictEqual(seen[0], 'abc123');
});

test('list returns issued cards on the template, and only follows Passcreator page links', async () => {
  const orig = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = async (url, init) => {
    seenUrl = url;
    const body = { success: true, data: [{ userProvidedId: '01234', memberName: 'Alex', validTo: '31 Mar 2027', createdOn: '2026-09-24 10:00:00',
      noOfActiveRegistrationsAppleWallet: 1, noOfActiveRegistrationsGoogleWallet: 0, noOfRegistrations: 1, firstDownloadedAt: '2026-09-24 11:00:00', linkToPassPage: 'https://app.passcreator.com/p/x' }],
      page: { next: 'https://app.passcreator.com/api/v3/pass?page=2' } };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const j = await (await post({ action: 'list' })).json();
  const q = JSON.parse(Buffer.from(new URL(seenUrl).searchParams.get('query'), 'base64url').toString());
  assert.strictEqual(q.templateId, 'tmpl-test');
  assert.strictEqual(j.cards[0].memberNumber, '01234');
  assert.strictEqual(j.cards[0].onApple, 1);
  assert.strictEqual(j.next, 'https://app.passcreator.com/api/v3/pass?page=2');
  await post({ action: 'list', next: j.next });
  assert.strictEqual(seenUrl, 'https://app.passcreator.com/api/v3/pass?page=2');
  const bad = await post({ action: 'list', next: 'https://evil.example/steal' });
  assert.strictEqual(bad.status, 502);
  globalThis.fetch = orig;
});

test('email checks the card is ours, then asks Passcreator to send it', async () => {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); seen.push(init.method + ' ' + u.pathname);
    const R = (s, b) => ({ ok: s < 300, status: s, headers: { get: () => null }, text: async () => JSON.stringify(b) });
    if (u.pathname === '/api/pass/01234') return R(200, { identifier: 'uid-1', passTemplateGuid: 'tmpl-test' });
    if (u.pathname === '/api/pass/09999') return R(200, { identifier: 'uid-9', passTemplateGuid: 'other' });
    if (u.pathname.startsWith('/api/pass/deliver/')) return R(200, {});
    return R(404, {});
  };
  let j = await (await post({ action: 'email', memberNumber: '01234', email: 'me@example.com' })).json();
  assert.deepStrictEqual(j, { ok: true });
  assert.ok(seen.includes('POST /api/pass/deliver/uid-1/email/me%40example.com'));
  j = await (await post({ action: 'email', memberNumber: '09999', email: 'me@example.com' })).json();
  assert.match(j.error, /different template/);
  j = await (await post({ action: 'email', memberNumber: '01234', email: 'not-an-email' })).json();
  assert.match(j.error, /doesn't look like an email/);
  globalThis.fetch = orig;
});
