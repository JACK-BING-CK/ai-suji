package app.suji.systementry

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal data class WidgetItem(val id: String, val title: String, val at: Long)
internal data class WidgetContent(val owner: String?, val rows: List<WidgetItem>)

internal class SystemStore private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "suji-system.db", null, 1) {
    companion object {
        @Volatile private var instance: SystemStore? = null
        fun of(context: Context): SystemStore = instance ?: synchronized(this) {
            instance ?: SystemStore(context).also { instance = it }
        }
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE state (name TEXT PRIMARY KEY,value TEXT)")
        db.execSQL("CREATE TABLE shares (id TEXT PRIMARY KEY,owner TEXT,text TEXT NOT NULL)")
        db.execSQL("CREATE TABLE navigation (id TEXT PRIMARY KEY,owner TEXT,kind TEXT NOT NULL,schedule_id TEXT,at INTEGER)")
        db.execSQL("CREATE TABLE widget_schedule (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,repeat_rule TEXT,priority INTEGER NOT NULL,done INTEGER NOT NULL,completed_slots TEXT NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        throw IllegalStateException("缺少系统入口数据库迁移：$oldVersion → $newVersion")
    }

    private fun <T> transaction(body: (SQLiteDatabase) -> T): T {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val result = body(db)
            db.setTransactionSuccessful()
            return result
        } finally {
            db.endTransaction()
        }
    }

    private fun owner(db: SQLiteDatabase): String? =
        db.rawQuery("SELECT value FROM state WHERE name='owner'", null).use {
            if (it.moveToFirst()) it.getString(0) else null
        }

    fun setOwner(account: String?): Boolean = transaction { db ->
        val previous = owner(db)
        if (account == previous) return@transaction false
        db.execSQL("INSERT OR REPLACE INTO state(name,value) VALUES ('owner',?)", arrayOf(account))
        if (previous != null) db.delete("widget_schedule", "user_id=?", arrayOf(previous))
        // 登录时原子领取匿名分享，防止账号切换时再次导入同一条。
        if (account != null) db.execSQL("UPDATE shares SET owner=? WHERE owner IS NULL", arrayOf(account))
        db.execSQL("DELETE FROM navigation WHERE owner IS NOT NULL AND owner IS NOT ?", arrayOf(account))
        true
    }

    fun receive(id: String, text: String) = transaction { db ->
        db.execSQL("INSERT OR IGNORE INTO shares(id,owner,text) VALUES (?,?,?)", arrayOf(id, owner(db), text))
    }

    fun shares(): JSONArray = transaction { db ->
        val active = owner(db)
        val selection = if (active == null) "owner IS NULL" else "owner=?"
        val result = JSONArray()
        db.rawQuery("SELECT id,owner,text FROM shares WHERE $selection ORDER BY rowid", active?.let { arrayOf(it) }).use {
            while (it.moveToNext()) result.put(JSONObject().put("id", it.getString(0))
                .put("owner", it.getString(1) ?: JSONObject.NULL).put("text", it.getString(2)))
        }
        result
    }

    fun acknowledge(id: String, share: Boolean) = transaction { db ->
        val table = if (share) "shares" else "navigation"
        val active = owner(db)
        if (active == null) db.delete(table, "id=? AND owner IS NULL", arrayOf(id))
        else db.delete(table, "id=? AND (owner=? OR owner IS NULL)", arrayOf(id, active))
    }

    fun rememberTarget(kind: String, expectedOwner: String?, schedule: String?, at: Long?) = transaction { db ->
        val active = owner(db)
        if (kind == "schedule" && (active == null || active != expectedOwner || schedule == null || at == null))
            return@transaction
        val values = ContentValues().apply {
            put("id", UUID.randomUUID().toString()); put("owner", active); put("kind", kind)
            put("schedule_id", schedule); put("at", at)
        }
        db.insertOrThrow("navigation", null, values)
    }

    fun target(): JSONObject? = transaction { db ->
        val active = owner(db)
        val scope = if (active == null) "owner IS NULL" else "(owner=? OR owner IS NULL)"
        db.rawQuery("SELECT id,owner,kind,schedule_id,at FROM navigation WHERE $scope ORDER BY rowid LIMIT 1",
            active?.let { arrayOf(it) }).use {
            if (!it.moveToFirst()) return@use null
            val item = JSONObject().put("id", it.getString(0)).put("owner", it.getString(1) ?: JSONObject.NULL)
                .put("kind", it.getString(2))
            if (!it.isNull(3)) item.put("scheduleId", it.getString(3))
            if (!it.isNull(4)) item.put("at", it.getLong(4))
            item
        }
    }

    fun replaceWidget(account: String, rows: JSONArray) = transaction { db ->
        require(account == owner(db)) { "账号已切换。" }
        db.delete("widget_schedule", "user_id=?", arrayOf(account))
        db.compileStatement("INSERT INTO widget_schedule (id,title,start_at,end_at,repeat_rule,priority,done,completed_slots,user_id) VALUES(?,?,?,?,?,?,?,?,?)").use { stmt ->
            for (i in 0 until rows.length()) {
                val row = rows.getJSONObject(i)
                val slots = row.getJSONArray("completed_slots")
                val text = StringBuilder(",")
                for (j in 0 until slots.length()) {
                    val slot = slots.getString(j).toLong()
                    require(slot > 0)
                    text.append(slot).append(',')
                }
                stmt.clearBindings()
                stmt.bindString(1, row.getString("id")); stmt.bindString(2, row.getString("title"))
                stmt.bindLong(3, row.getLong("start_at")); stmt.bindLong(4, row.getLong("end_at"))
                if (row.isNull("repeat_rule")) stmt.bindNull(5) else stmt.bindString(5, row.getString("repeat_rule"))
                stmt.bindLong(6, row.getLong("priority")); stmt.bindLong(7, row.getLong("done"))
                stmt.bindString(8, text.toString()); stmt.bindString(9, account); stmt.executeInsert()
            }
        }
    }

    fun today(sql: String, now: Long): WidgetContent = transaction { db ->
        val account = owner(db) ?: return@transaction WidgetContent(null, emptyList())
        val rows = mutableListOf<WidgetItem>()
        db.rawQuery(sql, arrayOf(now.toString(), account)).use {
            val id = it.getColumnIndexOrThrow("id"); val title = it.getColumnIndexOrThrow("title")
            val start = it.getColumnIndexOrThrow("start_at")
            while (rows.size < 3 && it.moveToNext()) rows.add(WidgetItem(it.getString(id), it.getString(title), it.getLong(start)))
        }
        WidgetContent(account, rows)
    }
}
