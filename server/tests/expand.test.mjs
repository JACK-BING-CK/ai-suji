import assert from 'node:assert/strict'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import test from 'node:test'
import { URL } from 'node:url'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { createApp } from '../src/app.ts'
import { debugSmsProvider } from '../src/sms.ts'

test(
  'MySQL 生成覆盖、模型重试计量、用户日额度及跨设备同步',
  {
    skip:
      process.env.AI_SUJI_MYSQL_TEST !== '1' &&
      '需配置已迁移的 MySQL 测试库及 AI_SUJI_MYSQL_TEST=1',
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
    const code = String(randomInt(100000, 1000000))
    const source = '给小区的闲置物品做一个共享角'
    const fields = {
      background: '闲置物品需要流通',
      points: ['征集', '维护'],
      risks: '做好责任登记',
      next_steps: '先征集居民意愿',
    }
    const calls = []
    let respond = () => JSON.stringify(fields)
    const app = createApp({
      pool,
      jwtSecret: randomBytes(32).toString('hex'),
      smsProvider: debugSmsProvider(code),
      expandModel: async (original, template, retry) => {
        assert.equal(original, source)
        calls.push({ template, retry })
        return {
          content: await respond(retry),
          tokens: 17,
          model: 'test-model',
        }
      },
    })
    const server = app.listen(0, '127.0.0.1')
    const owners = []
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve))
      try {
        for (const owner of owners) {
          for (const table of [
            'sync_publications',
            'expansion',
            'usage_log',
            'idea',
          ])
            await pool.execute('DELETE FROM ' + table + ' WHERE user_id=?', [
              owner,
            ])
          await pool.execute('DELETE FROM `user` WHERE id=?', [owner])
        }
      } finally {
        await pool.end()
      }
    })
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + server.address().port + '/api/'
    async function call(path, token, body) {
      const response = await globalThis.fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: 'Bearer ' + token }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, ...(await response.json()) }
    }
    const phone = () => '+999' + randomInt(100000000000, 999999999999)
    async function login(number) {
      const response = await call('auth/login', null, { phone: number, code })
      assert.equal(response.status, 200, response.msg)
      return response.data
    }
    const firstPhone = phone()
    const a = await login(firstPhone)
    owners.push(a.user.id)
    const b = await login(firstPhone)
    const other = await login(phone())
    owners.push(other.user.id)
    const ideaId = randomUUID()
    async function generate(token = a.token, template = 'general') {
      return call('ai/expand', token, { idea_id: ideaId, template })
    }
    async function pull(token, since = 0) {
      const response = await call('sync/pull?since=' + since, token)
      assert.equal(response.status, 200, response.msg)
      return response.data
    }
    const idea = {
      id: ideaId,
      user_id: a.user.id,
      content: source,
      tags: [],
      source: 'text',
      status: 'inbox',
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    }
    assert.equal(
      (await call('sync/push', a.token, { idea: [idea] })).status,
      200,
    )
    const initial = await pull(b.token)
    assert.equal((await generate(null)).status, 401)
    assert.equal((await generate(other.token)).status, 404)
    assert.equal((await generate(a.token, 'unknown')).status, 400)
    assert.equal(calls.length, 0)
    const created = await generate()
    assert.equal(created.status, 200, created.msg)
    for (const [key, value] of Object.entries(fields))
      assert.deepEqual(created.data[key], value)
    assert.equal(created.data.model, 'test-model')
    assert.equal(created.data.idea_id, ideaId)
    assert.equal(created.data.user_id, a.user.id)
    const firstPull = await pull(b.token, initial.server_time)
    assert.deepEqual(firstPull.expansion, [created.data])
    assert.deepEqual((await pull(other.token)).expansion, [])

    respond = (retry) =>
      retry ? JSON.stringify({ ...fields, background: '第二版' }) : 'not JSON'
    const regenerated = await generate(b.token, 'article')
    assert.equal(regenerated.status, 200, regenerated.msg)
    assert.equal(regenerated.data.id, created.data.id)
    assert.equal(regenerated.data.created_at, created.data.created_at)
    assert.ok(regenerated.data.updated_at > created.data.updated_at)
    assert.deepEqual(calls.slice(-2), [
      { template: 'article', retry: false },
      { template: 'article', retry: true },
    ])
    const nextPull = await pull(a.token, firstPull.server_time)
    assert.deepEqual(nextPull.expansion, [regenerated.data])
    respond = () => JSON.stringify({ ...fields, points: [' '] })
    const failed = await generate()
    assert.equal(failed.status, 500, failed.msg)
    assert.match(failed.msg, /校验失败/)
    assert.equal(calls.length, 5)
    assert.deepEqual((await pull(b.token, nextPull.server_time)).expansion, [])
    assert.deepEqual((await pull(b.token)).expansion, [regenerated.data])
    const [logs] = await pool.execute(
      'SELECT tokens FROM usage_log WHERE user_id=? AND type=?',
      [a.user.id, 'expand'],
    )
    assert.equal(logs.length, 5)
    assert.ok(logs.every((row) => row.tokens === 17))

    respond = async () => {
      const entry = { ...idea, content: '已换成另一个想法', updated_at: 2 }
      assert.equal(
        (await call('sync/push', b.token, { idea: [entry] })).status,
        200,
      )
      return JSON.stringify(fields)
    }
    assert.equal((await generate()).status, 409)
    assert.deepEqual((await pull(a.token)).expansion, [regenerated.data])
    assert.equal(
      (await call('sync/push', a.token, { idea: [{ ...idea, updated_at: 3 }] }))
        .status,
      200,
    )
    const now = Date.now()
    async function seed(type, time, owner = a.user.id) {
      await pool.execute(
        'INSERT INTO usage_log(id,user_id,type,tokens,created_at,updated_at) VALUES (?,?,?,0,?,?)',
        [randomUUID(), owner, type, time, time],
      )
    }
    for (let i = 0; i < 13; i++)
      await seed(i % 2 ? 'breakdown' : 'research', now)
    await seed('asr', now)
    await seed('expand', now - (now % 86400000) - 1)
    await seed('expand', now, other.user.id)
    // 一台设备占用最后一次调用并暂停在模型端，另一台不能超额或被长事务阻塞。
    let resume
    let started
    const waiting = new Promise((resolve) => {
      resume = resolve
    })
    const inFlight = new Promise((resolve) => {
      started = resolve
    })
    respond = async () => {
      started()
      await waiting
      return JSON.stringify(fields)
    }
    const last = generate()
    try {
      await Promise.race([
        inFlight,
        last.then((response) => assert.fail('模型未被调用：' + response.msg)),
      ])
      const denied = await generate(b.token)
      assert.equal(denied.status, 429)
      assert.equal(denied.code, 42901)
      assert.match(denied.msg, /今日 AI 额度已用完/)
      assert.equal(calls.length, 7)
    } finally {
      resume()
    }
    assert.equal((await last).status, 200)
  },
)
