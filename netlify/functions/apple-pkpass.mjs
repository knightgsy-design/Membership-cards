// Public: serves one member's signed .pkpass file, so a browser on their phone can open it and Wallet
// offers to add it. No passphrase here — a member's own phone (and nobody logged in) must be able to
// reach this. The member number is not secret, but it's also all this reveals: a wallet card, not an
// account. Deliberately on a site with no Netlify-level password (see own-wallet/README.md).
'use strict';

import configLib from './lib/config.js';
import passRecord from './lib/passRecord.js';
import imagesLib from './lib/images.js';

const { readConfig, appleReady } = configLib;

export default async (req) => {
  if (req.method !== 'GET') return new Response('Use GET', { status: 405 });
  const memberNumber = new URL(req.url).searchParams.get('member') || '';
  const config = readConfig(Netlify.env);
  if (!appleReady(config)) return new Response('Apple Wallet is not set up on this site yet.', { status: 500 });

  const r = await passRecord.buildApplePkpass(memberNumber.trim(), config, imagesLib.appleImages(config)).catch(e => ({ error: e.message }));
  if (r.error) return new Response(r.error, { status: 404 });

  return new Response(r.buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': `attachment; filename="gyc-membership-${memberNumber.replace(/[^A-Za-z0-9-]/g, '')}.pkpass"`,
      'Cache-Control': 'no-store',
    },
  });
};

export const config = { path: '/pass/apple' };
