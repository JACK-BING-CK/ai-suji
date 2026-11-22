import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { URL } from 'node:url'
import { initializeDatabase } from '../src/repositories/db/index.ts'
import { migrations } from '../src/repositories/db/migrations.ts'
import { ideaRepository } from '../src/repositories/idea.ts'
import { expansionRepository } from '../src/repositories/expansion.ts'
import { materialRepository } from '../src/repositories/material.ts'
import { stepRepository } from '../src/repositories/step.ts'
import { scheduleRepository } from '../src/repositories/schedule.ts'
import { reminderRepository } from '../src/repositories/reminder.ts'
import { usageLogRepository } from '../src/repositories/usage_log.ts'
import { deleteIdea, listInbox, saveDraft } from '../src/services/record.ts'
import {
  advanceIdeaStatus,
  filterIdeas,
  listIdeas,
  listIdeaTags,
  loadIdea,
  saveIdeaEdits,
} from '../src/services/ideas.ts'
import { installBridge } from './fixtures/sqlite-bridge.mjs'

test(
  '离线建库、迁移回滚、进程恢复及七个仓储',
  { timeout: 30000 },
  async (t) => {
    const folder = mkdtempSync(join(tmpdir(), 'ai-suji-'))
    const file = join(folder, 'app.db')
    const owner = randomUUID()
    const other = randomUUID()
    let simulateFailure = true
    const connection = installBridge(file, (sql) => {
      if (simulateFailure && sql.includes('CREATE TABLE step'))
        throw new Error('模拟迁移中断')
    })
    t.after(() => {
      connection()?.close()
      rmSync(folder, { recursive: true, force: true })
    })
    await t.test('升级中断后表与版本均回滚', async () => {
      await assert.rejects(initializeDatabase())
      assert.equal(
        connection().prepare('PRAGMA user_version').get().user_version,
        0,
      )
      assert.deepEqual(
        connection()
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all(),
        [],
      )
      simulateFailure = false
    })
    let id
    await t.test(
      '独立进程在空库写入后被强制终止，重新初始化仍能读取',
      async () => {
        const writer = fork(
          new URL('./fixtures/sqlite-writer.mjs', import.meta.url),
          [file, owner],
          {
            execArgv: ['--import', 'tsx'],
          },
        )
        const stopped = once(writer, 'exit')
        try {
          const [writtenId] = await Promise.race([
            once(writer, 'message', {
              signal: globalThis.AbortSignal.timeout(10000),
            }),
            stopped.then(() => {
              throw new Error('写入进程提前退出')
            }),
          ])
          id = writtenId
        } finally {
          writer.kill('SIGKILL')
          await stopped
        }
        await Promise.all([initializeDatabase(), initializeDatabase()])
        const tables = connection()
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all()
        assert.deepEqual(
          tables.map((row) => row.name),
          [
            'expansion',
            'idea',
            'material',
            'reminder',
            'schedule',
            'step',
            'sync_cursor',
            'sync_outbox',
            'usage_log',
          ],
        )
        assert.equal(
          connection().prepare('PRAGMA user_version').get().user_version,
          migrations.length,
        )
        const recovered = await loadIdea(owner, id)
        assert.equal(recovered.content, '杀进程前已提交')
        assert.deepEqual(recovered.tags, ['修改后的标签', '备忘'])
      },
    )
    await t.test('速记校验、语音来源、收集箱创建时间排序和软删除', async () => {
      const writer = randomUUID()
      await assert.rejects(saveDraft(writer, ' \n '), /先写下/)
      await assert.rejects(saveDraft(writer, '📝'.repeat(2001)), /2000/)
      const first = await saveDraft(writer, '📝'.repeat(2000))
      const second = await saveDraft(writer, '编辑过的语音', 'voice')
      await ideaRepository.create(writer, {
        content: '已整理',
        status: 'processed',
      })
      await ideaRepository.create(writer, {
        content: '已归档',
        status: 'archived',
      })
      // 固定创建时间，复现早先的记录最后编辑的情况。
      connection()
        .prepare('UPDATE idea SET created_at = ? WHERE user_id = ? AND id = ?')
        .run(first.created_at - 1000, writer, first.id)
      await ideaRepository.update(writer, first.id, { tags: ['修改过'] })
      assert.deepEqual(
        (await listInbox(writer)).map(({ id, source, status }) => [
          id,
          source,
          status,
        ]),
        [
          [second.id, 'voice', 'inbox'],
          [first.id, 'text', 'inbox'],
        ],
      )
      assert.equal(await deleteIdea(other, second.id), false)
      assert.ok(await deleteIdea(writer, second.id))
      assert.deepEqual(
        (await listInbox(writer)).map((idea) => idea.id),
        [first.id],
      )
      const row = connection()
        .prepare('SELECT deleted_at FROM idea WHERE user_id = ? AND id = ?')
        .get(writer, second.id)
      assert.ok(row.deleted_at > 0)
    })
    await t.test('想法库组合筛选、原文标签编辑和状态流转', async () => {
      const user = randomUUID()
      const first = await saveDraft(user, 'Camera 计划')
      const second = await saveDraft(user, '采访提纲')
      const third = await saveDraft(user, 'CAMERA 备选')
      const removed = await saveDraft(user, 'Camera 已删除')
      await deleteIdea(user, removed.id)
      const older = connection().prepare(
        'UPDATE idea SET created_at = ? WHERE user_id = ? AND id = ?',
      )
      older.run(100, user, first.id)
      older.run(200, user, second.id)
      older.run(300, user, third.id)
      await saveIdeaEdits(user, first.id, first.content, ['摄影', '周记'])
      await saveIdeaEdits(user, second.id, second.content, ['Camera', '摄影棚'])
      await saveIdeaEdits(user, third.id, third.content, ['摄影'])
      // 两次相同的状态操作必须只前进一格。
      await Promise.all([
        advanceIdeaStatus(user, second.id, 'inbox'),
        advanceIdeaStatus(user, second.id, 'inbox'),
      ])
      assert.equal((await loadIdea(user, second.id)).status, 'processed')
      await advanceIdeaStatus(user, third.id, 'inbox')
      await advanceIdeaStatus(user, third.id, 'processed')
      assert.equal(
        (await advanceIdeaStatus(user, third.id, 'archived')).status,
        'archived',
      )

      const rows = await listIdeas(user)
      const find = (keyword = '', tag = '', status = 'active') =>
        filterIdeas(rows, { keyword, tag, status }).map((idea) => idea.id)
      assert.deepEqual(
        rows.map((idea) => idea.id),
        [third.id, second.id, first.id],
      )
      assert.deepEqual(find(' cAmErA '), [second.id, first.id])
      assert.deepEqual(find('摄影'), [second.id, first.id])
      assert.deepEqual(find('camera', '摄影'), [first.id])
      assert.deepEqual(find('', '', 'processed'), [second.id])
      assert.deepEqual(find('camera', '摄影', 'archived'), [third.id])
      assert.deepEqual(find('备选', '摄影', 'inbox'), [])
      assert.deepEqual(find('%'), [])
      assert.deepEqual(
        new Set(listIdeaTags(rows)),
        new Set(['摄影', '摄影棚', 'Camera', '周记']),
      )

      const saved = await saveIdeaEdits(user, first.id, "修改 ' ? 📝", [
        '影像',
        ' 影像 ',
      ])
      assert.deepEqual(saved.tags, ['影像'])
      assert.equal(saved.content, "修改 ' ? 📝")
      assert.deepEqual(await loadIdea(user, first.id), saved)
      await assert.rejects(saveIdeaEdits(user, first.id, '   ', []), /不能为空/)
      await assert.rejects(
        saveIdeaEdits(user, first.id, '📝'.repeat(2001), []),
        /2000/,
      )
      await assert.rejects(
        saveIdeaEdits(other, first.id, '不属于我的想法', []),
        /找不到/,
      )
      await assert.rejects(
        advanceIdeaStatus(other, first.id, 'inbox'),
        /找不到/,
      )
      await assert.rejects(
        saveIdeaEdits(user, removed.id, '已删除', []),
        /找不到/,
      )
      assert.deepEqual(await loadIdea(user, first.id), saved)
      assert.deepEqual(
        (await saveIdeaEdits(user, first.id, saved.content, [])).tags,
        [],
      )
    })
    await t.test('离线 CRUD、JSON、用户隔离和软删除', async () => {
      const text = "灵感 ' ? 📝\n换行"
      const idea = await ideaRepository.update(owner, id, {
        content: text,
        tags: ['草稿', '?'],
      })
      assert.equal(idea.content, text)
      assert.deepEqual(idea.tags, ['草稿', '?'])
      assert.deepEqual(await ideaRepository.list(other), [])
      assert.equal(
        connection().prepare('PRAGMA foreign_keys').get().foreign_keys,
        1,
      )
      assert.throws(
        () =>
          connection()
            .prepare(
              'INSERT INTO material (id,user_id,idea_id,title,url,summary,source_name,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            )
            .run(randomUUID(), other, id, '素材', '', '', '', 0, 0, 0),
        /FOREIGN KEY constraint failed/,
      )
      assert.equal(await ideaRepository.get(other, id), null)
      assert.equal(
        await ideaRepository.update(other, id, { content: '无权修改' }),
        null,
      )
      assert.equal(await ideaRepository.remove(other, id), false)
      await assert.rejects(
        ideaRepository.create(owner, { content: '字'.repeat(2001) }),
      )
      await assert.rejects(ideaRepository.update(owner, id, { user_id: other }))

      const payload = {
        idea_id: id,
        background: '背景',
        points: ['一'],
        risks: '风险',
        next_steps: '下一步',
        model: '测试',
      }
      await assert.rejects(expansionRepository.create(other, payload))
      const [first, latest] = await Promise.all([
        expansionRepository.create(owner, payload),
        expansionRepository.create(owner, { ...payload, points: ['二'] }),
      ])
      assert.equal(first.id, latest.id)
      assert.deepEqual((await expansionRepository.list(owner))[0].points, [
        '二',
      ])
      await expansionRepository.remove(owner, latest.id)
      const nextExpansion = await expansionRepository.create(owner, payload)
      assert.notEqual(nextExpansion.id, latest.id)
      assert.equal((await expansionRepository.list(owner)).length, 1)
      assert.ok(
        connection()
          .prepare('SELECT deleted_at FROM expansion WHERE user_id=? AND id=?')
          .get(owner, latest.id).deleted_at > 0,
      )
      const step = await stepRepository.create(owner, {
        idea_id: id,
        title: '步骤',
        detail: '说明',
        duration_min: 15,
        sort_order: 0,
      })
      const schedule = await scheduleRepository.create(owner, {
        step_id: step.id,
        title: '日程',
        start_at: 1000,
        end_at: 2000,
      })
      const material = await materialRepository.create(owner, {
        idea_id: id,
        title: '素材',
        url: 'https://example.org/',
        summary: '摘要',
        source_name: '来源',
        published_at: 1000,
      })
      const reminder = await reminderRepository.create(owner, {
        schedule_id: schedule.id,
        remind_at: 1000,
      })
      const usage = await usageLogRepository.create(owner, {
        type: 'expand',
        tokens: 1,
      })
      assert.equal(reminder.snooze_min, 10)
      for (const [repo, record, patch] of [
        [reminderRepository, reminder, { enabled: 0 }],
        [scheduleRepository, schedule, { done: 1 }],
        [stepRepository, step, { duration_min: 30 }],
        [materialRepository, material, { title: '新素材' }],
        [expansionRepository, nextExpansion, { model: '新模型' }],
        [usageLogRepository, usage, { tokens: 2 }],
        [ideaRepository, idea, { status: 'processed' }],
      ]) {
        const saved = await repo.update(owner, record.id, patch)
        assert.deepEqual(await repo.get(owner, record.id), saved)
        assert.ok(saved.updated_at > record.updated_at)
        assert.ok(await repo.remove(owner, record.id))
        assert.equal(await repo.get(owner, record.id), null)
        assert.deepEqual(await repo.list(owner), [])
      }
      const tombstone = connection()
        .prepare(
          'SELECT deleted_at, updated_at FROM idea WHERE user_id=? AND id=?',
        )
        .get(owner, id)
      assert.ok(tombstone.deleted_at > 0)
      assert.equal(tombstone.updated_at, tombstone.deleted_at)
    })
  },
)
