import { Router } from 'express'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { HttpError } from './errors.js'
import {
  emptyBatch,
  parseBatch,
  parseSince,
  tables,
  type SyncBatch,
  type SyncRow,
  type SyncTable,
} from './sync-fields.js'

interface Version extends RowDataPacket {
  id: string
  updated_at: number
  deleted_at: number | null
}

interface CompletionChange {
  done: number
  version: number
}

async function reconcileCompletion(
  db: PoolConnection,
  owner: string,
  stepId: string,
  toggle: CompletionChange | undefined,
  stamp: number,
) {
  const [steps] = await db.execute<RowDataPacket[]>(
    'SELECT done, updated_at, deleted_at FROM `step` WHERE user_id = ? AND id = ?',
    [owner, stepId],
  )
  const step = steps[0]
  if (!step) return
  const stepVersion = Number(step.updated_at)
  const deleted = step.deleted_at !== null
  const fromSchedule = !deleted && toggle && toggle.version > stepVersion
  const done = fromSchedule ? toggle.done : Number(step.done)
  const version = fromSchedule ? toggle.version : stepVersion
  // 即使两者同时勾选，也把较新版本留在步骤上，防止迟到的旧步骤撤销勾选。
  if (fromSchedule) {
    await db.execute(
      'UPDATE `step` SET done=?, updated_at=? WHERE user_id=? AND id=?',
      [done, version, owner, stepId],
    )
    await publish(db, owner, 'step', stepId, stamp)
  }
  // 新日程继承步骤状态。离线设备晚到的日程若对应步骤已删除，则解除关联。
  const [schedules] = await db.execute<RowDataPacket[]>(
    'SELECT id FROM schedule WHERE user_id=? AND step_id=? AND deleted_at IS NULL' +
      (deleted ? '' : ' AND done <> ?'),
    deleted ? [owner, stepId] : [owner, stepId, done],
  )
  for (const row of schedules) {
    const field = deleted ? 'step_id=NULL' : 'done=?'
    await db.execute(
      `UPDATE schedule SET ${field}, updated_at=GREATEST(updated_at, ?) WHERE user_id=? AND id=?`,
      [...(deleted ? [] : [done]), version, owner, row.id],
    )
    await publish(db, owner, 'schedule', row.id, stamp)
  }
}

function databaseError(cause: unknown) {
  if (!cause || typeof cause !== 'object' || !('code' in cause)) return cause
  switch (cause.code) {
    case 'ER_DUP_ENTRY':
      return new HttpError(409, '记录编号冲突，请重新同步。')
    case 'ER_NO_REFERENCED_ROW_2':
      return new HttpError(400, '关联记录不存在或不属于当前账号。')
    case 'ER_DATA_TOO_LONG':
    case 'ER_CHECK_CONSTRAINT_VIOLATED':
      return new HttpError(400, '同步字段超出了数据库允许的范围。')
    case 'ER_LOCK_DEADLOCK':
    case 'ER_LOCK_WAIT_TIMEOUT':
      return new HttpError(503, '数据正在更新，请稍后重试。')
    default:
      return cause
  }
}

export async function withUserTransaction<T>(
  pool: Pool,
  owner: string,
  action: (db: PoolConnection, cursor: number) => Promise<T>,
) {
  const db = await pool.getConnection()
  try {
    await db.beginTransaction()
    // 同一账号的事务按提交顺序发布；同一毫秒及多进程写入均不能越过拉取游标。
    const [users] = await db.execute<RowDataPacket[]>(
      'SELECT id FROM `user` WHERE id = ? AND status = 1 AND deleted_at IS NULL FOR UPDATE',
      [owner],
    )
    if (!users.length) throw new HttpError(401, '登录状态已失效。')
    const [latest] = await db.execute<RowDataPacket[]>(
      'SELECT COALESCE(MAX(published_at), 0) AS last_publication FROM sync_publications WHERE user_id = ?',
      [owner],
    )
    const result = await action(db, Number(latest[0].last_publication))
    await db.commit()
    return result
  } catch (cause) {
    try {
      await db.rollback()
    } catch {
      db.destroy()
    }
    throw databaseError(cause)
  } finally {
    db.release()
  }
}

function pull(pool: Pool, owner: string, since: number) {
  return withUserTransaction(pool, owner, async (db, cursor) => {
    const batch = emptyBatch()
    let nextCursor = cursor
    for (const table of tables) {
      // published_at 补回晚到的离线修改；业务 updated_at 保留原值用于多设备冲突比较。
      const [rows] = await db.execute<(SyncRow & RowDataPacket)[]>(
        `SELECT t.*, p.published_at AS last_publication FROM \`${table}\` t LEFT JOIN sync_publications p
           ON t.user_id = p.user_id AND t.id = p.record_id AND p.table_name = ?
         WHERE t.user_id = ? AND (p.published_at IS NULL OR p.published_at > ? OR t.updated_at > p.published_at)
         ORDER BY p.published_at, t.id`,
        [table, owner, since],
      )
      for (const { last_publication, ...row } of rows) {
        let publication = Number(last_publication)
        // 其他后端业务直接落库的数据也要进入同一个发布序列。
        if (last_publication === null || row.updated_at > publication) {
          publication = Math.max(Date.now(), cursor + 1, row.updated_at)
          await publish(db, owner, table, row.id, publication)
          nextCursor = Math.max(nextCursor, publication)
        }
        if (publication > since) {
          if (table === 'reminder') row.native_id = null
          batch[table].push(row)
        }
      }
    }
    return { ...batch, server_time: nextCursor }
  })
}

export function publish(
  db: PoolConnection,
  owner: string,
  table: SyncTable,
  id: string,
  stamp: number,
) {
  return db.execute(
    'INSERT INTO sync_publications (user_id, table_name, record_id, published_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE published_at = ?',
    [owner, table, id, stamp, stamp],
  )
}

function wins(row: SyncRow, stored: Version) {
  if ((row.deleted_at === null) !== (stored.deleted_at === null))
    return row.deleted_at !== null
  return row.updated_at > Number(stored.updated_at)
}

async function storeRow(
  db: PoolConnection,
  table: SyncTable,
  row: SyncRow,
  exists: boolean,
) {
  const fields = Object.keys(row).filter(
    (key) => !exists || !['id', 'user_id', 'created_at'].includes(key),
  )
  const names = fields.map((field) => `\`${field}\``)
  const values = fields.map((field) =>
    Array.isArray(row[field]) ? JSON.stringify(row[field]) : row[field],
  )
  if (!exists) {
    await db.execute(
      `INSERT INTO \`${table}\` (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      values,
    )
  } else {
    await db.execute(
      `UPDATE \`${table}\` SET ${names.map((col) => col + '=?').join(',')} WHERE user_id = ? AND id = ?`,
      [...values, row.user_id, row.id],
    )
  }
}

async function mergeRow(
  db: PoolConnection,
  table: SyncTable,
  row: SyncRow,
  stamp: number,
  completion: Map<string, CompletionChange | undefined>,
): Promise<'accepted' | 'superseded' | 'unchanged'> {
  const linkFields = table === 'schedule' ? ', step_id, done' : ''
  const [existing] = await db.execute<Version[]>(
    `SELECT id, updated_at, deleted_at${linkFields} FROM \`${table}\` WHERE user_id = ? AND id = ?`,
    [row.user_id, row.id],
  )
  if (existing.length && !wins(row, existing[0])) return 'unchanged'
  let stored = row
  if (table === 'expansion' && row.deleted_at === null) {
    // 不同设备可为同一想法首次生成不同 UUID。保留一条活记录并把败方的墓碑发给两端。
    const [others] = await db.execute<Version[]>(
      'SELECT id, updated_at, deleted_at FROM expansion WHERE user_id = ? AND idea_id = ? AND id <> ? AND deleted_at IS NULL',
      [row.user_id, row.idea_id, row.id],
    )
    if (others.length) {
      const previous = others[0]
      if (row.updated_at > Number(previous.updated_at)) {
        await db.execute(
          'UPDATE expansion SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ?',
          [
            stamp,
            Math.max(row.updated_at, Number(previous.updated_at)),
            row.user_id,
            previous.id,
          ],
        )
        await publish(db, row.user_id, table, previous.id, stamp)
      } else {
        stored = { ...row, deleted_at: stamp }
      }
    }
  }
  await storeRow(db, table, stored, existing.length > 0)
  await publish(db, row.user_id, table, row.id, stamp)
  if (table === 'step') completion.set(row.id, undefined)
  if (
    table === 'schedule' &&
    row.deleted_at === null &&
    typeof row.step_id === 'string'
  ) {
    const lastToggle = completion.get(row.step_id)
    const old = existing[0]
    if (
      old?.step_id === row.step_id &&
      old.done !== row.done &&
      (!lastToggle || row.updated_at > lastToggle.version)
    ) {
      completion.set(row.step_id, {
        done: Number(row.done),
        version: row.updated_at,
      })
    } else if (!completion.has(row.step_id)) {
      completion.set(row.step_id, undefined)
    }
  }
  return stored === row ? 'accepted' : 'superseded'
}

function push(pool: Pool, owner: string, batch: SyncBatch) {
  return withUserTransaction(pool, owner, async (db, cursor) => {
    let stamp = Math.max(Date.now(), cursor + 1)
    for (const table of tables)
      for (const row of batch[table]) stamp = Math.max(stamp, row.updated_at)
    let accepted = 0
    let changed = false
    const dependencies: { id: string; parent: string }[] = []
    const completion = new Map<string, CompletionChange | undefined>()
    // 一批内先归档旧扩写，再插入新活记录，避免唯一约束受数组顺序影响。
    batch.expansion.sort(
      (a, b) => Number(a.deleted_at === null) - Number(b.deleted_at === null),
    )
    for (const table of tables) {
      for (const row of batch[table]) {
        const dependency =
          table === 'step' && typeof row.depends_on === 'string'
            ? row.depends_on
            : null
        const result = await mergeRow(
          db,
          table,
          dependency ? { ...row, depends_on: null } : row,
          stamp,
          completion,
        )
        if (result !== 'unchanged') changed = true
        if (result !== 'accepted') continue
        accepted++
        if (dependency) dependencies.push({ id: row.id, parent: dependency })
      }
    }
    // 所有步骤先落库，同批正向引用不会因数组次序触发外键错误。
    for (const { id, parent } of dependencies)
      await db.execute(
        'UPDATE `step` SET depends_on = ? WHERE user_id = ? AND id = ?',
        [parent, owner, id],
      )
    for (const [stepId, toggle] of completion)
      await reconcileCompletion(db, owner, stepId, toggle, stamp)
    return { accepted, server_time: changed ? stamp : cursor }
  })
}

export function createSyncRouter(pool: Pool) {
  const router = Router()
  router.get('/pull', async (request, response) => {
    const data = await pull(
      pool,
      response.locals.userId,
      parseSince(request.query.since),
    )
    response.set('Cache-Control', 'no-store').json({ code: 0, msg: '', data })
  })
  router.post('/push', async (request, response) => {
    const owner: string = response.locals.userId
    const data = await push(pool, owner, parseBatch(request.body, owner))
    response.json({ code: 0, msg: '', data })
  })
  return router
}
