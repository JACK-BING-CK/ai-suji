package app.suji.systementry

import android.content.Context
import org.json.JSONObject

object SystemNative {
    @JvmStatic fun invoke(context: Context?, operation: String, payload: String, callback: (String) -> Unit) {
        val result = try {
            val app = requireNotNull(context?.applicationContext) { "应用尚未就绪。" }
            val request = JSONObject(payload)
            val store = SystemStore.of(app)
            val data: Any? = when (operation) {
                "setOwner" -> {
                    val account = if (request.isNull("owner")) null else request.getString("owner")
                    if (store.setOwner(account)) TodayWidget.refresh(app)
                    null
                }
                "shares" -> store.shares()
                "ackShare" -> { store.acknowledge(request.getString("id"), true); null }
                "navigation" -> store.target()
                "ackNavigation" -> { store.acknowledge(request.getString("id"), false); null }
                "widget" -> {
                    store.replaceWidget(request.getString("owner"), request.getJSONArray("rows"))
                    TodayWidget.refresh(app)
                    null
                }
                else -> throw IllegalArgumentException("未知系统入口操作。")
            }
            JSONObject().put("ok", true).put("data", data ?: JSONObject.NULL)
        } catch (error: Exception) {
            JSONObject().put("ok", false).put("error", error.message ?: "系统入口操作失败。")
        }
        callback(result.toString())
    }
}
