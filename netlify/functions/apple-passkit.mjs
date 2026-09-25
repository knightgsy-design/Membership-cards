// Public: the Apple PassKit web service. This is what makes an installed pass update itself — Wallet
// calls these endpoints directly from members' phones, using the Authorization: ApplePass <token>
// header, never through the site's own passphrase. Spec:
// https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes
'use strict';

import configLib from './lib/config.js';
import passRecord from './lib/passRecord.js';
import imagesLib from './lib/images.js';
import store from './lib/store.js';

const { readConfig, appleReady } = configLib;

function authOk(req, expectedToken) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^ApplePass\s+(.+)$/);
  return Boolean(m && expectedToken && m[1] === expectedToken);
}

export default async (req) => {
  const config = readConfig(Netlify.env);
  if (!appleReady(config)) return new Response('', { status: 503 });

  const url = new URL(req.url);
  // Path after the function's mount point, e.g. "/v1/devices/ABC/registrations/pass.gg.gyc/01234".
  const path = url.pathname.replace(/^.*\/apple\/v1/, '/v1');
  const parts = path.split('/').filter(Boolean); // ["v1", ...]

  // POST /v1/devices/{deviceLibraryIdentifier}/registrations/{passTypeIdentifier}/{serialNumber}
  if (req.method === 'POST' && parts[1] === 'devices' && parts[3] === 'registrations') {
    const [, , deviceLibraryIdentifier, , passTypeIdentifier, serialNumber] = parts;
    if (passTypeIdentifier !== config.apple.passTypeId) return new Response('', { status: 404 });
    const record = await store.getMember(serialNumber);
    if (!record) return new Response('', { status: 404 });
    if (!authOk(req, record.authToken)) return new Response('', { status: 401 });
    let pushToken = '';
    try { pushToken = (await req.json()).pushToken || ''; } catch { /* ignore */ }
    if (!pushToken) return new Response('', { status: 400 });
    const { alreadyRegistered } = await store.registerDevice(passTypeIdentifier, serialNumber, deviceLibraryIdentifier, pushToken);
    return new Response('', { status: alreadyRegistered ? 200 : 201 });
  }

  // DELETE /v1/devices/{deviceLibraryIdentifier}/registrations/{passTypeIdentifier}/{serialNumber}
  if (req.method === 'DELETE' && parts[1] === 'devices' && parts[3] === 'registrations') {
    const [, , deviceLibraryIdentifier, , passTypeIdentifier, serialNumber] = parts;
    if (passTypeIdentifier !== config.apple.passTypeId) return new Response('', { status: 404 });
    const record = await store.getMember(serialNumber);
    if (record && !authOk(req, record.authToken)) return new Response('', { status: 401 });
    const { found } = await store.unregisterDevice(passTypeIdentifier, serialNumber, deviceLibraryIdentifier);
    return new Response('', { status: found ? 200 : 404 });
  }

  // GET /v1/devices/{deviceLibraryIdentifier}/registrations/{passTypeIdentifier}?passesUpdatedSince=tag
  if (req.method === 'GET' && parts[1] === 'devices' && parts[3] === 'registrations') {
    const [, , deviceLibraryIdentifier, , passTypeIdentifier] = parts;
    if (passTypeIdentifier !== config.apple.passTypeId) return new Response('', { status: 404 });
    const since = url.searchParams.get('passesUpdatedSince') || '';
    const serials = await store.serialsForDevice(passTypeIdentifier, deviceLibraryIdentifier);
    const updated = [];
    let lastUpdated = since;
    for (const serial of serials) {
      const record = await store.getMember(serial);
      if (!record) continue;
      if (!since || record.modifiedOn > since) updated.push(serial);
      if (record.modifiedOn > lastUpdated) lastUpdated = record.modifiedOn;
    }
    if (!updated.length) return new Response(null, { status: 204 });
    return Response.json({ lastUpdated, serialNumbers: updated }, { status: 200 });
  }

  // GET /v1/passes/{passTypeIdentifier}/{serialNumber}
  if (req.method === 'GET' && parts[1] === 'passes') {
    const [, , passTypeIdentifier, serialNumber] = parts;
    if (passTypeIdentifier !== config.apple.passTypeId) return new Response('', { status: 404 });
    const record = await store.getMember(serialNumber);
    if (!record) return new Response('', { status: 404 });
    if (!authOk(req, record.authToken)) return new Response('', { status: 401 });
    // HTTP dates only carry second precision, but modifiedOn is an ISO timestamp with milliseconds, so
    // compare at second precision or a genuinely-unchanged pass would never match and always re-send.
    const ifModifiedSince = req.headers.get('if-modified-since');
    if (ifModifiedSince) {
      const recordSec = Math.floor(new Date(record.modifiedOn).getTime() / 1000);
      const sinceSec = Math.floor(new Date(ifModifiedSince).getTime() / 1000);
      if (Number.isFinite(sinceSec) && recordSec <= sinceSec) return new Response(null, { status: 304 });
    }
    const { buffer } = await passRecord.buildApplePkpass(serialNumber, config, imagesLib.appleImages(config));
    return new Response(buffer, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.pkpass', 'Last-Modified': new Date(record.modifiedOn).toUTCString() } });
  }

  // POST /v1/log — Wallet reports client-side errors here; we just accept them.
  if (req.method === 'POST' && parts[1] === 'log') {
    let logs = [];
    try { logs = (await req.json()).logs || []; } catch { /* ignore */ }
    if (logs.length) console.log('Apple Wallet client log:', logs.slice(0, 20).join(' | '));
    return new Response('', { status: 200 });
  }

  return new Response('', { status: 404 });
};

export const config = { path: '/apple/v1/*' };
