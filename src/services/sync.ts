import { ref, watch } from 'vue'
import { HttpError } from '../api/http'
import { pullChanges, pushChanges } from '../api/sync'
import {
  applyPull,
  onLocalWrite,
  readPendingChanges,
  readSyncCursor,
  syncTables,
  type SyncBatch,
  type SyncRow,
} from '../repositories/sync'
import { useAuthStore } from '../store/auth'

export const syncMessage = ref('')
export const syncedDataRevision = ref(0)

function size(batch: SyncBatch) {
  return syncTables.reduce((total, table) => total + batch[table].length, 0)
}

// 超过单次传输上限时，先发父记录。步骤依赖链与同一环上的记录同批提交。
export function firstPacket(pending: SyncBatch): SyncBatch {
  const limit = 16 * 1024 * 1024
  const maxRows = 100
  if (size(pending) <= maxRows) {
    const json = JSON.stringify(pending)
    if (json.length * 3 <= limit || utf8Size(json) <= limit) return pending
  }
  const packet: SyncBatch = {
    idea: [],
    expansion: [],
    material: [],
    step: [],
    schedule: [],
    reminder: [],
  }
  let bytes = JSON.stringify(packet).length
  let rows = 0
  const steps = new Map(pending.step.map((row) => [row.id, row]))
  const included = new Set<string>()
  for (const table of syncTables) {
    for (const row of pending[table]) {
      if (table === 'step' && included.has(row.id)) continue
      const group: SyncRow[] = [row]
      let cycleMembers = 0
      if (table === 'step') {
        const seen = new Set([row.id])
        let parent = steps.get(String(row.depends_on))
        while (parent && !included.has(parent.id) && !seen.has(parent.id)) {
          group.push(parent)
          seen.add(parent.id)
          parent = steps.get(String(parent.depends_on))
        }
        if (parent && seen.has(parent.id)) {
          cycleMembers =
            group.length - group.findIndex((item) => item.id === parent.id)
        }
        group.reverse()
      }
      // 无环的长链可跨批；只有互相引用的步骤须同批提交。
      for (let offset = 0; offset < group.length;) {
        const block = group.slice(
          offset,
          offset + (offset === 0 && cycleMembers ? cycleMembers : 1),
        )
        const added = block.reduce(
          (n, item) => n + utf8Size(JSON.stringify(item)) + 1,
          0,
        )
        if (rows && (rows + block.length > maxRows || bytes + added > limit))
          return packet
        if (bytes + added > limit)
          throw new Error('单条记录或其循环依赖超过同步大小限制。')
        for (const item of block) {
          packet[table].push(item)
          if (table === 'step') included.add(item.id)
        }
        bytes += added
        rows += block.length
        offset += block.length
      }
    }
  }
  return packet
}

function utf8Size(value: string) {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0)!
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4
  }
  return bytes
}

export function startSync({ push = pushChanges, pull = pullChanges } = {}) {
  const auth = useAuthStore()
  let timer: ReturnType<typeof setTimeout> | undefined
  let foreground = true
  let online = true
  let running = false
  let requested = false
  let retryDelay = 0

  function schedule(delay = 100) {
    requested = true
    clearTimeout(timer)
    if (!running && foreground && online && auth.token)
      timer = setTimeout(run, delay)
  }

  async function run() {
    const owner = auth.user?.id
    if (running || !owner || !auth.token || !foreground || !online) return
    running = true
    requested = false
    const revision = auth.revision
    const current = () => auth.revision === revision && auth.user?.id === owner
    try {
      const pending = await readPendingChanges(owner)
      const sent = firstPacket(pending)
      const count = size(sent)
      let since = auth.needsFullSync ? 0 : await readSyncCursor(owner)
      if (!current()) return
      if (count) {
        const result = await push(sent)
        if (!current()) return
        if (
          !Number.isInteger(result?.accepted) ||
          result.accepted < 0 ||
          result.accepted > count
        )
          throw new Error('推送响应格式无效。')
        // 重复推送和冲突都可能返回零，需取回服务端已有的胜者。
        if (result.accepted < count) since = 0
      }
      const remote = await pull(since)
      if (!current()) return
      const changed = await applyPull(owner, remote, remote.server_time, sent)
      if (!current()) return
      if (changed) syncedDataRevision.value++
      if (!since) auth.completeFullSync()
      retryDelay = 0
      syncMessage.value = ''
      // 事务确认只清除已发送的版本；网络往返间的新写入继续发送。
      if (size(await readPendingChanges(owner))) requested = true
    } catch (cause) {
      if (current()) {
        syncMessage.value =
          (cause instanceof Error ? cause.message : '同步暂未完成。') +
          ' 本地记录已保留，将自动重试。'
        retryDelay =
          cause instanceof HttpError && cause.code === 429
            ? 60000
            : Math.min(60000, Math.max(2000, retryDelay * 2))
        requested = true
      }
    } finally {
      running = false
      if (requested) schedule(retryDelay || 100)
    }
  }

  const stopWatch = watch(
    () => auth.revision,
    () => {
      retryDelay = 0
      syncMessage.value = ''
      schedule()
    },
    { flush: 'sync' },
  )
  const stopWrites = onLocalWrite((owner) => {
    if (owner === auth.user?.id) schedule(retryDelay || 100)
  })
  function network(status: { isConnected: boolean }) {
    online = status.isConnected
    if (!online && auth.token)
      syncMessage.value = '当前离线，本地记录会在联网后自动同步。'
    if (online) retryDelay = 0
    schedule()
  }
  uni.onNetworkStatusChange(network)
  schedule()
  return {
    show() {
      foreground = true
      online = true
      schedule()
    },
    hide() {
      foreground = false
      clearTimeout(timer)
    },
    stop() {
      foreground = false
      clearTimeout(timer)
      stopWatch()
      stopWrites()
      uni.offNetworkStatusChange(network)
    },
  }
}
