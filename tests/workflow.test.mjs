import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ideaRepository } from '../src/repositories/idea.ts'
import { stepRepository } from '../src/repositories/step.ts'
import { scheduleRepository } from '../src/repositories/schedule.ts'
import { reminderRepository } from '../src/repositories/reminder.ts'
import { readPendingChanges } from '../src/repositories/sync.ts'
import { onLocalWrite } from '../src/repositories/syncQueue.ts'
import {
  addStep,
  editStep,
  removeStep,
  reorderSteps,
  listSteps,
  setStepDone,
  setScheduleDone,
  listIdeaSchedules,
  previewSchedule,
  confirmSchedule,
} from '../src/services/workflow.ts'
import { installBridge } from './fixtures/sqlite-bridge.mjs'

test('流程与日程在离线 SQLite 中的事务与预览', async (t) => {
  let failReminderAt = 0
  const connection = installBridge(':memory:', (sql) => {
    if (
      sql.startsWith('INSERT INTO reminder ') &&
      failReminderAt &&
      --failReminderAt === 0
    )
      throw new Error('模拟提醒写入中断')
  })
  t.after(() => connection()?.close())
  const owner = randomUUID()
  const other = randomUUID()
  const idea = await ideaRepository.create(owner, { content: '组织读书会' })
  const step = (title, duration_min) => ({ title, detail: '', duration_min })
  const first = await addStep(owner, idea.id, step('征集书目', 20))
  const second = await addStep(owner, idea.id, step('讨论', 40))
  const third = await addStep(owner, idea.id, step('总结', 10))
  const steps = () => listSteps(owner, idea.id)
  const schedules = () => listIdeaSchedules(owner, idea.id)
  const time = new Date(2026, 10, 19, 23, 50).getTime()
  let drafts
  await t.test(
    '手动编辑和拖动顺序可重新读取，失败时保留顺序并隔离账号',
    async () => {
      const edited = await editStep(owner, first.id, {
        title: ' 征集书目 ',
        detail: ' 选出三本书 ',
        duration_min: 20,
      })
      assert.equal(edited.title, '征集书目')
      assert.equal(edited.detail, '选出三本书')
      for (const minutes of [0, -1, 1.1, 2147483648])
        await assert.rejects(
          addStep(owner, idea.id, step('安排', minutes)),
          /正整数/,
        )
      await assert.rejects(editStep(owner, first.id, step('  ', 10)), /标题/)
      await assert.rejects(addStep(other, idea.id, step('安排', 1)))
      await assert.rejects(removeStep(other, first.id), /无法访问/)
      await assert.rejects(
        editStep(other, first.id, step('更新', 3)),
        /无法访问/,
      )
      assert.deepEqual(await listSteps(other, idea.id), [])
      await reorderSteps(owner, idea.id, [first.id, third.id, second.id])
      await assert.rejects(
        reorderSteps(owner, idea.id, [second.id, first.id, randomUUID()]),
        /重新排序/,
      )
      await assert.rejects(
        reorderSteps(owner, idea.id, [first.id, first.id, second.id]),
        /重新排序/,
      )
      assert.deepEqual(
        (await steps()).map((row) => [row.id, row.sort_order]),
        [
          [first.id, 0],
          [third.id, 1],
          [second.id, 2],
        ],
      )
    },
  )
  await t.test(
    '23:50 起按步骤累加到次日，可逐项改时，取消或无效预览均不落库',
    async () => {
      const rows = await steps()
      drafts = previewSchedule([...rows].reverse(), time)
      assert.deepEqual(
        drafts.map((row) => [row.title, row.start_at, row.end_at]),
        [
          ['征集书目', time, new Date(2026, 10, 20, 0, 10).getTime()],
          [
            '总结',
            new Date(2026, 10, 20, 0, 10).getTime(),
            new Date(2026, 10, 20, 0, 20).getTime(),
          ],
          [
            '讨论',
            new Date(2026, 10, 20, 0, 20).getTime(),
            new Date(2026, 10, 20, 1, 0).getTime(),
          ],
        ],
      )
      const abandoned = previewSchedule(rows, time)
      abandoned[0].end_at = time
      await assert.rejects(
        confirmSchedule(owner, idea.id, abandoned),
        /结束时间/,
      )
      assert.throws(() => previewSchedule(rows, NaN), /无效/)
      await assert.rejects(confirmSchedule(other, idea.id, drafts), /无法访问/)
      drafts[2].start_at += 5 * 60_000
      drafts[2].end_at += 10 * 60_000
      assert.deepEqual(await schedules(), [])
      assert.deepEqual(await reminderRepository.list(owner), [])
      const pending = await readPendingChanges(owner)
      assert.deepEqual([pending.schedule, pending.reminder], [[], []])
    },
  )
  await t.test(
    '中途失败回滚全部日程提醒与队列，同一预览并发确认只生成一份',
    async () => {
      failReminderAt = 2
      let notified = 0
      const stop = onLocalWrite(() => {
        notified++
      })
      try {
        await assert.rejects(
          confirmSchedule(owner, idea.id, drafts),
          /写入失败/,
        )
        assert.equal(notified, 0)
        assert.deepEqual(await schedules(), [])
        assert.deepEqual(await reminderRepository.list(owner), [])
        const before = await readPendingChanges(owner)
        assert.deepEqual([before.schedule, before.reminder], [[], []])
        await Promise.all([
          confirmSchedule(owner, idea.id, drafts),
          confirmSchedule(owner, idea.id, drafts),
        ])
        assert.ok(notified > 0)
      } finally {
        stop()
      }
      const rows = await schedules()
      const reminders = await reminderRepository.list(owner)
      assert.equal(rows.length, 3)
      assert.equal(reminders.length, 3)
      for (const [i, row] of rows.entries()) {
        assert.deepEqual(
          [row.id, row.step_id, row.start_at, row.end_at],
          [
            drafts[i].id,
            drafts[i].step_id,
            drafts[i].start_at,
            drafts[i].end_at,
          ],
        )
        const reminder = reminders.find((item) => item.schedule_id === row.id)
        assert.deepEqual(
          [
            reminder.remind_at,
            reminder.level,
            reminder.enabled,
            reminder.native_id,
          ],
          [row.start_at - 600_000, 0, 1, null],
        )
      }
      const after = await readPendingChanges(owner)
      assert.equal(after.schedule.length, 3)
      assert.equal(after.reminder.length, 3)
    },
  )
  await t.test(
    '已有完成状态带入新日程，步骤与多个日程双向勾选，独立日程单独更新',
    async () => {
      await setStepDone(owner, first.id, true)
      const another = previewSchedule(await steps(), time + 86400000)
      await confirmSchedule(owner, idea.id, another)
      const read = async () => [
        (await stepRepository.get(owner, first.id)).done,
        ...(await schedules())
          .filter((row) => row.step_id === first.id)
          .map((row) => row.done),
      ]
      assert.deepEqual(await read(), [1, 1, 1])
      await assert.rejects(
        setScheduleDone(other, another[0].id, false),
        /无法访问/,
      )
      await setScheduleDone(owner, another[0].id, false)
      assert.deepEqual(await read(), [0, 0, 0])
      await setStepDone(owner, first.id, true)
      assert.deepEqual(await read(), [1, 1, 1])
      assert.ok(
        (await schedules())
          .filter((row) => row.step_id !== first.id)
          .every((row) => row.done === 0),
      )
      const standalone = await scheduleRepository.create(owner, {
        title: '独立日程',
        start_at: time,
        end_at: time + 120000,
      })
      await setScheduleDone(owner, standalone.id, true)
      assert.equal((await scheduleRepository.get(owner, standalone.id)).done, 1)
      assert.deepEqual(await read(), [1, 1, 1])
    },
  )
  await t.test(
    '来源变更拒绝旧预览；删除步骤解除依赖，并保留已有日程和提醒',
    async () => {
      const stale = previewSchedule(await steps(), time)
      await stepRepository.update(owner, third.id, { depends_on: first.id })
      await assert.rejects(confirmSchedule(owner, idea.id, stale), /重新预览/)
      assert.equal((await schedules()).length, 6)
      await removeStep(owner, first.id)
      assert.equal(await stepRepository.get(owner, first.id), null)
      assert.equal((await stepRepository.get(owner, third.id)).depends_on, null)
      const rows = await schedules()
      assert.equal(rows.length, 6)
      assert.equal(rows.filter((row) => row.step_id === null).length, 2)
      assert.equal((await reminderRepository.list(owner)).length, 6)
      const detached = rows.find((row) => row.step_id === null)
      await setScheduleDone(owner, detached.id, false)
      assert.equal((await scheduleRepository.get(owner, detached.id)).done, 0)
    },
  )
})
