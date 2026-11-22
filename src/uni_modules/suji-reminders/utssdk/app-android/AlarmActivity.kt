package app.suji.reminders

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.Vibrator
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.text.DateFormat
import java.util.Date

private fun openApp(activity: Activity) {
    val launch = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
        ?: error("找不到 AI速记 的启动入口。")
    activity.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
}

internal fun handleAction(activity: Activity, intent: Intent, type: String) {
    val store = AlarmStore(activity)
    val item = store.fromIntent(intent)
    if (item != null) {
        val phase = item.getString("phase")
        val valid = when (type) {
            "open" -> phase == "shown"
            "preview" -> phase == "armed"
            "done", "snooze" -> phase == "ringing"
            else -> false
        }
        if (valid) {
            store.perform(item, type)
            // 延期已注册并尝试写入本地库，唤起 App 消费动作或重试遇锁的事务。
            openApp(activity)
        }
    }
    activity.finish()
}

class ReminderActionActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        try {
            handleAction(this, intent, intent.action ?: "")
        } catch (error: Exception) {
            Log.e("SujiReminder", "处理通知操作失败", error)
            Toast.makeText(this, "提醒操作失败，请在日程中重试。", Toast.LENGTH_LONG).show()
            finish()
        }
    }
}

@Suppress("DEPRECATION")
class AlarmActivity : Activity() {
    companion object {
        private val visible = mutableMapOf<String, WeakReference<AlarmActivity>>()
        fun closeIfRinging(id: String) {
            visible.remove(id)?.get()?.let { activity ->
                activity.stopFeedback()
                activity.finish()
            }
        }
    }
    private var id = ""
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var active = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val item = AlarmStore(this).fromIntent(intent)
        if (item == null || item.optString("phase") != "ringing") { finish(); return }
        id = item.getString("id")
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        else window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val previous = visible.put(id, WeakReference(this))?.get()
        previous?.stopFeedback()
        previous?.finish()
        showControls(item)
    }
    private fun showControls(item: JSONObject) {
        val frame = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            val pad = (32 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Color.rgb(248, 249, 242))
        }
        fun label(value: String, size: Float, bold: Boolean = false) {
            val view = TextView(this).apply {
                text = value; textSize = size
                setTextColor(Color.rgb(32, 56, 49))
                if (bold) setTypeface(typeface, Typeface.BOLD)
                setPadding(0, 6, 0, 8)
            }
            frame.addView(view)
        }
        label("日程闹钟", 17f)
        label(DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(item.getLong("at"))), 42f, true)
        label(item.getString("title"), 24f, true)
        label(item.getString("body"), 16f)
        fun button(value: String, type: String) {
            frame.addView(Button(this).apply {
                text = value
                setOnClickListener {
                    try { handleAction(this@AlarmActivity, intent, type) }
                    catch (error: Exception) { Toast.makeText(this@AlarmActivity, error.localizedMessage ?: "闹钟操作失败，请重试。", Toast.LENGTH_LONG).show() }
                }
            })
        }
        button("完成", "done")
        button("${item.getInt("snoozeMin")} 分钟后再提醒", "snooze")
        setContentView(frame)
    }
    override fun onResume() {
        super.onResume()
        if (isFinishing) return
        val item = AlarmStore(this).fromIntent(intent)
        if (item == null || item.optString("phase") != "ringing") { finish(); return }
        if (active) return
        try {
            notifications(this).cancel(notificationTag(id), NOTIFICATION_ID)
            AlarmNotice.post(this, item, offerFullscreen = false, activityOwnsSound = true)
            active = true
            val channel = if (Build.VERSION.SDK_INT >= 26) notifications(this).getNotificationChannel(ALARM_CHANNEL) else null
            val sound = if (channel == null) alarmSound() else channel.sound
            if (channel?.shouldVibrate() != false) {
                vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                vibrator?.vibrate(channel?.vibrationPattern ?: vibrationPattern, 0, alarmAudio())
            }
            if (sound != null) {
                player = MediaPlayer()
                player!!.apply {
                    setAudioAttributes(alarmAudio()); setDataSource(this@AlarmActivity, sound)
                    isLooping = true
                    setOnPreparedListener { if (active && player === it) it.start() }
                    setOnErrorListener { _, _, _ -> Toast.makeText(this@AlarmActivity, "未能播放闹钟铃声，请检查系统闹钟音量。", Toast.LENGTH_LONG).show(); true }
                    prepareAsync()
                }
            }
        } catch (error: Exception) {
            Log.e("SujiReminder", "无法启动闹钟反馈", error)
            Toast.makeText(this, "部分响铃或震动不可用，请检查系统闹钟设置。", Toast.LENGTH_LONG).show()
        }
    }
    private fun stopFeedback() {
        active = false
        player?.release(); player = null
        vibrator?.cancel(); vibrator = null
    }
    override fun onStop() {
        super.onStop()
        val restore = active && !isFinishing && visible[id]?.get() === this
        stopFeedback()
        if (restore) {
            val item = AlarmStore(this).fromIntent(intent)
            if (item?.optString("phase") == "ringing") {
                try { AlarmNotice.post(this, item, offerFullscreen = false) }
                catch (error: Exception) { Log.e("SujiReminder", "恢复系统闹钟通知失败", error) }
            }
        }
    }
    override fun onBackPressed() { moveTaskToBack(true) }
    override fun onDestroy() {
        stopFeedback()
        if (visible[id]?.get() === this) visible.remove(id)
        super.onDestroy()
    }
}
