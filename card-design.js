// The GYC membership card design, applied to Passcreator by public/setup.html via the Netlify function.
// Layout follows reference/pass-template-spec.md. Edit CLUB below, push, then press
// "Create / update card design" on /setup.html again to update the template.
//
// API: https://developer.passcreator.com/en/api/v2/pass-template
//   create  POST /api/v2/pass-template
//   update  POST /api/v2/pass-template/{id}   (then POST .../publish so existing cards update)
// The Apple pass certificate (passTypeId), icon, logo, Wallet switches and email sendout settings are
// copied from a source template (the one in PASSCREATOR_TEMPLATE_ID): the API can't create those.

'use strict';

const { FIELD_KEYS } = require('./import.js');

const DESIGN_NAME = 'GYC Membership TEST';

// Club details shown on the back of the card. Leave a value empty ('') to leave it off the card.
// Taken from https://www.gyc.org.gg/contact/ on 24 Sep 2026.
const CLUB = {
  name: 'Guernsey Yacht Club',
  address: 'Castle Emplacement, St Peter Port, Guernsey GY1 1AU',
  phone: '+44 (0)1481 722838',
  email: 'club@gyc.org.gg',
  website: 'https://www.gyc.org.gg',
  memberPortal: 'https://members.gyc.org.gg/portal',   // Sailing Club Manager member login
  events: 'https://members.gyc.org.gg/events',         // events calendar and booking
};

const COLORS = { backgroundColor: '#13294B', foregroundColor: '#FFFFFF', labelColor: '#D7B46A' };

const ph = key => `{${key}}`; // Passcreator placeholder for an additional property, e.g. {memberName}

function field(label, value, extra = {}) {
  return { type: 'text', label, value, ...extra };
}

function buildTemplate(source, name = DESIGN_NAME) {
  const src = source || {};
  const srcImages = src.images || {};
  const hasLogo = Boolean(srcImages.logo) && !srcImages.logoHidden;

  const contact = [CLUB.name, CLUB.address, CLUB.phone, CLUB.email].filter(Boolean).join('\n');
  const links = [
    CLUB.memberPortal && { label: 'Manage my membership', value: CLUB.memberPortal },
    CLUB.events && { label: 'Book club events', value: CLUB.events },
    CLUB.website && { label: 'Club website', value: CLUB.website },
    CLUB.phone && { label: 'Call the club', value: 'tel:' + CLUB.phone.replace(/\(0\)/g, '').replace(/[^+\d]/g, '') },
    CLUB.email && { label: 'Email the club', value: 'mailto:' + CLUB.email },
  ].filter(Boolean);

  const tpl = {
    name,
    description: 'GYC wallet membership card. Cards are created and renewed by the GYC Membership Cards site; match on member number (userProvidedId).',
    organizationName: CLUB.name,
    type: 'generic',
    passTypeId: src.passTypeId,
    logoText: hasLogo ? '' : CLUB.name,
    expiration: {
      expirationDateDifferentForEachPass: true,
      limitExpirationDateOfPassWithTemplate: false,
      fallbackToTemplateExpirationDateIfEmpty: false,
    },
    fields: {
      headerFields: [field('Season', ph(FIELD_KEYS.season), { alignment: 'PKTextAlignmentRight' })],
      primaryFields: [field('Member', ph(FIELD_KEYS.memberName))],
      secondaryFields: [
        field('Membership', ph(FIELD_KEYS.membershipType)),
        field('Valid to', ph(FIELD_KEYS.validTo), { changeMessage: 'Membership renewed: valid to %@', alignment: 'PKTextAlignmentRight' }),
      ],
      auxiliaryFields: [field('Member no.', ph(FIELD_KEYS.memberNumber))],
      backFields: [
        field('Latest from the club', 'Welcome aboard for the new season.', { changeMessage: '%@' }),
        field('At the club', 'Show this card at the bar for member prices, and at the door for member-only events.'),
        field('Contact', contact),
        field('Terms', 'Personal to the named member and not transferable.'),
      ],
    },
    barcode: {
      format: 'PKBarcodeFormatQR',
      value: ph(FIELD_KEYS.memberNumber),
      valueDifferentForEachPass: false,
      useAutoIdForValue: false,
      alternativeText: '',
    },
    links,
    images: {
      icon: srcImages.icon,
      logo: hasLogo ? srcImages.logo : null,
      logoHidden: !hasLogo,
      background: null,
      backgroundHidden: true,
      thumbnail: null,
      thumbnailHidden: true,
      ...(srcImages.googlePayLogo ? { googlePayLogo: srcImages.googlePayLogo } : {}),
    },
    colors: { ...COLORS, voidedBackgroundColor: '#5B6573' },
    googlePayActive: Boolean(src.googlePayActive),
    googleWallet: { cardTitle: CLUB.name, header: ph(FIELD_KEYS.memberName), subHeader: ph(FIELD_KEYS.membershipType) },
    additionalProperties: [
      { name: FIELD_KEYS.memberNumber, type: 'text', required: true },
      { name: FIELD_KEYS.memberName, type: 'text', required: true },
      { name: FIELD_KEYS.membershipType, type: 'text' },
      { name: FIELD_KEYS.validTo, type: 'text' },
      { name: FIELD_KEYS.season, type: 'text' },
    ],
    enforceUniqueUserProvidedId: true,
    askForUserProvidedIdInBacked: true,
    sharingProhibited: true,
    hidePrintVersion: true,
  };
  if (src.walletApps) tpl.walletApps = src.walletApps;
  if (src.sendoutOptions) {
    const s = src.sendoutOptions;
    const pick = o => (o ? { emailTemplate: o.emailTemplate ?? null, subject: o.subject || '' } : undefined);
    tpl.sendoutOptions = {
      adHoc: pick(s.adHoc),
      downloadPages: pick(s.downloadPages),
      passCreationNotification: s.passCreationNotification
        ? { ...pick(s.passCreationNotification), recipient: s.passCreationNotification.recipient || '' }
        : undefined,
    };
  }
  return tpl;
}

// What the setup page should warn about after applying the design.
function designWarnings(source) {
  const w = [];
  const s = (source && source.sendoutOptions) || {};
  if (!s.adHoc || !s.adHoc.emailTemplate) w.push('No email template for sending cards ("ad hoc" sendout) was set on the source template, so card emails won\'t send. In Passcreator, open the new template\'s sendout/email settings and pick an email template.');
  if (!source || !source.googlePayActive) w.push('Google Wallet is off on the source template, so it is off on the new one too. Turn it on in Passcreator if members use Android.');
  const missing = Object.entries({ phone: CLUB.phone, email: CLUB.email, website: CLUB.website, 'member portal link': CLUB.memberPortal, 'events link': CLUB.events })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) w.push(`Not on the card yet (send these to whoever looks after the site): club ${missing.join(', ')}.`);
  return w;
}

module.exports = { buildTemplate, designWarnings, DESIGN_NAME, CLUB };
