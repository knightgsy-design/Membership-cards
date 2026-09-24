# GYC wallet membership cards: yearly update

**Easiest way: use the website.** Go to https://gyc-membership-cards.netlify.app, sign in, and
follow the four steps on the page: set the season, add the Sailing Club Manager export, check
the members, then **Practice run** and **Go live**. Download the results log at the end and keep it.
The page shows at the top whether it's connected to the TEST template or the REAL one.
At the bottom, **Cards already issued** lists every card, shows whether each member has added it to
their phone, and has a **Send card email** button to (re)send a card.
Nothing needs installing. The rest of this file covers the offline alternative (running it
on your own computer), which does the same job.

---

This folder puts members' Guernsey Yacht Club cards into Apple Wallet and Google Wallet,
and updates them each year after renewals close. You run it about once a year.

It never changes anything in Sailing Club Manager. It only creates or updates cards on Passcreator.

You will need:
- a computer (Windows or Mac)
- about 30 minutes the first time, 10 minutes after that
- the Passcreator login

---

## First time only: set up the computer

### 1. Install Node
Node is the free program that runs the update.

1. Go to https://nodejs.org and download the version marked **LTS**.
2. Open the download and click through the installer, accepting the defaults.

### 2. Put this folder somewhere easy
For example, your Documents folder. Keep the name `gyc-wallet-passes`.

### 3. Open a command window in this folder
- **Windows:** open the folder, click in the address bar at the top, type `cmd` and press Enter.
- **Mac:** open the Terminal app, type `cd ` (with a space after it), drag the folder
  into the Terminal window, then press Enter.

To check Node is installed, type this and press Enter:

```
node --version
```

You should see a number such as `v22.1.0`. If you see "not recognised" or "command not found",
restart the computer and try again.

### 4. Add the Passcreator key
The key is like a password that lets this program use the club's Passcreator account.

1. In this folder, make a copy of the file `.env.example` and name the copy `.env`
   (a dot, then `env`, with nothing after it).
   - On Windows, if you can't see the file, choose **View > Show > File name extensions** and **Hidden items**.
   - On a Mac, press **Cmd + Shift + .** in the folder to show hidden files.
2. Open `.env` in Notepad (Windows) or TextEdit (Mac).
3. Log in to Passcreator, go to **Integrations > API Keys**, create a key called
   "GYC yearly update", and copy it.
4. Paste it after `PASSCREATOR_API_KEY=` with no spaces.
5. After `PASSCREATOR_TEMPLATE_ID=` paste the ID of the membership card template.
   You'll find it in Passcreator on the template's page. **The first time, use the test template,
   not the real one** (see "Trying it safely" below).
6. Save the file.

Keep the key private. Don't email it or paste it into a chat. If it has ever been shared,
delete it in Passcreator and make a new one.

---

## Every year, after renewals close

### Step 1. Export members from Sailing Club Manager
Export current members as a CSV file.

### Step 2. Convert the file
Open the **GYC Pass Converter** (`reference/gyc-pass-converter.html` in this folder,
or the hosted link in `reference/links.md`).

1. Set the season (for example `2026/27`) and the season end date.
2. Drop the export onto the page.
3. Read any warnings or errors. Errors mean a member is left out, so fix those members in
   Sailing Club Manager and export again.
4. Click **Download Passcreator file** and save it into **this folder**.

### Step 3. Do a practice run (dry run)
In the command window, type the following, using your file's name, and press Enter:

```
node import.js --file passcreator-import-2026-27.csv
```

Nothing changes on Passcreator during a practice run. It checks every row and tells you what
it *would* do:

| You see | Meaning |
|---|---|
| `would create` | This member has no card yet. A new card will be made and emailed to them. |
| `would update` | The member has a card. It will be updated (the log says what changes). |
| `unchanged` | The card is already correct. Nothing to do. |
| `failed` | Something is wrong with this row. The reason is shown next to it. |

### Step 4. Do it for real (live run)
If the practice run looks right, press the up-arrow key to bring back the same command, add
`--live` at the end, and press Enter:

```
node import.js --file passcreator-import-2026-27.csv --live
```

This time you'll see `created`, `updated`, `unchanged` or `failed`.

- Members whose card is **created** get an email with a button to add it to their phone.
- Members whose card is **updated** don't need to do anything. Their card changes on their phone
  by itself (it can take a few minutes).

### Step 5. Check the log
Each run saves a log in this folder, named with the date, for example `results-2026-09-24.csv`
(practice runs end in `-dry-run`). Open it in Excel or Numbers. It has one line per member:
member number, what happened, and why.

It's safe to run the live command again. Members already done show as `unchanged`, and only
the ones that failed are retried.

---

## If something goes wrong

| Message | What to do |
|---|---|
| `Can't find the file` | Check the file is in this folder and the name is typed exactly, including `.csv`. |
| `This doesn't look like a file from the GYC Pass Converter` | You used the Sailing Club Manager export directly. Put it through the converter first (Step 2). |
| `Passcreator refused the API key` | The key in `.env` is wrong or was deleted. Make a new one (First time, step 4). |
| `PASSCREATOR_API_KEY and PASSCREATOR_TEMPLATE_ID must both be set` | The `.env` file is missing, misnamed, or one of the two lines is empty. |
| `failed` with `could not reach Passcreator` | The internet dropped. The program already tried again 4 times. Check your connection and run the live command again. |
| `failed` with `too many requests` | Passcreator asked us to slow down. Wait 15 minutes and run it again. |
| `failed` with `membership already expired` | That member's expiry date is in the past. Check their renewal in Sailing Club Manager. |
| `failed` with `duplicate member number` | Two rows have the same member number. Fix it in Sailing Club Manager and export again. |
| `failed` with `another template` | That member number is already used on a different Passcreator card. Ask the Passcreator admin. |
| `failed` with `template has no field named ...` | The card design in Passcreator doesn't match this program. Ask whoever maintains it (see below). |
| `new card, no email so send the link by hand` | This member has no email address. Find their card in Passcreator and send them the link another way. |

If you're stuck, don't try to fix things in Passcreator by hand. Send the log file (not the
`.env` file) to whoever maintains this program.

---

## Trying it safely
Before using it on the real membership template for the first time:

1. In Passcreator, make a copy of the membership template and call it "TEST".
2. Put the TEST template's ID in `.env`.
3. Run the practice run, then the live run, with `sample-data/passcreator-import-sample.csv`
   (made-up members with `example.com` addresses, so no real emails go out).
4. Check the cards in Passcreator look right. Then delete the test cards, and change `.env`
   to the real template's ID.

---

## For whoever maintains this
- Everything is in `import.js`, plain Node 18 or later, with no packages to install. `npm test` runs
  the tests against a fake Passcreator, with no key or network needed.
- A member's card is found by its member number, which is stored as the Passcreator
  `userProvidedId` and also used as the QR code. That's why re-runs update cards rather than making duplicates.
- The Passcreator field names are listed in `FIELD_KEYS` at the top of `import.js`. Check them
  against the template once it's built (see `reference/pass-template-spec.md`).
- The project brief is in `CLAUDE.md`.

### Online version (Netlify)
- Site: `gyc-membership-cards` on the GYC Netlify team. `public/index.html` is the page (the converter
  plus the import); `netlify/functions/passes.mjs` is the server part at `/api/passes`. It reuses `import.js`
  and handles up to 10 members per call, so it stays within Netlify's function time limit.
- Netlify site settings (environment variables): `PASSCREATOR_API_KEY` (mark it as secret) and
  `PASSCREATOR_TEMPLATE_ID`. Change the template ID to switch between the TEST and real templates; the page
  shows which one it's using.
- Access is controlled by Netlify's visitor access settings (team login or site password), which
  cover the function too.
- The site isn't linked to GitHub, so changes need a manual redeploy (or link the repo in Netlify under
  Project configuration > Build & deploy).
