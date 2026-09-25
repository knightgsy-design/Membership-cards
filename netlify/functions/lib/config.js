// Reads and validates the environment variables the own-wallet system needs. Every secret is set as
// a Netlify environment variable, never in code. See own-wallet/README.md for how to obtain each one.
'use strict';

// Accepts either the real `Netlify.env` object (has .get()) or a plain object (tests, and anything
// that already collected the values some other way).
function need(env, key) {
  const raw = typeof env.get === 'function' ? env.get(key) : env[key];
  return (raw || '').trim();
}

// Certificates and keys are stored base64-encoded in env vars (Netlify env var values are plain text,
// so binary/PEM material is base64'd to survive copy-paste).
function b64(env, key) {
  const v = need(env, key);
  if (!v) return '';
  try { return Buffer.from(v, 'base64').toString('utf8'); } catch { return ''; }
}
function b64Raw(env, key) {
  const v = need(env, key);
  if (!v) return null;
  try { return Buffer.from(v, 'base64'); } catch { return null; }
}

function readConfig(env = process.env) {
  return {
    apple: {
      passTypeId: need(env, 'APPLE_PASS_TYPE_ID'),
      teamId: need(env, 'APPLE_TEAM_ID'),
      // Pass Type ID certificate + private key, PEM format, base64-encoded (export from Keychain Access
      // as .p12 then convert, or use openssl to produce separate cert.pem/key.pem — see README).
      certPem: b64(env, 'APPLE_PASS_CERT_PEM_BASE64'),
      keyPem: b64(env, 'APPLE_PASS_KEY_PEM_BASE64'),
      keyPassphrase: need(env, 'APPLE_PASS_KEY_PASSPHRASE'),
      wwdrPem: b64(env, 'APPLE_WWDR_PEM_BASE64'),
      // APNs auth key (.p8), for push notifications telling phones to fetch the updated pass.
      apnsKeyPem: b64(env, 'APPLE_APNS_KEY_PEM_BASE64'),
      apnsKeyId: need(env, 'APPLE_APNS_KEY_ID'),
      apnsSandbox: need(env, 'APPLE_APNS_SANDBOX') === 'true',
      webServiceBase: need(env, 'URL') || need(env, 'DEPLOY_PRIME_URL') || '',
    },
    google: {
      issuerId: need(env, 'GOOGLE_WALLET_ISSUER_ID'),
      classSuffix: need(env, 'GOOGLE_WALLET_CLASS_SUFFIX') || 'gyc_membership',
      serviceAccountEmail: need(env, 'GOOGLE_WALLET_CLIENT_EMAIL'),
      privateKeyPem: b64(env, 'GOOGLE_WALLET_PRIVATE_KEY_PEM_BASE64'),
      origins: need(env, 'GOOGLE_WALLET_ORIGINS').split(',').map(s => s.trim()).filter(Boolean),
    },
    images: {
      iconPng: b64Raw(env, 'APPLE_ICON_PNG_BASE64'),
      icon2xPng: b64Raw(env, 'APPLE_ICON2X_PNG_BASE64'),
      logoPng: b64Raw(env, 'APPLE_LOGO_PNG_BASE64'),
      logo2xPng: b64Raw(env, 'APPLE_LOGO2X_PNG_BASE64'),
    },
  };
}

function appleReady(c) {
  return Boolean(c.apple.passTypeId && c.apple.teamId && c.apple.certPem && c.apple.keyPem && c.apple.wwdrPem);
}
function applePushReady(c) {
  return Boolean(c.apple.apnsKeyPem && c.apple.apnsKeyId);
}
function googleReady(c) {
  return Boolean(c.google.issuerId && c.google.serviceAccountEmail && c.google.privateKeyPem);
}

module.exports = { readConfig, appleReady, applePushReady, googleReady };
