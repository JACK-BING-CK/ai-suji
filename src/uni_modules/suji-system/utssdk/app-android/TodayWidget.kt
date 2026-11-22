package app.suji.systementry

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.text.format.DateFormat
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import java.util.Calendar
import java.util.Date

class TodayWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = refresh(context)

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action in setOf(REFRESH, Intent.ACTION_DATE_CHANGED, Intent.ACTION_TIME_CHANGED,
                Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_MY_PACKAGE_REPLACED)) refresh(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        alarms(context).cancel(tick(context))
    }

    companion object {
        private const val REFRESH = "app.suji.systementry.REFRESH_WIDGET"
        private fun resource(ctx: Context, name: String, type: String = "id"): Int =
            ctx.resources.getIdentifier(name, type, ctx.packageName)
        private fun flags() = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0
        private fun alarms(ctx: Context) = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        private fun tick(ctx: Context): PendingIntent = PendingIntent.getBroadcast(ctx, 0,
            Intent(ctx, TodayWidget::class.java).setAction(REFRESH), flags())

        private fun launch(ctx: Context, owner: String?, item: WidgetItem? = null): PendingIntent {
            val uri = Uri.Builder().scheme("suji-widget").authority(if (item == null) "record" else "schedule")
            if (owner != null) uri.appendQueryParameter("owner", owner)
            if (item != null) uri.appendQueryParameter("id", item.id).appendQueryParameter("at", item.at.toString())
            val intent = Intent(ctx, WidgetEntryActivity::class.java).setData(uri.build())
            return PendingIntent.getActivity(ctx, 0, intent, flags())
        }

        fun refresh(ctx: Context) {
            val manager = AppWidgetManager.getInstance(ctx)
            val ids = manager.getAppWidgetIds(ComponentName(ctx, TodayWidget::class.java))
            if (ids.isEmpty()) return
            val views = RemoteViews(ctx.packageName, resource(ctx, "suji_today_widget", "layout"))
            val now = System.currentTimeMillis()
            val content = try {
                val sqlId = resource(ctx, "suji_widget_today", "raw")
                val sql = ctx.resources.openRawResource(sqlId).bufferedReader().use { it.readText() }
                SystemStore.of(ctx).today(sql, now)
            } catch (error: Exception) {
                Log.e("SujiWidget", "读取今日待办失败", error)
                null
            }
            val items = content?.rows.orEmpty()
            val empty = resource(ctx, "suji_widget_empty")
            views.setTextViewText(empty, when {
                content == null -> "暂时无法读取待办"
                content.owner == null -> "登录后查看今日待办"
                else -> "今天没有待办"
            })
            views.setViewVisibility(empty, if (items.isEmpty()) View.VISIBLE else View.GONE)
            views.setOnClickPendingIntent(resource(ctx, "suji_widget_record"), launch(ctx, content?.owner))
            val time = DateFormat.getTimeFormat(ctx)
            for (i in 0..2) {
                val viewId = resource(ctx, "suji_widget_row_${i + 1}")
                val item = items.getOrNull(i)
                views.setViewVisibility(viewId, if (item == null) View.GONE else View.VISIBLE)
                if (item != null) {
                    views.setTextViewText(viewId, "${time.format(Date(item.at))}   ${item.title}")
                    views.setOnClickPendingIntent(viewId, launch(ctx, content?.owner, item))
                }
            }
            manager.updateAppWidget(ids, views)
            // 桌面数据完全来自本地。即使应用未打开，也在本地午夜和系统改时后重新计算。
            val midnight = Calendar.getInstance().apply {
                timeInMillis = now
                add(Calendar.DAY_OF_MONTH, 1)
                set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
            }.timeInMillis
            val alarm = alarms(ctx)
            if (Build.VERSION.SDK_INT >= 23) alarm.setAndAllowWhileIdle(AlarmManager.RTC, midnight, tick(ctx))
            else alarm.set(AlarmManager.RTC, midnight, tick(ctx))
        }
    }
}
