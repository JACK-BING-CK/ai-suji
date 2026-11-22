<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import AppNavBar from '@/components/AppNavBar.vue'
import {
  getReminderPermissions,
  openReminderSettings,
} from '@/services/reminderService'
import { useAppearanceStore } from '@/store/appearance'

defineOptions({ name: 'ReminderPermissionsPage' })
const appearance = useAppearanceStore()
type Permissions = Awaited<ReturnType<typeof getReminderPermissions>>
type Kind = keyof Permissions
const entries: { key: Kind; title: string; detail: string }[] = [
  { key: 'notifications', title: '通知', detail: '显示日程标题和提醒内容。' },
  { key: 'exact', title: '精确闹钟', detail: '让系统在选定的时刻唤醒提醒。' },
  {
    key: 'fullscreen',
    title: '全屏闹钟',
    detail:
      '在「日程闹钟」通知类别选择高重要性，并允许横幅、锁屏通知和全屏提醒。部分华为机型只提供应用通知设置。全屏受限时，闹钟仍按时发通知，可在通知中完成或延期。',
  },
  {
    key: 'battery',
    title: '电池优化白名单',
    detail: '允许 AI速记在省电时继续后台运行。',
  },
]
let platform = ''
// #ifdef APP-PLUS
// 系统设置仅在移动客户端开放，Android 和 iOS 展示各自适用的权限。
platform = uni.getSystemInfoSync().platform
// #endif
const native = platform === 'android' || platform === 'ios'
const status = ref<Permissions>()
const visibleEntries = computed(() =>
  entries.filter(
    ({ key }) =>
      (platform !== 'ios' || key === 'notifications') &&
      status.value?.[key] !== null,
  ),
)
const busy = ref<Kind | ''>('')
const error = ref('')
let visible = false
let revision = 0

async function refresh() {
  if (!visible || !native) return
  const request = ++revision
  try {
    const permissions = await getReminderPermissions()
    if (revision === request) {
      status.value = permissions
      error.value = ''
    }
  } catch (cause) {
    if (revision === request) {
      status.value = undefined
      error.value =
        cause instanceof Error
          ? cause.message
          : '读取系统权限失败，请重新检查。'
    }
  }
}
async function open(kind: Kind) {
  if (busy.value) return
  busy.value = kind
  error.value = ''
  try {
    await openReminderSettings(kind)
    await refresh()
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : '打开系统设置失败，请在手机设置中搜索该权限。'
  } finally {
    busy.value = ''
  }
}
onShow(() => {
  visible = true
  void refresh()
})
onHide(() => {
  visible = false
  revision++
})
// #ifdef APP-PLUS
// 从外部系统设置返回时，页面路由可能保持不变。
uni.onAppShow(refresh)
onBeforeUnmount(() => {
  uni.offAppShow(refresh)
  visible = false
  revision++
})
// #endif
</script>

<template>
  <view class="app-page" :class="appearance.pageClass">
    <AppNavBar title="提醒权限" back fallback-tab="/pages/mine/index" />
    <view class="page-body">
      <text v-if="error" class="error-text" role="alert">{{ error }}</text>
      <view v-if="native" class="surface card">
        <view class="heading"
          ><text class="section-title">这台设备</text>
          <button class="quiet-button" @click="refresh">重新检查</button></view
        >
        <view v-for="entry in visibleEntries" :key="entry.key" class="row">
          <view class="copy"
            ><text class="title">{{ entry.title }}</text>
            <text class="muted-copy">{{ entry.detail }}</text>
          </view>
          <button
            class="quiet-button action"
            :class="{ granted: status?.[entry.key] }"
            :aria-label="entry.title + '系统设置'"
            :disabled="!!busy"
            @click="open(entry.key)"
          >
            {{
              busy === entry.key
                ? '打开中…'
                : status?.[entry.key]
                  ? '已开启 ›'
                  : status
                    ? '去开启 ›'
                    : '去检查 ›'
            }}
          </button>
        </view>
      </view>
      <text v-else class="surface notice"
        >请在 Android 或 iOS 客户端检查本机提醒权限。</text
      >
      <text v-if="platform === 'ios'" class="surface notice"
        >iOS 闹钟通过本地通知响铃。系统对单次自定义通知铃声的上限是 30
        秒，铃声文件须短于 30 秒。请同时在系统通知设置中开启声音。</text
      >
      <navigator
        v-if="platform !== 'ios'"
        class="surface guide"
        url="/pages/reminders/background"
      >
        <view
          ><text class="title">后台运行设置指引</text>
          <text class="muted-copy">华为、小米、OPPO、vivo</text></view
        >
        <text aria-hidden="true">›</text>
      </navigator>
    </view>
  </view>
</template>

<style scoped>
.heading,
.row,
.guide {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.card {
  padding: 0 var(--space-4);
}
.heading {
  min-height: 58px;
}
.row {
  padding: var(--space-4) 0;
  border-top: 1px solid var(--border);
}
.copy {
  min-width: 0;
}
.title {
  font-size: 16px;
  color: var(--text);
  font-weight: 600;
}
.action {
  flex-shrink: 0;
  padding: 0;
}
.granted {
  color: var(--text-secondary);
}
.guide,
.notice {
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}
.guide {
  color: var(--primary);
  margin-top: var(--space-4);
}
.notice {
  display: block;
  margin-top: var(--space-3);
  font-size: 14px;
  line-height: 1.65;
}
</style>
