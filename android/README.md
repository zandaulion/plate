# Bitey for Android

This module is the local-first Android host for Bitey. It packages the existing
`web/` interface and `core/` calculations inside the APK and serves them from
`https://plate.local`; it does not load the interface from the Express server.

Implemented local-first slices:

1. The PWA's diary API is local to the installed app. Profile, weigh-ins, and
   diary-entry metadata live in an app-private Room database. Attached photo
   bytes remain in the WebView's private IndexedDB, keyed by their entry, so
   the bridge never copies a large image payload into Room.
2. CameraX + bundled ML Kit decode EAN, UPC and Code 128 barcodes on-device.
3. Barcode cache records live in an app-private Room database, outside the
   WebView. A local cache hit works offline. On a miss, each direct Open Food Facts
   lookup has an explicit consent prompt; no request is relayed through Firebase
   and nutrition results (not product images) are cached only on the device.
4. Typed generic-food search uses the bundled SQLite table through a narrow
   native bridge; it has no network dependency.

The AI photo paths are visibly marked as premium. The Android client now uses
Google Play Billing 9.1 to restore and acknowledge the `bitey_ai` subscription
on the user's Google Play account. All camera, gallery, correction, leftovers,
and shared-photo paths ask the same native entitlement gate first. The rest of
the log continues to work locally without an account.

## Play Billing launch checklist

`bitey_ai` is deliberately a subscription: photo analysis has a continuing
model cost, so a permanent unlock would not be sustainable. Before enabling it
for sale in Play Console:

1. Create a **subscription** with product ID `bitey_ai`, then add these two
   active base plans with the exact IDs the packaged app expects:
   - `monthly` at **€5.99 per month**
   - `yearly` at **€49.99 per year**
   The interface asks Google Play for fresh localised prices and lets the
   person choose explicitly; no introductory or promotional offer is selected
   accidentally.
2. Install the AAB from a Play testing track on a licence-test account. ADB
   installs do not have the Play purchase context needed to exercise the real
   billing flow.
3. Test a completed purchase, a cancellation, a pending payment, reinstall,
   restore, and subscription management from Settings.
4. Do **not** activate the product for real customers until the Firebase AI
   endpoint verifies a purchase token with the Google Play Developer API,
   checks its expiry / entitlement state, and applies the 20-call daily
   server-side usage limit. The client gate is good UX and supports restore, but it cannot
   protect paid Gemini capacity from a modified APK.

The billing bridge does not expose Play account details or purchase tokens to
the WebView, and it does not send diary data or photos to Google Play.

The interface assets are synchronised automatically by the Gradle
`syncPlateAssets` task, so UI tuning in `web/` remains the source of truth.

The machine currently has Android Studio's bundled JDK, but no configured
Android SDK on the command line. Open `android/` in Android Studio, install the
requested API 36 SDK if prompted, then sync and run the `app` configuration.
