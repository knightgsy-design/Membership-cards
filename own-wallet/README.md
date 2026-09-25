# GYC Cards — own Apple & Google accounts (no Passcreator)

This is a second, independent way to issue GYC membership cards, alongside the Passcreator-based
site. It talks to Apple Wallet and Google Wallet directly, using the club's own Apple Developer and
Google Cloud accounts, so there's no per-card fee and no third party in the middle. It keeps its own
list of members and cards — it has never heard of Passcreator, and Passcreator has never heard of it.

**Read this before using it.** Getting this working needs real accounts and certificates from Apple
and Google, which only the club (not Claude) can obtain, and it costs more of your own time to set up
and keep working than the Passcreator site did. The trade-off, in plain terms:

| | Passcreator site | This system |
|---|---|---|
| Ongoing cost | Passcreator subscription | Apple Developer: **$99/year**. Google Wallet API: free. |
| Setup effort | Netlify + one API key | Netlify + an Apple Developer account, a Pass Type ID certificate, a Google Cloud project, a service account, and (for Apple) a push key |
| Card emails | Passcreator sends them | Nothing sends emails; you get a link per member and send it yourself |
| Who maintains the card designer/import UI | Passcreator's screens | Only this code — a change means editing `card-design.js`-equivalent settings here |
| What breaks if a certificate expires | Nothing (Passcreator's problem) | Apple's Pass Type ID certificate expires yearly and must be renewed and re-uploaded, or every card silently stops updating |

If that trade-off doesn't suit, the Passcreator site (`public/index.html`) remains the simpler option.
This one exists because you asked for a version that doesn't depend on it.

## What you'll need

### Apple (for Apple Wallet cards)
1. An **Apple Developer Program** account for the club ($99/year): https://developer.apple.com/programs/enroll/
2. A **Pass Type ID**, created in that account (Certificates, Identifiers & Profiles → Identifiers →
   Pass Type IDs), e.g. `pass.gg.gyc.membership`.
3. A **Pass Type ID certificate** for that identifier (created from the same page — it will ask you to
   upload a Certificate Signing Request, which Keychain Access on a Mac can generate, or `openssl`).
   Download it as a `.cer` file, import it into Keychain Access, then export it *with its private key*
   as a `.p12` file, protected with a password.
4. Apple's **WWDR intermediate certificate** (G4), downloaded from
   https://www.apple.com/certificateauthority/ — a public file, not secret.
5. *(Optional but recommended)* An **APNs Auth Key** (a `.p8` file), from the same developer account
   (Certificates, Identifiers & Profiles → Keys → create a key with the "Apple Push Notifications
   service" capability). Without this, cards still work, but a renewed card won't update on a member's
   phone until they reopen Wallet themselves — with it, updates happen automatically within moments.

Converting the `.p12` and `.p8` files to the plain-text (PEM) format this system needs, and then to
base64 for pasting into Netlify, is a job for whoever sets this up technically — see "Turning files
into environment variables" below.

### Google (for Google Wallet cards)
1. A **Google Cloud project** for the club: https://console.cloud.google.com
2. Apply for **Google Wallet API** access (Business Console): https://pay.google.com/business/console
   — this needs Google's approval, which can take a few days, and needs the club's own **Issuer ID**.
3. Enable the **Google Wallet API** on the Cloud project, then create a **service account** with the
   "Wallet Object Issuer" role, and download its **JSON key** — this contains the private key this
   system signs with.
4. Add the service account's email as a member on the Google Wallet Business Console issuer account.

### Netlify
A separate Netlify site from the Passcreator one (so the two don't interfere), **without** Netlify's
own site password — some of this site's pages must stay reachable by members' phones and by Apple's
and Google's own servers, which a site-wide password would block. Instead, the secretary-facing parts
are protected by a passphrase this system checks itself (see below).

## Turning files into environment variables

Netlify environment variables are plain text, so certificates and keys (which are binary or multi-line
text) are base64-encoded first. On a Mac or Linux computer, in Terminal:

```
openssl pkcs12 -in cert.p12 -clcerts -nokeys -out cert.pem       # then base64 cert.pem
openssl pkcs12 -in cert.p12 -nocerts -nodes -out key.pem         # then base64 key.pem
base64 -i cert.pem | tr -d '\n'     # copy this into APPLE_PASS_CERT_PEM_BASE64
base64 -i key.pem | tr -d '\n'      # copy this into APPLE_PASS_KEY_PEM_BASE64
base64 -i AppleWWDRCAG4.pem | tr -d '\n'   # copy into APPLE_WWDR_PEM_BASE64
base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n'   # copy into APPLE_APNS_KEY_PEM_BASE64
```

For Google, open the downloaded service account JSON file and copy two fields out of it:
`client_email` (goes straight into `GOOGLE_WALLET_CLIENT_EMAIL`) and `private_key` (base64-encode the
whole value, including the `-----BEGIN PRIVATE KEY-----` lines, into `GOOGLE_WALLET_PRIVATE_KEY_PEM_BASE64`).

This is fiddly one-off work. If nobody at the club is comfortable with a terminal, ask whoever looks
after this site to do it once — after that, nobody needs to touch it again until a certificate expires.

## Environment variables (set in the Netlify site settings)

| Variable | From | Required for |
|---|---|---|
| `APPLE_PASS_TYPE_ID` | The Pass Type ID identifier | Apple |
| `APPLE_TEAM_ID` | Apple Developer account → Membership | Apple |
| `APPLE_PASS_CERT_PEM_BASE64` | The Pass Type ID certificate | Apple |
| `APPLE_PASS_KEY_PEM_BASE64` | Its private key | Apple |
| `APPLE_PASS_KEY_PASSPHRASE` | Only if you set one exporting the key | Apple (if used) |
| `APPLE_WWDR_PEM_BASE64` | Apple's WWDR G4 certificate | Apple |
| `APPLE_APNS_KEY_PEM_BASE64` | The `.p8` auth key | Apple push updates (optional) |
| `APPLE_APNS_KEY_ID` | Shown when you create the key | Apple push updates (optional) |
| `GOOGLE_WALLET_ISSUER_ID` | Google Wallet Business Console | Google |
| `GOOGLE_WALLET_CLIENT_EMAIL` | Service account JSON, `client_email` | Google |
| `GOOGLE_WALLET_PRIVATE_KEY_PEM_BASE64` | Service account JSON, `private_key` (base64'd) | Google |
| `GOOGLE_WALLET_ORIGINS` | This site's web address, e.g. `https://gyc-own-wallet.netlify.app` | Google |
| `OWN_WALLET_PASSPHRASE` | Make one up | Always — locks the secretary pages |
| `URL` | Set automatically by Netlify | Always |

You can set only the Apple ones, only the Google ones, or both — each works independently. The page's
banner shows which are ready.

## Everyday use

Open `/own-wallet.html` on this site, enter the passphrase, and it works like the Passcreator site:
set the season, drop in the Sailing Club Manager export, practice run, go live. There's also a form to
add one member by hand, and a list of issued cards.

**No emails are sent automatically.** For each member, click "Get wallet links" to get their personal
Apple Wallet and/or Google Wallet link, and send it however you'd send anything else — your own email,
the club's newsletter system, or a text message.

**Reconciling a fresh export against issued cards isn't built here yet** (the Passcreator site has
this; this one doesn't). Ask for it if you want it added.

## What's stored, and where

Every member's card details live in Netlify Blobs, attached to this Netlify site — a small database
Netlify provides, invisible in the file system, separate from Passcreator entirely. Deleting the site
deletes this data. There's no separate backup: Sailing Club Manager remains the master record, and this
system can always be rebuilt from a fresh export.

## Renewing the Apple certificate

Apple's Pass Type ID certificate expires about a year after it's issued. Before it does, repeat the
"Apple" steps above to get a new one, and update `APPLE_PASS_CERT_PEM_BASE64` and
`APPLE_PASS_KEY_PEM_BASE64` in Netlify. If it lapses, existing cards keep working but stop updating,
and no new cards can be created until it's renewed.

## How it works, for whoever maintains this

- `lib/config.js` — reads and validates the environment variables above.
- `lib/store.js` — Netlify Blobs: one record per member, plus Apple device-registration records.
- `lib/applePkpass.js` — builds a `.pkpass` (a signed zip) for one member: `pass.json`, the club's
  icon/logo, `manifest.json` (SHA-1 of each file), and a detached PKCS#7 signature over the manifest,
  using the Pass Type ID certificate chained to Apple's WWDR certificate. Verified during development
  against `openssl cms -verify`.
- `lib/applePush.js` — sends an APNs "background" push (an empty JSON body to
  `/3/device/{token}`, topic = the Pass Type ID) telling a phone to re-fetch a changed pass. Auth is a
  short-lived ES256 JWT signed with the `.p8` key, per Apple's token-based APNs authentication.
- `lib/googleWallet.js` — creates/updates one shared `genericClass` (the card's look) and one
  `genericObject` per member, via `walletobjects.googleapis.com`, authenticated as the service account
  (a JWT-bearer OAuth exchange). `saveLink()` builds the signed "Add to Google Wallet" JWT link.
- `lib/passRecord.js` — the glue: creates/updates/deletes a member's record and pushes the change to
  whichever wallets are configured.
- `lib/pngGenerator.js` — a tiny built-in PNG encoder so Apple cards have *some* icon/logo out of the
  box (a plain navy-and-gold square). Set `APPLE_ICON_PNG_BASE64`, `APPLE_ICON2X_PNG_BASE64`,
  `APPLE_LOGO_PNG_BASE64`, `APPLE_LOGO2X_PNG_BASE64` (each a base64'd PNG) to use the club's real
  artwork instead. Apple's recommended sizes: icon 29×29 / 58×58, logo up to 160×50 / 320×100.
- Card design (front/back fields, colours, club contact details) is set directly in
  `lib/applePkpass.js` and `lib/googleWallet.js` — there's no visual editor for this system.

`netlify/functions/own-wallet.mjs` is the secretary-facing API (status/run/list/delete/links), gated by
`OWN_WALLET_PASSPHRASE`. `netlify/functions/apple-pkpass.mjs` and `netlify/functions/apple-passkit.mjs`
are deliberately **not** gated — they're what a member's phone and Apple's own servers call, and must
stay reachable by anyone. `npm test` covers the signing, both wallets' API calls (against fakes, not
real Apple/Google), and the PassKit protocol end to end; it does not and cannot test against real Apple
or Google servers.
