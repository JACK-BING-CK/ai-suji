import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createHttpClient } from '../src/api/http.ts'
import { useAuthStore } from '../src/store/auth.ts'

const { createPinia, setActivePinia } = createRequire(import.meta.url)('pinia')
const request = createHttpClient('https://api.example.test/')

function setup() {
  const storage = new Map()
  const calls = []
  const navigations = []
  globalThis.uni = {
    setStorageSync: (key, value) =>
      storage.set(key, globalThis.structuredClone(value)),
    getStorageSync: (key) => storage.get(key) ?? '',
    removeStorageSync: (key) => storage.delete(key),
    request: (options) => calls.push(options),
    uploadFile: (options) => calls.push(options),
    reLaunch: (options) => {
      navigations.push(options.url)
      options.success()
    },
  }
  globalThis.getCurrentPages = () => []
  setActivePinia(createPinia())
  return { calls, navigations, auth: useAuthStore(), storage }
}

test('登录 JWT 重启可恢复，首次全量标记持久化，退出后删除凭据', () => {
  const { auth } = setup()
  const id = randomUUID()
  auth.setSession({ id, nickname: '测试' }, 'server-token')
  setActivePinia(createPinia())
  const restarted = useAuthStore()
  restarted.restore()
  assert.equal(restarted.user.id, id)
  assert.equal(restarted.token, 'server-token')
  assert.equal(restarted.needsFullSync, true)
  restarted.completeFullSync()
  assert.equal(restarted.needsFullSync, false)
  restarted.logout()
  setActivePinia(createPinia())
  const signedOut = useAuthStore()
  signedOut.restore()
  assert.equal(signedOut.user, null)
})

test('录音上传使用登录 JWT，沿用超时、解包和过期处理', async () => {
  const { auth, calls, navigations } = setup()
  auth.setSession({ id: randomUUID(), nickname: '测试' }, 'login-token')
  const options = {
    filePath: '_doc/test.mp3',
    name: 'audio',
  }
  const result = request('/api/asr', options)
  assert.equal(calls[0].name, 'audio')
  assert.equal(calls[0].filePath, options.filePath)
  assert.equal(calls[0].timeout, 15000)
  assert.deepEqual(calls[0].header, { Authorization: 'Bearer login-token' })
  calls[0].success({
    statusCode: 200,
    data: JSON.stringify({ code: 0, data: { text: '记录' } }),
  })
  assert.deepEqual(await result, { text: '记录' })
  const expired = request('/api/asr', options)
  calls[1].success({ statusCode: 401, data: '' })
  await assert.rejects(expired, { code: 401 })
  assert.equal(auth.user, null)
  assert.deepEqual(navigations, ['/pages/auth/login'])
  auth.setSession({ id: randomUUID(), nickname: '测试' }, 'login-jwt')
  const invalid = request('/api/asr', {
    filePath: options.filePath,
    name: 'audio',
  })
  assert.deepEqual(calls[2].header, { Authorization: 'Bearer login-jwt' })
  calls[2].success({ statusCode: 200, data: 'invalid' })
  await assert.rejects(invalid, { code: 'FORMAT' })
})

test('请求只向配置的地址发送，携带服务端令牌并解包数据', async () => {
  const { auth, calls } = setup()
  const health = request('/health')
  assert.deepEqual(calls[0].header, {})
  calls[0].success({ statusCode: 200, data: { status: 'ok' } })
  assert.deepEqual(await health, { status: 'ok' })
  auth.setSession({ id: randomUUID(), nickname: '测试' }, 'test-bearer')
  const result = request('/api/sync/push', {
    method: 'POST',
    data: { idea: [] },
  })
  assert.equal(calls[1].url, 'https://api.example.test/api/sync/push')
  assert.deepEqual(calls[1].data, { idea: [] })
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].timeout, 15000)
  assert.equal(calls[1].header.Authorization, 'Bearer test-bearer')
  calls[1].success({
    statusCode: 200,
    data: { code: 0, msg: '', data: { accepted: 0 } },
  })
  assert.deepEqual(await result, { accepted: 0 })
  for (const path of ['https://other.example.test/', '//other.example.test/']) {
    await assert.rejects(request(path), { code: 'CONFIG' })
  }
  assert.equal(calls.length, 2)
})

test('并发的 HTTP 和业务 401 只登出一次，旧会话不能撤销新登录', async () => {
  const { auth, calls, navigations } = setup()
  const account = { id: randomUUID(), nickname: '测试' }
  auth.setSession(account, 'first-session')
  const previous = request('/api/sync/pull')
  auth.setSession(account, 'second-session')
  calls[0].success({ statusCode: 401, data: {} })
  await assert.rejects(previous, { code: 401 })
  assert.equal(auth.token, 'second-session')
  assert.deepEqual(navigations, [])
  const first = request('/api/sync/pull'),
    second = request('/api/ai/expand')
  calls[1].success({
    statusCode: 200,
    data: { code: 401, msg: '', data: null },
  })
  calls[2].success({ statusCode: 401, data: {} })
  await Promise.all([
    assert.rejects(first, { code: 401 }),
    assert.rejects(second, { code: 401 }),
  ])
  assert.equal(auth.user, null)
  setActivePinia(createPinia())
  const restarted = useAuthStore()
  restarted.restore()
  assert.equal(restarted.token, null)
  assert.equal(restarted.user, null)
  assert.deepEqual(navigations, ['/pages/auth/login'])
})

test('权限、额度、服务、网络错误和响应格式异常均返回可读错误', async () => {
  const { calls } = setup()
  for (const [statusCode, data, code] of [
    [403, {}, 403],
    [429, { code: 42901, msg: '' }, 42901],
    [500, { code: 500, msg: '稍后再试' }, 500],
    [200, { status: 'ok' }, 'FORMAT'],
  ]) {
    const result = request('/api/ideas')
    calls.pop().success({ statusCode, data })
    await assert.rejects(
      result,
      (error) => error.code === code && /[\u4e00-\u9fff]/u.test(error.message),
    )
  }
  for (const [errMsg, code] of [
    ['request:fail timeout', 'TIMEOUT'],
    ['request:fail', 'NETWORK'],
  ]) {
    const result = request('/api/ideas')
    calls.pop().fail({ errMsg })
    await assert.rejects(result, { code })
  }
})
