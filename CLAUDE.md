# GYC Wallet Membership Passes — project brief for Claude Code

## Goal
Build a small Node.js script that issues and updates Apple Wallet and Google Wallet
membership passes for Guernsey Yacht Club (GYC) through the Passcreator API.

It replaces clicking through Passcreator's CSV import once a year. It is NOT a live
integration: it runs on demand, typically once a year after renewals close.

## Context
- Master member record: Sailing Club Manager (built by Clubmin). Never write back to it.
- Input: the CSV produced by `reference/gyc-pass-converter.html` from a Sailing Club Manager export.
- Output: passes created or updated on one Passcreator template.
- Future operator: a non-technical volunteer membership secretary. Simplicity beats cleverness.

## Hard rules
1. Read Passcreator's API documentation at https://developer.passcreator.com before writing
   any API call. Do not guess endpoints, auth headers or payload shapes. If the docs are
   unclear, stop and ask.
2. The API key comes only from the `PASSCREATOR_API_KEY` environment variable (see `.env.example`).
   Never print, log, commit or hard-code it.
3. The template ID comes from `PASSCREATOR_TEMPLATE_ID`.
4. Match passes on `memberNumber` so existing passes update rather than duplicate.
5. Default to `--dry-run` behaviour unless `--live` is passed.
6. Minimal dependencies. Plain Node (18+) with built-in fetch preferred.
7. Test against a test template before the real one.

## Input CSV columns (from the converter)
| Column | Example | Use |
|---|---|---|
| memberNumber | 01234 | Unique key; also the QR code content |
| memberName | Alex Sample | Front of card |
| email | alex@example.com | Used to send the add-to-wallet link |
| membershipType | Full sailing | Front of card |
| validTo | 31 Mar 2027 | Display label on card |
| passExpiry | 2027-03-31 | Pass expiry date setting |
| season | 2026/27 | Header on card |

Pass template fields are specified in `reference/pass-template-spec.md`.

## Deliverables
1. `import.js` — reads the CSV, validates rows, then for each row creates or updates the pass.
   Flags: `--file <path>`, `--dry-run` (default), `--live`.
2. `results-<date>.csv` log: memberNumber, action (created / updated / unchanged / failed), reason.
3. Clear summary printed at the end: counts per action.
4. Graceful handling of rate limits and network errors (retry with backoff, then log as failed).
5. `README.md` rewritten for the membership secretary: install Node, set the key, run a
   dry run, run live, read the log, what to do if it fails. No jargon.

## Out of scope
- No automatic sync with Sailing Club Manager.
- No web server, no Netlify function (possible later phase only).
- No sending notices; club notices are edited by hand in Passcreator.

## Open items the owner will supply
- Real Sailing Club Manager export column headers (the sample file uses guessed headers).
- Passcreator template ID and exact field keys once the template is built.

## Implementation notes (added when import.js was built)
Checked against https://developer.passcreator.com on 24 Sep 2026.
- Auth: raw key in `Authorization` header (no "Bearer"). Rate limit 600 req/min; the script
  spaces requests 150 ms apart and retries 429/5xx/network errors after 2, 4, 8, 16 s.
- Lookup: `GET /api/pass/{userProvidedId}?includeFieldMapping=true` (V1 Read a Pass, not
  deprecated; also matches identifier or barcode value). 404 means no pass yet. A hit on a
  different template is logged as failed and never touched.
- Create: `POST /api/v3/pass` with `templateId`, `userProvidedId` = `barcodeValue` = memberNumber,
  `enforceUniqueUserProvidedId: true`, `expirationDate` "YYYY-MM-DD 23:59", the card fields, and
  `emailRecipient` when there is an email (Passcreator sends the pass only if the template's
  sendout settings have an email template selected).
- Update: `PATCH /api/v3/pass/{identifier}` with changed fields only; no `emailRecipient`, so
  renewals don't re-send emails. No changes means "unchanged" and no write.
- Field keys live in `FIELD_KEYS` in import.js. They're still unconfirmed (open item above).
- `npm test` runs against an in-memory fake Passcreator.

## Online version (added later, at the owner's request)
- Netlify project `gyc-membership-cards` (team `knightgsy`, site id d1a211b0-0e92-4e45-8191-b83ce2aa512e).
- `public/index.html` = converter + import UI; `netlify/functions/passes.mjs` = `/api/passes`, reusing
  import.js. Batches of up to 10 members per call; the function retries after 1 s and 2 s, and the page
  retries whole batches after 2, 4 and 8 s (safe, because each row is looked up before writing).
- `status` action: `GET /api/pass-template` (V1 list templates), used to show the template name.
- Go live is only enabled after a practice run of the identical data.
- `npm test` covers the function; the page was tested end to end in Chromium against a fake Passcreator.
- Issued cards list: `list` action -> `GET /api/v3/pass?query=<base64url>` (templateId, userProvidedId notEmpty),
  `formatKeyAdditionalProperties=name`, 100 per page, following only Passcreator's own `page.next` links.
  "On phone" = active Apple/Google registrations. The API has no per-pass "email sent" status (only message
  webhooks), so the page offers `email` -> `POST /api/pass/deliver/{identifier}/email/{address}` instead; it needs
  an *ad hoc* email template on the pass template.
- Card design: `card-design.js` (layout, colours, back fields, CLUB details). `/setup.html` -> `design` action:
  describe the connected template (`GET /api/v2/pass-template/{id}/describe`), copy passTypeId, icon/logo, walletApps,
  googlePayActive and sendoutOptions, then create "GYC Membership TEST" (`POST /api/v2/pass-template`) or update it
  (`POST /api/v2/pass-template/{id}` + `/publish`). Never writes the source template. The API has no way to create
  email templates, so emails need an email template picked in Passcreator; until then the page offers a mailto
  fallback and a card-links CSV for a mail-merge. Club phone/email/website/portal/events links are still blank in CLUB.
- Manual add: page form -> `run` action with one member (practice, confirm, then live). Reconcile: page loads all
  `list` pages and compares them with the export's valid rows (name, membership type, valid to, season); fixes reuse
  `run` (live) and `delete`. Cards not in the export, including lapsed members, are offered for deletion; bulk
  delete needs DELETE typed.

## Parallel system: own Apple/Google accounts, no Passcreator (added later, at the owner's request)
See `own-wallet/README.md` for full detail (accounts needed, costs, env vars, architecture). Summary:
- Completely independent of the Passcreator system above: its own storage (Netlify Blobs), its own
  card design (`own-wallet/lib/applePkpass.js`, `own-wallet/lib/googleWallet.js`), its own UI
  (`public/own-wallet.html`). Meant to run as a *separate* Netlify site so the two don't interfere.
- Apple: builds and signs `.pkpass` files itself (PKCS#7/CMS via node-forge, verified against
  `openssl cms -verify` during development) and implements Apple's PassKit web service protocol
  (register/unregister/list-updated/get-pass/log) plus APNs push, using the club's own Pass Type ID
  certificate and (optionally) an APNs auth key. No Apple Developer account = no Apple cards.
  https://developer.apple.com/documentation/walletpasses
- Google: creates/updates a `genericClass`/`genericObject` via `walletobjects.googleapis.com` under
  the club's own Google Cloud service account, and builds "Add to Google Wallet" JWT save links.
  https://developers.google.com/wallet/generic/rest/v1
- The secretary-facing API (`netlify/functions/own-wallet.mjs`) is gated by an app-level passphrase
  (`OWN_WALLET_PASSPHRASE`), not Netlify's site password, because the PassKit web service
  (`apple-passkit.mjs`) and the pass-download endpoint (`apple-pkpass.mjs`) must stay reachable by
  members' phones and Apple's own servers — a site-wide password would block them.
- No email sending here (unlike Passcreator): the UI hands back a personal Apple/Google wallet link
  per member for the secretary to send however they choose.
- `npm test` covers this with a self-signed test certificate (Apple) and a fake fetch (Google) — never
  against real Apple/Google infrastructure, which isn't available from here.

## Dashboard, find-member, announcements (added to own-wallet, matching a committee-dashboard mockup)
- `stats` action: cards issued, Apple/Google split, expiring within 30 days, membership types present,
  and `certDaysRemaining` (parsed from the Apple cert's real notAfter date via node-forge).
- `announce` action: sets each targeted member's stored `notice` (shown on the Apple card's back field,
  changeMessage triggers the on-device banner) and pushes; for Google, calls
  `genericObject/{id}/addMessage` with `messageType: TEXT_AND_NOTIFY`
  (https://developers.google.com/wallet/reference/rest/v1/genericobject/addmessage). Capped at 500
  members per call.
- Deliberately NOT built: automatic Sailing Club Manager sync (the mockup showed one; out of scope per
  the top of this file, and no SCM API access exists to build it). "Email members without a card" is a
  CSV download for a mail-merge, not real sending — this system has no email sender.
