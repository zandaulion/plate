import org.gradle.api.tasks.Sync

plugins {
    id("com.android.application")
    id("com.google.devtools.ksp")
}

android {
    namespace = "app.plate"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.plate"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }
}

/**
 * The interface has one source of truth: web/ and core/. At build time they
 * are copied into the APK and served from https://plate.local by WebView. No
 * production app assets are fetched from the old Express server.
 */
val plateRoot = rootProject.projectDir.parentFile
val generatedPlateAssets = layout.buildDirectory.dir("generated/plate-assets")

val syncPlateAssets by tasks.registering(Sync::class) {
    from(plateRoot.resolve("web"))
    from(plateRoot.resolve("core")) { into("core") }
    from(plateRoot.resolve("assets/foods.sqlite")) { into("database") }
    into(generatedPlateAssets)
}

android.sourceSets.named("main") {
    // The copy task is wired to preBuild below, so resolving this directory at
    // configuration time does not lose its generated-asset dependency.
    assets.srcDir(generatedPlateAssets.get().asFile)
}

tasks.named("preBuild") {
    dependsOn(syncPlateAssets)
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.webkit:webkit:1.17.0")

    // Bundled scanning works as soon as the app is installed. It does not
    // download a barcode model or send camera frames to a service.
    val cameraXVersion = "1.6.2"
    implementation("androidx.camera:camera-camera2:$cameraXVersion")
    implementation("androidx.camera:camera-core:$cameraXVersion")
    implementation("androidx.camera:camera-lifecycle:$cameraXVersion")
    implementation("androidx.camera:camera-view:$cameraXVersion")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    val roomVersion = "2.8.4"
    implementation("androidx.room:room-runtime:$roomVersion")
    ksp("androidx.room:room-compiler:$roomVersion")
}
