# Bitey — Google Play release package

This folder is the single home for the materials needed to publish Bitey on
Google Play.

## Contents

- `LISTINGS.md` — title, tagline, short and full descriptions, and first
  release notes in all twelve launch languages.
- `PRIVACY_NOTICE.md` — the public Privacy Policy text. Replace its marked
  privacy-contact placeholder before publishing it.
- `assets/feature-graphic-base.png` — 1280 × 720 feature-graphic artwork.
- `screenshots/` — authentic Android screenshots and their capture guide.
- `releases/` — the destination for the signed Play App Bundle once the
  Zandaulion upload key is available. Do not commit keystores here or anywhere
  else in the repository.

## Store identity

- Play title: **Bitey — Private Food Log**
- Tagline: **Nutrition, privately.**
- Android package and namespace: `com.zandaulion.bitey`
- Launcher label: **Bitey**
- First release version: **1.0.0** (`versionCode` 1)
- Intended upload artifact: `bitey-private-food-log-1.0.0.aab`

The package name is permanent after the first Play upload. It is deliberately
separate from the pre-release `app.plate` package, so testing installations do
not accidentally become the store identity.

## Before the first upload

1. Create the Bitey app in Play Console with the title and tagline above.
2. Enrol it in Play App Signing and create an upload key kept outside Git.
3. Build a signed release AAB with version code 1.
4. Complete the store listing, privacy policy, Data safety form, content rating,
   camera permission declaration, and testing track requirements.
