package app.suji.reminders

import android.app.Activity
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal const val ALARM_CHANNEL = "suji.local.alarm.v1"
internal const val NOTICE_CHANNEL = "suji.local.notice.v1"
internal val vibrationPattern = longArrayOf(0, 650, 450, 650, 800)

internal fun alarmSound() = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
internal fun alarmAudio() = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
internal fun notifications(ctx: Context) =
    ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

internal fun ensureChannels(ctx: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val notices = NotificationChannel(NOTICE_CHANNEL, "日程通知", NotificationManager.IMPORTANCE_DEFAULT)
    val alarms = NotificationChannel(ALARM_CHANNEL, "日程闹钟", NotificationManager.IMPORTANCE_HIGH).apply {
        setSound(alarmSound(), alarmAudio())
        enableVibration(true)
        vibrationPattern = app.suji.reminders.vibrationPattern
    }
    notifications(ctx).createNotificationChannels(listOf(notices, alarms))
}

internal fun systemIntent(ctx: Context, cls: Class<*>, action: String, item: JSONObject): Intent =
    Intent(ctx, cls).setAction(action).setData(Uri.Builder().scheme("suji-local")
        .authority(action).appendPath(item.getString("id")).appendPath(item.getLong("at").toString()).build())

internal fun pending(ctx: Context, item: JSONObject, action: String): PendingIntent {
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
    if (action == "fire" || action == "dismiss") {
        return PendingIntent.getBroadcast(ctx, 0, systemIntent(ctx, ReminderReceiver::class.java, action, item), flags)
    }
    val cls = if (action == "ring") AlarmActivity::class.java else ReminderActionActivity::class.java
    return PendingIntent.getActivity(ctx, 0, systemIntent(ctx, cls, action, item)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK), flags)
}

internal const val NOTIFICATION_ID = 1
internal fun notificationTag(id: String) = "suji-local-$id"

internal class AlarmStore(private val ctx: Context) {
    private val prefs = ctx.getSharedPreferences("suji.local.reminders.v1", Context.MODE_PRIVATE)
    private val alarms = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    private fun itemKey(id: String) = "item:$id"
    private fun save(editor: SharedPreferences.Editor) {
        check(editor.commit()) { "系统无法保存本地提醒，请检查设备存储。" }
    }
    fun item(id: String): JSONObject? = prefs.getString(itemKey(id), null)?.let { JSONObject(it) }
    fun items() = JSONArray().also { list ->
        prefs.all.filterKeys { it.startsWith("item:") }.values.forEach { list.put(JSONObject(it as String)) }
    }
    fun actions() = JSONArray(prefs.getString("actions", "[]"))
    fun ack(key: String) {
        val remaining = JSONArray()
        val current = actions()
        for (i in 0 until current.length()) {
            val entry = current.getJSONObject(i)
            if (entry.getString("key") != key) remaining.put(entry)
        }
        save(prefs.edit().putString("actions", remaining.toString()))
    }

    fun exactAllowed() = Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()
    fun alarmChannelHigh() = Build.VERSION.SDK_INT < 26 ||
        (notifications(ctx).getNotificationChannel(ALARM_CHANNEL)?.importance ?: 0) >= NotificationManager.IMPORTANCE_HIGH
    fun fullScreenAllowed() = alarmChannelHigh() &&
        (Build.VERSION.SDK_INT < 34 || notifications(ctx).canUseFullScreenIntent())
    fun allowed() = (Build.VERSION.SDK_INT < 24 || notifications(ctx).areNotificationsEnabled()) &&
        (Build.VERSION.SDK_INT < 33 || ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
    private fun armed(item: JSONObject) {
        check(exactAllowed()) { "请先在提醒权限页开启精确闹钟权限。" }
        val at = item.getLong("at")
        val fire = pending(ctx, item, "fire")
        when {
            item.getInt("level") == 1 -> alarms.setAlarmClock(AlarmManager.AlarmClockInfo(at, pending(ctx, item, "preview")), fire)
            Build.VERSION.SDK_INT >= 23 -> alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire)
            else -> alarms.setExact(AlarmManager.RTC_WAKEUP, at, fire)
        }
    }
    fun channelAllowed(level: Int): Boolean = Build.VERSION.SDK_INT < 26 ||
        (notifications(ctx).getNotificationChannel(if (level == 1) ALARM_CHANNEL else NOTICE_CHANNEL)?.importance
            ?: NotificationManager.IMPORTANCE_NONE) != NotificationManager.IMPORTANCE_NONE

    fun schedule(data: JSONObject) {
        ensureChannels(ctx)
        check(allowed()) { "请先在提醒权限页允许通知。" }
        val id = data.getString("id")
        val level = data.getInt("level")
        require(level in 0..1 && id.isNotEmpty() && data.getInt("snoozeMin") > 0) { "提醒设置无效。" }
        check(channelAllowed(level)) { "请在系统通知设置里开启对应的日程通知类别。" }
        val previous = item(id)
        val at = data.getLong("at")
        require(at > System.currentTimeMillis()) { "提醒时间已过，请重新选择。" }
        val next = JSONObject(data.toString()).put("phase", "armed")
        armed(next)
        try {
            save(prefs.edit().putString(itemKey(id), next.toString()))
        } catch (failure: Exception) {
            alarms.cancel(pending(ctx, next, "fire"))
            throw failure
        }
        if (previous != null && previous.getLong("at") != at) alarms.cancel(pending(ctx, previous, "fire"))
        clearPresented(id)
    }
    private fun clearPresented(id: String) {
        notifications(ctx).cancel(notificationTag(id), NOTIFICATION_ID)
        AlarmActivity.closeIfRinging(id)
    }
    fun cancel(id: String) {
        val previous = item(id)
        save(prefs.edit().remove(itemKey(id)))
        if (previous != null) alarms.cancel(pending(ctx, previous, "fire"))
        clearPresented(id)
    }
    fun fromIntent(intent: Intent): JSONObject? {
        val parts = intent.data?.pathSegments ?: return null
        if (parts.size != 2 || parts[0].isEmpty()) return null
        return item(parts[0])?.takeIf { it.getLong("at").toString() == parts[1] }
    }
    fun markFired(data: JSONObject) {
        if (data.getString("phase") != "armed") return
        val level = data.getInt("level")
        ensureChannels(ctx)
        if (!allowed() || !channelAllowed(level) || !ReminderDatabase.shouldDeliver(ctx, data, actions())) {
            save(prefs.edit().remove(itemKey(data.getString("id"))))
            return
        }
        data.put("phase", if (level == 1) "ringing" else "shown")
        save(prefs.edit().putString(itemKey(data.getString("id")), data.toString()))
        // 某些机型锁定通道级别。保留精确定时及通知操作，只申请系统当前允许的全屏展示。
        AlarmNotice.post(ctx, data, offerFullscreen = level == 1 && fullScreenAllowed())
    }
    fun dismiss(data: JSONObject) {
        if (data.getString("phase") == "shown") save(prefs.edit().remove(itemKey(data.getString("id"))))
    }
    fun perform(data: JSONObject, type: String) {
        val id = data.getString("id")
        val scheduled = data.getLong("at")
        val event = JSONObject().put("key", UUID.randomUUID().toString()).put("id", id)
            .put("owner", data.getString("owner")).put("scheduleId", data.getString("scheduleId"))
            .put("type", if (type == "preview") "open" else type).put("scheduledAt", scheduled)
        val change = prefs.edit()
        val next = if (type == "snooze")
            System.currentTimeMillis() + data.getInt("snoozeMin") * 60_000L else scheduled
        event.put("at", next)
        val snoozed = if (type == "snooze") JSONObject(data.toString()).put("at", next).put("phase", "armed") else null
        if (snoozed != null) {
            armed(snoozed)
            change.putString(itemKey(id), snoozed.toString())
        } else if (type != "preview") {
            change.remove(itemKey(id))
        }
        try {
            save(change.putString("actions", actions().put(event).toString()))
        } catch (failure: Exception) {
            if (snoozed != null) alarms.cancel(pending(ctx, snoozed, "fire"))
            throw failure
        }
        if (snoozed != null && ReminderDatabase.writeSnooze(ctx, data, scheduled, next, actions()) == SnoozeWrite.OBSOLETE) {
            // 删除、关闭或改期可能刚刚提交，不能留下已经失效的延期闹钟。
            cancel(id)
        }
        if (type != "preview") clearPresented(id)
    }
}

object ReminderNative {
    @JvmStatic fun invoke(ctx: Context?, activity: Activity?, operation: String, payload: String, reply: (String) -> Unit) {
        val work = Runnable {
            val result = try {
                checkNotNull(ctx) { "安卓应用上下文尚未就绪。" }
                val store = AlarmStore(ctx)
                val data = JSONObject(payload)
                val value: Any = when (operation) {
                    "schedule" -> { store.schedule(data); true }
                    "cancel" -> { store.cancel(data.getString("id")); true }
                    "list" -> store.items()
                    "actions" -> store.actions()
                    "ack" -> { store.ack(data.getString("key")); true }
                    "permissions" -> {
                        ensureChannels(ctx)
                        val power = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
                        JSONObject().put("notifications", store.allowed() && store.channelAllowed(0) && store.channelAllowed(1))
                            .put("exact", store.exactAllowed()).put("fullscreen", store.fullScreenAllowed())
                            .put("battery", Build.VERSION.SDK_INT < 23 || power.isIgnoringBatteryOptimizations(ctx.packageName))
                    }
                    "settings" -> { openSettings(ctx, activity, data.getString("kind")); true }
                    else -> error("不支持的提醒操作。")
                }
                JSONObject().put("ok", true).put("data", value)
            } catch (error: Exception) {
                JSONObject().put("ok", false).put("error", "本地提醒操作失败：" + (error.localizedMessage ?: "请检查权限后重试。"))
            }
            reply(result.toString())
        }
        if (Looper.myLooper() == Looper.getMainLooper()) work.run() else Handler(Looper.getMainLooper()).post(work)
    }

    private fun openSettings(ctx: Context, activity: Activity?, kind: String) {
        val prefs = ctx.getSharedPreferences("suji.local.permissions", Context.MODE_PRIVATE)
        if (kind == "notifications" && Build.VERSION.SDK_INT >= 33 && activity != null &&
            ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            (!prefs.getBoolean("requested", false) || activity.shouldShowRequestPermissionRationale(android.Manifest.permission.POST_NOTIFICATIONS))) {
            prefs.edit().putBoolean("requested", true).apply()
            activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 6843)
            return
        }
        val app = Uri.parse("package:${ctx.packageName}")
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, app)
        val target = when (kind) {
            "exact" -> if (Build.VERSION.SDK_INT >= 31) Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, app) else details
            "fullscreen" -> when {
                // 部分华为设备把新建的闹钟通道设置为普通重要性，需要用户开启横幅和锁屏通知。
                Build.VERSION.SDK_INT >= 26 && !AlarmStore(ctx).alarmChannelHigh() ->
                    Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                        .putExtra(Settings.EXTRA_CHANNEL_ID, ALARM_CHANNEL)
                Build.VERSION.SDK_INT >= 34 -> Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, app)
                else -> details
            }
            // 系统列表由用户选择是否加入白名单，不声明直接申请豁免的权限。
            "battery" -> if (Build.VERSION.SDK_INT >= 23) Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS) else details
            "notifications" -> if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName) else details
            else -> error("无法识别该权限。")
        }
        try {
            ctx.startActivity(target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: android.content.ActivityNotFoundException) {
            ctx.startActivity(details.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
