import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ideaRepository } from '../src/repositories/idea.ts'
import {
  applyPull,
  readPendingChanges,
  readSyncCursor,
  syncTables,
} from '../src/repositories/sync.ts'
import {
  deleteMaterial,
  findMaterials,
  loadMaterials,
  openMaterialUrl,
} from '../src/services/materials.ts'
import { useAuthStore } from '../src/store/auth.ts'
import { installBridge } from './fixtures/sqlite-bridge.mjs'

const { createPinia, setActivePinia } = createRequire(import.meta.url)('pinia')

test('找题材的离线缓存、删除同步和登录隔离', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'ai-suji-materials-'))
  const connection = installBridge(join(folder, 'app.db'))
  t.after(() => {
    connection()?.close()
    rmSync(folder, { recursive: true, force: true })
  })
  globalThis.uni.setStorageSync = () => {}
  setActivePinia(createPinia())
  const auth = useAuthStore()
  const user = { id: randomUUID(), nickname: '素材账号' }
  const other = { id: randomUUID(), nickname: '其他账号' }
  auth.setSession(user, 'test-token')
  const idea = await ideaRepository.create(user.id, { content: '自行车通勤' })
  const batch = await readPendingChanges(user.id)
  const empty = Object.fromEntries(syncTables.map((table) => [table, []]))
  await applyPull(user.id, empty, 10, batch)
  const original = {
    id: randomUUID(),
    idea_id: idea.id,
    user_id: user.id,
    created_at: 20,
    updated_at: 20,
    deleted_at: null,
    title: '通勤路线',
    source_name: '资料馆',
    published_at: 0,
    url: 'https://example.org/a%2Fb?q=%E7%8E%AF&v=2#文档',
    summary: '路线摘要',
  }
  const search = (reply) =>
    findMaterials(user.id, idea.id, async (id) => {
      assert.equal(id, idea.id)
      return reply
    })
  assert.equal(await search([original]), 1)
  assert.equal(await search([]), 0)
  await assert.rejects(
    findMaterials(user.id, idea.id, async () => {
      throw new Error('网络超时')
    }),
    /网络超时/,
  )
  assert.deepEqual(await loadMaterials(user.id, idea.id), [original])
  assert.deepEqual(await loadMaterials(other.id, idea.id), [])
  assert.equal(await readSyncCursor(user.id), 10)
  assert.deepEqual((await readPendingChanges(user.id)).material, [])
  const second = { ...original, id: randomUUID() }
  await assert.rejects(
    search([second, { ...original, user_id: other.id }]),
    /同步后重新读取/,
  )
  assert.deepEqual(await loadMaterials(user.id, idea.id), [original])
  assert.equal(await deleteMaterial(other.id, original.id), false)
  assert.equal(await deleteMaterial(user.id, original.id), true)
  await search([original])
  assert.deepEqual(await loadMaterials(user.id, idea.id), [])
  const [deleted] = (await readPendingChanges(user.id)).material
  assert.equal(deleted.id, original.id)
  assert.ok(deleted.deleted_at)
  await assert.rejects(
    findMaterials(user.id, idea.id, async () => {
      auth.setSession(other, 'other-token')
      return [second]
    }),
    /登录状态已改变/,
  )
  assert.deepEqual(await loadMaterials(user.id, idea.id), [])
})

test('系统浏览器只接收原样的网页 URL', () => {
  const opened = []
  const errors = []
  globalThis.plus = { runtime: { openURL: (url) => opened.push(url) } }
  const url = 'https://example.org/%2Farticle?ref=%2B%3D#资料'
  for (const bad of [
    'intent://scan',
    'file:///local',
    'javascript:alert(1)',
    'https://name@example.org/page',
    'https://good.test\\@other.test',
    'https:///x',
    'https://example.org/\u0000',
  ])
    openMaterialUrl(bad, (message) => errors.push(message))
  openMaterialUrl(url, (message) => errors.push(message))
  assert.equal(errors.length, 7)
  assert.deepEqual(opened, [url])
})
