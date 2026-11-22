import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { URL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createPinia } from 'pinia'
import test from 'node:test'
import { buildCalendar } from '../src/services/calendar.ts'
import { ideaRepository, importSharedIdea } from '../src/repositories/idea.ts'
import { installBridge } from './fixtures/sqlite-bridge.mjs'
import { startSystemEntries } from '../src/services/systemEntries.ts'
import { scheduleRepository } from '../src/repositories/schedule.ts'
import { useAuthStore } from '../src/store/auth.ts'

const widgetSql = readFileSync(
  new URL(
    '../src/uni_modules/suji-system/utssdk/app-android/res/raw/suji_widget_today.sql',
    import.meta.url,
  ),
  'utf8',
)

test('桌面本地查询与 APP 今日待办一致，包括重复、跨日、逾期、完成与账号隔离', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(
      'CREATE TABLE widget_schedule (user_id TEXT,id TEXT PRIMARY KEY,title TEXT,start_at INTEGER,end_at INTEGER,repeat_rule TEXT,priority INTEGER,done INTEGER,completed_slots TEXT)',
    )
    const insert = db.prepare(
      'INSERT INTO widget_schedule VALUES(?,?,?,?,?,?,?,?,?)',
    )
    const read = db.prepare(widgetSql)
    const now = new Date(2026, 0, 31, 8, 15, 10, 365).getTime()
    const schedules = []
    function add(i, at, duration, rule, done, slots, owner = 'current') {
      const row = {
        id: randomUUID(),
        title: '测试' + i,
        start_at: at,
        end_at: at + duration,
        repeat_rule: rule,
        priority: i % 2,
        done,
        completed_slots: slots,
        deleted_at: null,
      }
      insert.run(
        owner,
        row.id,
        row.title,
        at,
        row.end_at,
        rule,
        row.priority,
        done,
        ',' + slots.join(',') + (slots.length ? ',' : ''),
      )
      if (owner === 'current') schedules.push(row)
    }
    for (let i = 0; i < 48; i++) {
      const start = new Date(now)
      start.setDate(start.getDate() + (i - 23) * 4)
      add(
        i,
        start.getTime(),
        i % 5 === 0 ? 111000000 : 3600000,
        [null, 'FREQ=DAILY', 'FREQ=WEEKLY', 'RRULE:FREQ=MONTHLY'][i % 4],
        i % 7 === 0 ? 1 : 0,
        ['1', '3', '7', '52'],
      )
    }
    add(57, now, 1800000, 'FREQ=MONTHLY', 0, [])
    add(58, now + 1, 1800000, 'FREQ=DAILY', 0, [], 'other')
    for (let i = 0; i < 415; i += 3) {
      const date = new Date(now)
      date.setDate(date.getDate() + i - 50)
      const t = date.getTime()
      const expected = buildCalendar(
        schedules,
        t,
        'week',
        t,
        undefined,
        3,
      ).today.map((s) => [s.schedule.id, s.start_at])
      // ?NNN 通过位置索引绑定，与 Android、iOS 的 SQLite 接口相同。
      const actual = read
        .all({ 1: t, 2: 'current' })
        .map((s) => [s.id, s.start_at])
      assert.deepEqual(actual, expected, date.toISOString())
    }
    assert.equal(read.all({ 1: now, 2: 'logged-out' }).length, 0)
  } finally {
    db.close()
  }
})

const localDatabase = installBridge(
  join(mkdtempSync(join(tmpdir(), 'suji-share-')), 'local.sqlite'),
)

test('离线导入保留原文与链接；重复交付、提交后重试和软删除都不会新增想法', async () => {
  const owner = randomUUID(),
    id = randomUUID()
  const text = '一段来自浏览器的文字\nhttps://example.cn/story?a=1&b=2'
  const values = await Promise.all([
    importSharedIdea(owner, id, text),
    importSharedIdea(owner, id, text),
  ])
  assert.deepEqual(values.sort(), [false, true])
  const row = await ideaRepository.get(owner, id)
  assert.deepEqual(
    [row.content, row.source, row.status],
    [text, 'share', 'inbox'],
  )
  assert.equal(await ideaRepository.get(randomUUID(), id), null)
  assert.equal(
    localDatabase()
      .prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE user_id=?')
      .get(owner).n,
    1,
  )
  await ideaRepository.remove(owner, id)
  assert.equal(await importSharedIdea(owner, id, text), false)
  assert.equal(await ideaRepository.get(owner, id), null)
})

test('应用启动后自动导入原生分享；小组件收到更新并按本机账号进入正确实例', async () => {
  const owner = randomUUID(),
    shareId = randomUUID()
  const auth = useAuthStore(createPinia())
  auth.user = { id: owner, nickname: '验收' }
  const at = Date.now()
  const row = await scheduleRepository.create(owner, {
    title: '今日的采访',
    start_at: at,
    end_at: at + 1800000,
  })
  const opened = [],
    updates = [],
    acks = []
  let share = true,
    action = {
      id: randomUUID(),
      kind: 'schedule',
      owner,
      scheduleId: row.id,
      at,
    }
  globalThis.getCurrentPages = () => [{ route: 'pages/ideas/index' }]
  globalThis.uni.showToast = () => {}
  globalThis.uni.navigateTo = globalThis.uni.switchTab = (arg) => {
    opened.push(arg.url)
    arg.success()
  }
  let wake
  globalThis.plus.globalEvent = {
    addEventListener: (_event, cb) => {
      wake = cb
    },
  }
  const bridge = (operation, raw, callback) => {
    const payload = JSON.parse(raw)
    let data = null
    if (operation === 'shares')
      data = share ? [{ id: shareId, owner, text: '来自浏览器' }] : []
    if (operation === 'ackShare') {
      share = false
      acks.push(payload.id)
    }
    if (operation === 'navigation') data = action
    if (operation === 'ackNavigation') action = null
    if (operation === 'widget') updates.push(payload)
    callback(JSON.stringify({ ok: true, data }))
  }
  const lifecycle = startSystemEntries(bridge)
  async function until(check) {
    for (let i = 0; i < 100; i++) {
      if (check()) return
      await delay(5)
    }
    assert.fail('等待系统入口处理超时')
  }
  try {
    lifecycle.show()
    await until(() => updates.length && acks.length && opened.length)
    assert.equal((await ideaRepository.get(owner, shareId)).source, 'share')
    assert.deepEqual(acks, [shareId])
    assert.deepEqual(opened, [
      '/pages/schedule/detail?id=' + row.id + '&at=' + at,
    ])
    assert.deepEqual(
      updates.at(-1).rows.map((s) => s.id),
      [row.id],
    )
    await scheduleRepository.update(owner, row.id, { done: 1 })
    await until(() => updates.at(-1).rows[0].done === 1)
    action = { id: randomUUID(), kind: 'record', owner: null }
    wake()
    await until(() => opened.at(-1) === '/pages/record/index')
  } finally {
    lifecycle.hide()
  }
})
