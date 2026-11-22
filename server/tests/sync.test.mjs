import assert from 'node:assert/strict'
import { randomBytes, randomUUID, randomInt } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import test from 'node:test'
import { URL } from 'node:url'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { createApp } from '../src/app.ts'
import { debugSmsProvider } from '../src/sms.ts'
import { parseBatch, parseSince, tables } from '../src/sync-fields.ts'

test('拒绝畸形同步记录、未知表、越权归属和无效游标', () => {
  const owner = randomUUID()
  assert.throws(() => parseBatch([], owner))
  assert.throws(() => parseBatch({ user: [] }, owner))
  assert.throws(() => parseBatch({ idea: null }, owner))
  assert.throws(() => parseBatch({ idea: [{ user_id: owner }] }, owner))
  assert.throws(
    () => parseBatch({ idea: [{ user_id: randomUUID() }] }, owner),
    /无权/,
  )
  assert.throws(() => parseSince('-1'))
  assert.throws(() => parseSince('1.5'))
  assert.equal(parseSince(undefined), 0)
})

test(
  'MySQL 六表同步、离线游标、并发、事务回滚与账号隔离',
  {
    skip:
      process.env.AI_SUJI_MYSQL_TEST !== '1' &&
      '运行需配置已迁移的测试库及 AI_SUJI_MYSQL_TEST=1',
    timeout: 60000,
  },
  async (t) => {
    const settings = {
      ...parse(readFileSync(new URL('../.env', import.meta.url))),
      ...process.env,
    }
    const pool = mysql.createPool({
      host: settings.DB_HOST,
      port: Number(settings.DB_PORT || 3306),
      user: settings.DB_USER,
      password: settings.DB_PASSWORD,
      database: settings.DB_NAME,
      charset: 'utf8mb4',
    })
    const code = randomBytes(12).toString('hex')
    const app = createApp({
      pool,
      jwtSecret: randomBytes(32).toString('hex'),
      smsProvider: debugSmsProvider(code),
    })
    const server = app.listen(0, '127.0.0.1')
    const owners = []
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve))
      try {
        // 仅清理本次测试随机建立的两个账号及其外键记录。
        for (const user of owners) {
          await pool.execute(
            'UPDATE `step` SET depends_on = NULL WHERE user_id = ?',
            [user],
          )
          await pool.execute(
            'DELETE FROM sync_publications WHERE user_id = ?',
            [user],
          )
          for (const table of [...tables].reverse())
            await pool.execute(`DELETE FROM \`${table}\` WHERE user_id = ?`, [
              user,
            ])
          await pool.execute('DELETE FROM `user` WHERE id = ?', [user])
        }
      } finally {
        await pool.end()
      }
    })
    await once(server, 'listening')
    const call = async (path, token, body) => {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${server.address().port}/api/${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { Authorization: 'Bearer ' + token }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      )
      const json = await response.json()
      assert.equal(typeof json.msg, 'string')
      assert.equal(response.ok ? 0 : response.status, json.code)
      return json
    }
    async function login(phone) {
      const result = await call('auth/login', null, { phone, code })
      assert.equal(result.code, 0, result.msg)
      return result.data
    }
    const phone = () => '+999' + randomInt(100000000000, 999999999999)
    const firstPhone = phone()
    const a = await login(firstPhone)
    owners.push(a.user.id)
    const b = await login(firstPhone)
    const other = await login(phone())
    owners.push(other.user.id)
    assert.equal(a.user.id, b.user.id)
    assert.notEqual(other.user.id, a.user.id)
    const pull = (token, cursor = 0) => call('sync/pull?since=' + cursor, token)
    const push = (token, batch) => call('sync/push', token, batch)
    const row = (fields) => ({
      id: randomUUID(),
      user_id: a.user.id,
      created_at: 10,
      updated_at: 10,
      deleted_at: null,
      ...fields,
    })
    const idea = row({
      content: '离线初稿？ 📝',
      source: 'text',
      status: 'inbox',
      tags: ["标签'"],
    })
    const expansion = row({
      idea_id: idea.id,
      background: '',
      points: ['甲', '乙'],
      risks: '',
      next_steps: '',
      model: 'demo',
    })
    const material = row({
      idea_id: idea.id,
      title: '素材',
      url: '',
      summary: '',
      source_name: '',
      published_at: 100,
    })
    const step = row({
      idea_id: idea.id,
      title: '步骤',
      detail: '',
      duration_min: 15,
      sort_order: 0,
      depends_on: null,
      done: 0,
    })
    const next = {
      ...step,
      id: randomUUID(),
      depends_on: step.id,
      sort_order: 1,
    }
    const schedule = row({
      idea_id: null,
      step_id: next.id,
      title: '日程',
      start_at: 10,
      end_at: 20,
      repeat_rule: null,
      priority: 0,
      done: 0,
    })
    const reminder = row({
      schedule_id: schedule.id,
      remind_at: 10,
      level: 1,
      sound: null,
      snooze_min: 10,
      enabled: 1,
      native_id: '本机通知编号',
    })
    const initial = {
      reminder: [reminder],
      schedule: [schedule],
      step: [next, step],
      material: [material],
      expansion: [expansion],
      idea: [idea],
    }
    assert.equal((await pull()).code, 401)
    assert.equal((await push(null, {})).code, 401)
    const saved = await push(a.token, initial)
    assert.equal(saved.code, 0, saved.msg)
    assert.equal(saved.data.accepted, 7)
    const snapshot = (await pull(b.token)).data
    assert.deepEqual(snapshot.idea, [idea])
    assert.deepEqual(snapshot.expansion, [expansion])
    assert.deepEqual(snapshot.material, [material])
    assert.deepEqual(snapshot.schedule, [{ ...schedule, completed_slots: [] }])
    assert.deepEqual(snapshot.reminder, [{ ...reminder, native_id: null }])
    assert.deepEqual(
      snapshot.step.find((s) => s.id === next.id),
      next,
    )
    const same = (await pull(b.token, snapshot.server_time)).data
    assert.ok(tables.every((table) => same[table].length === 0))
    // 两端离线交错：先勾步骤，再传另一台新建的日程；新日程须继承步骤的状态。
    const checkStep = { ...next, updated_at: 12, done: 1 }
    assert.equal((await push(a.token, { step: [checkStep] })).code, 0)
    const lateSchedule = {
      ...schedule,
      id: randomUUID(),
      created_at: 13,
      updated_at: 13,
    }
    assert.equal((await push(b.token, { schedule: [lateSchedule] })).code, 0)
    const checked = (await pull(b.token, snapshot.server_time)).data
    assert.equal(checked.step.find((item) => item.id === next.id).done, 1)
    assert.equal(checked.schedule.length, 2)
    assert.ok(checked.schedule.every((item) => item.done === 1))
    const uncheck = { ...lateSchedule, updated_at: 14, done: 0 }
    assert.equal((await push(b.token, { schedule: [uncheck] })).code, 0)
    const unchecked = (await pull(a.token, checked.server_time)).data
    assert.equal(unchecked.step.find((item) => item.id === next.id).done, 0)
    assert.equal(unchecked.schedule.length, 2)
    assert.ok(unchecked.schedule.every((item) => item.done === 0))
    const both = {
      step: [{ ...next, updated_at: 100, done: 1 }],
      schedule: [{ ...schedule, updated_at: 105, done: 1 }],
    }
    assert.equal((await push(a.token, both)).code, 0)
    const older = { ...next, updated_at: 103, done: 0 }
    assert.equal((await push(b.token, { step: [older] })).data.accepted, 0)
    const reconciled = (await pull(b.token, unchecked.server_time)).data
    assert.equal(
      reconciled.step.find((item) => item.id === next.id).updated_at,
      105,
    )
    assert.ok(reconciled.schedule.every((item) => item.done === 1))
    // 远端已取得当前时间游标，之后提交的离线更新保留原逻辑时间，仍可增量取得。
    const edit = { ...idea, content: '离线修改', updated_at: 15 }
    assert.equal((await push(a.token, { idea: [edit] })).data.accepted, 1)
    const late = (await pull(b.token, snapshot.server_time)).data
    assert.deepEqual(late.idea, [edit])
    assert.ok(late.server_time > snapshot.server_time)
    assert.equal((await push(b.token, { idea: [idea] })).data.accepted, 0)
    const competing = [
      { ...edit, content: '新版本', updated_at: 50 },
      { ...edit, content: '较旧版本', updated_at: 30 },
    ]
    await Promise.all(
      competing.map((entry) => push(a.token, { idea: [entry] })),
    )
    assert.deepEqual((await pull(a.token)).data.idea, [competing[0]])
    const deleted = { ...idea, deleted_at: 11, updated_at: 11 }
    assert.equal((await push(b.token, { idea: [deleted] })).data.accepted, 1)
    assert.equal(
      (await push(a.token, { idea: [{ ...edit, updated_at: 100 }] })).data
        .accepted,
      0,
    )
    assert.deepEqual((await pull(a.token, late.server_time)).data.idea, [
      deleted,
    ])
    const replacement = {
      ...expansion,
      id: randomUUID(),
      updated_at: 60,
      model: '更新',
    }
    assert.equal(
      (await push(a.token, { expansion: [replacement] })).data.accepted,
      1,
    )
    const superseded = { ...expansion, id: randomUUID(), updated_at: 55 }
    assert.equal(
      (await push(b.token, { expansion: [superseded] })).data.accepted,
      0,
    )
    const versions = (await pull(b.token)).data.expansion
    assert.deepEqual(
      versions.filter((entry) => entry.deleted_at === null),
      [replacement],
    )
    assert.equal(
      versions.filter((entry) => entry.deleted_at !== null).length,
      2,
    )
    const beforeFailure = (await pull(a.token)).data.server_time
    const partial = { ...idea, id: randomUUID() }
    const bad = { ...reminder, id: randomUUID(), schedule_id: randomUUID() }
    assert.equal(
      (await push(a.token, { idea: [partial], reminder: [bad] })).code,
      400,
    )
    assert.equal((await pull(a.token)).data.server_time, beforeFailure)
    assert.ok(
      !(await pull(a.token)).data.idea.some((item) => item.id === partial.id),
    )
    assert.equal((await push(other.token, { idea: [idea] })).code, 403)
    assert.equal(
      (await push(other.token, { idea: [{ ...idea, user_id: other.user.id }] }))
        .code,
      409,
    )
    const alien = { ...material, id: randomUUID(), user_id: other.user.id }
    assert.equal((await push(other.token, { material: [alien] })).code, 400)
    const privateList = (await pull(other.token)).data
    assert.ok(tables.every((table) => privateList[table].length === 0))
    const directId = randomUUID()
    await pool.execute(
      'INSERT INTO idea (id,user_id,created_at,updated_at,content) VALUES (?,?,10,10,?)',
      [directId, a.user.id, '服务端创建'],
    )
    const direct = (await pull(b.token, beforeFailure)).data
    assert.deepEqual(
      direct.idea.map((entry) => entry.id),
      [directId],
    )
    assert.ok(direct.server_time > beforeFailure)
    assert.deepEqual((await pull(b.token, direct.server_time)).data.idea, [])
    await pool.execute(
      'UPDATE idea SET content=?, updated_at=? WHERE user_id=? AND id=?',
      ['服务端编辑', direct.server_time + 1, a.user.id, directId],
    )
    const modified = (await pull(a.token, direct.server_time)).data
    assert.equal(modified.idea[0].content, '服务端编辑')
    assert.ok(modified.server_time > direct.server_time)
    await t.test(
      '重复日程逐次打卡、旧设备编辑保留打卡、另一台设备撤销',
      async () => {
        const series = {
          ...schedule,
          id: randomUUID(),
          step_id: null,
          repeat_rule: 'FREQ=WEEKLY',
          completed_slots: ['2'],
          updated_at: 110,
        }
        assert.equal(
          (await push(a.token, { schedule: [series] })).data.accepted,
          1,
        )
        const secondDevice = (await pull(b.token, modified.server_time)).data
        assert.deepEqual(secondDevice.schedule, [series])
        const oldDevice = {
          ...series,
          title: '旧客户端修改标题',
          updated_at: 111,
        }
        delete oldDevice.completed_slots
        assert.equal(
          (await push(b.token, { schedule: [oldDevice] })).data.accepted,
          1,
        )
        const edited = (await pull(a.token, secondDevice.server_time)).data
        assert.deepEqual(edited.schedule[0].completed_slots, ['2'])
        const undone = {
          ...edited.schedule[0],
          updated_at: 112,
          completed_slots: [],
        }
        assert.equal(
          (await push(b.token, { schedule: [undone] })).data.accepted,
          1,
        )
        assert.deepEqual(
          (await pull(a.token, edited.server_time)).data.schedule,
          [undone],
        )
      },
    )
  },
)
