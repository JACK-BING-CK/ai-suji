import { ref } from 'vue'
import {
  applyReminderAction,
  listEnabledReminders,
  readScheduleReminders,
  setRegistered,
  writeReminderSettings,
  type ReminderRow,
  type ReminderSettings,
} from '../repositories/scheduledReminders'
import { reminderRepository } from '../repositories/reminder'
import type {
  NativeReminder,
  ReminderPlatform,
  ReminderPermissions,
} from '../types/reminders'
import { calendarDate, clockTime } from '../utils/localDateTime'

export type { ReminderRow, ReminderSettings }
export const loadScheduleReminders = readScheduleReminders
export const reminderRevision = ref(0)

interface Runtime {
  native: ReminderPlatform
  owner(): string | null
  openDetail(scheduleId: string): Promise<boolean | void>
  pendingLimit?: number
}
let runtime: Runtime | undefined
let tail: Promise<void> = Promise.resolve()

export function installReminderRuntime(value: Runtime) {
  runtime = value
}

function phone() {
  if (!runtime) throw new Error('请在包含本地提醒模块的手机 App 中操作。')
  return runtime
}

function serialized<T>(task: (app: Runtime) => Promise<T>) {
  const result = tail.then(() => task(phone()))
  // 每个调用方收到自己的异常，后续关闭和重试仍能执行。
  tail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function consumeActions(app: Runtime) {
  let changed = false
  for (const action of await app.native.actions()) {
    const owner = app.owner()
    if (owner && owner === action.owner) {
      const valid = await applyReminderAction(owner, action)
      if (valid && app.owner() === owner) {
        if (action.type === 'open') {
          // 冷启动时页面栈可能仍为空。保留点击动作，其他系统提醒仍按时登记。
          if ((await app.openDetail(action.scheduleId)) === false) continue
        } else {
          changed = true
          reminderRevision.value++
        }
      }
    }
    // 入库或导航成功后确认。意外退出会重放，旧时间戳不会二次延期。
    await app.native.ack(action.key)
  }
  return changed
}

function sameRequest(a: NativeReminder, b: NativeReminder) {
  return (
    a.owner === b.owner &&
    a.scheduleId === b.scheduleId &&
    a.at === b.at &&
    a.level === b.level &&
    a.title === b.title &&
    a.body === b.body &&
    a.sound === b.sound &&
    a.snoozeMin === b.snoozeMin
  )
}

async function reconcile(app: Runtime, force: boolean) {
  const owner = app.owner()
  const now = Date.now()
  const rows = owner ? await listEnabledReminders(owner) : []
  const requests: NativeReminder[] = rows.map(
    ({ reminder: r, title, startAt }) => ({
      id: r.id,
      owner: r.user_id,
      scheduleId: r.schedule_id,
      at: r.remind_at,
      level: r.level,
      title,
      body: `日程开始时间 ${calendarDate(startAt)} ${clockTime(startAt)}`,
      snoozeMin: r.snooze_min > 0 ? r.snooze_min : 10,
      sound: r.sound,
    }),
  )
  const desired = new Map(requests.map((r) => [r.id, r]))
  const future = requests.filter((r) => r.at > now)
  const candidates = future.slice(0, app.pendingLimit ?? future.length)
  const allowed = new Set(candidates.map((row) => row.id))
  const active = new Map((await app.native.list()).map((row) => [row.id, row]))
  const issues: string[] = []
  const previousOwners = new Set<string>()
  for (const row of active.values()) {
    const target = desired.get(row.id)
    if (
      !target ||
      target.owner !== row.owner ||
      (target.at <= now && target.at !== row.at) ||
      (target.at > now && !allowed.has(row.id))
    ) {
      await app.native.cancel(row.id)
      active.delete(row.id)
      if (row.owner !== owner) previousOwners.add(row.owner)
    }
  }
  for (const previous of previousOwners) await setRegistered(previous, [])
  for (const row of candidates) {
    if (app.owner() !== owner) break
    const prior = active.get(row.id)
    if (!force && prior && sameRequest(prior, row)) continue
    try {
      await app.native.schedule(row)
      active.set(row.id, row)
    } catch (cause) {
      // 系统撤权后可能只剩原生缓存；重排失败时清理旧登记，让本地显示待登记。
      if (prior) {
        await app.native.cancel(row.id)
        active.delete(row.id)
      }
      issues.push(cause instanceof Error ? cause.message : '系统登记提醒失败。')
    }
  }
  if (owner)
    await setRegistered(
      owner,
      [...active.keys()].filter((id) => desired.has(id)),
    )
  if (future.length > candidates.length)
    issues.push(
      `系统仅能登记最近 ${candidates.length} 条提醒。其余已保存在本机，下次打开或返回 App 时补排。`,
    )
  if (issues.length) throw new Error([...new Set(issues)].join(' '))
}

function refresh(force: boolean) {
  return serialized(async (app) => {
    await consumeActions(app)
    await reconcile(app, force)
  })
}

export function rescheduleAll() {
  return refresh(true)
}

export function refreshReminderChanges() {
  return runtime ? refresh(false) : Promise.resolve()
}

export async function updateRemindersAfterSave() {
  try {
    await refreshReminderChanges()
  } catch (cause) {
    uni.showToast({
      title:
        '日程已保存。' +
        (cause instanceof Error ? cause.message : '系统提醒需重新登记。'),
      icon: 'none',
    })
  }
}

export function readReminderActions() {
  return serialized(async (app) => {
    if (await consumeActions(app)) await reconcile(app, false)
  })
}

export async function scheduleReminder(reminder: ReminderRow) {
  const app = phone()
  if (app.owner() !== reminder.user_id)
    throw new Error('请切换到提醒所属账号。')
  // 与已提交的本地库比对，避免旧对象在删除或改期后重新登记。
  await refresh(false)
}

export async function cancelReminder(id: string) {
  const owner = phone().owner()
  if (!owner) throw new Error('请先登录再关闭提醒。')
  const row = await reminderRepository.get(owner, id)
  if (row?.enabled) await reminderRepository.update(owner, id, { enabled: 0 })
  await refresh(false)
}

export async function saveReminderSettings(
  owner: string,
  scheduleId: string,
  input: ReminderSettings,
) {
  if (phone().owner() !== owner)
    throw new Error('登录状态已变更，请重新打开日程。')
  if (
    !Number.isSafeInteger(input.remind_at) ||
    !Number.isFinite(new Date(input.remind_at).getTime()) ||
    (input.enabled && input.remind_at <= Date.now())
  )
    throw new Error('请选择将来的提醒时间。')
  if (
    !Number.isInteger(input.snooze_min) ||
    input.snooze_min < 1 ||
    input.snooze_min > 2147483647
  )
    throw new Error('稍后提醒间隔必须是有效的正整数分钟。')
  const row = await writeReminderSettings(owner, scheduleId, input)
  try {
    await scheduleReminder(row)
  } catch (cause) {
    throw new Error(
      '提醒设置已保存在本机。' +
        (cause instanceof Error ? cause.message : '请检查系统提醒权限。'),
      { cause },
    )
  }
}

export async function getReminderPermissions() {
  return phone().native.permissions()
}
export async function openReminderSettings(kind: keyof ReminderPermissions) {
  await phone().native.settings(kind)
}
