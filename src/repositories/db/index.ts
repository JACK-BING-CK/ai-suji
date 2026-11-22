import { migrations } from './migrations'
import { close, executor, open, transaction, type SqlExecutor } from './native'

export type { SqlExecutor, SqlRow, SqlValue } from './native'

let initialization: Promise<void> | undefined
let discardConnection = false
let queue: Promise<void> = Promise.resolve()

async function atomic<T>(work: (db: SqlExecutor) => Promise<T>): Promise<T> {
  await transaction('begin')
  try {
    const result = await work(executor)
    await transaction('commit')
    return result
  } catch (error) {
    try {
      await transaction('rollback')
    } catch (rollbackError) {
      // 下次初始化先关闭状态不明的连接，关闭失败时也不能复用。
      discardConnection = true
      initialization = undefined
      throw new Error('本地事务回滚失败，请重试。', { cause: rollbackError })
    }
    throw error
  }
}

async function openAndMigrate(): Promise<void> {
  if (discardConnection) {
    await close()
    discardConnection = false
  }
  await open()
  await executor.execute('PRAGMA foreign_keys = ON')
  const [setting] = await executor.query('PRAGMA foreign_keys')
  if (Number(setting?.foreign_keys) !== 1)
    throw new Error('本地数据库未能启用关联约束。')

  await atomic(async (db) => {
    const [row] = await db.query('PRAGMA user_version')
    const raw = row?.user_version
    const version = raw === null || raw === '' ? NaN : Number(raw)
    if (!Number.isInteger(version) || version < 0)
      throw new Error('本地数据库版本号无效。')
    if (version > migrations.length)
      throw new Error('本地数据版本较新，请更新 App 后再打开。')

    for (let i = version; i < migrations.length; i++) {
      for (const sql of migrations[i]) await db.execute(sql)
      await db.execute(`PRAGMA user_version = ${i + 1}`)
    }
  })
}

export function initializeDatabase(): Promise<void> {
  initialization ??= openAndMigrate().catch((error: unknown) => {
    initialization = undefined
    throw error
  })
  return initialization
}

export function withDatabase<T>(
  work: (db: SqlExecutor) => Promise<T>,
): Promise<T> {
  const result = queue.then(async () => {
    await initializeDatabase()
    return work(executor)
  })
  // 失败通过 result 传给调用方，排队的下一个操作仍可继续。
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export function withTransaction<T>(
  work: (db: SqlExecutor) => Promise<T>,
): Promise<T> {
  return withDatabase(() => atomic(work))
}
