import { watch } from 'vue'
import { importSharedIdea } from '../repositories/idea'
import { scheduleRepository } from '../repositories/schedule'
import { onLocalWrite } from '../repositories/syncQueue'
import { useAuthStore } from '../store/auth'
import { syncedDataRevision } from './sync'
import type { invokeSystem } from '@/uni_modules/suji-system'

interface IncomingShare {
  id: string
  owner: string | null
  text: string
}

interface Destination {
  id: string
  owner: string | null
  kind: 'record' | 'schedule'
  scheduleId?: string
  at?: number
}

function invoke<T>(
  bridge: typeof invokeSystem,
  operation: string,
  payload: object = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      bridge(operation, JSON.stringify(payload), (raw) => {
        try {
          const result = JSON.parse(raw)
          if (result.ok !== true)
            throw new Error(result.error || '系统入口暂不可用。')
          resolve(result.data as T)
        } catch (cause) {
          reject(cause)
        }
      })
    } catch {
      reject(
        new Error('此安装包缺少系统分享和桌面组件，请使用集成原生模块的版本。'),
      )
    }
  })
}

async function openPage(path: string, tab = false) {
  const pages = getCurrentPages()
  const current = pages[pages.length - 1] as
    (Page.PageInstance & { options?: { id?: string; at?: string } }) | undefined
  if (!current) return false
  const existing = '/' + current.route
  if (
    existing === path ||
    (current.options?.id &&
      path ===
        existing + '?id=' + current.options.id + '&at=' + current.options.at)
  )
    return true
  await new Promise<void>((resolve, reject) => {
    const options = {
      url: path,
      success: () => resolve(),
      fail: () => reject(new Error('暂时无法打开对应页面。')),
    }
    if (tab) uni.switchTab(options)
    else if (pages.length >= 10) uni.redirectTo(options)
    else uni.navigateTo(options)
  })
  return true
}

export function startSystemEntries(bridge: typeof invokeSystem) {
  const native = <T>(operation: string, payload?: object) =>
    invoke<T>(bridge, operation, payload)
  const auth = useAuthStore()
  const owner = () => auth.user?.id ?? null
  let active = false
  let busy = false
  let rerun = false
  let widgetDirty = true
  let lastWidget = ''
  let lastOwner: string | null | undefined
  let lastMessage = ''
  let askedToLogin = false
  let poll: ReturnType<typeof setInterval> | undefined

  async function updateWidget(account: string) {
    widgetDirty = false
    try {
      const saved = await scheduleRepository.list(account)
      if (owner() !== account) return
      const rows = saved.map(
        ({
          id,
          title,
          start_at,
          end_at,
          repeat_rule,
          priority,
          done,
          completed_slots,
        }) => ({
          id,
          title,
          start_at,
          end_at,
          repeat_rule,
          priority,
          done,
          completed_slots,
        }),
      )
      const signature = JSON.stringify(rows)
      if (lastWidget !== signature) {
        await native('widget', { owner: account, rows })
        lastWidget = signature
      }
    } catch (cause) {
      widgetDirty = true
      throw cause
    }
  }

  async function processIncoming(account: string | null) {
    if (!active || owner() !== account) return
    const shares = await native<IncomingShare[]>('shares')
    if (!account && shares.length && !askedToLogin) {
      askedToLogin = await openPage('/pages/auth/login')
      if (askedToLogin)
        uni.showToast({ title: '登录后会自动收进想法库', icon: 'none' })
    }
    let imported = false
    for (const share of shares) {
      if (!account || owner() !== account) break
      if (share.owner !== account) continue
      if (await importSharedIdea(account, share.id, share.text)) {
        imported = true
        syncedDataRevision.value++
      }
      await native('ackShare', { id: share.id })
    }
    if (imported && owner() === account) {
      uni.showToast({ title: '分享已存入收集箱', icon: 'none' })
    }
    if (!active || owner() !== account) return
    const action = await native<Destination | null>('navigation')
    if (action && owner() === account) {
      let opened = true
      if (action.kind === 'record')
        opened = await openPage('/pages/record/index', true)
      else if (
        action.kind === 'schedule' &&
        account &&
        action.owner === account &&
        action.scheduleId &&
        Number.isSafeInteger(action.at)
      ) {
        const row = await scheduleRepository.get(account, action.scheduleId)
        if (row && owner() === account)
          opened = await openPage(
            '/pages/schedule/detail?id=' +
              encodeURIComponent(row.id) +
              '&at=' +
              action.at,
          )
        else if (owner() === account)
          uni.showToast({ title: '日程已删除', icon: 'none' })
      }
      if (opened) await native('ackNavigation', { id: action.id })
    }
  }

  async function processEntries(account: string | null) {
    if (lastOwner !== account) {
      await native('setOwner', { owner: account })
      lastOwner = account
      lastWidget = ''
      widgetDirty = true
      askedToLogin = false
    }
    try {
      await processIncoming(account)
    } finally {
      // 保存后立即回桌面时，已经提交的本地日程仍要交给小组件。
      if (widgetDirty && account && owner() === account)
        await updateWidget(account)
    }
  }

  async function run() {
    if (busy) {
      rerun = true
      return
    }
    busy = true
    try {
      do {
        rerun = false
        await processEntries(owner())
      } while (rerun)
      lastMessage = ''
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : '系统分享或桌面待办更新失败，请重新打开应用。'
      if (message !== lastMessage)
        uni.showToast({ title: message, icon: 'none' })
      lastMessage = message
    } finally {
      busy = false
    }
  }
  function changed() {
    widgetDirty = true
    void run()
  }
  watch(owner, changed, { flush: 'sync' })
  onLocalWrite((account) => {
    if (account === owner()) changed()
  })
  watch(syncedDataRevision, changed)
  plus.globalEvent?.addEventListener('newintent', () => {
    void run()
  })
  return {
    show() {
      active = true
      changed()
      clearInterval(poll)
      // iOS 共享扩展独立于宿主；Android 启动中的 Activity 也可能晚于 onShow 交付 Intent。
      poll = setInterval(() => {
        void run()
      }, 3000)
    },
    hide() {
      active = false
      clearInterval(poll)
    },
  }
}
