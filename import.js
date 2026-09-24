#!/usr/bin/env node
// GYC wallet membership passes: issue and update passes on Passcreator from the
// CSV made by reference/gyc-pass-converter.html.
//
//   node import.js --file passcreator-import-2026-27.csv            (dry run, the default)
//   node import.js --file passcreator-import-2026-27.csv --live     (really creates/updates passes)
//
// API calls follow https://developer.passcreator.com:
//   - Auth: raw API key in the Authorization header, no "Bearer" prefix.
//   - Find a pass:   GET   /api/pass/{userProvidedId}?includeFieldMapping=true   (V1 "Read a Pass")
//   - Create a pass: POST  /api/v3/pass                  body {"data": {...}}
//   - Update a pass: PATCH /api/v3/pass/{identifier}     body {"data": {...}} (only fields sent change)
//   - Rate limit: 600 requests/minute, exponential block when exceeded.
// Each pass's userProvidedId is the member number, so re-running updates rather than duplicates.

'use strict';

const fs = require('fs');
const path = require('path');

// Passcreator field keys (additional property names on the template). Left: CSV column.
// Right: the property name in Passcreator. Confirm these once the template is built
// (reference/pass-template-spec.md) and change the right-hand side if they differ.
const FIELD_KEYS = {
  memberNumber: 'memberNumber',
  memberName: 'memberName',
  membershipType: 'membershipType',
  validTo: 'validTo',
  season: 'season',
};

const REQUIRED_COLUMNS = ['memberNumber', 'memberName', 'email', 'membershipType', 'validTo', 'passExpiry', 'season'];
const API_BASE = 'https://app.passcreator.com';
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];
const MIN_GAP_MS = 150; // keeps us well under 600 requests a minute
const EXPIRY_TIME = '23:59'; // pass stays valid until the end of the expiry day

class FatalError extends Error {}

// ---------- small helpers ----------

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function parseArgs(argv) {
  const opts = { file: null, live: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') opts.file = argv[++i];
    else if (a.startsWith('--file=')) opts.file = a.slice(7);
    else if (a === '--live') opts.live = true;
    else if (a === '--dry-run') opts.live = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new FatalError(`Unknown option: ${a}`);
  }
  if (opts.help) return opts;
  if (!opts.file) throw new FatalError('Tell me which file to use, e.g.  node import.js --file passcreator-import.csv');
  return opts;
}

// Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, commas/newlines in quotes, BOM.
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(v => v.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], records: [] };
  const headers = nonEmpty[0].map(h => h.trim());
  const records = nonEmpty.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
    return o;
  });
  return { headers, records };
}

function isValidIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function todayIso(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- validation ----------

// Returns [{ rowNo, row, error }]. A row with an error is logged as failed and not sent.
function validateRows(records, today) {
  const seen = new Map();
  return records.map((row, idx) => {
    const rowNo = idx + 2; // row 1 is the header, as in a spreadsheet
    const problems = [];
    const num = row.memberNumber;
    if (!num) problems.push('no member number');
    if (!row.memberName) problems.push('no name');
    if (!row.validTo) problems.push('no "valid to" date');
    if (!row.season) problems.push('no season');
    if (!row.passExpiry) problems.push('no pass expiry date');
    else if (!isValidIsoDate(row.passExpiry)) problems.push(`pass expiry "${row.passExpiry}" is not a date like 2027-03-31`);
    else if (row.passExpiry < today) problems.push(`membership already expired (${row.passExpiry})`);
    if (num && seen.has(num)) problems.push(`duplicate member number (first seen on row ${seen.get(num)})`);
    if (num && !seen.has(num)) seen.set(num, rowNo);
    return { rowNo, row, error: problems.length ? problems.join('; ') : null };
  });
}

// ---------- Passcreator API ----------

function makeClient({ apiKey, fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), retryDelays = RETRY_DELAYS_MS, minGap = MIN_GAP_MS }) {
  let lastCall = 0;

  async function request(method, urlPath, body) {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + minGap - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();

      let res, text, networkError = null;
      try {
        res = await fetchImpl(API_BASE + urlPath, {
          method,
          headers: { Authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        text = await res.text();
      } catch (e) {
        networkError = e;
      }

      const retryable = networkError || res.status === 429 || res.status >= 500;
      if (retryable && attempt < retryDelays.length) {
        const retryAfter = res && Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? Math.max(retryAfter * 1000, retryDelays[attempt]) : retryDelays[attempt]);
        continue;
      }
      if (networkError) {
        return { status: 0, json: null, error: `could not reach Passcreator (${networkError.cause && networkError.cause.code || networkError.message})` };
      }
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (res.status === 401 || res.status === 403) {
        throw new FatalError('Passcreator refused the API key (HTTP ' + res.status + '). Check the PASSCREATOR_API_KEY setting (the .env file, or the Netlify site settings for the online version), and that the key can see this template.');
      }
      return { status: res.status, json, error: res.ok ? null : describeError(res.status, json, text) };
    }
  }

  return { request };
}

function describeError(status, json, text) {
  let msg = '';
  if (json) {
    if (Array.isArray(json.errors) && json.errors.length) msg = json.errors.join('; ');
    else if (json.ErrorMessage) msg = json.ErrorMessage;
    else if (json.description) msg = json.description;
  }
  if (!msg && text) msg = String(text).slice(0, 200);
  if (status === 429) msg = 'too many requests (rate limit), gave up after retries' + (msg ? `: ${msg}` : '');
  return `HTTP ${status}${msg ? ': ' + msg : ''}`;
}

async function findPass(client, memberNumber) {
  const r = await client.request('GET', `/api/pass/${encodeURIComponent(memberNumber)}?includeFieldMapping=true`);
  if (r.status === 404) return { pass: null };
  if (r.error) return { error: `lookup failed: ${r.error}` };
  const pass = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!pass || !pass.identifier) return { pass: null };
  return { pass };
}

function desiredData(row) {
  const data = {
    userProvidedId: row.memberNumber,
    barcodeValue: row.memberNumber,
    expirationDate: `${row.passExpiry} ${EXPIRY_TIME}`,
  };
  for (const [column, key] of Object.entries(FIELD_KEYS)) data[key] = row[column];
  return data;
}

// Which of the desired values differ from the existing pass. Returns a data object with only those.
function changedData(pass, desired) {
  const changes = {};
  const mapping = pass.fieldMapping || {};
  const fields = pass.passFieldData || {};
  for (const key of Object.values(FIELD_KEYS)) {
    const current = key in mapping ? fields[mapping[key]] : fields[key];
    if (String(current == null ? '' : current).trim() !== desired[key]) changes[key] = desired[key];
  }
  if (String(pass.expirationDate || '').slice(0, 16) !== desired.expirationDate) changes.expirationDate = desired.expirationDate;
  if (String(pass.barcodeValue || '') !== desired.barcodeValue) changes.barcodeValue = desired.barcodeValue;
  return changes;
}

const LABELS = { expirationDate: 'pass expiry', barcodeValue: 'QR code' };
const describeChanges = changes => 'changed: ' + Object.keys(changes).map(k => LABELS[k] || k).join(', ');

async function processRow(client, templateId, row, live) {
  const found = await findPass(client, row.memberNumber);
  if (found.error) return { action: 'failed', reason: found.error };
  const desired = desiredData(row);

  if (!found.pass) {
    const reason = row.email ? 'new card, emailed to member' : 'new card, no email so send the link by hand';
    if (!live) return { action: 'would create', reason };
    const data = { templateId, ...desired, enforceUniqueUserProvidedId: true };
    if (row.email) data.emailRecipient = row.email;
    const r = await client.request('POST', '/api/v3/pass', { data });
    if (r.error || (r.json && r.json.success === false)) return { action: 'failed', reason: `create failed: ${r.error || describeError(r.status, r.json)}` };
    return { action: 'created', reason };
  }

  const pass = found.pass;
  if (pass.passTemplateGuid && pass.passTemplateGuid !== templateId) {
    return { action: 'failed', reason: `member number already used by a pass on another template ("${pass.passTemplateName || pass.passTemplateGuid}")` };
  }
  const unknown = pass.fieldMapping ? Object.values(FIELD_KEYS).filter(k => !(k in pass.fieldMapping)) : [];
  if (unknown.length) return { action: 'failed', reason: `template has no field named ${unknown.join(', ')} (check FIELD_KEYS in import.js)` };
  const changes = changedData(pass, desired);
  if (!Object.keys(changes).length) return { action: 'unchanged', reason: '' };
  if (!live) return { action: 'would update', reason: describeChanges(changes) };
  const r = await client.request('PATCH', `/api/v3/pass/${encodeURIComponent(pass.identifier)}`, { data: changes });
  if (r.error || (r.json && r.json.success === false)) return { action: 'failed', reason: `update failed: ${r.error || describeError(r.status, r.json)}` };
  return { action: 'updated', reason: describeChanges(changes) };
}

// ---------- results log ----------

function resultsPath(dir, live, now = new Date()) {
  const base = `results-${todayIso(now)}${live ? '' : '-dry-run'}`;
  let p = path.join(dir, `${base}.csv`);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${base}-${n}.csv`);
  return p;
}

function writeResults(file, results) {
  const lines = ['memberNumber,action,reason', ...results.map(r => [r.memberNumber, r.action, r.reason].map(csvCell).join(','))];
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
}

// ---------- main ----------

async function run(opts, deps = {}) {
  const log = deps.log || console.log;
  const env = deps.env || process.env;
  const now = deps.now || new Date();
  const outDir = deps.outDir || process.cwd();

  if (!fs.existsSync(opts.file)) throw new FatalError(`Can't find the file "${opts.file}". Check the name and that it's in this folder.`);
  const { headers, records } = parseCsv(fs.readFileSync(opts.file, 'utf8'));
  const missing = REQUIRED_COLUMNS.filter(c => !headers.includes(c));
  if (missing.length) {
    throw new FatalError(`This doesn't look like a file from the GYC Pass Converter. Missing column(s): ${missing.join(', ')}.\n` +
      'Run the Sailing Club Manager export through the converter first, then use the file it downloads.');
  }
  if (!records.length) throw new FatalError('The file has no member rows.');

  const apiKey = (env.PASSCREATOR_API_KEY || '').trim();
  const templateId = (env.PASSCREATOR_TEMPLATE_ID || '').trim();
  const online = Boolean(apiKey && templateId);
  if (opts.live && !online) {
    throw new FatalError('To run live, PASSCREATOR_API_KEY and PASSCREATOR_TEMPLATE_ID must both be set in the .env file.');
  }

  log(opts.live ? 'LIVE RUN: passes will be created and updated on Passcreator.' : 'DRY RUN: nothing will be changed on Passcreator.');
  if (!opts.live && !online) log('No API key or template ID set, so only the file is checked (Passcreator is not contacted).');
  if (online) log(`Template: ${templateId}`);
  log(`Reading ${records.length} member row(s) from ${opts.file}\n`);

  const client = online ? makeClient({ apiKey, ...deps.client }) : null;
  const checked = validateRows(records, todayIso(now));
  const results = [];
  let i = 0;
  for (const { row, rowNo, error } of checked) {
    i++;
    let outcome;
    if (error) outcome = { action: 'failed', reason: `row ${rowNo}: ${error}` };
    else if (!online) outcome = { action: 'ok (not checked)', reason: row.email ? '' : 'no email, so the card link must be sent by hand' };
    else outcome = await processRow(client, templateId, row, opts.live);
    results.push({ memberNumber: row.memberNumber, ...outcome });
    log(`  [${i}/${checked.length}] ${row.memberNumber || '(no number)'}: ${outcome.action}${outcome.reason ? ' - ' + outcome.reason : ''}`);
  }

  const file = resultsPath(outDir, opts.live, now);
  writeResults(file, results);

  const counts = {};
  for (const r of results) counts[r.action] = (counts[r.action] || 0) + 1;
  log('\nSummary');
  for (const [action, n] of Object.entries(counts)) log(`  ${action.padEnd(17)} ${n}`);
  log(`  ${'total'.padEnd(17)} ${results.length}`);
  log(`\nFull log saved to ${path.relative(process.cwd(), file) || file}`);
  if (counts.failed) log('Some rows failed. Open the log, fix those members in Sailing Club Manager, re-export and run again.');
  if (!opts.live) log('This was a dry run. When it looks right, run the same command with --live on the end.');
  return { results, counts, file };
}

if (require.main === module) {
  loadEnvFile(path.join(__dirname, '.env'));
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log('Usage: node import.js --file <converter csv> [--dry-run | --live]\nDry run is the default. See README.md.');
    process.exit(0);
  }
  run(opts).then(
    ({ counts }) => process.exit(counts.failed ? 1 : 0),
    e => {
      console.error('\nStopped: ' + (e instanceof FatalError ? e.message : `unexpected problem: ${e && e.stack || e}`));
      process.exit(2);
    },
  );
}

module.exports = { parseCsv, validateRows, changedData, desiredData, makeClient, processRow, run, FIELD_KEYS, FatalError };
