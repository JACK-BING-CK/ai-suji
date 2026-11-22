import {
  withDatabase,
  withTransaction,
  type SqlExecutor,
  type SqlValue,
} from './db'
import { expansionRepository } from './expansion'
import {
  fromSql,
  integer,
  nonnegativeInteger,
  uuid,
  type FieldValue,
} from './fields'
import { ideaRepository } from './idea'
import { materialRepository } from './material'
import { reminderRepository } from './reminder'
import { scheduleRepository } from './schedule'
import { stepRepository } from './step'
import { queueChange, syncTables, type SyncTable } from './syncQueue'

export { onLocalWrite, syncTables, type SyncTable } from './syncQueue'

export type SyncRow = {
  id: string
  user_id: string
  created_at: number
  updated_at: number
  deleted_at: number | null
  [field: string]: FieldValue
}
export type SyncBatch = Record<SyncTable, SyncRow[]>

export function readExpansionSource(userId: string, ideaId: string) {
  return withDatabase(async (db) => {
    const [row] = await db.query(
      `SELECT idea.*, EXISTS (SELECT 1 FROM sync_outbox q
          WHERE q.user_id = idea.user_id AND q.table_name = 'idea' AND q.row_id = idea.id) AS pending
       FROM idea WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
      [uuid(userId), uuid(ideaId)],
    )
    if (!row) throw new Error('找不到这条想法，可能已删除。')
    return {
      idea: ideaRepository.syncCodec.decode(row),
      pending: Number(row.pending) === 1,
    }
  })
}

export function storeGeneratedExpansion(userId: string, row: SyncRow) {
  // 接口只返回本次扩写；其他未拉取的变更仍需从原游标开始读取。
  return withTransaction((db) => mergeRow(db, uuid(userId), 'expansion', row))
}

export function storeResearchedMaterials(
  userId: string,
  ideaId: string,
  rows: Awaited<ReturnType<typeof materialRepository.list>>,
) {
  const owner = uuid(userId)
  const idea = uuid(ideaId)
  if (!Array.isArray(rows) || rows.length > 25)
    throw new Error('返回的素材列表无效。')
  return withTransaction(async (db) => {
    let changed = false
    for (const row of rows) {
      if (row.idea_id !== idea || row.deleted_at !== null)
        throw new Error('返回的素材与当前想法不符。')
      if (await mergeRow(db, owner, 'material', { ...row })) changed = true
    }
    return changed
  })
}

export function storeGeneratedSteps(
  userId: string,
  ideaId: string,
  rows: Awaited<ReturnType<typeof stepRepository.list>>,
) {
  const owner = uuid(userId)
  const idea = uuid(ideaId)
  if (!Array.isArray(rows) || rows.length < 3 || rows.length > 12)
    throw new Error('返回的流程步骤数量无效，请重新同步。')
  return withTransaction(async (db) => {
    await db.execute('PRAGMA defer_foreign_keys = ON')
    const ids = new Set<string>()
    let changed = false
    for (const row of rows) {
      if (row.idea_id !== idea || row.deleted_at !== null || ids.has(row.id))
        throw new Error('返回的步骤与当前流程不符，请重新同步。')
      ids.add(row.id)
      if (await mergeRow(db, owner, 'step', { ...row })) changed = true
    }
    return changed
  })
}

const codecs = {
  idea: ideaRepository.syncCodec,
  expansion: expansionRepository.syncCodec,
  material: materialRepository.syncCodec,
  step: stepRepository.syncCodec,
  schedule: scheduleRepository.syncCodec,
  reminder: reminderRepository.syncCodec,
}

export function readSyncCursor(userId: string) {
  return withDatabase(async (db) => {
    const [row] = await db.query(
      'SELECT cursor FROM sync_cursor WHERE user_id = ?',
      [uuid(userId)],
    )
    return row ? fromSql(integer, row.cursor) : 0
  })
}

export function readPendingChanges(
  userId: string,
  scope?: {
    ideaId: string
    tables: readonly ('idea' | 'expansion' | 'step')[]
  },
): Promise<SyncBatch> {
  const owner = uuid(userId)
  return withDatabase(async (db) => {
    const batch: SyncBatch = {
      idea: [],
      expansion: [],
      material: [],
      step: [],
      schedule: [],
      reminder: [],
    }
    for (const table of scope?.tables ?? syncTables) {
      const filter = scope
        ? table === 'idea'
          ? ' AND t.id = ?'
          : ' AND t.idea_id = ?'
        : ''
      const rows = await db.query(
        `SELECT t.* FROM ${table} t JOIN sync_outbox q
         ON t.user_id = q.user_id AND t.id = q.row_id
         WHERE t.user_id = ? AND q.table_name = ?${filter} ORDER BY t.created_at, t.id`,
        scope ? [owner, table, uuid(scope.ideaId)] : [owner, table],
      )
      batch[table] = rows.map((raw) => {
        const row = codecs[table].decode(raw)
        // 系统闹钟句柄只在分配它的手机上有效。
        return table === 'reminder' ? { ...row, native_id: null } : { ...row }
      })
    }
    return batch
  })
}

function clearVersion(
  db: SqlExecutor,
  owner: string,
  table: SyncTable,
  id: string,
  version: number,
) {
  return db.execute(
    'DELETE FROM sync_outbox WHERE user_id = ? AND table_name = ? AND row_id = ? AND version = ?',
    [owner, table, id, version],
  )
}

async function mergeRow(
  db: SqlExecutor,
  owner: string,
  table: SyncTable,
  wire: SyncRow,
) {
  if (uuid(wire.user_id) !== owner) throw new Error('同步数据不属于当前账号。')
  const id = uuid(wire.id)
  const version = nonnegativeInteger(wire.updated_at)
  const createdAt = nonnegativeInteger(wire.created_at)
  const deletedAt =
    wire.deleted_at === null ? null : nonnegativeInteger(wire.deleted_at)
  const codec = codecs[table]
  const [stored] = await db.query(
    `SELECT * FROM ${table} WHERE user_id = ? AND id = ?`,
    [owner, id],
  )
  // 升级期间旧服务端可能仍返回不带打卡数组的日程。
  const fields = codec.encodeFields(
    table === 'schedule' && wire.completed_slots === undefined
      ? {
          ...wire,
          completed_slots: stored
            ? scheduleRepository.syncCodec.decode(stored).completed_slots
            : [],
        }
      : wire,
  )
  if (stored) {
    const localDeleted = stored.deleted_at != null
    const remoteDeleted = deletedAt !== null
    if (
      localDeleted !== remoteDeleted
        ? localDeleted
        : fromSql(integer, stored.updated_at) > version
    )
      return false
  }
  if (table === 'reminder') fields.native_id = stored?.native_id ?? null

  // 另一台设备可能给同一想法独立生成过思路，先释放活行唯一约束。
  if (table === 'expansion' && deletedAt === null) {
    const [other] = await db.query(
      'SELECT id, updated_at FROM expansion WHERE user_id = ? AND idea_id = ? AND id <> ? AND deleted_at IS NULL',
      [owner, fields.idea_id, id],
    )
    if (other) {
      const otherVersion = fromSql(integer, other.updated_at)
      if (otherVersion > version) return false
      const otherId = uuid(other.id)
      await db.execute(
        'UPDATE expansion SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?',
        [version, version, owner, otherId],
      )
      await queueChange(db, table, owner, otherId, version)
    }
  }

  const values: Record<string, SqlValue> = {
    created_at: createdAt,
    updated_at: version,
    deleted_at: deletedAt,
    ...fields,
  }
  const names = Object.keys(values)
  if (stored) {
    await clearVersion(
      db,
      owner,
      table,
      id,
      fromSql(integer, stored.updated_at),
    )
    const local = codec.decode(stored)
    const localFields = codec.encodeFields({ ...local })
    if (
      local.created_at === createdAt &&
      local.updated_at === version &&
      local.deleted_at === deletedAt &&
      Object.keys(fields).every((name) => fields[name] === localFields[name])
    )
      return false
    await db.execute(
      `UPDATE ${table} SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE user_id = ? AND id = ?`,
      [...Object.values(values), owner, id],
    )
  } else {
    await db.execute(
      `INSERT INTO ${table} (id, user_id, ${names.join(', ')}) VALUES (?, ?, ${names.map(() => '?').join(', ')})`,
      [id, owner, ...Object.values(values)],
    )
  }
  return true
}

export function applyPull(
  userId: string,
  batch: SyncBatch,
  cursor: number,
  sent?: SyncBatch,
) {
  const owner = uuid(userId)
  nonnegativeInteger(cursor)
  return withTransaction(async (db) => {
    // 先写子步骤或稍后才收到的依赖均在本次提交时统一检查。
    await db.execute('PRAGMA defer_foreign_keys = ON')
    let changed = false
    for (const table of syncTables) {
      if (!Array.isArray(batch[table])) throw new Error('同步响应缺少业务表。')
      const rows =
        table === 'expansion'
          ? [...batch[table]].sort(
              (a, b) =>
                Number(a.deleted_at === null) - Number(b.deleted_at === null),
            )
          : batch[table]
      for (const row of rows) {
        if (await mergeRow(db, owner, table, row)) changed = true
      }
      for (const row of sent?.[table] ?? []) {
        if (uuid(row.user_id) !== owner)
          throw new Error('推送记录不属于当前账号。')
        await clearVersion(
          db,
          owner,
          table,
          uuid(row.id),
          nonnegativeInteger(row.updated_at),
        )
      }
    }
    await db.execute(
      `INSERT OR REPLACE INTO sync_cursor (user_id, cursor) VALUES
       (?, MAX(?, COALESCE((SELECT cursor FROM sync_cursor WHERE user_id = ?), 0)))`,
      [owner, cursor, owner],
    )
    return changed
  })
}

function legacyOwner() {
  const id: unknown = uni.getStorageSync('ai-suji.local-user-id.v1')
  return typeof id === 'string' && id ? uuid(id) : null
}

async function canClaim(db: SqlExecutor, legacy: string) {
  // 只认旧版生成的设备身份；已有云同步状态的账号绝不作为迁移来源。
  const [synced] = await db.query(
    'SELECT cursor FROM sync_cursor WHERE user_id = ?',
    [legacy],
  )
  if (synced) return false
  const [data] = await db.query(
    'SELECT 1 FROM sync_outbox WHERE user_id = ? UNION ALL SELECT 1 FROM usage_log WHERE user_id = ? LIMIT 1',
    [legacy, legacy],
  )
  return Boolean(data)
}

export async function hasLegacyData() {
  const legacy = legacyOwner()
  return legacy ? withDatabase((db) => canClaim(db, legacy)) : false
}

export async function claimLegacyData(userId: string) {
  const owner = uuid(userId)
  const legacy = legacyOwner()
  if (!legacy || legacy === owner) return
  await withTransaction(async (db) => {
    if (!(await canClaim(db, legacy))) return
    await db.execute('PRAGMA defer_foreign_keys = ON')
    for (const table of [...syncTables, 'usage_log', 'sync_outbox']) {
      await db.execute(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`, [
        owner,
        legacy,
      ])
    }
    // 标记旧身份已认领，旧页面随后提交的写入也不会转入另一账号。
    await db.execute(
      'INSERT INTO sync_cursor (user_id, cursor) VALUES (?, 0)',
      [legacy],
    )
  })
}
