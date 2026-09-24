// TEMPORARY scheduled job (added with the owner's approval while they were travelling; to be removed once it
// has run). Creates the "GYC Membership TEST" card design (card-design.js) if it doesn't exist yet, copying
// the certificate, images and email settings from PASSCREATOR_TEMPLATE_ID. It never updates or deletes
// anything. To change the design later, use the button on /setup.html.
import cli from '../../import.js';
import { applyDesign, readSettings } from './passes.mjs';

export default async () => {
  const { apiKey, templateId } = readSettings();
  if (!apiKey || !templateId) return;
  try {
    const r = await applyDesign(cli.makeClient({ apiKey, retryDelays: [1000, 2000] }), templateId, { createOnly: true });
    if (r.error) console.log('design-once: ' + r.error);
    else if (r.created) console.log(`design-once: created "${r.templateName}" ${r.templateId}. ${r.warnings.join(' ')}`);
  } catch (e) {
    console.log('design-once failed: ' + (e && e.message));
  }
};

export const config = { schedule: '@hourly' };
