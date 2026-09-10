package com.zandaulion.bitey

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

private const val BACKUP_FORMAT = "plate-android-backup"
private const val BACKUP_VERSION = 1
private const val MAX_BACKUP_JSON_BYTES = 2 * 1024 * 1024
private const val MAX_BACKUP_TOTAL_PHOTO_BYTES = 250L * 1024 * 1024
private val BACKUP_PHOTO_PATH = Regex("photos/([A-Za-z0-9_.-]{1,120})")

/** A versioned, portable ZIP. It is deliberately unencrypted for now: Android
 * writes it to a user-chosen location, and the UI states that it is sensitive. */
class LocalBackup(private val context: Context) {
    private val database = PlateDatabase.get(context)
    private val photos = LocalPhotoStore(context, database.photos())

    fun exportTo(uri: Uri): JSONObject {
        val photoRows = database.photos().all()
        // `plate.json` is the PWA's portable format. Android used to write a
        // private plate-backup.json here, which meant a backup could return to
        // Android but not to the PWA. Keep the PWA contract as the one format
        // both clients write; the importer below still accepts old Android ZIPs.
        val photoNames = photoRows.associate { photo ->
            photo.id to "${photo.id}.${if (photo.mimeType == "image/png") "png" else "jpg"}"
        }
        val entries = JSONArray().also { rows -> database.entries().all().forEach { raw ->
            val source = JSONObject(raw)
            val photoId = source.optionalString("photoId")
            val exportedPhoto = photoId?.let { id ->
                require(photoNames.containsKey(id)) { "A diary photo is missing from this device." }
                photoNames.getValue(id)
            }
            rows.put(JSONObject()
                .put("id", source.getString("id"))
                .put("day", source.getString("day"))
                .put("meal", source.opt("meal"))
                .put("loggedAt", source.optionalString("createdAt"))
                .put("portionSource", source.optionalString("portionSource"))
                .put("note", source.opt("note"))
                .put("photo", exportedPhoto ?: JSONObject.NULL)
                .put("items", source.optJSONArray("items") ?: JSONArray())
                .put("totals", source.optJSONObject("totals") ?: JSONObject()))
        } }
        val manifest = JSONObject()
            .put("exportVersion", 1)
            .put("exportedAt", java.time.Instant.now().toString())
            .put("profile", database.profile().profileJson()?.let(::JSONObject) ?: JSONObject.NULL)
            .put("weights", JSONArray().also { rows -> database.weights().all().forEach { weight ->
                rows.put(JSONObject().put("day", weight.day).put("kg", weight.kg).put("measuredAt", weight.at))
            } })
            .put("entryCount", entries.length())
            .put("entries", entries)
            // The hosted PWA has no barcode cache, but retaining this optional
            // extension lets an Android backup round-trip through Android
            // without silently dropping locally cached lookup results.
            .put("barcodeFoods", JSONArray().also { rows -> database.barcodeFoods().all().forEach { food ->
                rows.put(JSONObject().put("barcode", food.barcode).put("foodJson", food.foodJson).put("cachedAt", food.cachedAt))
            } })
            .put("photos", JSONArray().also { rows -> photoRows.forEach { photo ->
                rows.put(photoNames.getValue(photo.id))
            } })

        context.contentResolver.openOutputStream(uri)?.use { stream ->
            ZipOutputStream(stream.buffered()).use { zip ->
                zip.putNextEntry(ZipEntry("plate.json"))
                zip.write(manifest.toString(2).toByteArray(Charsets.UTF_8))
                zip.closeEntry()
                photoRows.forEach { photo ->
                    val opened = photos.open(photo.id) ?: error("A local photo is missing")
                    opened.second.use { input ->
                        zip.putNextEntry(ZipEntry("photos/${photoNames.getValue(photo.id)}"))
                        input.copyTo(zip)
                        zip.closeEntry()
                    }
                }
            }
        } ?: error("Could not open the selected backup file")
        return JSONObject().put("entries", database.entries().all().size).put("photos", photoRows.size)
    }

    fun importFrom(uri: Uri): JSONObject {
        val staging = File(context.cacheDir, "plate-import-${UUID.randomUUID()}").also { it.mkdirs() }
        try {
            var manifestText: String? = null
            var pwaManifestText: String? = null
            val stagedPhotos = mutableMapOf<String, File>()
            var totalPhotoBytes = 0L
            context.contentResolver.openInputStream(uri)?.use { stream ->
                ZipInputStream(BufferedInputStream(stream)).use { zip ->
                    var entry = zip.nextEntry
                    while (entry != null) {
                        if (entry.isDirectory) { entry = zip.nextEntry; continue }
                        when (entry.name) {
                            "plate-backup.json" -> {
                                val bytes = zip.readBytesLimited(MAX_BACKUP_JSON_BYTES)
                                manifestText = bytes.toString(Charsets.UTF_8)
                            }
                            "plate.json" -> {
                                val bytes = zip.readBytesLimited(MAX_BACKUP_JSON_BYTES)
                                pwaManifestText = bytes.toString(Charsets.UTF_8)
                            }
                            // The PWA ZIP also carries its spreadsheet export
                            // and sometimes a note about a missing server file.
                            "plate.csv", "plate-weights.csv", "README.txt" -> Unit
                            else -> {
                                val match = BACKUP_PHOTO_PATH.matchEntire(entry.name)
                                    ?: throw IllegalArgumentException("The backup contains an unsupported file.")
                                val id = match.groupValues[1]
                                if (stagedPhotos.containsKey(id)) throw IllegalArgumentException("The backup contains a duplicate photo.")
                                val output = File(staging, id)
                                FileOutputStream(output).use { zip.copyLimitedTo(it, MAX_PHOTO_BYTES.toLong()) }
                                totalPhotoBytes += output.length()
                                require(totalPhotoBytes <= MAX_BACKUP_TOTAL_PHOTO_BYTES) { "The backup contains too many photos." }
                                stagedPhotos[id] = output
                            }
                        }
                        zip.closeEntry()
                        entry = zip.nextEntry
                    }
                }
            } ?: error("Could not read the selected backup file")

            val manifest = when {
                manifestText != null -> JSONObject(manifestText)
                pwaManifestText != null -> pwaExportAsLocal(JSONObject(pwaManifestText), stagedPhotos)
                else -> throw IllegalArgumentException("This is not a Plate backup.")
            }
            require(manifest.optString("format") == BACKUP_FORMAT && manifest.optInt("version") == BACKUP_VERSION) {
                "This backup is not compatible with this version of Plate."
            }
            val profile = manifest.optJSONObject("profile")
            val weights = manifest.optJSONArray("weights") ?: JSONArray()
            val entries = manifest.optJSONArray("entries") ?: JSONArray()
            val foods = manifest.optJSONArray("barcodeFoods") ?: JSONArray()
            val photoRows = manifest.optJSONArray("photos") ?: JSONArray()
            val photoInfo = mutableMapOf<String, JSONObject>()
            for (index in 0 until photoRows.length()) {
                val photo = photoRows.getJSONObject(index)
                val id = photo.optString("id")
                require(PHOTO_ID.matches(id) && photo.optString("path") == "photos/$id") { "The backup has an invalid photo." }
                require(photo.optString("mimeType") in setOf("image/jpeg", "image/png")) { "The backup has an invalid photo type." }
                require(photo.optLong("byteCount") in 1..MAX_PHOTO_BYTES.toLong() && stagedPhotos[id]?.length() == photo.optLong("byteCount")) {
                    "A photo in the backup is incomplete."
                }
                require(photoInfo.put(id, photo) == null) { "The backup contains a duplicate photo." }
            }
            for (index in 0 until entries.length()) {
                val entry = entries.getJSONObject(index)
                val id = entry.optString("id")
                require(PHOTO_ID.matches(id) && entry.optString("day").matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) {
                    "The backup has an invalid diary entry."
                }
                entry.optionalString("photoId")?.let { photoId ->
                    require(photoInfo.containsKey(photoId)) { "A diary photo is missing from the backup." }
                }
            }

            // Files are copied before the database changes; this avoids diary
            // rows that refer to a photo which failed to restore.
            photoInfo.forEach { (id, photo) -> photos.writeFromFile(id, stagedPhotos.getValue(id), photo.getString("mimeType")) }
            database.runInTransaction {
                database.profile().clear()
                database.weights().clear()
                database.entries().clear()
                database.barcodeFoods().clear()
                if (profile != null) database.profile().save(ProfileEntity(profileJson = profile.put("id", "profile").toString(), updatedAt = System.currentTimeMillis()))
                for (index in 0 until weights.length()) {
                    val weight = weights.getJSONObject(index)
                    database.weights().save(WeightEntity(weight.getString("day"), weight.getDouble("kg"), weight.getString("at")))
                }
                for (index in 0 until entries.length()) {
                    val entry = entries.getJSONObject(index)
                    entry.remove("photoData")
                    database.entries().save(DiaryEntryEntity(entry.getString("id"), entry.getString("day"), entry.getLong("sortKey"), entry.toString(), System.currentTimeMillis()))
                }
                for (index in 0 until foods.length()) {
                    val food = foods.getJSONObject(index)
                    database.barcodeFoods().save(BarcodeFoodEntity(food.getString("barcode"), food.getString("foodJson"), food.getLong("cachedAt")))
                }
                database.photos().clear()
                photoInfo.forEach { (id, photo) -> database.photos().save(PhotoEntity(id, photo.getString("mimeType"), photo.getLong("byteCount"))) }
            }
            photos.prune(photoInfo.keys)
            return JSONObject().put("entries", entries.length()).put("photos", photoInfo.size)
        } finally {
            staging.deleteRecursively()
        }
    }
}

private fun ZipInputStream.readBytesLimited(limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    copyLimitedTo(output, limit.toLong())
    return output.toByteArray()
}

private fun JSONObject.optionalString(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotBlank() }

/**
 * The hosted PWA predates the Android-only archive. Its `plate.json` is still
 * lossless for profile and entries, while its ZIP holds photo files under
 * their original server names. Translate it into the native archive shape
 * before the normal validation/import path runs.
 */
private fun pwaExportAsLocal(pwa: JSONObject, stagedPhotos: MutableMap<String, File>): JSONObject {
    require(pwa.optInt("exportVersion") == 1) { "This PWA export is not compatible with this version of Plate." }
    val sourceEntries = pwa.optJSONArray("entries") ?: JSONArray()
    val sourceWeights = pwa.optJSONArray("weights") ?: JSONArray()
    val sourceFoods = pwa.optJSONArray("barcodeFoods") ?: JSONArray()
    val entries = JSONArray()
    val weights = JSONArray()
    val foods = JSONArray()
    val photos = JSONArray()
    val photoIds = mutableMapOf<String, String>()

    for (index in 0 until sourceEntries.length()) {
        val source = sourceEntries.getJSONObject(index)
        val id = source.optString("id")
        require(PHOTO_ID.matches(id)) { "The PWA export has an invalid diary entry." }
        val originalPhoto = source.optionalString("photo")
        val nativePhoto = originalPhoto?.let { original ->
            photoIds.getOrPut(original) {
                require(stagedPhotos.containsKey(original)) { "A diary photo is missing from the PWA backup." }
                val localId = UUID.nameUUIDFromBytes("plate-pwa-photo:$original".toByteArray()).toString()
                stagedPhotos[localId] = stagedPhotos.getValue(original)
                val mimeType = if (original.endsWith(".png", ignoreCase = true)) "image/png" else "image/jpeg"
                photos.put(JSONObject()
                    .put("id", localId)
                    .put("mimeType", mimeType)
                    .put("byteCount", stagedPhotos.getValue(original).length())
                    .put("path", "photos/$localId"))
                localId
            }
        }
        val loggedAt = source.optString("loggedAt").takeIf { it.isNotBlank() } ?: java.time.Instant.now().toString()
        val sortKey = runCatching { java.time.Instant.parse(loggedAt).toEpochMilli() * 1000 + index }
            .getOrElse { System.currentTimeMillis() * 1000 + index }
        val entry = JSONObject(source.toString())
        entry.remove("loggedAt")
        entry.remove("photo")
        entry.put("id", id)
        entry.put("createdAt", loggedAt)
        entry.put("sortKey", sortKey)
        entry.put("photoId", nativePhoto ?: JSONObject.NULL)
        entry.put("photoMimeType", if (originalPhoto?.endsWith(".png", ignoreCase = true) == true) "image/png" else "image/jpeg")
        entry.put("corrections", 0)
        entries.put(entry)
    }

    for (index in 0 until sourceWeights.length()) {
        val source = sourceWeights.getJSONObject(index)
        val day = source.optString("day")
        val kg = source.optDouble("kg", Double.NaN)
        require(day.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) && kg in 20.0..400.0) {
            "The PWA export has an invalid weigh-in."
        }
        val at = source.optionalString("at")
            ?: source.optionalString("measuredAt")
            ?: "${day}T12:00:00.000Z"
        weights.put(JSONObject().put("day", day).put("kg", kg).put("at", at))
    }

    for (index in 0 until sourceFoods.length()) {
        val source = sourceFoods.getJSONObject(index)
        val barcode = source.optString("barcode").filter(Char::isDigit)
        val foodJson = source.optionalString("foodJson")
        require(barcode.length in 6..14 && foodJson != null) { "The PWA export has an invalid cached food." }
        foods.put(JSONObject()
            .put("barcode", barcode)
            .put("foodJson", foodJson)
            .put("cachedAt", source.optLong("cachedAt", System.currentTimeMillis())))
    }

    val profile = pwa.optJSONObject("profile")?.let { source ->
        JSONObject(source.toString()).apply {
            // Old PWA exports can carry ageYears without birthYear. Convert it
            // to the durable fact the device-local profile uses.
            if (!has("birthYear") && has("ageYears")) {
                val age = optInt("ageYears", -1)
                if (age in 13..120) put("birthYear", java.time.Year.now().value - age)
            }
        }
    } ?: JSONObject.NULL

    return JSONObject()
        .put("format", BACKUP_FORMAT)
        .put("version", BACKUP_VERSION)
        .put("profile", profile)
        // Older PWA exports have no weights or barcode cache, so those
        // categories remain empty rather than pretending information exists.
        .put("weights", weights)
        .put("entries", entries)
        .put("barcodeFoods", foods)
        .put("photos", photos)
}

private fun ZipInputStream.copyLimitedTo(output: java.io.OutputStream, limit: Long) {
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var copied = 0L
    while (true) {
        val read = read(buffer)
        if (read <= 0) break
        copied += read
        require(copied <= limit) { "The backup is too large." }
        output.write(buffer, 0, read)
    }
}
