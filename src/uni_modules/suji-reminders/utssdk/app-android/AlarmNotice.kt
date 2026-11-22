package app.suji.reminders

import android.app.Notification
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.AudioManager
import android.os.Build
import android.util.Log
import android.widget.Toast
import org.json.JSONObject

internal object AlarmNotice {
    @Suppress("DEPRECATION")
    fun post(ctx: Context, data: JSONObject, offerFullscreen: Boolean, activityOwnsSound: Boolean = false) {
        val id = data.getString("id")
        val alarm = data.getInt("level") == 1
        val channel = if (alarm) ALARM_CHANNEL else NOTICE_CHANNEL
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, channel) else Notification.Builder(ctx)
        builder.setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(data.getString("title")).setContentText(data.getString("body"))
            .setStyle(Notification.BigTextStyle().bigText(data.getString("body")))
            .setColor(Color.rgb(35, 90, 76)).setShowWhen(true).setWhen(data.getLong("at"))
            .setContentIntent(pending(ctx, data, if (alarm) "ring" else "open"))
            .setCategory(if (alarm) Notification.CATEGORY_ALARM else Notification.CATEGORY_REMINDER)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(!alarm)
        if (alarm) {
            builder.setPriority(Notification.PRIORITY_MAX).setOngoing(true)
                .addAction(android.R.drawable.checkbox_on_background, "完成", pending(ctx, data, "done"))
                .addAction(android.R.drawable.ic_media_pause, "${data.getInt("snoozeMin")} 分钟后再提醒", pending(ctx, data, "snooze"))
            if (offerFullscreen) builder.setFullScreenIntent(pending(ctx, data, "ring"), true)
            if (activityOwnsSound && Build.VERSION.SDK_INT >= 26) {
                // 锁屏页已经接管音频。静音的分组子通知仍保留两个操作按钮。
                builder.setGroup("suji-visible-$id").setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
            }
            if (!activityOwnsSound && Build.VERSION.SDK_INT < 26)
                builder.setSound(alarmSound(), AudioManager.STREAM_ALARM).setVibrate(vibrationPattern)
        } else {
            builder.setDeleteIntent(pending(ctx, data, "dismiss"))
            if (Build.VERSION.SDK_INT < 26) builder.setDefaults(Notification.DEFAULT_ALL)
        }
        val notification = builder.build()
        // 未打开全屏页时，响铃和震动由系统通知持有，可跨应用普通进程死亡继续播放。
        if (alarm && !activityOwnsSound) notification.flags = notification.flags or Notification.FLAG_INSISTENT
        notifications(ctx).notify(notificationTag(id), NOTIFICATION_ID, notification)
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            val store = AlarmStore(context)
            val data = store.fromIntent(intent) ?: return
            when (intent.action) {
                "fire" -> store.markFired(data)
                "dismiss" -> store.dismiss(data)
            }
        } catch (error: Exception) {
            Log.e("SujiReminder", "提醒投递失败", error)
            Toast.makeText(context, "提醒投递失败，请打开 AI速记检查提醒权限。", Toast.LENGTH_LONG).show()
        }
    }
}
