package com.zandaulion.bitey

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Kotlin-owned, app-private persistence. Start with barcode data because it
 * crosses the network boundary: a cached result must be available before a
 * direct Open Food Facts request is even considered.
 */
@Entity(tableName = "barcode_foods")
data class BarcodeFoodEntity(
    @PrimaryKey val barcode: String,
    val foodJson: String,
    val cachedAt: Long,
)

@Dao
interface BarcodeFoodDao {
    @Query("SELECT foodJson FROM barcode_foods WHERE barcode = :barcode LIMIT 1")
    fun foodJson(barcode: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun save(food: BarcodeFoodEntity)

    @Query("SELECT barcode, foodJson, cachedAt FROM barcode_foods ORDER BY barcode ASC")
    fun all(): List<BarcodeFoodEntity>

    @Query("DELETE FROM barcode_foods")
    fun clear()
}

@Entity(tableName = "profile")
data class ProfileEntity(
    @PrimaryKey val id: String = "profile",
    val profileJson: String,
    val updatedAt: Long,
)

@Dao
interface ProfileDao {
    @Query("SELECT profileJson FROM profile WHERE id = 'profile' LIMIT 1")
    fun profileJson(): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun save(profile: ProfileEntity)

    @Query("DELETE FROM profile")
    fun clear()
}

@Entity(tableName = "weights")
data class WeightEntity(
    @PrimaryKey val day: String,
    val kg: Double,
    val at: String,
)

@Dao
interface WeightDao {
    @Query("SELECT day, kg, at FROM weights ORDER BY day ASC")
    fun all(): List<WeightEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun save(weight: WeightEntity)

    @Query("DELETE FROM weights WHERE day = :day")
    fun delete(day: String): Int

    @Query("DELETE FROM weights")
    fun clear()
}

/**
 * Diary content without the image payload. Image bytes remain in the WebView's
 * private store for this migration: keeping them out of the JS bridge and Room
 * avoids copying large base64 strings through either layer.
 */
@Entity(tableName = "entries")
data class DiaryEntryEntity(
    @PrimaryKey val id: String,
    val day: String,
    val sortKey: Long,
    val entryJson: String,
    val updatedAt: Long,
)

@Dao
interface DiaryEntryDao {
    @Query("SELECT entryJson FROM entries ORDER BY day ASC, sortKey DESC")
    fun all(): List<String>

    @Query("SELECT entryJson FROM entries WHERE id = :id LIMIT 1")
    fun entryJson(id: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun save(entry: DiaryEntryEntity)

    @Query("DELETE FROM entries WHERE id = :id")
    fun delete(id: String): Int

    @Query("DELETE FROM entries")
    fun clear()
}

/** Metadata for a photo held in the app-private files directory. */
@Entity(tableName = "photos")
data class PhotoEntity(
    @PrimaryKey val id: String,
    val mimeType: String,
    val byteCount: Long,
)

@Dao
interface PhotoDao {
    @Query("SELECT id, mimeType, byteCount FROM photos ORDER BY id ASC")
    fun all(): List<PhotoEntity>

    @Query("SELECT id, mimeType, byteCount FROM photos WHERE id = :id LIMIT 1")
    fun photo(id: String): PhotoEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun save(photo: PhotoEntity)

    @Query("DELETE FROM photos WHERE id = :id")
    fun delete(id: String): Int

    @Query("DELETE FROM photos")
    fun clear()
}

@Database(
    entities = [BarcodeFoodEntity::class, ProfileEntity::class, WeightEntity::class, DiaryEntryEntity::class, PhotoEntity::class],
    version = 4,
    exportSchema = false,
)
abstract class PlateDatabase : RoomDatabase() {
    abstract fun barcodeFoods(): BarcodeFoodDao
    abstract fun profile(): ProfileDao
    abstract fun weights(): WeightDao
    abstract fun entries(): DiaryEntryDao
    abstract fun photos(): PhotoDao

    companion object {
        @Volatile private var instance: PlateDatabase? = null

        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS profile (id TEXT NOT NULL, profileJson TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(id))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS weights (day TEXT NOT NULL, kg REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY(day))",
                )
            }
        }

        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS entries (id TEXT NOT NULL, day TEXT NOT NULL, sortKey INTEGER NOT NULL, entryJson TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(id))",
                )
            }
        }

        private val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS photos (id TEXT NOT NULL, mimeType TEXT NOT NULL, byteCount INTEGER NOT NULL, PRIMARY KEY(id))",
                )
            }
        }

        fun get(context: Context): PlateDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                PlateDatabase::class.java,
                "plate.db",
            ).addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4).build().also { instance = it }
        }
    }
}
