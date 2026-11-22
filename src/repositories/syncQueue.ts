import type { SqlExecutor } from './db'

export const syncTables = [
  'idea',
  'expansion',
  'material',
  'step',
  'schedule',
  'reminder',
] as const
export type SyncTable = (typeof syncTables)[number]

const listeners = new Set<(owner: string) => void>()

export function onLocalWrite(listener: (owner: string) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyLocalWrite(owner: string) {
  for (const listener of listeners) {
    try {
      listener(owner)
    } catch {
      // 业务写入已提交，队列仍在，下次同步可恢复。
      console.warn('本地保存成功，同步将在下次连接时重试。')
    }
  }
}

export async function queueChange(
  db: SqlExecutor,
  table: SyncTable | 'usage_log',
  owner: string,
  id: string,
  version: number,
) {
  if (table === 'usage_log') return
  await db.execute(
    'INSERT OR REPLACE INTO sync_outbox (user_id, table_name, row_id, version) VALUES (?, ?, ?, ?)',
    [owner, table, id, version],
  )
}
