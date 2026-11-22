package app.suji.systementry

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import java.util.UUID

private fun Activity.openApp() {
    val main = packageManager.getLaunchIntentForPackage(packageName)
        ?: throw IllegalStateException("没有找到 AI速记入口。")
    main.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    startActivity(main)
}

class ShareActivity : Activity() {
    override fun onCreate(savedState: Bundle?) {
        super.onCreate(savedState)
        try {
            if (Intent.ACTION_SEND != intent.action || intent.type?.startsWith("text/") != true)
                throw IllegalArgumentException("请选择要分享的文字或网页链接。")
            val text = contents(intent)
            require(text.isNotBlank()) { "分享内容为空。" }
            require(text.codePointCount(0, text.length) <= 2000) { "分享内容超过 2000 字，请缩短后重试。" }
            // 旋屏或系统恢复同一次分享时复用 ID，另一次分享即使文字相同也单独记录。
            val id = savedState?.getString("shareId") ?: UUID.randomUUID().toString()
            shareId = id
            SystemStore.of(this).receive(id, text)
            openApp()
        } catch (error: Exception) {
            Toast.makeText(this, error.localizedMessage ?: "分享失败，请重试。", Toast.LENGTH_LONG).show()
        } finally {
            finish()
        }
    }

    private var shareId: String? = null
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("shareId", shareId)
    }

    private fun contents(input: Intent): String {
        val pieces = mutableListOf<String>()
        fun add(value: CharSequence?) {
            val text = value?.toString()?.trim().orEmpty()
            if (text.isNotEmpty() && pieces.none { text == it || (text.startsWith("http") && it.contains(text)) }) pieces.add(text)
        }
        add(input.getCharSequenceExtra(Intent.EXTRA_TEXT))
        input.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) {
                val item = clip.getItemAt(i)
                add(item.text)
                val uri = item.uri
                if (uri?.scheme.equals("http", true) || uri?.scheme.equals("https", true)) add(uri.toString())
            }
        }
        val subject = input.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()?.trim().orEmpty()
        if (subject.isNotEmpty() && pieces.none { it.contains(subject) }) pieces.add(0, subject)
        return pieces.joinToString("\n")
    }
}

class WidgetEntryActivity : Activity() {
    override fun onCreate(savedState: Bundle?) {
        super.onCreate(savedState)
        try {
            val uri = requireNotNull(intent.data)
            val kind = uri.host
            require(kind == "record" || kind == "schedule")
            if (savedState == null) SystemStore.of(this).rememberTarget(
                kind, uri.getQueryParameter("owner"), uri.getQueryParameter("id"),
                uri.getQueryParameter("at")?.toLongOrNull())
            openApp()
        } catch (error: Exception) {
            Toast.makeText(this, "打开 AI速记失败，请再点一次。", Toast.LENGTH_LONG).show()
        } finally { finish() }
    }
}
