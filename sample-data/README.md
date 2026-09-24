Fake data for testing only. Headers are GUESSED: replace with the real Sailing Club
Manager export headers before relying on the mapping. The rows deliberately include
a missing email, a lapsed member, a blank expiry and a duplicate member number.

`passcreator-import-sample.csv` is `scm-export-sample.csv` run through
`reference/gyc-pass-converter.html` (on 24 Sep 2026): the lapsed member (01237) and the
duplicate 01234 row were left out by the converter; 01238's blank expiry became the season end.
Use it for dry runs and test-template runs of `import.js`.
