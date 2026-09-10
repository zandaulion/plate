package app.plate

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileOutputStream
import java.util.Locale

/**
 * Reads the generic-food table packaged with the APK. The table never leaves
 * the device and is copied once into app-private database storage so Android's
 * SQLite engine can query it efficiently.
 */
class GenericFoodSearch(private val context: Context) : AutoCloseable {
    private val database = lazy { openPackagedTable() }

    fun search(rawQuery: String): String {
        val query = rawQuery.trim().take(80)
        if (query.length < 2) return error("short_query", "Type at least two characters.")
        val tokens = query.lowercase(Locale.ROOT)
            .split(Regex("[^\\p{L}\\p{N}]+"))
            .filter { it.isNotBlank() }
            .take(6)
        if (tokens.isEmpty()) return error("short_query", "Type at least two characters.")

        val where = tokens.joinToString(" AND ") { "(search LIKE ? OR search LIKE ?)" }
        val args = tokens.flatMap { listOf("$it%", "% $it%") }.toTypedArray()
        val rows = JSONArray()
        database.value.rawQuery(
            "SELECT name, kcal, protein, fat, carbs FROM foods WHERE $where LIMIT 24",
            args,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val name = cursor.getString(0)
                rows.put(JSONObject()
                    .put("id", "usda:$name")
                    .put("source", "usda")
                    .put("barcode", JSONObject.NULL)
                    .put("name", name)
                    .put("per100", JSONObject()
                        .put("calories", cursor.getDouble(1))
                        .put("protein", cursor.getDouble(2))
                        .put("fat", cursor.getDouble(3))
                        .put("carbs", cursor.getDouble(4)))
                    .put("servingG", JSONObject.NULL))
            }
        }
        return JSONObject().put("ok", true).put("results", rows).toString()
    }

    override fun close() {
        if (database.isInitialized()) database.value.close()
    }

    private fun openPackagedTable(): SQLiteDatabase {
        // The filename doubles as a content version. Bumping it on a future
        // food-table update naturally installs the new immutable copy without
        // touching a user's diary database.
        val target = context.getDatabasePath("plate-generic-foods-v1.sqlite")
        if (!target.exists()) {
            target.parentFile?.mkdirs()
            context.assets.open("database/foods.sqlite").use { input ->
                FileOutputStream(target).use { output -> input.copyTo(output) }
            }
        }
        return SQLiteDatabase.openDatabase(target.path, null, SQLiteDatabase.OPEN_READONLY)
    }

    private fun error(code: String, message: String): String = JSONObject()
        .put("ok", false)
        .put("code", code)
        .put("message", message)
        .toString()
}
