import { withDatabase, withTransaction } from './db'
import { uuid } from './fields'
import { reminderRepository } from './reminder'
import { scheduleRepository } from './schedule'
import { notifyLocalWrite } from './syncQueue'
import { setScheduleDoneInTransaction } from './workflow'
import type { ReminderAction } from '../types/reminders'

export type ReminderRow = Awaited<ReturnType<typeof reminderRepository.create>>
export type ReminderSettings = Pick<
  ReminderRow,
  'remind_at' | 'enabled' | 'level' | 'snooze_min'
> & { id?: string }

export function readScheduleReminders(owner: string, id: string) {
  return withDatabase(async (db) => {
    const user = uuid(owner)
    const schedule = await scheduleRepository.transaction.get(
      db,
      user,
      uuid(id),
    )
    if (!schedule) throw new Error('日程已删除或无法访问。')
    const reminders = await reminderRepository.transaction.list(db, user, {
      where: { schedule_id: schedule.id },
    })
    return {
      schedule,
      reminders: reminders.sort((a, b) => a.remind_at - b.remind_at),
    }
  })
}

export function listEnabledReminders(owner: string) {
  return withDatabase(async (db) => {
    const rows = await db.query(
      `SELECT r.*, s.title AS schedule_title, s.start_at AS schedule_start
       FROM reminder r JOIN schedule s ON s.user_id=r.user_id AND s.id=r.schedule_id
       WHERE r.user_id=? AND r.enabled=1 AND r.deleted_at IS NULL AND s.deleted_at IS NULL AND s.done=0
       ORDER BY r.remind_at, r.id`,
      [uuid(owner)],
    )
    return rows.map((row) => ({
      reminder: reminderRepository.syncCodec.decode(row),
      title: String(row.schedule_title),
      startAt: Number(row.schedule_start),
    }))
  })
}

export async function writeReminderSettings(
  owner: string,
  scheduleId: string,
  input: ReminderSettings,
) {
  const user = uuid(owner)
  const saved = await withTransaction(async (db) => {
    const schedule = await scheduleRepository.transaction.get(
      db,
      user,
      uuid(scheduleId),
    )
    if (!schedule) throw new Error('日程已删除或无法访问。')
    if (schedule.done && input.enabled)
      throw new Error('日程已完成，请先恢复为待办。')
    const { id, ...fields } = input
    const repo = reminderRepository.transaction
    if (!id)
      return repo.create(db, user, { ...fields, schedule_id: schedule.id })
    const row = await repo.get(db, user, uuid(id))
    if (!row || row.schedule_id !== schedule.id)
      throw new Error('提醒已删除或无法访问。')
    const updated = await repo.update(db, user, row.id, fields)
    if (!updated) throw new Error('提醒更新失败。')
    return updated
  })
  notifyLocalWrite(user)
  return saved
}

// 设备登记标识只写本机，不改变业务版本或触发云同步。
export function setRegistered(owner: string, ids: readonly string[]) {
  return withTransaction(async (db) => {
    const user = uuid(owner)
    const registered = new Set(ids)
    const rows = await db.query(
      'SELECT id,native_id FROM reminder WHERE user_id=?',
      [user],
    )
    for (const row of rows) {
      const id = uuid(row.id)
      const value = registered.has(id) ? id : null
      if ((row.native_id ?? null) !== value)
        await db.execute(
          'UPDATE reminder SET native_id=? WHERE user_id=? AND id=?',
          [value, user, id],
        )
    }
  })
}

export async function applyReminderAction(
  owner: string,
  action: ReminderAction,
) {
  const user = uuid(owner)
  if (action.owner !== user) return false
  const applied = await withTransaction(async (db) => {
    const row = await reminderRepository.transaction.get(
      db,
      user,
      uuid(action.id),
    )
    if (!row || !row.enabled || row.schedule_id !== action.scheduleId)
      return false
    const schedule = await scheduleRepository.transaction.get(
      db,
      user,
      row.schedule_id,
    )
    if (!schedule || schedule.done) return false
    // 原生锁屏动作已把同一次延期连同同步队列提交时，只需刷新页面并唤醒同步。
    if (
      action.type === 'snooze' &&
      row.remind_at === action.at &&
      action.at > action.scheduledAt
    )
      return true
    if (row.remind_at !== action.scheduledAt) return false
    if (action.type === 'snooze') {
      if (!Number.isSafeInteger(action.at) || action.at <= action.scheduledAt)
        throw new Error('系统返回的稍后提醒时间无效。')
      await reminderRepository.transaction.update(db, user, row.id, {
        remind_at: action.at,
      })
    } else if (action.type === 'done') {
      await setScheduleDoneInTransaction(db, user, schedule, 1)
      await reminderRepository.transaction.update(db, user, row.id, {
        enabled: 0,
      })
    }
    return true
  })
  if (applied && action.type !== 'open') notifyLocalWrite(user)
  return applied
}
