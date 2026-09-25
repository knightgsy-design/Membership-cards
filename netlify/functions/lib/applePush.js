// Tells a phone to fetch an updated pass, via Apple Push Notification service (APNs). This is what
// makes a renewed card update on the member's phone without them reopening Wallet.
// https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
'use strict';

const http2 = require('http2');
const jwt = require('jsonwebtoken');

let cachedToken = null; // APNs auth tokens are valid up to an hour; reuse within a run.

function authToken(config) {
  const { apple } = config;
  if (cachedToken && cachedToken.expires > Date.now() + 5000) return cachedToken.token;
  const token = jwt.sign({ iss: apple.teamId, iat: Math.floor(Date.now() / 1000) }, apple.apnsKeyPem, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: apple.apnsKeyId },
  });
  cachedToken = { token, expires: Date.now() + 55 * 60 * 1000 };
  return token;
}

// Sends one silent "your pass changed" push. Resolves to {ok, status, reason}; never throws, so a
// push failure never stops the pass update itself (the phone will still pick it up next time it polls).
function sendOne(pushToken, config, deps = {}) {
  const { apple } = config;
  const host = apple.apnsSandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const connect = deps.connect || http2.connect;
  return new Promise(resolve => {
    let client;
    try {
      client = connect(`https://${host}`);
    } catch (e) {
      resolve({ ok: false, reason: e.message }); return;
    }
    client.on('error', e => resolve({ ok: false, reason: e.message }));
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${pushToken}`,
      authorization: `bearer ${authToken(config)}`,
      'apns-topic': apple.passTypeId,
      'apns-priority': '10',
      'apns-push-type': 'background',
    });
    let status = null;
    req.on('response', headers => { status = headers[':status']; });
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { client.close(); resolve({ ok: status === 200, status, reason: status === 200 ? null : body }); });
    req.on('error', e => resolve({ ok: false, reason: e.message }));
    req.end(JSON.stringify({}));
  });
}

// Pushes every phone registered for this serial number. Best-effort: failures are collected, not thrown.
async function pushSerial(passTypeId, serialNumber, config, storeDeps, pushDeps) {
  const store = require('./store.js');
  const devices = await store.devicesForSerial(passTypeId, serialNumber, storeDeps);
  const results = await Promise.all(devices.map(d => sendOne(d.pushToken, config, pushDeps)));
  return { sent: results.length, failed: results.filter(r => !r.ok).length };
}

module.exports = { authToken, sendOne, pushSerial };
