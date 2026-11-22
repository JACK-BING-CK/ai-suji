import { watch } from 'vue'
import { onLocalWrite } from '../repositories/syncQueue'
import { useAuthStore } from '../store/auth'
import { syncedDataRevision } from './sync'
import { reminderPlatform } from './reminderPlatform'
import {
  installReminderRuntime,
  readReminderActions,
  refreshReminderChanges,
  rescheduleAll,
} from './reminderService'

async function openDetail(id: string) {
  const pages = getCurrentPages()
  const top = pages[pages.length - 1] as
    (Page.PageInstance & { options?: { id?: string } }) | undefined
  if (top?.route === 'pages/schedule/detail' && top.options?.id === id) return
  if (!top) return false
  const url = '/pages/schedule/detail?id=' + encodeURIComponent(id)
  await new Promise<void>((resolve, reject) => {
    const options = {
      url,
      success: () => resolve(),
      fail: () => reject(new Error('日程详情暂时无法打开。')),
    }
    if (pages.length >= 10) uni.redirectTo(options)
    else uni.navigateTo(options)
  })
}

export function startReminderLifecycle() {
  const auth = useAuthStore()
  installReminderRuntime({
    native: reminderPlatform,
    owner: () => auth.user?.id ?? null,
    openDetail,
    pendingLimit: plus.os.name === 'iOS' ? 64 : undefined,
  })
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  let active = false
  let lastMessage = ''
  let refreshPending = false
  function report(cause: unknown) {
    const message =
      cause instanceof Error
        ? cause.message
        : '系统提醒操作失败，请到提醒权限页检查。'
    if (lastMessage !== message) uni.showToast({ title: message, icon: 'none' })
    lastMessage = message
  }
  function refresh() {
    if (refreshPending) return
    refreshPending = true
    void Promise.resolve().then(async () => {
      refreshPending = false
      try {
        await refreshReminderChanges()
      } catch (cause) {
        report(cause)
      }
    })
  }
  onLocalWrite((owner) => {
    if (owner === auth.user?.id) refresh()
  })
  watch([() => auth.user?.id, syncedDataRevision], refresh)
  async function poll() {
    if (polling) return
    polling = true
    try {
      await readReminderActions()
    } catch (cause) {
      report(cause)
    } finally {
      polling = false
    }
  }
  return {
    show() {
      if (active) return
      active = true
      lastMessage = ''
      // 冷启动和权限设置返回前台均重新登记；通知触发依靠系统，轮询只负责前台接收按钮操作。
      void rescheduleAll().catch(report)
      timer = setInterval(poll, 2000)
    },
    hide() {
      active = false
      clearInterval(timer)
    },
  }
}
