import assert from 'node:assert/strict'
import test from 'node:test'
import { startApi } from './fixtures/api.mjs'

test('手机号与验证码换取 JWT，账号停用后令牌立即失效', async (t) => {
  const { base, accounts, login } = await startApi(t)
  assert.equal((await login('bad')).status, 400)
  const phone = '13900000001'
  assert.equal((await login(phone, 'wrong')).status, 400)
  assert.equal(accounts.size, 0)
  const { data: first } = await (await login(phone)).json()
  const { data: second } = await (await login('+86' + phone)).json()
  assert.equal(first.user.id, second.user.id)
  assert.equal(accounts.size, 1)
  assert.equal(typeof first.token, 'string')
  assert.equal(
    (await globalThis.fetch(base + '/api/sync/pull?since=0')).status,
    401,
  )
  assert.equal(
    (await globalThis.fetch(base + '/api/sync/push', { method: 'POST' }))
      .status,
    401,
  )
  accounts.get(phone).status = 0
  assert.equal((await login(phone)).status, 403)
  assert.equal(
    (
      await globalThis.fetch(base + '/api/sync/pull?since=0', {
        headers: { Authorization: 'Bearer ' + first.token },
      })
    ).status,
    401,
  )
})

test('同一 IP 任意连续一分钟只允许 60 次请求，限流到时恢复', async (t) => {
  const { base } = await startApi(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const url = base + '/health'
  for (let i = 0; i < 60; i++) {
    assert.equal((await globalThis.fetch(url)).status, 200)
  }
  now += 59_000
  const limited = await globalThis.fetch(url)
  assert.equal(limited.status, 429)
  assert.equal((await limited.json()).code, 429)
  assert.equal(limited.headers.get('Retry-After'), '1')
  now += 1000
  assert.equal((await globalThis.fetch(url)).status, 200)
})
