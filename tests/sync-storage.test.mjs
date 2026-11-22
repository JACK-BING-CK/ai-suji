import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { migrations } from '../src/repositories/db/migrations.ts'
import { ideaRepository } from '../src/repositories/idea.ts'
import { expansionRepository } from '../src/repositories/expansion.ts'
import { reminderRepository } from '../src/repositories/reminder.ts'
import { scheduleRepository } from '../src/repositories/schedule.ts'
import { stepRepository } from '../src/repositories/step.ts'
import {
  applyPull,
  claimLegacyData,
  hasLegacyData,
  onLocalWrite,
  readPendingChanges,
  readExpansionSource,
  storeGeneratedExpansion,
  storeGeneratedSteps,
  readSyncCursor,
  syncTables,
} from '../src/repositories/sync.ts'
import { installBridge } from './fixtures/sqlite-bridge.mjs'

const empty = () => Object.fromEntries(syncTables.map((table) => [table, []]))

test('离线同步队列、旧版数据认领、冲突和事务原子性', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'ai-suji-sync-'))
  const file = join(folder, 'app.db')
  const owner = randomUUID()
  const other = randomUUID()
  const legacy = randomUUID()
  const legacyIdea = randomUUID()
  const legacyStep = randomUUID()
  const legacySchedule = randomUUID()
  const old = new DatabaseSync(file)
  for (const sql of migrations[0]) old.exec(sql)
  old.exec('PRAGMA user_version = 1')
  const seed = old.prepare(
    'INSERT INTO idea (id, user_id, created_at, updated_at, deleted_at, content) VALUES (?, ?, 10, 20, ?, ?)',
  )
  seed.run(legacyIdea, legacy, null, '设备上的想法')
  seed.run(randomUUID(), legacy, 19, '已删除')
  seed.run(randomUUID(), other, null, '其他用户')
  old
    .prepare(
      'INSERT INTO step (id, user_id, idea_id, created_at, updated_at, title, detail, duration_min, sort_order) VALUES (?, ?, ?, 10, 20, ?, ?, 1, 0)',
    )
    .run(legacyStep, legacy, legacyIdea, '关联的步骤', '')
  old
    .prepare(
      'INSERT INTO schedule (id,user_id,idea_id,step_id,created_at,updated_at,title,start_at,end_at,done) VALUES (?,?,?,?,10,20,?,100,200,1)',
    )
    .run(legacySchedule, legacy, legacyIdea, legacyStep, '旧版流程生成的日程')
  old.close()
  let failQueue = false
  const connection = installBridge(file, (sql) => {
    if (failQueue && sql.includes('INTO sync_outbox'))
      throw new Error('模拟队列写入失败')
  })
  globalThis.uni.getStorageSync = () => legacy
  t.after(() => {
    connection()?.close()
    rmSync(folder, { recursive: true, force: true })
  })

  await t.test(
    '升级旧版保留六表待发送修改，同一设备身份只能认领一次',
    async () => {
      assert.equal((await readPendingChanges(legacy)).idea.length, 2)
      assert.ok(await hasLegacyData())
      await claimLegacyData(owner)
      assert.equal(await hasLegacyData(), false)
      const batch = await readPendingChanges(owner)
      assert.equal(batch.idea.length, 2)
      assert.ok(batch.idea.some((row) => row.deleted_at === 19))
      assert.equal(batch.step[0].user_id, owner)
      assert.equal(batch.step[0].idea_id, legacyIdea)
      const restored = await scheduleRepository.get(owner, legacySchedule)
      assert.equal(restored.step_id, legacyStep)
      assert.equal(restored.done, 1)
      assert.deepEqual(restored.completed_slots, [])
      assert.deepEqual(batch.schedule, [restored])
      assert.equal((await readPendingChanges(other)).idea.length, 1)
      assert.deepEqual(await readPendingChanges(legacy), empty())
      await claimLegacyData(other)
      assert.equal((await readPendingChanges(other)).idea.length, 1)
      await applyPull(owner, batch, 40, batch)
      assert.deepEqual(await readPendingChanges(owner), empty())
    },
  )

  await t.test(
    '生成前识别待传原文，生成后保留服务端 UUID、自身游标和本机队列',
    async () => {
      const userId = randomUUID()
      const idea = await ideaRepository.create(userId, { content: '新想法' })
      assert.equal((await readExpansionSource(userId, idea.id)).pending, true)
      await assert.rejects(readExpansionSource(other, idea.id), /找不到/)
      const batch = await readPendingChanges(userId)
      await applyPull(userId, batch, 80, batch)
      assert.equal((await readExpansionSource(userId, idea.id)).pending, false)
      const generated = {
        id: randomUUID(),
        user_id: userId,
        idea_id: idea.id,
        created_at: 95,
        updated_at: 95,
        deleted_at: null,
        background: '背景',
        points: ['要点'],
        risks: '待确认',
        next_steps: '试访',
        model: '测试模型',
      }
      assert.equal(await storeGeneratedExpansion(userId, generated), true)
      const latest = { ...generated, updated_at: 100, points: ['第二版'] }
      await storeGeneratedExpansion(userId, latest)
      assert.equal(await storeGeneratedExpansion(userId, generated), false)
      assert.deepEqual(await expansionRepository.list(userId), [latest])
      assert.equal(await readSyncCursor(userId), 80)
      assert.deepEqual(await readPendingChanges(userId), empty())
    },
  )

  await t.test(
    '拆解仅推送当前想法的修改；返回步骤原子入库并保留拉取游标',
    async () => {
      const userId = randomUUID()
      const idea = await ideaRepository.create(userId, { content: '拆解目标' })
      await ideaRepository.create(userId, { content: '稍后同步' })
      const manual = await stepRepository.create(userId, {
        idea_id: idea.id,
        title: '手动准备',
        detail: '',
        duration_min: 2,
        sort_order: 0,
      })
      const pending = await readPendingChanges(userId, {
        ideaId: idea.id,
        tables: ['idea', 'expansion', 'step'],
      })
      assert.deepEqual(pending.idea, [idea])
      assert.deepEqual(pending.step, [manual])
      await applyPull(userId, pending, 54, pending)
      const rows = [1, 2, 3].map((order) => ({
        ...manual,
        id: randomUUID(),
        title: '生成' + order,
        sort_order: order,
      }))
      rows[1].depends_on = rows[0].id
      rows[2].depends_on = rows[1].id
      await assert.rejects(
        storeGeneratedSteps(userId, idea.id, [
          rows[0],
          rows[1],
          { ...rows[2], user_id: other },
        ]),
      )
      assert.deepEqual(await stepRepository.list(userId), [manual])
      assert.equal(
        await storeGeneratedSteps(userId, idea.id, [...rows].reverse()),
        true,
      )
      assert.equal(await storeGeneratedSteps(userId, idea.id, rows), false)
      const saved = (await stepRepository.list(userId)).sort(
        (a, b) => a.sort_order - b.sort_order,
      )
      assert.deepEqual(saved, [manual, ...rows])
      assert.equal(await readSyncCursor(userId), 54)
      const rest = await readPendingChanges(userId)
      assert.equal(rest.idea.length, 1)
      assert.deepEqual(rest.step, [])
    },
  )

  await t.test('提交才通知；确认只清理实际发出的版本', async () => {
    const notifications = []
    const unsubscribe = onLocalWrite((id) => notifications.push(id))
    try {
      failQueue = true
      await assert.rejects(ideaRepository.remove(owner, legacyIdea))
      assert.deepEqual(notifications, [])
      assert.ok(await ideaRepository.get(owner, legacyIdea))
      failQueue = false
      await ideaRepository.update(owner, legacyIdea, { content: '离线修改一' })
      const sent = await readPendingChanges(owner)
      await ideaRepository.update(owner, legacyIdea, { content: '离线修改二' })
      await applyPull(owner, sent, 41, sent)
      const pending = await readPendingChanges(owner)
      assert.equal(pending.idea[0].content, '离线修改二')
      assert.deepEqual(notifications, [owner, owner])
      await applyPull(
        owner,
        {
          ...empty(),
          idea: [{ ...sent.idea[0], deleted_at: 5, updated_at: 10 }],
        },
        42,
        pending,
      )
      assert.equal(await ideaRepository.get(owner, legacyIdea), null)
      await applyPull(owner, pending, 43)
      assert.equal(await ideaRepository.get(owner, legacyIdea), null)
      assert.deepEqual(await readPendingChanges(owner), empty())
    } finally {
      failQueue = false
      unsubscribe()
    }
  })

  await t.test(
    '六表跨依赖及子步骤乱序可原子恢复，系统闹钟标识留在本机',
    async () => {
      const row = () => ({
        id: randomUUID(),
        user_id: owner,
        created_at: 100,
        updated_at: 110,
        deleted_at: null,
      })
      const idea = {
        ...row(),
        content: '跨设备',
        tags: ['离线'],
        source: 'voice',
        status: 'inbox',
      }
      const expansion = {
        ...row(),
        idea_id: idea.id,
        background: '',
        points: ['x'],
        risks: '',
        next_steps: '',
        model: '测试',
      }
      const material = {
        ...row(),
        idea_id: idea.id,
        title: '素材',
        summary: '',
        url: '',
        source_name: '',
        published_at: 100,
      }
      const parent = {
        ...row(),
        idea_id: idea.id,
        title: '父',
        detail: '',
        duration_min: 10,
        sort_order: 0,
        done: 0,
        depends_on: null,
      }
      const child = {
        ...parent,
        id: randomUUID(),
        title: '子',
        depends_on: parent.id,
        sort_order: 1,
      }
      const schedule = {
        ...row(),
        title: '日程',
        start_at: 100,
        end_at: 200,
        idea_id: idea.id,
        step_id: child.id,
        repeat_rule: null,
        priority: 0,
        done: 0,
      }
      const reminder = {
        ...row(),
        schedule_id: schedule.id,
        remind_at: 150,
        level: 0,
        snooze_min: 10,
        sound: null,
        enabled: 1,
        native_id: '另一台设备的标识',
      }
      const batch = {
        idea: [idea],
        expansion: [expansion],
        material: [material],
        step: [child, parent],
        schedule: [schedule],
        reminder: [reminder],
      }
      assert.equal(await applyPull(owner, batch, 50), true)
      assert.equal(await applyPull(owner, batch, 50), false)
      assert.equal(
        (await reminderRepository.get(owner, reminder.id)).native_id,
        null,
      )
      const edited = await reminderRepository.update(owner, reminder.id, {
        native_id: '本设备标识',
      })
      const pending = await readPendingChanges(owner)
      assert.equal(pending.reminder[0].native_id, null)
      await applyPull(
        owner,
        {
          ...empty(),
          reminder: [
            { ...edited, updated_at: edited.updated_at + 1, native_id: null },
          ],
        },
        51,
        pending,
      )
      assert.equal(
        (await reminderRepository.get(owner, reminder.id)).native_id,
        '本设备标识',
      )
      assert.deepEqual(await readPendingChanges(owner), empty())
      const another = { ...expansion, id: randomUUID(), updated_at: 120 }
      assert.ok(
        await applyPull(
          owner,
          {
            ...empty(),
            expansion: [
              another,
              { ...expansion, updated_at: 120, deleted_at: 120 },
            ],
          },
          52,
        ),
      )
      const active = connection()
        .prepare(
          'SELECT id FROM expansion WHERE user_id=? AND idea_id=? AND deleted_at IS NULL',
        )
        .all(owner, idea.id)
      assert.deepEqual(
        active.map((item) => item.id),
        [another.id],
      )
    },
  )

  await t.test(
    '越权和不完整关联回滚整批及游标，等时戳以服务端为准',
    async () => {
      const local = await ideaRepository.create(owner, { content: '离线' })
      const sent = await readPendingChanges(owner)
      const remote = { ...local, content: '服务端' }
      await assert.rejects(
        applyPull(
          owner,
          { ...empty(), idea: [remote, { ...remote, user_id: other }] },
          60,
          sent,
        ),
      )
      assert.deepEqual(await readPendingChanges(owner), sent)
      const bad = {
        ...local,
        id: randomUUID(),
        idea_id: randomUUID(),
        background: '',
        points: [],
        risks: '',
        next_steps: '',
        model: '测试',
      }
      await assert.rejects(
        applyPull(
          owner,
          { ...empty(), idea: [remote], expansion: [bad] },
          60,
          sent,
        ),
      )
      assert.equal(await readSyncCursor(owner), 52)
      assert.equal((await ideaRepository.get(owner, local.id)).content, '离线')
      assert.deepEqual(await readPendingChanges(owner), sent)
      assert.ok(
        await applyPull(owner, { ...empty(), idea: [remote] }, 60, sent),
      )
      assert.equal(
        (await ideaRepository.get(owner, local.id)).content,
        '服务端',
      )
      assert.equal(await readSyncCursor(owner), 60)
      assert.deepEqual(await readPendingChanges(owner), empty())
    },
  )
})
