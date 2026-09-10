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

The AI photo paths are visibly marked as premium. Billing and entitlement checks
remain a separate release milestone; the rest of the log continues to work
locally without an account.

The interface assets are synchronised automatically by the Gradle
`syncPlateAssets` task, so UI tuning in `web/` remains the source of truth.

The machine currently has Android Studio's bundled JDK, but no configured
Android SDK on the command line. Open `android/` in Android Studio, install the
requested API 36 SDK if prompted, then sync and run the `app` configuration.
