package app.plate

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

private const val PLATE_HOST = "plate.local"
private const val PLATE_ORIGIN = "https://$PLATE_HOST/index.html"

/**
 * Serves files copied into the APK under a synthetic HTTPS origin. Using HTTPS
 * rather than file:// keeps modern WebView facilities (module imports, storage
 * and camera permissions) available without turning on unsafe file access.
 */
private class PlateAssetClient(context: Context, private val photos: LocalPhotoStore) : WebViewClient() {
    private val assets = WebViewAssetLoader.Builder()
        .setDomain(PLATE_HOST)
        .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(context))
        .build()

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? {
        val photoId = request.url.encodedPath
            ?.takeIf { it.startsWith("/local-photo/") }
            ?.removePrefix("/local-photo/")
        if (photoId != null && request.method == "GET") {
            val opened = runCatching { photos.open(photoId) }.getOrNull()
            if (opened != null) return WebResourceResponse(opened.first.mimeType, null, opened.second)
        }
        return assets.shouldInterceptRequest(request.url)
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // The app only navigates inside its packaged origin. Network operations
        // will be explicit native bridge calls, never arbitrary page loads.
        return request.url.host != PLATE_HOST
    }
}

/**
 * A deliberately tiny bridge contract. It proves that the page is locally
 * hosted and gives the next milestones one stable capability boundary. The
 * storage and barcode methods are added behind this object rather than by
 * exposing broad Android APIs to JavaScript.
 */
private class PlateNativeBridge(
    private val onBarcodeScanRequested: () -> Unit,
    private val onOpenFoodFactsLookupRequested: (String) -> Unit,
    private val onCachedFoodReadRequested: (String) -> Unit,
    private val onCachedFoodWriteRequested: (String, String) -> Unit,
    private val onGenericFoodSearchRequested: (String, String) -> Unit,
    private val onLocalDiaryRequested: (String, String, String) -> Unit,
    private val onLocalPhotoRequested: (String, String, String, String, String) -> Unit,
    private val onBackupExportRequested: () -> Unit,
    private val onBackupImportRequested: () -> Unit,
    private val onPrimaryActionLabelsChanged: (String, String, String) -> Unit,
) {
    @JavascriptInterface
    fun platform(): String = "android"

    @JavascriptInterface
    fun isLocalBuild(): Boolean = true

    @JavascriptInterface
    fun scanBarcode() {
        onBarcodeScanRequested()
    }

    @JavascriptInterface
    fun lookupOpenFoodFacts(barcode: String) {
        onOpenFoodFactsLookupRequested(barcode)
    }

    @JavascriptInterface
    fun readCachedFood(barcode: String) {
        onCachedFoodReadRequested(barcode)
    }

    @JavascriptInterface
    fun writeCachedFood(barcode: String, foodJson: String) {
        onCachedFoodWriteRequested(barcode, foodJson)
    }

    @JavascriptInterface
    fun searchGenericFoods(query: String, requestId: String) {
        onGenericFoodSearchRequested(query, requestId)
    }

    @JavascriptInterface
    fun localDiary(operation: String, payload: String, requestId: String) {
        onLocalDiaryRequested(operation, payload, requestId)
    }

    @JavascriptInterface
    fun localPhoto(operation: String, id: String, payload: String, mimeType: String, requestId: String) {
        onLocalPhotoRequested(operation, id, payload, mimeType, requestId)
    }

    @JavascriptInterface
    fun exportBackup() = onBackupExportRequested()

    @JavascriptInterface
    fun importBackup() = onBackupImportRequested()

    /** The action bar is native to avoid a WebView compositing glitch, but its
     * wording still belongs to the PWA's active interface language. */
    @JavascriptInterface
    fun setPrimaryActionLabels(manual: String, barcode: String, photo: String) {
        onPrimaryActionLabelsChanged(manual, barcode, photo)
    }
}

@SuppressLint("SetJavaScriptEnabled")
class PlateWebView(
    context: Context,
    onBarcodeScanRequested: () -> Unit,
    onBackupExportRequested: () -> Unit,
    onBackupImportRequested: () -> Unit,
    onPrimaryActionLabelsChanged: (String, String, String) -> Unit,
) : WebView(context) {
    private val networkExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val barcodeFoods by lazy { PlateDatabase.get(context).barcodeFoods() }
    private val profileStore by lazy { PlateDatabase.get(context).profile() }
    private val weightStore by lazy { PlateDatabase.get(context).weights() }
    private val entryStore by lazy { PlateDatabase.get(context).entries() }
    private val photoStore by lazy { LocalPhotoStore(context, PlateDatabase.get(context).photos()) }
    private val backup = lazy { LocalBackup(context) }
    private val genericFoodSearch = lazy { GenericFoodSearch(context) }

    init {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mediaPlaybackRequiresUserGesture = true

        CookieManager.getInstance().setAcceptCookie(false)
        webChromeClient = WebChromeClient()
        webViewClient = PlateAssetClient(context, photoStore)
        addJavascriptInterface(
            PlateNativeBridge(
                onBarcodeScanRequested,
                ::lookupOpenFoodFacts,
                ::readCachedFood,
                ::writeCachedFood,
                ::searchGenericFoods,
                ::localDiary,
                ::localPhoto,
                onBackupExportRequested,
                onBackupImportRequested,
                onPrimaryActionLabelsChanged,
            ),
            "PlateNative",
        )
        loadUrl(PLATE_ORIGIN)
    }

    fun deliverBarcode(barcode: String) {
        // JSONObject.quote produces a JavaScript string literal, preventing a
        // barcode value from becoming executable code in the page context.
        val value = JSONObject.quote(barcode)
        evaluateJavascript("window.__plateNativeBarcodeResult?.($value)", null)
    }

    /** The native action bar may invoke only these established PWA controls;
     * callers never get an arbitrary JavaScript execution surface. */
    fun performPrimaryAction(action: String) {
        val elementId = when (action) {
            "manual" -> "add-manual"
            "barcode" -> "add-barcode"
            "photo" -> "add-btn"
            else -> return
        }
        evaluateJavascript("document.getElementById(${JSONObject.quote(elementId)})?.click()", null)
    }

    /**
     * Lets the packaged interface consume a system Back gesture before Android
     * backgrounds the task. The page owns its sheet/history stack, so native
     * code deliberately asks it whether there is somewhere to return to rather
     * than guessing from WebView navigation history.
     */
    fun navigateBack(onComplete: (Boolean) -> Unit) {
        evaluateJavascript("window.__plateNativeBack?.() === true") { result ->
            onComplete(result == "true")
        }
    }

    override fun onDetachedFromWindow() {
        if (genericFoodSearch.isInitialized()) genericFoodSearch.value.close()
        networkExecutor.shutdownNow()
        super.onDetachedFromWindow()
    }

    private fun lookupOpenFoodFacts(barcode: String) {
        // The JavaScript UI asks for consent immediately before this method is
        // called. Keep the native boundary narrow as well: only barcode-shaped
        // values can become a request URL. Always answer the page, including
        // for Code 128 values that cannot be product barcodes.
        if (!barcode.matches(Regex("[0-9]{8,14}"))) {
            val invalid = JSONObject()
                .put("ok", false)
                .put("code", "invalid_barcode")
                .put("message", "This does not look like a food barcode. Enter it manually instead.")
                .toString()
            evaluateJavascript(
                "window.__plateNativeOpenFoodFactsResult?.(${JSONObject.quote(invalid)})",
                null,
            )
            return
        }
        networkExecutor.execute {
            val result = runCatching { openFoodFactsResult(barcode) }.getOrElse {
                JSONObject()
                    .put("ok", false)
                    .put("code", "network_error")
                    .put("message", "Could not contact Open Food Facts. Try again or enter it manually.")
                    .toString()
            }
            post {
                evaluateJavascript(
                    "window.__plateNativeOpenFoodFactsResult?.(${JSONObject.quote(result)})",
                    null,
                )
            }
        }
    }

    private fun readCachedFood(barcode: String) {
        if (!barcode.matches(Regex("[0-9]{8,14}"))) {
            deliverFoodCacheResult(cacheError("invalid_barcode", "This does not look like a food barcode."))
            return
        }
        networkExecutor.execute {
            val result = runCatching { barcodeFoods.foodJson(barcode) }
                .fold(
                    onSuccess = { foodJson ->
                        JSONObject().put("ok", true).put("foodJson", foodJson).toString()
                    },
                    onFailure = {
                        cacheError("cache_error", "The local barcode cache could not be opened.")
                    },
                )
            post { deliverFoodCacheResult(result) }
        }
    }

    private fun writeCachedFood(barcode: String, foodJson: String) {
        if (!barcode.matches(Regex("[0-9]{8,14}")) || foodJson.length > 12_000) {
            deliverFoodCacheResult(cacheError("bad_food", "That barcode result could not be saved locally."))
            return
        }
        networkExecutor.execute {
            val result = runCatching {
                // Parsing here makes the bridge reject malformed calls rather
                // than preserving arbitrary text in the database.
                JSONObject(foodJson)
                barcodeFoods.save(BarcodeFoodEntity(barcode, foodJson, System.currentTimeMillis()))
                JSONObject().put("ok", true).toString()
            }.getOrElse {
                cacheError("cache_error", "That barcode result could not be saved locally.")
            }
            post { deliverFoodCacheResult(result) }
        }
    }

    private fun cacheError(code: String, message: String): String = JSONObject()
        .put("ok", false)
        .put("code", code)
        .put("message", message)
        .toString()

    private fun deliverFoodCacheResult(result: String) {
        evaluateJavascript(
            "window.__plateNativeFoodCacheResult?.(${JSONObject.quote(result)})",
            null,
        )
    }

    private fun searchGenericFoods(query: String, requestId: String) {
        networkExecutor.execute {
            val result = runCatching { genericFoodSearch.value.search(query) }.getOrElse {
                JSONObject()
                    .put("ok", false)
                    .put("code", "search_error")
                    .put("message", "The on-device food table could not be opened.")
                    .toString()
            }
            post {
                evaluateJavascript(
                    "window.__plateNativeGenericFoodSearchResult?.(${JSONObject.quote(requestId)}, ${JSONObject.quote(result)})",
                    null,
                )
            }
        }
    }

    /**
     * Fixed, JSON-only operations for the diary data that has moved into Room.
     * This is intentionally not a SQL bridge: the WebView cannot name a table,
     * execute a query, or access any operation outside this whitelist.
     */
    private fun localDiary(operation: String, payload: String, requestId: String) {
        networkExecutor.execute {
            val result = runCatching { localDiaryResult(operation, payload) }.getOrElse {
                diaryError("storage_error", "The local diary could not be updated.")
            }
            post {
                evaluateJavascript(
                    "window.__plateNativeDiaryResult?.(${JSONObject.quote(requestId)}, ${JSONObject.quote(result)})",
                    null,
                )
            }
        }
    }

    /** Photo writes are separate from diary JSON so large image data has only
     * one narrowly scoped route into app-private files. */
    private fun localPhoto(operation: String, id: String, payload: String, mimeType: String, requestId: String) {
        networkExecutor.execute {
            val result = runCatching { localPhotoResult(operation, id, payload, mimeType) }.getOrElse {
                diaryError("photo_error", "The local photo could not be saved.")
            }
            post {
                evaluateJavascript(
                    "window.__plateNativePhotoResult?.(${JSONObject.quote(requestId)}, ${JSONObject.quote(result)})",
                    null,
                )
            }
        }
    }

    private fun localPhotoResult(operation: String, id: String, payload: String, mimeType: String): String {
        if (!id.matches(Regex("[A-Za-z0-9_-]{1,80}"))) {
            return diaryError("bad_photo", "That photo could not be saved.")
        }
        return when (operation) {
            "write" -> {
                // Base64 expands a 5 MiB photo to about 6.7 MiB. Reject it at
                // the bridge before decoding or writing it to disk.
                if (payload.length > 7_000_000) diaryError("bad_photo", "That photo is too large to save.")
                else {
                    val photo = photoStore.saveBase64(id, payload, mimeType)
                    JSONObject().put("ok", true).put("id", photo.id).toString()
                }
            }
            "copy" -> {
                val from = payload
                if (!from.matches(Regex("[A-Za-z0-9_-]{1,80}"))) diaryError("bad_photo", "That photo could not be copied.")
                else JSONObject().put("ok", true).put("id", photoStore.copy(from, id).id).toString()
            }
            "delete" -> {
                photoStore.delete(id)
                JSONObject().put("ok", true).toString()
            }
            else -> diaryError("not_implemented", "That photo operation is not available.")
        }
    }

    fun exportBackup(uri: Uri) {
        networkExecutor.execute {
            val result = runCatching { backup.value.exportTo(uri) }
                .fold(
                    onSuccess = { summary -> JSONObject().put("ok", true).put("summary", summary).toString() },
                    onFailure = { diaryError("backup_error", "The backup could not be written.") },
                )
            post { deliverBackupResult("export", result) }
        }
    }

    fun importBackup(uri: Uri) {
        networkExecutor.execute {
            val result = runCatching { backup.value.importFrom(uri) }
                .fold(
                    onSuccess = { summary -> JSONObject().put("ok", true).put("summary", summary).toString() },
                    onFailure = { diaryError("backup_error", "The backup could not be restored.") },
                )
            post { deliverBackupResult("import", result) }
        }
    }

    fun deliverBackupCancelled(operation: String) {
        deliverBackupResult(operation, JSONObject().put("ok", false).put("code", "cancelled").toString())
    }

    private fun deliverBackupResult(operation: String, result: String) {
        evaluateJavascript(
            "window.__plateNativeBackupResult?.(${JSONObject.quote(operation)}, ${JSONObject.quote(result)})",
            null,
        )
    }

    private fun localDiaryResult(operation: String, payload: String): String = when (operation) {
        "profile.read" -> JSONObject()
            .put("ok", true)
            .put("profile", profileStore.profileJson()?.let(::JSONObject) ?: JSONObject.NULL)
            .toString()

        "profile.write" -> {
            if (payload.length > 4_000) {
                diaryError("bad_profile", "The profile could not be saved.")
            } else {
                val profile = JSONObject(payload).put("id", "profile")
                profileStore.save(ProfileEntity(profileJson = profile.toString(), updatedAt = System.currentTimeMillis()))
                JSONObject().put("ok", true).toString()
            }
        }

        "weights.list" -> {
            val rows = JSONArray()
            weightStore.all().forEach { weight ->
                rows.put(JSONObject()
                    .put("day", weight.day)
                    .put("kg", weight.kg)
                    .put("at", weight.at))
            }
            JSONObject().put("ok", true).put("weights", rows).toString()
        }

        "weights.write" -> {
            val weight = JSONObject(payload)
            val day = weight.optString("day")
            val kg = weight.optDouble("kg", Double.NaN)
            if (!day.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) || kg !in 20.0..400.0) {
                diaryError("bad_weight", "That weight looks wrong.")
            } else {
                val at = weight.optString("at").takeIf { it.isNotBlank() } ?: java.time.Instant.now().toString()
                weightStore.save(WeightEntity(day, kg, at))
                JSONObject().put("ok", true).put("day", day).put("kg", kg).toString()
            }
        }

        "weights.delete" -> {
            val day = JSONObject(payload).optString("day")
            if (!day.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) {
                diaryError("bad_weight", "That weight could not be removed.")
            } else {
                JSONObject().put("ok", true).put("deleted", weightStore.delete(day) > 0).toString()
            }
        }

        "entries.list" -> {
            val rows = JSONArray()
            entryStore.all().forEach { entryJson -> rows.put(JSONObject(entryJson)) }
            JSONObject().put("ok", true).put("entries", rows).toString()
        }

        "entries.read" -> {
            val id = JSONObject(payload).optString("id")
            if (!id.matches(Regex("[A-Za-z0-9_-]{1,80}"))) {
                diaryError("bad_entry", "That diary entry could not be read.")
            } else {
                JSONObject()
                    .put("ok", true)
                    .put("entry", entryStore.entryJson(id)?.let(::JSONObject) ?: JSONObject.NULL)
                    .toString()
            }
        }

        "entries.write" -> {
            val entry = JSONObject(payload)
            val id = entry.optString("id")
            val day = entry.optString("day")
            val sortKey = entry.optLong("sortKey", -1)
            if (!id.matches(Regex("[A-Za-z0-9_-]{1,80}")) ||
                !day.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) || sortKey < 0
            ) {
                diaryError("bad_entry", "That diary entry could not be saved.")
            } else {
                // The photo remains in IndexedDB, keyed by photoId. Do not let
                // large base64 data cross into the native database by accident.
                entry.remove("photoData")
                if (entry.toString().length > 64_000) {
                    diaryError("bad_entry", "That diary entry is too large to save.")
                } else {
                    entryStore.save(DiaryEntryEntity(
                        id = id,
                        day = day,
                        sortKey = sortKey,
                        entryJson = entry.toString(),
                        updatedAt = System.currentTimeMillis(),
                    ))
                    JSONObject().put("ok", true).put("entry", entry).toString()
                }
            }
        }

        "entries.delete" -> {
            val id = JSONObject(payload).optString("id")
            if (!id.matches(Regex("[A-Za-z0-9_-]{1,80}"))) {
                diaryError("bad_entry", "That diary entry could not be removed.")
            } else {
                JSONObject().put("ok", true).put("deleted", entryStore.delete(id) > 0).toString()
            }
        }

        else -> diaryError("not_implemented", "That local diary operation is not available.")
    }

    private fun diaryError(code: String, message: String): String = JSONObject()
        .put("ok", false)
        .put("code", code)
        .put("message", message)
        .toString()

    private fun openFoodFactsResult(barcode: String): String {
        val fields = listOf(
            "code", "product_name", "product_name_en", "product_name_ro",
            "brands", "serving_size", "nutriments",
        ).joinToString(",")
        val connection = (URL(
            "https://world.openfoodfacts.org/api/v2/product/$barcode.json?fields=$fields",
        ).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 10_000
            // This identifies the software, never the person or device. The
            // request goes directly from their network to Open Food Facts.
            setRequestProperty("User-Agent", "Plate-Android/0.1.0 (anonymous device lookup)")
            setRequestProperty("Accept", "application/json")
        }
        return try {
            if (connection.responseCode !in 200..299) {
                return JSONObject()
                    .put("ok", false)
                    .put("code", "network_error")
                    .put("message", "Open Food Facts could not answer right now. Try again or enter it manually.")
                    .toString()
            }
            val response = connection.inputStream.bufferedReader().use { it.readText() }
            val body = JSONObject(response)
            val product = body.optJSONObject("product")
            if (body.optInt("status") != 1 || product == null) {
                JSONObject()
                    .put("ok", false)
                    .put("code", "not_found")
                    .put("message", "That barcode is not in Open Food Facts yet. Enter it manually instead.")
                    .toString()
            } else {
                JSONObject().put("ok", true).put("product", product).toString()
            }
        } finally {
            connection.disconnect()
        }
    }
}
