import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import process from 'node:process'
import test from 'node:test'
import mysql from 'mysql2/promise'
import { createApp } from '../src/app.ts'
import { createBreakdownModel, parseBreakdown } from '../src/breakdown-model.ts'
import { debugSmsProvider } from '../src/sms.ts'

const plans = [2, null, 1].map((depends_on_index, i) => ({
  title: '步骤' + i,
  detail: '操作说明' + i,
  duration_min: 20 + i,
  depends_on_index,
}))

test('拆解校验数组、时长与依赖，稳定排序或在发现环时回退原序', () => {
  const parse = (rows) => parseBreakdown(JSON.stringify(rows))
  assert.deepEqual(
    parse(plans).map((step) => step.index),
    [1, 2, 0],
  )
  for (const parent of [0, 2]) {
    const cyclic = plans.map((step, i) => ({
      ...step,
      depends_on_index: i === 0 ? parent : i === 2 ? 0 : null,
    }))
    const sorted = parse(cyclic)
    assert.deepEqual(
      sorted.map((step) => step.index),
      [0, 1, 2],
    )
    assert.deepEqual(
      sorted.map((step) => step.depends_on_index),
      [null, null, null],
    )
  }
  assert.equal(parse(Array(12).fill(plans[1])).length, 12)
  for (const rows of [
    [],
    plans.slice(0, 2),
    Array(13).fill(plans[1]),
    { steps: plans },
  ])
    assert.throws(() => parse(rows))
  assert.throws(() => parseBreakdown('不完整的 JSON'))
  for (const patch of [
    { duration_min: 0 },
    { duration_min: -1 },
    { duration_min: 1.5 },
    { duration_min: '20' },
    { duration_min: 2 ** 31 },
    { depends_on_index: undefined },
    { depends_on_index: -1 },
    { depends_on_index: 3 },
    { depends_on_index: '1' },
    { depends_on_index: 0.25 },
    { title: ' ' },
    { detail: null },
    { extra: '' },
  ])
    assert.throws(() => parse([{ ...plans[0], ...patch }, ...plans.slice(1)]))
})

test('拆解适配器请求顶层数组，重试时保留原文及已有思路', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(plans) } }],
        usage: { total_tokens: 17 },
      }),
    }
  })
  const model = createBreakdownModel({
    LLM_API_KEY: randomUUID(),
    LLM_BASE_URL: 'http://127.0.0.1/v1',
  })
  const source = JSON.stringify({
    content: '搭一个共享书架',
    expansion: { background: '盘活闲置书' },
  })
  const result = await model(source, false)
  assert.equal(result.tokens, 17)
  assert.equal(parseBreakdown(result.content).length, 3)
  await model(source, true)
  for (const body of requests) {
    assert.deepEqual(body.response_format, { type: 'text' })
    assert.deepEqual(body.messages[1], { role: 'user', content: source })
    assert.match(body.messages[0].content, /JSON 数组/)
  }
  assert.notEqual(
    requests[0].messages[0].content,
    requests[1].messages[0].content,
  )
})

test(
  'MySQL 拆解读取当前思路、原子追加步骤、增量同步并与扩写共用额度',
  {
    skip:
      process.env.AI_SUJI_MYSQL_TEST !== '1' &&
      '需配置已迁移的独立 MySQL 测试库',
    timeout: 60000,
  },
  async (t) => {
    const pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      charset: 'utf8mb4',
    })
    const code = String(randomInt(100000, 1000000))
    const calls = []
    let reply = () => JSON.stringify(plans)
    const app = createApp({
      pool,
      jwtSecret: randomUUID(),
      smsProvider: debugSmsProvider(code),
      breakdownModel: async (source, retry) => {
        calls.push({ source: JSON.parse(source), retry })
        return { content: await reply(retry), model: 'test', tokens: 9 }
      },
      expandModel: async () => assert.fail('已超出共享额度'),
    })
    const server = app.listen(0, '127.0.0.1')
    const owners = []
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve))
      try {
        for (const owner of owners) {
          await pool.execute(
            'UPDATE `step` SET depends_on=NULL WHERE user_id=?',
            [owner],
          )
          for (const table of [
            'sync_publications',
            'step',
            'expansion',
            'usage_log',
            'idea',
          ])
            await pool.execute('DELETE FROM `' + table + '` WHERE user_id=?', [
              owner,
            ])
          await pool.execute('DELETE FROM `user` WHERE id=?', [owner])
        }
      } finally {
        await pool.end()
      }
    })
    await once(server, 'listening')
    const request = async (path, token, body) => {
      const response = await globalThis.fetch(
        'http://127.0.0.1:' + server.address().port + '/api/' + path,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { Authorization: 'Bearer ' + token }),
          },
          body: JSON.stringify(body),
        },
      )
      return response.json()
    }
    async function login() {
      const response = await request('auth/login', null, {
        phone: '+999' + randomInt(100000000000, 999999999999),
        code,
      })
      assert.equal(response.code, 0, response.msg)
      owners.push(response.data.user.id)
      return response.data
    }
    const { user, token } = await login()
    const other = await login()
    const ideaId = randomUUID()
    const send = (session = token) =>
      request('ai/breakdown', session, { idea_id: ideaId })
    const idea = {
      id: ideaId,
      user_id: user.id,
      content: '给图书角安排换书活动',
      source: 'text',
      status: 'inbox',
      tags: [],
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    }
    const base = {
      idea_id: ideaId,
      user_id: user.id,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    }
    const manual = {
      ...base,
      id: randomUUID(),
      title: '已有的手动步骤',
      detail: '',
      duration_min: 5,
      sort_order: 7,
      depends_on: null,
      done: 1,
    }
    assert.equal(
      (await request('sync/push', token, { idea: [idea], step: [manual] }))
        .code,
      0,
    )
    assert.equal((await send(null)).code, 401)
    assert.equal((await send(other.token)).code, 404)
    assert.equal(
      (await request('ai/breakdown', token, { idea_id: 'abc' })).code,
      400,
    )
    assert.equal(calls.length, 0)
    const cursor = (await request('sync/pull?since=0', token)).data.server_time
    const first = await send()
    assert.equal(first.code, 0, first.msg)
    assert.deepEqual(calls[0].source, {
      content: idea.content,
      expansion: null,
    })
    assert.deepEqual(
      first.data.map((s) => s.sort_order),
      [8, 9, 10],
    )
    assert.deepEqual(
      first.data.map((s) => s.title),
      ['步骤1', '步骤2', '步骤0'],
    )
    assert.deepEqual(
      first.data.map((s) => s.depends_on),
      [null, first.data[0].id, first.data[1].id],
    )
    const pulled = (
      await request('sync/pull?since=' + cursor, token)
    ).data.step.sort((a, b) => a.sort_order - b.sort_order)
    assert.deepEqual(pulled, first.data)
    const fields = {
      background: '社区图书共享',
      points: ['提前登记'],
      risks: '留意天气',
      next_steps: '确认场地',
    }
    const expansion = { ...base, id: randomUUID(), ...fields, model: 'test' }
    assert.equal(
      (await request('sync/push', token, { expansion: [expansion] })).code,
      0,
    )
    reply = (retry) =>
      retry
        ? JSON.stringify(
            plans.map((step, i) => ({
              ...step,
              depends_on_index: i === 0 ? 0 : null,
            })),
          )
        : '[]'
    const second = await send()
    assert.equal(second.code, 0, second.msg)
    assert.deepEqual(
      calls.slice(-2).map((call) => call.retry),
      [false, true],
    )
    assert.deepEqual(calls.at(-1).source, {
      content: idea.content,
      expansion: fields,
    })
    assert.deepEqual(
      second.data.map((s) => s.depends_on),
      [null, null, null],
    )
    assert.deepEqual(
      second.data.map((s) => s.sort_order),
      [11, 12, 13],
    )
    reply = () => '[]'
    const invalid = await send()
    assert.equal(invalid.code, 500)
    assert.match(invalid.msg, /3 至 12/)
    reply = async () => {
      assert.equal(
        (
          await request('sync/push', token, {
            expansion: [{ ...expansion, updated_at: 2, background: '已修改' }],
          })
        ).code,
        0,
      )
      return JSON.stringify(plans)
    }
    assert.equal((await send()).code, 409)
    const final = (await request('sync/pull?since=0', token)).data.step
    assert.equal(final.length, 7)
    assert.deepEqual(
      final.find((row) => row.id === manual.id),
      manual,
    )
    const [logs] = await pool.execute(
      'SELECT type,tokens FROM usage_log WHERE user_id=?',
      [user.id],
    )
    assert.equal(logs.length, 6)
    assert.ok(logs.every((row) => row.type === 'breakdown' && row.tokens === 9))
    const now = Date.now()
    for (let i = logs.length; i < 20; i++)
      await pool.execute(
        'INSERT INTO usage_log(id,user_id,type,tokens,created_at,updated_at) VALUES (?,?,?,0,?,?)',
        [randomUUID(), user.id, i % 2 ? 'expand' : 'research', now, now],
      )
    assert.equal((await send()).code, 42901)
    assert.equal(
      (
        await request('ai/expand', token, {
          idea_id: ideaId,
          template: 'general',
        })
      ).code,
      42901,
    )
    assert.equal(calls.length, 6)
  },
)
