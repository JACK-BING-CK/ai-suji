import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter, on } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { HttpError } from '../src/api/http.ts'
import { ideaRepository } from '../src/repositories/idea.ts'
import {
  readPendingChanges,
  readSyncCursor,
  syncTables,
} from '../src/repositories/sync.ts'
import { startSync, syncMessage } from '../src/services/sync.ts'
import { useAuthStore } from '../src/store/auth.ts'
import { installBridge } from './fixtures/sqlite-bridge.mjs'

const { createPinia, setActivePinia } = createRequire(import.meta.url)('pinia')
const empty = () => Object.fromEntries(syncTables.map((table) => [table, []]))

async function waitFor(condition) {
  const deadline = Date.now() + 3000
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, '同步状态未按时更新')
    await delay(10)
  }
}

test(
  '前台自动重试、网络恢复及切换账号时隔离延迟响应',
  { timeout: 15000 },
  async (t) => {
    const folder = mkdtempSync(join(tmpdir(), 'ai-suji-scheduler-'))
    const connection = installBridge(join(folder, 'app.db'))
    const storage = new Map()
    const transport = new EventEmitter()
    const calls = on(transport, 'request', { signal: t.signal })
    let notifyNetwork
    Object.assign(globalThis.uni, {
      setStorageSync: (key, value) => storage.set(key, value),
      getStorageSync: (key) => storage.get(key) ?? '',
      onNetworkStatusChange: (listener) => {
        notifyNetwork = listener
      },
      offNetworkStatusChange: () => {
        notifyNetwork = undefined
      },
    })
    setActivePinia(createPinia())
    const auth = useAuthStore()
    const first = { id: randomUUID(), nickname: '甲' }
    const second = { id: randomUUID(), nickname: '乙' }
    function request(method, body) {
      return new Promise((resolve, reject) =>
        transport.emit('request', {
          owner: auth.user.id,
          method,
          body,
          resolve,
          reject,
        }),
      )
    }
    async function next(method, owner = first.id) {
      const {
        value: [call],
      } = await calls.next()
      assert.equal(call.method, method)
      assert.equal(call.owner, owner)
      return call
    }
    const sync = startSync({
      push: (body) => request('push', body),
      pull: (since) => request('pull', since),
    })
    t.after(async () => {
      sync.stop()
      await calls.return()
      connection()?.close()
      rmSync(folder, { recursive: true, force: true })
    })

    auth.setSession({ ...first }, 'first-test-session')
    const initial = await next('pull')
    assert.equal(initial.body, 0)
    initial.resolve({ ...empty(), server_time: 10 })
    await waitFor(() => !auth.needsFullSync)
    const saved = await ideaRepository.create(first.id, {
      content: '离线也要保留',
    })
    const firstPush = await next('push')
    assert.equal(firstPush.body.idea[0].id, saved.id)
    const failure = new HttpError('NETWORK', '网络中断')
    firstPush.reject(failure)
    await waitFor(() => syncMessage.value.includes('重试'))
    assert.deepEqual((await readPendingChanges(first.id)).idea, [saved])
    assert.equal(await readSyncCursor(first.id), 10)

    // 没有再次写入或切前台，退避到期自动重试；断网再恢复会立即重新调度。
    const retry = await next('push')
    assert.deepEqual(retry.body, firstPush.body)
    notifyNetwork({ isConnected: false })
    retry.reject(failure)
    await waitFor(() => syncMessage.value.includes('重试'))
    notifyNetwork({ isConnected: true })
    const recovered = await next('push')
    recovered.resolve({ accepted: 1, server_time: 11 })
    const pulled = await next('pull')
    assert.equal(pulled.body, 10)
    pulled.resolve({ ...recovered.body, server_time: 12 })
    await waitFor(async () => (await readSyncCursor(first.id)) === 12)
    assert.deepEqual(await readPendingChanges(first.id), empty())

    await ideaRepository.update(first.id, saved.id, { content: '传输中改账号' })
    const upload = await next('push')
    upload.resolve({ accepted: 1, server_time: 13 })
    const delayed = await next('pull')
    auth.setSession({ ...second }, 'second-test-session')
    delayed.resolve({ ...upload.body, server_time: 99 })
    const fresh = await next('pull', second.id)
    assert.equal(fresh.body, 0)
    assert.ok(auth.needsFullSync)
    assert.equal(await readSyncCursor(first.id), 12)
    assert.equal(await readSyncCursor(second.id), 0)
    assert.deepEqual(
      (await readPendingChanges(first.id)).idea,
      upload.body.idea,
    )
    assert.deepEqual(await ideaRepository.list(second.id), [])
    fresh.resolve({ ...empty(), server_time: 20 })
    await waitFor(() => !auth.needsFullSync)
    assert.equal(await readSyncCursor(second.id), 20)
    assert.equal(await readSyncCursor(first.id), 12)

    sync.hide()
    await Promise.all(
      Array.from({ length: 103 }, (_, index) =>
        ideaRepository.create(second.id, { content: '积压记录 ' + index }),
      ),
    )
    sync.show()
    for (const [count, cursor] of [
      [100, 21],
      [3, 22],
    ]) {
      const packet = await next('push', second.id)
      assert.equal(packet.body.idea.length, count)
      packet.resolve({ accepted: count, server_time: cursor })
      const result = await next('pull', second.id)
      assert.equal(result.body, cursor - 1)
      result.resolve({ ...packet.body, server_time: cursor })
    }
    await waitFor(async () => (await readSyncCursor(second.id)) === 22)
    assert.deepEqual(await readPendingChanges(second.id), empty())
  },
)
