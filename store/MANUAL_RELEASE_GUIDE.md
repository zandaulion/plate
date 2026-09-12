# Bitey — manual launch guide

This is the human-owned part of launching **Bitey — Private Food Log**. It is
ordered so that the work already in the closed test is not disturbed, and so
that no secret, personal email, signing key, or Firebase credential needs to
go into GitHub.

## Current status

- The submitted closed-test bundle is **1.0.0** (`versionCode` 1). It contains
  the local diary, barcode lookup, import/export, translations, and tablet UI.
- The current source includes the Play Billing foundation, but no updated signed
  bundle has been uploaded yet. The billing test release must be **1.0.1** with
  `versionCode` **2** or higher.
- The app expects one subscription product, `bitey_ai`, with two auto-renewing
  base plans: `monthly` and `yearly`.
- Gemini/Firebase is **not wired in yet**. Do not sell Bitey AI to real users
  until its server-side entitlement check and 20-call daily limit exist.

## Keep these private

Keep all of the following on your machine or in the relevant cloud console;
never paste them into a source file, issue, screenshot, or Git commit:

- The upload keystore and its passwords.
- `android/keystore.properties` and `android/local.properties`.
- Signed `.aab` and `.apk` artifacts.
- Firebase service-account files, Firebase environment files, and any Gemini
  or Google Cloud credential.
- Tester email addresses, payment details, government/business documents, and
  a personal support email if you prefer not to publish it.

The repository already ignores those locations, including copied APKs and the
future Firebase files. Use a brand-owned contact alias, such as
`privacy@your-domain.example`, rather than a personal inbox wherever Play
requires a public contact.

## 1. Let the current closed test finish review

1. In Play Console, wait for **1.0.0** to be approved for closed testing.
2. Install it from the tester opt-in link on a real phone and verify the
   non-paid core: manual meals, barcode scan, direct lookup consent, weight
   entries/trends, backup export, backup import, every language, tablet layout,
   and system Back.
3. Do not use the current test to judge payments. Version 1.0.0 predates the
   billing code.

Record issues without attaching an exported Bitey backup or a screenshot that
contains a real diary, weight, profile, barcode, or photo.

## 2. Publish a privacy-policy URL before production

1. Choose a public privacy contact alias that you are willing to monitor.
2. Replace the marked contact placeholder in `PRIVACY_NOTICE.md` locally, then
   publish the policy as a normal public HTTPS page. It must not be a PDF or a
   login-only page.
3. Put that HTTPS URL in Play Console's Privacy Policy field and add the same
   link in the app before production.
4. Keep the policy accurate: it currently says diary data stays on device and
   that Open Food Facts is an optional direct barcode lookup. Update it before
   adding cloud AI, analytics, sync, or a new SDK that transmits user data.

The policy text is deliberately public; the contact address does not need to
be a personal address.

## 3. Finish the store listing

Use `LISTINGS.md` as the source of truth.

- **Title:** `Bitey — Private Food Log`
- **Tagline:** `Nutrition, privately.`
- **Category:** Health & Fitness
- **Tags:** Dieting and Weight loss
- **Health feature:** Nutrition and weight management only
- **App icon:** `assets/app-icon-512.png` (512 × 512 PNG)
- **Phone screenshots:** `screenshots/00-fresh.png` through
  `screenshots/04-private-backup.png`
- **Tablet screenshots:** the five `tablet-7-*` and five `tablet-10-*` images

Use `assets/feature-graphic-play.png` for upload: it is a flattened **1024 ×
500 24-bit PNG** with no alpha channel. Keep `feature-graphic-v2.png` as the
editable visual source.

The current screenshots contain English UI text. Use them for the English
listing. Before attaching screenshots to a translated listing, capture that
locale in the app; Play recommends that screenshots containing text match the
listing language.

## 4. Complete Play Console's app-content forms for the current release

Answer from the released 1.0.0 behaviour, not from a future Gemini plan.

### Health declaration

Select **Nutrition and weight management**. Do not select activity tracking,
medical advice, clinical decision support, disease management, period, sleep,
or stress management. Bitey is a diary and trend tool, not a medical device.

### Data Safety

Do **not** select **Health info** or **Fitness info** merely because users log
meals or weigh-ins. Those diary and profile values are processed only on the
device in the current release, so they do not meet Play's off-device
collection definition.

There is one separate decision: an allowed cache-miss barcode lookup sends the
scanned barcode directly to Open Food Facts over HTTPS. Play defines collection
as transmitting data off-device, and an explicit user action can exempt the
transfer from being declared as *sharing* but not automatically from
*collection*. Make the declaration conservatively after reviewing Open Food
Facts' retention practices:

1. If its handling is not provably ephemeral, answer **Yes** to collection.
2. Use **Other user-generated content** for the optional barcode value, purpose
   **App functionality**, and mark it **optional**.
3. Answer **not shared** only because Bitey shows a specific consent prompt and
   the person initiates the direct lookup. Confirm that this remains true in
   the released app.
4. State that it is encrypted in transit (the request is HTTPS). Do not claim a
   deletion mechanism for data held by Open Food Facts; its policy governs that
   service.

If you receive different written guidance from Open Food Facts or Play, follow
the more conservative interpretation and update both Data Safety and the
privacy notice. Google Play Billing's own card/payment handling does not need
to be declared when Bitey never accesses that information.

### Other app-content tasks

- Complete the content-rating questionnaire accurately; do not claim medical
  diagnosis or treatment.
- Provide the camera permission declaration: camera access is user-initiated
  for barcode scanning and food photos; barcode recognition happens on-device.
- Complete the target audience, ads, and any developer-account verification
  tasks shown in Play Console truthfully. Bitey contains no ads.

## 5. Configure the subscription in Play Console

Do this before building the billing test release. Product and activated base
plan IDs cannot be renamed or reused later, so enter them exactly.

1. Ensure the developer payments profile is complete.
2. Go to **Monetize with Play → Products → Subscriptions** and create a
   subscription.
3. Enter:

   | Field | Value |
   | --- | --- |
   | Product ID | `bitey_ai` |
   | Name | `Bitey AI` |
   | Description | Private AI food-photo analysis, with 20 calls per day |

4. Add an **auto-renewing** base plan:

   | Base-plan ID | Period | Base price |
   | --- | --- | --- |
   | `monthly` | Monthly | €5.99 |
   | `yearly` | Yearly | €49.99 |

5. Choose the countries/regions in which you are ready to sell. Start with the
places where your tax and support arrangements are complete; expand later.
6. Do not add a free trial, introductory price, or promotional offer at launch.
   The shipped chooser intentionally displays only the two standard base plans.
7. Save and activate both base plans so Play can return them to authorised test
   accounts. Keep the **app release** confined to closed testing until the
   Firebase entitlement service is live.

The app reads localised price text from Google Play at runtime. Do not hardcode
converted local prices in the store listing or in app text.

## 6. Make and test the billing release

The source is already version **1.0.1** with `versionCode` **2**. Before asking
Codex to build the next signed bundle, restore signing locally on the laptop:

1. Copy `android/keystore.properties.example` to the ignored local file
   `android/keystore.properties`.
2. Keep `storeFile=../../globe-release.jks`, then replace the three
   `REPLACE_*` values with the local keystore password, alias, and key
   password. Do this in the file itself; never paste those values into chat or
   GitHub.
3. Tell Codex the local file is complete. The release build will use it, verify
   the signed AAB, and copy the upload-ready file to `C:\Users\danie\APKs`.
   The build now refuses to finish if signing is absent, so an unsigned bundle
   cannot be confused with an upload-ready one.
4. Upload that AAB to the closed test track, create a release, and wait for it
   to become available.
5. In Play Console, add only test-account email addresses under **License
   testing**. Keep that list in Play Console, not in this repository.
6. On a real device, install from the Play opt-in link while signed in with a
   licence-test account. Do not use a random sideloaded production APK as the
   only billing test.

Test this list before any production rollout:

- Monthly purchase completes and unlocks the photo entry point.
- Yearly purchase completes and shows the correct selected plan in the Play
  purchase sheet.
- User cancels the Play purchase sheet.
- Pending/declined purchase keeps the feature locked.
- Restore works after reinstall and after returning to the app.
- Manage subscription opens Google Play's subscription page.
- A non-licence tester is not accidentally charged during test validation.
- The regular, non-AI diary remains usable with no subscription.

Google Play's licence-test methods use test payment instruments, and test
subscription periods are accelerated. Still run at least one test with a
non-licence tester before production so the app does not depend on test-only
behaviour.

## 7. Firebase/Gemini work — do this *before selling Bitey AI*

This is a later implementation milestone, not a Play Console toggle.

1. Create or choose a Firebase project under the intended business ownership
   and enable billing/budgets there.
2. Use Firebase AI Logic's guided setup and enable Firebase App Check. Do not
   embed a standalone Gemini API key in Bitey or in GitHub. Firebase's current
   AI Logic setup uses a managed service identity for authorisation.
3. Implement a Firebase endpoint that receives a Play purchase token only over
   HTTPS, verifies it with the Google Play Developer API, and grants access
   only for a valid, unexpired subscription.
4. Enforce a **hard 20-call-per-day limit** on that server, keyed to a privacy-
   preserving entitlement identity. Never enforce the paid quota only in the
   Android client.
5. Send only the photo and minimal prompt data required for the requested food
   analysis. Do not upload the local diary, backup ZIP, or unrelated profile
   data.
6. Add retries, abuse controls, monitoring, an alerting budget, and a way to
   revoke access for refunded or expired subscriptions.
7. Update the privacy notice, in-app disclosure/consent, and Data Safety form
   before shipping the Firebase-enabled build. That version will transmit food
   photos and may handle health-related data off-device, so the current
   declaration will no longer be sufficient.

## 8. Production checklist

Only after steps 1–7 are true:

- [ ] Closed-test feedback is resolved.
- [ ] The privacy-policy URL and monitored non-personal alias are live.
- [ ] Store text, graphics, and screenshots pass Console validation.
- [ ] All App content, Data Safety, and permission answers match the exact
      release binary.
- [ ] `bitey_ai`, `monthly`, and `yearly` have been tested with Play.
- [ ] Firebase verifies purchases and enforces the hard daily cap.
- [ ] The Firebase/Gemini data-flow disclosures are live before the AI build.
- [ ] The production AAB has a higher version code than every test AAB.
- [ ] A final real-device smoke test passes without the emulator.

Then promote the tested release gradually, monitor crashes, reviews, failed
payments, and AI spending, and keep the next rollout easy to halt.

## Official references

- [Create and manage Play subscriptions](https://support.google.com/googleplay/android-developer/answer/140504)
- [Test a Google Play Billing integration](https://developer.android.com/google/play/billing/test)
- [Google Play Data Safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Play store-listing asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151)
- [Firebase AI Logic](https://firebase.google.com/docs/ai-logic)
- [Secure Play Billing verification](https://developer.android.com/google/play/billing/security)
