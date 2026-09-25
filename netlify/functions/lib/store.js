// Persistent storage for the own-wallet system, using Netlify Blobs. This is the master record of
// every member's pass (Passcreator is not involved at all in this system) and of which phones are
// registered for push updates on each pass.
//
// Netlify Blobs needs no setup: it works automatically inside a deployed Netlify Function. For local
// testing, pass a fake `getStore` in deps.
'use strict';

function stores(deps = {}) {
  // globalThis.__ownWalletFakeGetStore is a test seam only (tests run outside a deployed Netlify
  // Function, where the real @netlify/blobs has nothing to connect to).
  const getStore = deps.getStore || globalThis.__ownWalletFakeGetStore || require('@netlify/blobs').getStore;
  return {
    members: getStore('own-wallet-members'),
    devices: getStore('own-wallet-devices'), // key: passTypeId|deviceLibraryIdentifier -> {pushToken, serialNumbers:[...]}
  };
}

// ---- members (one pass record per member number) ----

async function getMember(memberNumber, deps) {
  const { members } = stores(deps);
  return (await members.get(memberNumber, { type: 'json' })) || null;
}

async function putMember(record, deps) {
  const { members } = stores(deps);
  await members.setJSON(record.memberNumber, record);
}

async function deleteMember(memberNumber, deps) {
  const { members } = stores(deps);
  await members.delete(memberNumber);
}

async function listMembers(deps) {
  const { members } = stores(deps);
  const out = [];
  let cursor;
  do {
    const page = await members.list({ cursor });
    for (const b of page.blobs) {
      const rec = await members.get(b.key, { type: 'json' });
      if (rec) out.push(rec);
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

// ---- Apple device registrations (per passTypeIdentifier + serialNumber + deviceLibraryIdentifier) ----

function regKey(passTypeId, serialNumber, deviceLibraryIdentifier) {
  return `${passTypeId}|${serialNumber}|${deviceLibraryIdentifier}`;
}

async function registerDevice(passTypeId, serialNumber, deviceLibraryIdentifier, pushToken, deps) {
  const { devices } = stores(deps);
  const existing = await devices.get(regKey(passTypeId, serialNumber, deviceLibraryIdentifier), { type: 'json' });
  await devices.setJSON(regKey(passTypeId, serialNumber, deviceLibraryIdentifier), { pushToken, registeredOn: new Date().toISOString() });
  return { alreadyRegistered: Boolean(existing) };
}

async function unregisterDevice(passTypeId, serialNumber, deviceLibraryIdentifier, deps) {
  const { devices } = stores(deps);
  const key = regKey(passTypeId, serialNumber, deviceLibraryIdentifier);
  const existing = await devices.get(key, { type: 'json' });
  if (!existing) return { found: false };
  await devices.delete(key);
  return { found: true };
}

// Every device registered for a given pass (used to send a push when that pass changes).
async function devicesForSerial(passTypeId, serialNumber, deps) {
  const { devices } = stores(deps);
  const prefix = `${passTypeId}|${serialNumber}|`;
  const out = [];
  let cursor;
  do {
    const page = await devices.list({ prefix, cursor });
    for (const b of page.blobs) {
      const rec = await devices.get(b.key, { type: 'json' });
      if (rec) out.push({ deviceLibraryIdentifier: b.key.slice(prefix.length), pushToken: rec.pushToken });
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

// Every serial number a given device is registered for on this pass type (for the PassKit
// "registrations" GET), along with each one's updateTag, filtered to those updated since `since`.
async function serialsForDevice(passTypeId, deviceLibraryIdentifier, deps) {
  const { devices } = stores(deps);
  const out = [];
  let cursor;
  do {
    const page = await devices.list({ prefix: `${passTypeId}|`, cursor });
    for (const b of page.blobs) {
      const parts = b.key.split('|');
      if (parts[2] === deviceLibraryIdentifier) out.push(parts[1]);
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

module.exports = { getMember, putMember, deleteMember, listMembers, registerDevice, unregisterDevice, devicesForSerial, serialsForDevice };
