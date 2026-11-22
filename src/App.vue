<script setup lang="ts">
import { onHide, onLaunch, onShow } from '@dcloudio/uni-app'
import { watch } from 'vue'
import { useAppearanceStore } from './store/appearance'
import { useAuthStore } from './store/auth'
import { useDraftStore } from './store/draft'
// #ifdef APP-PLUS
import { initializeDatabase } from './repositories/db'
import { recoverPendingVoice } from './services/pendingVoice'
import { startSync } from './services/sync'
import { startReminderLifecycle } from './services/reminderLifecycle'
import { startSystemEntries } from './services/systemEntries'
// 安卓通过系统 Activity、iOS 通过共享容器传入系统入口事件。
import { invokeSystem } from '@/uni_modules/suji-system'
// #endif

const auth = useAuthStore()
const appearance = useAppearanceStore()
const draft = useDraftStore()
// #ifdef APP-PLUS
// 原生 SQLite 同步跟随应用生命周期；H5 仅提供界面预览。
let sync: ReturnType<typeof startSync> | undefined
let reminderLifecycle: ReturnType<typeof startReminderLifecycle> | undefined
let systemEntries: ReturnType<typeof startSystemEntries> | undefined
let foreground = true
onShow(() => {
  foreground = true
  reminderLifecycle?.show()
  systemEntries?.show()
  sync?.show()
})
onHide(() => {
  foreground = false
  reminderLifecycle?.hide()
  systemEntries?.hide()
  sync?.hide()
})
// #endif
onShow(() => appearance.refreshSystemTheme())
watch(
  () => auth.user?.id,
  (owner, previous) => {
    if (previous && owner !== previous) draft.$reset()
  },
  { flush: 'sync' },
)

onLaunch(async () => {
  try {
    auth.restore()
  } catch (error) {
    uni.showToast({
      title: error instanceof Error ? error.message : '登录状态恢复失败',
      icon: 'none',
    })
  }
  appearance.followSystem()
  // 仅 App-Plus 含 Android/iOS 原生 SQLite 桥，H5 预览跳过初始化。
  // #ifdef APP-PLUS
  if (auth.user) {
    try {
      await recoverPendingVoice(auth.user.id)
    } catch (cause) {
      uni.showToast({
        title:
          cause instanceof Error
            ? cause.message
            : '录音恢复失败，请在记录页重试。',
        icon: 'none',
      })
    }
  }
  try {
    await initializeDatabase()
    systemEntries = startSystemEntries(invokeSystem)
    if (foreground) systemEntries.show()
    reminderLifecycle = startReminderLifecycle()
    if (foreground) reminderLifecycle.show()
    sync = startSync()
    if (!foreground) sync.hide()
  } catch (error) {
    uni.showModal({
      title: '本地数据库未就绪',
      content:
        error instanceof Error ? error.message : '请重新打开 App 后重试。',
      showCancel: false,
    })
  }
  // #endif
})
</script>
<style lang="scss">
@use './styles/theme';
</style>
