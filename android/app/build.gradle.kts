import org.gradle.api.tasks.Sync
import java.util.Properties

plugins {
    id("com.android.application")
    id("com.google.devtools.ksp")
}

/**
 * Release credentials must remain local. They may come from the ignored
 * android/keystore.properties file or from the process environment, which is
 * how the existing Zandaulion keystore is used for a one-off release build.
 */
val localSigningProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.isFile) file.inputStream().use(::load)
}

fun signingValue(property: String, environment: String): String? =
    System.getenv(environment)?.takeIf { it.isNotBlank() }
        ?: localSigningProperties.getProperty(property)?.takeIf { it.isNotBlank() }

val releaseStoreFile = signingValue("storeFile", "BITEY_STORE_FILE")
val releaseStorePassword = signingValue("storePassword", "BITEY_STORE_PASSWORD")
val releaseKeyAlias = signingValue("keyAlias", "BITEY_KEY_ALIAS")
val releaseKeyPassword = signingValue("keyPassword", "BITEY_KEY_PASSWORD")
val releaseSigningReady = listOf(
    releaseStoreFile,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

android {
    namespace = "com.zandaulion.bitey"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.zandaulion.bitey"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    if (releaseSigningReady) {
        signingConfigs {
            create("release") {
                storeFile = rootProject.file(requireNotNull(releaseStoreFile))
                storePassword = requireNotNull(releaseStorePassword)
                keyAlias = requireNotNull(releaseKeyAlias)
                keyPassword = requireNotNull(releaseKeyPassword)
            }
        }
        buildTypes {
            getByName("release") {
                signingConfig = signingConfigs.getByName("release")
            }
        }
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
