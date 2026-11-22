package app.suji.reminders

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

internal enum class SnoozeWrite { STORED, OBSOLETE, DEFERRED }

internal object ReminderDatabase {
    private fun localDatabase(ctx: Context, path: String): File? {
        if (path.isEmpty()) return null
        val uri = Uri.parse(path)
        val raw = when {
            uri.scheme == null -> path
            uri.scheme == "file" && uri.authority.isNullOrEmpty() -> uri.path ?: return null
            else -> return null
        }
        val file = File(raw)
        if (!file.isAbsolute) return null
        val target = file.canonicalFile
        if (target.name != "ai-suji.db" || !target.isFile) return null
        val roots = mutableListOf(File(ctx.applicationInfo.dataDir).canonicalFile)
        // 旧版 App-Plus 还可能把 _doc 放在 Android/data/<自己的包名>/apps 下。
        ctx.getExternalFilesDirs(null).filterNotNull().forEach { files ->
            val app = files.canonicalFile.parentFile
            if (app != null && app.name == ctx.packageName) roots.add(app)
        }
        return target.takeIf { roots.any { root -> target.path.startsWith(root.path + File.separator) } }
    }

    private const val ACTIVE = """user_id=? AND id=? AND schedule_id=? AND level=? AND enabled=1 AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM schedule s WHERE s.user_id=reminder.user_id
            AND s.id=reminder.schedule_id AND s.done=0 AND s.deleted_at IS NULL)"""

    private fun identity(item: JSONObject) = arrayOf(item.getString("owner"), item.getString("id"),
        item.getString("scheduleId"), item.getInt("level").toString())

    private fun currentTime(db: SQLiteDatabase, args: Array<String>): Long? =
        db.rawQuery("SELECT remind_at FROM reminder WHERE $ACTIVE", args).use {
            if (it.moveToFirst()) it.getLong(0) else null
        }

    // 连续锁屏延期时，前一笔 SQLite 写入可能尚在重试。只追认同账号、同日程的连续动作。
    private fun reaches(item: JSONObject, stored: Long, wanted: Long, pending: JSONArray): Boolean {
        var at = stored
        if (at == wanted) return true
        for (i in 0 until pending.length()) {
            val e = pending.getJSONObject(i)
            if (e.optString("type") == "snooze" && e.optString("owner") == item.getString("owner")
                && e.optString("id") == item.getString("id") && e.optString("scheduleId") == item.getString("scheduleId")
                && e.optLong("scheduledAt") == at) {
                at = e.getLong("at")
                if (at == wanted) return true
            }
        }
        return false
    }

    fun shouldDeliver(ctx: Context, item: JSONObject, pending: JSONArray): Boolean {
        try {
            val path = localDatabase(ctx, item.optString("databasePath", "")) ?: return true
            val flags = SQLiteDatabase.OPEN_READONLY or SQLiteDatabase.NO_LOCALIZED_COLLATORS
            return SQLiteDatabase.openDatabase(path.path, null, flags).use { db ->
                db.rawQuery("PRAGMA busy_timeout=0", null).use { it.moveToFirst() }
                val stored = currentTime(db, identity(item))
                stored != null && reaches(item, stored, item.getLong("at"), pending)
            }
        } catch (error: Exception) {
            Log.w("SujiReminder", "读取本地库失败，本次按已登记的系统提醒投递。", error)
            return true
        }
    }

    fun writeSnooze(ctx: Context, item: JSONObject, oldAt: Long, nextAt: Long, pending: JSONArray): SnoozeWrite {
        try {
            val path = localDatabase(ctx, item.optString("databasePath", "")) ?: return SnoozeWrite.DEFERRED
            val flags = SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.NO_LOCALIZED_COLLATORS
            return SQLiteDatabase.openDatabase(path.path, null, flags).use { db ->
                // App 可能正持有 SQLite 事务。此时交给已持久化的动作重试，不等待写锁。
                db.rawQuery("PRAGMA busy_timeout=0", null).use { it.moveToFirst() }
                db.beginTransactionNonExclusive()
                try {
                    val result = update(db, item, oldAt, nextAt, pending)
                    db.setTransactionSuccessful()
                    result
                } finally {
                    db.endTransaction()
                }
            }
        } catch (error: Exception) {
            Log.w("SujiReminder", "锁屏延期已留在本机动作队列，待应用恢复后重试。", error)
            return SnoozeWrite.DEFERRED
        }
    }

    private fun update(db: SQLiteDatabase, item: JSONObject, oldAt: Long, nextAt: Long, pending: JSONArray): SnoozeWrite {
        val args = identity(item)
        val current = currentTime(db, args) ?: return SnoozeWrite.OBSOLETE
        if (current == nextAt) return SnoozeWrite.STORED
        if (!reaches(item, current, oldAt, pending)) return SnoozeWrite.OBSOLETE
        db.execSQL("""UPDATE reminder SET remind_at=?, updated_at=MAX(updated_at + 1, ?)
            WHERE $ACTIVE AND remind_at=?""", arrayOf<Any>(nextAt, System.currentTimeMillis(), *args, current))
        db.execSQL("""INSERT OR REPLACE INTO sync_outbox (user_id,table_name,row_id,version)
            SELECT user_id,'reminder',id,updated_at FROM reminder WHERE $ACTIVE""", args)
        return SnoozeWrite.STORED
    }
}
