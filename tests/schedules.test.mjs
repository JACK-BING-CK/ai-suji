import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { installBridge } from './fixtures/sqlite-bridge.mjs'
import { ideaRepository } from '../src/repositories/idea.ts'
import { scheduleRepository } from '../src/repositories/schedule.ts'
import { reminderRepository } from '../src/repositories/reminder.ts'
import { applyPull, readPendingChanges } from '../src/repositories/sync.ts'
import {
  deleteSchedule,
  saveSchedule,
  setOccurrenceDone,
} from '../src/services/schedules.ts'
import {
  addStep,
  confirmSchedule,
  listSteps,
  previewSchedule,
} from '../src/services/workflow.ts'

test('日历的离线编辑、打卡和提醒事务', async (t) => {
  let failRemove = false
  const connection = installBridge(':memory:', (query) => {
    if (failRemove && query.startsWith('UPDATE schedule SET deleted_at'))
      throw new Error('模拟中途失败')
  })
  t.after(() => connection()?.close())
  const owner = randomUUID()
  const other = randomUUID()
  const start = new Date(2026, 11, 31, 10).getTime()
  const input = {
    title: ' 年末复盘 ',
    start_at: start,
    end_at: start + 1800000,
    repeat_rule: 'FREQ=DAILY',
    priority: 1,
    idea_id: null,
  }
  const read = (id) => scheduleRepository.get(owner, id)

  await t.test('新建校验、离线勾选不同实例、旧版拉取与反向打卡', async () => {
    for (const invalid of [
      { title: ' ' },
      { end_at: start },
      { start_at: NaN },
      { repeat_rule: 'FREQ=HOURLY' },
    ])
      await assert.rejects(saveSchedule(owner, { ...input, ...invalid }))
    const row = await saveSchedule(owner, input)
    assert.equal(row.title, '年末复盘')
    assert.equal(row.idea_id, null)
    assert.equal(row.priority, 1)
    await assert.rejects(setOccurrenceDone(other, row, start, true))
    await assert.rejects(setOccurrenceDone(owner, row, start + 500, true))
    const second = new Date(2027, 0, 1, 10).getTime()
    const third = new Date(2027, 0, 2, 10).getTime()
    await Promise.all([
      setOccurrenceDone(owner, row, second, true),
      setOccurrenceDone(owner, row, third, true),
    ])
    assert.deepEqual((await read(row.id)).completed_slots, ['1', '2'])
    assert.equal((await read(row.id)).done, 0)
    await setOccurrenceDone(owner, row, start, true)
    let sent = await readPendingChanges(owner)
    assert.deepEqual(sent.schedule[0].completed_slots, ['1', '2'])
    assert.equal(sent.schedule[0].done, 1)
    await applyPull(owner, sent, 50, sent)
    const fromOldClient = {
      ...sent.schedule[0],
      updated_at: sent.schedule[0].updated_at + 1,
      title: '远端编辑',
    }
    delete fromOldClient.completed_slots
    await applyPull(owner, { ...sent, schedule: [fromOldClient] }, 51)
    assert.deepEqual((await read(row.id)).completed_slots, ['1', '2'])
    await setOccurrenceDone(owner, row, second, false)
    const fresh = await read(row.id)
    assert.deepEqual(fresh.completed_slots, ['2'])
    await assert.rejects(saveSchedule(owner, input, row), /已更新/)
    const edited = await saveSchedule(
      owner,
      { ...input, title: '新标题' },
      fresh,
    )
    assert.deepEqual(edited.completed_slots, ['2'])
    const changed = await saveSchedule(
      owner,
      { ...input, repeat_rule: 'FREQ=WEEKLY' },
      edited,
    )
    assert.deepEqual(changed.completed_slots, [])
    await assert.rejects(setOccurrenceDone(owner, row, second, true), /更改/)
    await deleteSchedule(owner, changed)
    sent = await readPendingChanges(owner)
    assert.ok(sent.schedule[0].deleted_at)
    assert.equal(await read(row.id), null)
  })

  await t.test(
    '步骤生成的日程可改时间和想法；删除失败回滚提醒及队列',
    async () => {
      const idea = await ideaRepository.create(owner, { content: '准备复盘' })
      const alien = await ideaRepository.create(other, { content: '其他账号' })
      const step = await addStep(owner, idea.id, {
        title: '整理照片',
        detail: '',
        duration_min: 30,
      })
      const drafts = previewSchedule([step], start)
      await confirmSchedule(owner, idea.id, drafts)
      const row = await read(drafts[0].id)
      await assert.rejects(
        saveSchedule(owner, { ...input, idea_id: alien.id }, row),
      )
      const shift = 2 * 3600000
      const update = {
        ...input,
        idea_id: idea.id,
        start_at: start + shift,
        end_at: input.end_at + shift,
      }
      let edited = await saveSchedule(owner, update, row)
      assert.equal(edited.step_id, step.id)
      const reminders = () =>
        reminderRepository.list(owner, { where: { schedule_id: row.id } })
      assert.equal((await reminders())[0].remind_at, update.start_at - 600000)
      await setOccurrenceDone(owner, edited, edited.start_at, true)
      assert.equal((await listSteps(owner, idea.id))[0].done, 1)
      edited = await saveSchedule(
        owner,
        { ...update, idea_id: null },
        await read(row.id),
      )
      assert.equal(edited.step_id, null)
      assert.equal(edited.idea_id, null)
      await assert.rejects(deleteSchedule(other, edited))
      const before = await readPendingChanges(owner)
      failRemove = true
      await assert.rejects(deleteSchedule(owner, edited))
      failRemove = false
      assert.equal((await reminders()).length, 1)
      assert.deepEqual(await readPendingChanges(owner), before)
      await deleteSchedule(owner, edited)
      assert.equal(await read(row.id), null)
      assert.equal((await reminders()).length, 0)
      assert.ok((await readPendingChanges(owner)).reminder[0].deleted_at)
      assert.equal((await listSteps(owner, idea.id)).length, 1)
    },
  )
})
