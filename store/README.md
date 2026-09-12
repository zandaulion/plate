# Bitey — Google Play release package

This folder is the single home for the materials needed to publish Bitey on
Google Play.

## Contents

- `LISTINGS.md` — title, tagline, short and full descriptions, and first
  release notes in all twelve launch languages.
- `PRIVACY_NOTICE.md` — the public Privacy Policy text. Replace its marked
  privacy-contact placeholder before publishing it.
- `MANUAL_RELEASE_GUIDE.md` — the manual Play Console, privacy, billing, and
  later Firebase/Gemini steps, in the order to perform them.
- `assets/feature-graphic-base.png` — 1280 × 720 feature-graphic artwork.
- `screenshots/` — authentic Android screenshots and their capture guide.
- `releases/` — local signed Play App Bundles ready for Play Console upload.
  Do not commit keystores or signed bundles here or anywhere else in the
  repository.

## Current upload artifact

The local `releases/bitey-private-food-log-1.0.0.aab` is the signed version
1.0.0 (`versionCode` 1) upload bundle. It is intentionally Git-ignored; use
the recorded hash to confirm the file before uploading it to Play Console.

- File SHA-256: `25D7FA1A970F215EA02EB3CAEEF2ACA22CA1F9272F016AC4D6B217C0425FF42F`
- Upload certificate SHA-256:
  `4A:27:74:1E:3B:D3:A6:5F:30:C2:FA:EE:AA:06:4E:E9:67:BF:2B:79:9D:D2:B3:22:1B:6F:2B:50:22:E1:E2:BE`

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
