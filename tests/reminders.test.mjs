import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { installBridge } from './fixtures/sqlite-bridge.mjs'
import { scheduleRepository } from '../src/repositories/schedule.ts'
import { reminderRepository } from '../src/repositories/reminder.ts'
import { readPendingChanges } from '../src/repositories/sync.ts'
import { deleteSchedule } from '../src/services/schedules.ts'
import { setScheduleDone } from '../src/services/workflow.ts'
import {
  cancelReminder,
  installReminderRuntime,
  loadScheduleReminders,
  readReminderActions,
  refreshReminderChanges,
  rescheduleAll,
  saveReminderSettings,
} from '../src/services/reminderService.ts'

test('本机 SQLite 与系统提醒对账，不需要网络', async (t) => {
  const conn = installBridge(':memory:')
  t.after(() => conn()?.close())
  const user = randomUUID()
  let owner = user
  const pending = new Map()
  const actions = []
  const writes = []
  const opened = []
  let denied = false
  const native = {
    async schedule(item) {
      if (denied) throw new Error('请开启精确闹钟权限。')
      pending.set(item.id, item)
      writes.push(item.id)
    },
    async cancel(id) {
      pending.delete(id)
    },
    async list() {
      return [...pending.values()]
    },
    async actions() {
      return [...actions]
    },
    async ack(key) {
      actions.splice(
        actions.findIndex((a) => a.key === key),
        1,
      )
    },
  }
  installReminderRuntime({
    native,
    owner: () => owner,
    openDetail: async (id) => opened.push(id),
    pendingLimit: 2,
  })
  const at = Date.now() + 3600000
  const schedule = await scheduleRepository.create(user, {
    title: '出发',
    start_at: at,
    end_at: at + 600000,
  })
  const settings = {
    level: 1,
    enabled: 1,
    remind_at: at - 600000,
    snooze_min: 7,
  }
  await saveReminderSettings(user, schedule.id, settings)
  const [reminder] = (await loadScheduleReminders(user, schedule.id)).reminders
  const id = reminder.id
  const action = (type, from, to = from) => ({
    key: randomUUID(),
    id,
    owner: user,
    scheduleId: schedule.id,
    scheduledAt: from,
    at: to,
    type,
  })

  await t.test(
    '原生登记含标题正文，重复初始化、系统回收和历史通知均能正确恢复',
    async () => {
      assert.equal(pending.get(id).title, '出发')
      assert.ok(pending.get(id).body.includes('日程开始时间'))
      assert.equal(reminder.native_id, id)
      await refreshReminderChanges()
      assert.equal(writes.length, 1)
      await rescheduleAll()
      assert.equal(writes.length, 2)
      pending.clear()
      await rescheduleAll()
      assert.equal(pending.get(id).level, 1)
      const batch = await readPendingChanges(user)
      assert.equal(batch.reminder[0].native_id, null)
    },
  )
  await t.test(
    '冷启动点击直达所属日程，延期写库再登记，重复投递和过期操作无副作用',
    async () => {
      actions.push(action('open', settings.remind_at))
      const next = settings.remind_at + 7 * 60000
      actions.push(
        action('snooze', settings.remind_at, next),
        action('snooze', settings.remind_at, next),
      )
      await rescheduleAll()
      assert.deepEqual(opened, [schedule.id])
      assert.equal((await reminderRepository.get(user, id)).remind_at, next)
      assert.equal(pending.get(id).at, next)
      actions.push(
        action('done', settings.remind_at),
        action('open', settings.remind_at),
      )
      await readReminderActions()
      assert.equal((await scheduleRepository.get(user, schedule.id)).done, 0)
      assert.deepEqual(opened, [schedule.id])
      actions.push(action('done', next))
      await readReminderActions()
      assert.equal((await scheduleRepository.get(user, schedule.id)).done, 1)
      assert.equal((await reminderRepository.get(user, id)).enabled, 0)
      assert.equal(pending.has(id), false)
    },
  )
  await t.test('关闭提醒、完成和删除日程立即撤销，换号清理旧提醒', async () => {
    await setScheduleDone(user, schedule.id, false)
    await saveReminderSettings(user, schedule.id, { ...settings, id })
    await cancelReminder(id)
    await rescheduleAll()
    assert.equal(pending.size, 0)
    await saveReminderSettings(user, schedule.id, { ...settings, id })
    owner = randomUUID()
    actions.push(action('open', settings.remind_at))
    await rescheduleAll()
    assert.equal(pending.size, 0)
    assert.deepEqual(opened, [schedule.id])
    owner = user
    await rescheduleAll()
    await setScheduleDone(user, schedule.id, true)
    assert.equal(pending.has(id), false)
    await setScheduleDone(user, schedule.id, false)
    assert.ok(pending.has(id))
    await deleteSchedule(user, await scheduleRepository.get(user, schedule.id))
    assert.equal(pending.size, 0)
    assert.equal(await reminderRepository.get(user, id), null)
  })
  await t.test(
    '权限失败仍保留本机提醒；iOS 容量先排近期，取消后补位',
    async () => {
      const parent = await scheduleRepository.create(user, {
        title: '提醒设置',
        start_at: at,
        end_at: at + 1,
      })
      denied = true
      await assert.rejects(
        saveReminderSettings(user, parent.id, settings),
        /已保存在本机.*权限/,
      )
      assert.equal(pending.size, 0)
      denied = false
      const [a, b, c] = await Promise.all(
        [0, 1, 2].map(async (n) => {
          if (!n)
            return (await loadScheduleReminders(user, parent.id)).reminders[0]
          return reminderRepository.create(user, {
            schedule_id: parent.id,
            remind_at: at + n * 10000,
          })
        }),
      )
      await assert.rejects(rescheduleAll(), /最近 2 条/)
      assert.deepEqual([...pending.keys()], [a.id, b.id])
      await cancelReminder(a.id)
      assert.deepEqual([...pending.keys()], [b.id, c.id])
    },
  )
})
