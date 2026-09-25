// The canonical stored record for one member's card, and the logic that pushes it out to Apple and
// Google. Independent of Passcreator: this is its own source of truth (own-wallet/lib/store.js).
'use strict';

const crypto = require('crypto');
const applePkpass = require('./applePkpass.js');
const applePush = require('./applePush.js');
const googleWallet = require('./googleWallet.js');
const store = require('./store.js');
const { appleReady, applePushReady, googleReady } = require('./config.js');

const TRACKED_FIELDS = ['memberName', 'email', 'membershipType', 'validTo', 'passExpiry', 'season'];

function changed(existing, row) {
  if (!existing) return true;
  return TRACKED_FIELDS.some(f => String(existing[f] || '') !== String(row[f] || ''));
}

// Creates or updates the stored record and pushes the change to whichever wallets are configured.
// Returns {action: 'created'|'updated'|'unchanged'|'failed', reason}.
async function upsert(row, config, images, deps = {}) {
  const existing = await store.getMember(row.memberNumber, deps.store);
  if (!changed(existing, row)) return { action: 'unchanged', reason: '' };

  const record = {
    memberNumber: row.memberNumber,
    memberName: row.memberName,
    email: row.email || '',
    membershipType: row.membershipType,
    validTo: row.validTo,
    passExpiry: row.passExpiry,
    season: row.season,
    authToken: (existing && existing.authToken) || crypto.randomBytes(16).toString('hex'),
    createdOn: (existing && existing.createdOn) || new Date().toISOString(),
    modifiedOn: new Date().toISOString(),
    apple: existing && existing.apple, // whether an Apple pass has been generated at least once
    google: existing && existing.google,
  };

  const errors = [];
  if (appleReady(config)) {
    record.apple = true; // the .pkpass is generated on demand (own-wallet.mjs GET), not stored
    if (existing && applePushReady(config)) {
      const p = await applePush.pushSerial(config.apple.passTypeId, record.memberNumber, config, deps.store, deps.push).catch(e => ({ sent: 0, failed: 0, error: e.message }));
      if (p.error) errors.push(`Apple push: ${p.error}`);
    }
  }
  if (googleReady(config)) {
    const c = await googleWallet.ensureClass(config, deps.google).catch(e => ({ ok: false, error: e.message }));
    if (!c.ok) errors.push(`Google Wallet: ${c.error}`);
    else {
      const g = await googleWallet.upsertObject(record, config, deps.google).catch(e => ({ ok: false, error: e.message }));
      if (!g.ok) errors.push(`Google Wallet: ${g.error}`);
      else record.google = true;
    }
  }

  await store.putMember(record, deps.store);
  if (errors.length) return { action: 'failed', reason: errors.join('; ') };
  return { action: existing ? 'updated' : 'created', reason: existing ? 'card updated' : 'card created' };
}

async function remove(memberNumber, config, deps = {}) {
  const existing = await store.getMember(memberNumber, deps.store);
  if (!existing) return { action: 'unchanged', reason: 'no card to delete' };
  if (googleReady(config)) {
    const g = await googleWallet.voidObject(existing, config, deps.google).catch(e => ({ ok: false, error: e.message }));
    if (!g.ok) return { action: 'failed', reason: `Google Wallet: ${g.error}` };
  }
  await store.deleteMember(memberNumber, deps.store);
  return { action: 'deleted', reason: '' };
}

async function buildApplePkpass(memberNumber, config, images, deps = {}) {
  const record = await store.getMember(memberNumber, deps.store);
  if (!record) return { error: 'no card for that member' };
  return { buffer: await applePkpass.buildPkpass(record, config, images), record };
}

// Pushes a club notice to one member's card(s): sets the Apple "Latest from the club" field and pushes
// it, and adds a Google Wallet notification message. Returns {action:'sent'|'failed', reason}.
async function announce(memberNumber, headline, body, config, deps = {}) {
  const record = await store.getMember(memberNumber, deps.store);
  if (!record) return { action: 'failed', reason: 'no card for that member' };
  const errors = [];
  if (appleReady(config)) {
    record.notice = body;
    record.modifiedOn = new Date().toISOString();
    await store.putMember(record, deps.store);
    if (applePushReady(config)) {
      const p = await applePush.pushSerial(config.apple.passTypeId, memberNumber, config, deps.store, deps.push).catch(e => ({ error: e.message }));
      if (p.error) errors.push(`Apple push: ${p.error}`);
    }
  }
  if (googleReady(config) && record.google) {
    const g = await googleWallet.addMessage(record, headline, body, config, deps.google).catch(e => ({ ok: false, error: e.message }));
    if (!g.ok) errors.push(`Google Wallet: ${g.error}`);
  }
  return errors.length ? { action: 'failed', reason: errors.join('; ') } : { action: 'sent', reason: '' };
}

module.exports = { upsert, remove, buildApplePkpass, announce, changed, TRACKED_FIELDS };
