package app.plate

import android.content.Context
import android.util.Base64
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

const val MAX_PHOTO_BYTES = 5 * 1024 * 1024
val PHOTO_ID = Regex("[A-Za-z0-9_-]{1,80}")

/**
 * Image bytes are app-private files rather than WebView data. This keeps them
 * out of Room and lets Android stream them into an export without pushing a
 * whole image back through JavaScript.
 */
class LocalPhotoStore(
    private val context: Context,
    private val metadata: PhotoDao,
) {
    private val directory = File(context.filesDir, "plate-photos")

    fun saveBase64(id: String, base64: String, mimeType: String): PhotoEntity {
        require(PHOTO_ID.matches(id))
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        require(bytes.isNotEmpty() && bytes.size <= MAX_PHOTO_BYTES)
        return write(id, bytes.inputStream(), bytes.size.toLong(), mimeType)
    }

    fun copy(fromId: String, toId: String): PhotoEntity {
        val source = metadata.photo(fromId) ?: error("Source photo is not available")
        FileInputStream(fileFor(fromId)).use { input ->
            return write(toId, input, source.byteCount, source.mimeType)
        }
    }

    fun open(id: String): Pair<PhotoEntity, InputStream>? {
        val photo = metadata.photo(id) ?: return null
        val file = fileFor(id)
        if (!file.isFile) return null
        return photo to FileInputStream(file)
    }

    fun delete(id: String) {
        metadata.delete(id)
        fileFor(id).delete()
    }

    fun writeFromFile(id: String, source: File, mimeType: String): PhotoEntity =
        FileInputStream(source).use { input -> write(id, input, source.length(), mimeType) }

    fun prune(keep: Set<String>) {
        directory.listFiles()?.forEach { file ->
            if (file.name !in keep && file.name != ".nomedia") file.delete()
        }
    }

    private fun write(id: String, input: InputStream, expectedBytes: Long, mimeType: String): PhotoEntity {
        require(PHOTO_ID.matches(id))
        require(expectedBytes in 1..MAX_PHOTO_BYTES.toLong())
        require(mimeType == "image/jpeg" || mimeType == "image/png")
        if (!directory.exists()) directory.mkdirs()
        val target = fileFor(id)
        val temporary = File(directory, ".${id}.tmp")
        input.use { source -> temporary.outputStream().use { output -> source.copyTo(output) } }
        require(temporary.length() == expectedBytes)
        if (target.exists()) target.delete()
        check(temporary.renameTo(target)) { "Could not save photo" }
        return PhotoEntity(id, mimeType, expectedBytes).also(metadata::save)
    }

    private fun fileFor(id: String): File {
        require(PHOTO_ID.matches(id))
        return File(directory, id)
    }
}
