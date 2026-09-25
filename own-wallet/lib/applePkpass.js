// Builds a signed .pkpass file for a member, from scratch (no Passcreator involved).
//
// Format: https://developer.apple.com/documentation/walletpasses — a .pkpass is a zip containing
// pass.json, the images, and a manifest.json (SHA-1 of every file) signed as a detached PKCS#7/CMS
// signature with the club's Pass Type ID certificate, chained to Apple's WWDR intermediate certificate.
'use strict';

const forge = require('node-forge');
const JSZip = require('jszip');

const COLORS = { background: 'rgb(19,41,75)', foreground: 'rgb(255,255,255)', label: 'rgb(215,180,106)' };

function field(key, label, value) { return { key, label, value: value == null ? '' : String(value) }; }

// Builds pass.json for one member. `webServiceURL` and `authenticationToken` are what makes the pass
// register for push updates; omit both to issue a pass that never auto-updates (still downloadable).
function buildPassJson(record, config) {
  const { apple } = config;
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: apple.passTypeId,
    teamIdentifier: apple.teamId,
    serialNumber: record.memberNumber,
    organizationName: 'Guernsey Yacht Club',
    description: 'GYC membership card',
    logoText: 'Guernsey Yacht Club',
    backgroundColor: COLORS.background,
    foregroundColor: COLORS.foreground,
    labelColor: COLORS.label,
    generic: {
      headerFields: [field('season', 'Season', record.season)],
      primaryFields: [field('memberName', 'Member', record.memberName)],
      secondaryFields: [field('membershipType', 'Membership', record.membershipType), field('validTo', 'Valid to', record.validTo)],
      auxiliaryFields: [field('memberNumber', 'Member no.', record.memberNumber)],
      backFields: [
        field('notice', 'Latest from the club', 'Welcome aboard for the new season.'),
        field('atClub', 'At the club', 'Show this card at the bar for member prices, and at the door for member-only events.'),
        field('contact', 'Contact', 'Guernsey Yacht Club, Castle Emplacement, St Peter Port, Guernsey GY1 1AU\n+44 (0)1481 722838\nclub@gyc.org.gg'),
        field('terms', 'Terms', 'Personal to the named member and not transferable.'),
      ],
    },
    barcodes: [{ message: record.memberNumber, format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1' }],
  };
  if (record.passExpiry) pass.expirationDate = `${record.passExpiry}T23:59:00${londonOffset(record.passExpiry)}`;
  if (apple.webServiceBase && record.authToken) {
    pass.webServiceURL = apple.webServiceBase.replace(/\/$/, '') + '/apple';
    pass.authenticationToken = record.authToken;
  }
  return pass;
}

// A rough British-Isles UTC offset (+00:00 in winter, +01:00 in summer/BST) good enough for an
// end-of-day expiry date; Apple only needs a valid, unambiguous instant.
function londonOffset(isoDate) {
  const d = new Date(isoDate + 'T12:00:00Z');
  const jan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).getTimezoneOffset ? 0 : 0;
  // Node has no timezone database guarantee in all runtimes; approximate BST as late Mar–late Oct.
  const m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const bst = (m > 3 && m < 10) || (m === 3 && day >= 25) || (m === 10 && day < 25);
  return bst ? '+01:00' : '+00:00';
}

function sha1Hex(buf) {
  const md = forge.md.sha1.create();
  md.update(buf.toString('binary'));
  return md.digest().toHex();
}

// Detached PKCS#7 signature of manifest.json, using the Pass Type ID certificate (+ WWDR chain) and key.
function signManifest(manifestBuf, config) {
  const { apple } = config;
  const cert = forge.pki.certificateFromPem(apple.certPem);
  const wwdr = forge.pki.certificateFromPem(apple.wwdrPem);
  const key = forge.pki.decryptRsaPrivateKey(apple.keyPem, apple.keyPassphrase || undefined) || forge.pki.privateKeyFromPem(apple.keyPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestBuf.toString('binary'));
  p7.addCertificate(cert);
  p7.addCertificate(wwdr);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest }, // filled in automatically from p7.content
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, 'binary');
}

// images: { iconPng, icon2xPng, logoPng, logo2xPng } Buffers (see own-wallet/assets and README).
async function buildPkpass(record, config, images) {
  const passJson = buildPassJson(record, config);
  const files = {
    'pass.json': Buffer.from(JSON.stringify(passJson), 'utf8'),
    'icon.png': images.iconPng,
    'icon@2x.png': images.icon2xPng,
    'logo.png': images.logoPng,
    'logo@2x.png': images.logo2xPng,
  };
  const manifest = {};
  for (const [name, buf] of Object.entries(files)) manifest[name] = sha1Hex(buf);
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  const signature = signManifest(manifestBuf, config);

  const zip = new JSZip();
  for (const [name, buf] of Object.entries(files)) zip.file(name, buf);
  zip.file('manifest.json', manifestBuf);
  zip.file('signature', signature);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildPassJson, buildPkpass, sha1Hex, signManifest };
