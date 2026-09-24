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
