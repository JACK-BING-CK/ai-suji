import {
  withDatabase,
  withTransaction,
  type SqlExecutor,
  type SqlRow,
  type SqlValue,
} from './db'
import { fromSql, integer, uuid, type Field } from './fields'
import { notifyLocalWrite, queueChange } from './syncQueue'

type Table =
  | 'idea'
  | 'expansion'
  | 'material'
  | 'step'
  | 'schedule'
  | 'reminder'
  | 'usage_log'
type Shape = Record<string, Field>
type Fields<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> }

interface StoredRow {
  id: string
  user_id: string
  created_at: number
  updated_at: number
  deleted_at: number | null
}

const parentTables: Readonly<Record<string, Table | undefined>> = {
  idea_id: 'idea',
  step_id: 'step',
  depends_on: 'step',
  schedule_id: 'schedule',
}

async function checkParents(
  db: SqlExecutor,
  owner: string,
  values: Record<string, SqlValue>,
) {
  for (const [key, value] of Object.entries(values)) {
    const parent = parentTables[key]
    if (!parent || value === null) continue
    const rows = await db.query(
      `SELECT id FROM ${parent} WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
      [owner, value],
    )
    if (!rows.length) throw new Error('关联记录不存在或已删除')
  }
}

async function newId(db: SqlExecutor): Promise<string> {
  // 使用 SQLite 的随机源，安卓和 iOS 的逻辑层均无需浏览器加密接口。
  const [row] = await db.query('SELECT lower(hex(randomblob(16))) AS digits')
  const digits = row?.digits
  if (typeof digits !== 'string' || !/^[a-f0-9]{32}$/.test(digits))
    throw new Error('无法生成记录编号')
  const variant = ((parseInt(digits[16], 16) & 3) | 8).toString(16)
  return [
    digits.slice(0, 8),
    digits.slice(8, 12),
    '4' + digits.slice(13, 16),
    variant + digits.slice(17, 20),
    digits.slice(20),
  ].join('-')
}

export function createRepository<
  S extends Shape,
  D extends keyof S & string = never,
>(
  table: Table,
  columns: S,
  options: { defaults?: Pick<Fields<S>, D>; latestBy?: keyof S & string } = {},
) {
  type Row = StoredRow & Fields<S>
  type CreateInput = Omit<Fields<S>, D> & Partial<Pick<Fields<S>, D>>
  const active = 'user_id = ? AND id = ? AND deleted_at IS NULL'

  function encode(input: object, creating: boolean): Record<string, SqlValue> {
    const data: Record<string, unknown> = creating
      ? { ...options.defaults }
      : {}
    for (const [key, value] of Object.entries(input)) {
      if (!Object.prototype.hasOwnProperty.call(columns, key))
        throw new Error(`不可写入字段 ${key}`)
      if (value !== undefined) data[key] = value
    }
    const result: Record<string, SqlValue> = {}
    for (const key of creating ? Object.keys(columns) : Object.keys(data)) {
      try {
        const value = columns[key](data[key])
        result[key] = Array.isArray(value) ? JSON.stringify(value) : value
      } catch (error) {
        throw new Error(
          `${key} 字段无效：${error instanceof Error ? error.message : '请检查输入'}`,
          { cause: error },
        )
      }
    }
    return result
  }

  function decode(raw: SqlRow): Row {
    const result: Record<string, unknown> = {
      id: uuid(raw.id),
      user_id: uuid(raw.user_id),
      created_at: fromSql(integer, raw.created_at),
      updated_at: fromSql(integer, raw.updated_at),
      deleted_at:
        raw.deleted_at == null ? null : fromSql(integer, raw.deleted_at),
    }
    for (const [key, field] of Object.entries(columns)) {
      result[key] = fromSql(field, raw[key])
    }
    return result as Row
  }

  async function read(
    db: SqlExecutor,
    owner: string,
    id: string,
  ): Promise<Row | null> {
    const [row] = await db.query(`SELECT * FROM ${table} WHERE ${active}`, [
      owner,
      id,
    ])
    return row ? decode(row) : null
  }

  async function readSaved(
    db: SqlExecutor,
    owner: string,
    id: string,
  ): Promise<Row> {
    const saved = await read(db, owner, id)
    if (!saved) throw new Error('无法读取刚保存的记录')
    return saved
  }

  async function change(
    db: SqlExecutor,
    owner: string,
    row: StoredRow,
    values: Record<string, SqlValue>,
  ) {
    const setters = Object.keys(values).map((name) => `${name} = ?`)
    // 同一毫秒内连续写入，或系统时间回拨时，仍保留可同步的版本顺序。
    const nextTime = Math.max(Date.now(), row.updated_at + 1)
    await db.execute(
      `UPDATE ${table} SET ${[...setters, 'updated_at = ?'].join(', ')} WHERE ${active}`,
      [...Object.values(values), nextTime, owner, row.id],
    )
    await queueChange(db, table, owner, row.id, nextTime)
    return readSaved(db, owner, row.id)
  }

  async function run<T>(
    userId: string,
    action: string,
    write: boolean,
    task: (db: SqlExecutor, owner: string) => Promise<T>,
  ): Promise<T> {
    try {
      const owner = uuid(userId)
      const executor = write ? withTransaction : withDatabase
      const result = await executor((db) => task(db, owner))
      if (write && result && table !== 'usage_log') notifyLocalWrite(owner)
      return result
    } catch (error) {
      throw new Error(
        `${action}失败：${error instanceof Error ? error.message : '请检查本地数据库'}`,
        { cause: error },
      )
    }
  }

  type ListOptions = {
    where?: Partial<Fields<S>>
    orderBy?: 'created_at' | 'updated_at'
  }
  type Patch = Partial<Fields<S>> | ((current: Row) => Partial<Fields<S>>)

  async function create(
    db: SqlExecutor,
    owner: string,
    input: CreateInput,
    recordId?: string,
  ): Promise<Row> {
    const values = encode(input, true)
    await checkParents(db, owner, values)
    if (options.latestBy) {
      const [existing] = await db.query(
        `SELECT * FROM ${table} WHERE user_id = ? AND ${options.latestBy} = ? AND deleted_at IS NULL`,
        [owner, values[options.latestBy]],
      )
      if (existing) return change(db, owner, decode(existing), values)
    }
    const id = recordId === undefined ? await newId(db) : uuid(recordId)
    const now = Date.now()
    const names = [
      'id',
      'user_id',
      'created_at',
      'updated_at',
      ...Object.keys(values),
    ]
    await db.execute(
      `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      [id, owner, now, now, ...Object.values(values)],
    )
    await queueChange(db, table, owner, id, now)
    return readSaved(db, owner, id)
  }

  async function list(
    db: SqlExecutor,
    owner: string,
    options: ListOptions = {},
  ): Promise<Row[]> {
    const filters = Object.entries(encode(options.where ?? {}, false))
    const conditions = [
      'user_id = ?',
      'deleted_at IS NULL',
      ...filters.map(([name]) => `${name} IS ?`),
    ]
    const order = options.orderBy === 'created_at' ? 'created_at' : 'updated_at'
    const rows = await db.query(
      `SELECT * FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY ${order} DESC, id`,
      [owner, ...filters.map(([, value]) => value)],
    )
    return rows.map(decode)
  }

  async function update(
    db: SqlExecutor,
    owner: string,
    id: string,
    patch: Patch,
  ): Promise<Row | null> {
    const row = await read(db, owner, uuid(id))
    if (!row) return null
    const values = encode(
      typeof patch === 'function' ? patch(row) : patch,
      false,
    )
    if (!Object.keys(values).length) return row
    await checkParents(db, owner, values)
    return change(db, owner, row, values)
  }

  async function remove(
    db: SqlExecutor,
    owner: string,
    id: string,
  ): Promise<boolean> {
    const recordId = uuid(id)
    const [row] = await db.query(
      `SELECT updated_at FROM ${table} WHERE ${active}`,
      [owner, recordId],
    )
    if (!row) return false
    const deletedAt = Math.max(Date.now(), fromSql(integer, row.updated_at) + 1)
    await db.execute(
      `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE ${active}`,
      [deletedAt, deletedAt, owner, recordId],
    )
    await queueChange(db, table, owner, recordId, deletedAt)
    return true
  }

  return {
    // 同步复用各模型字段的白名单及类型校验，并保留远端的时间戳。
    syncCodec: {
      decode,
      encodeFields(row: Record<string, unknown>) {
        const fields: Record<string, unknown> = {}
        for (const name of Object.keys(columns)) {
          if (row[name] === undefined)
            throw new Error(`同步数据缺少字段 ${name}。`)
          fields[name] = row[name]
        }
        return encode(fields, true)
      },
    },
    // 在同一个写事务中组合多个模型时，由外层统一提交并通知同步。
    transaction: { create, get: read, list, update, remove },
    create(userId: string, input: CreateInput): Promise<Row> {
      return run(userId, '保存记录', true, (db, owner) =>
        create(db, owner, input),
      )
    },
    get(userId: string, id: string): Promise<Row | null> {
      return run(userId, '读取记录', false, (db, owner) =>
        read(db, owner, uuid(id)),
      )
    },
    list(userId: string, options: ListOptions = {}): Promise<Row[]> {
      return run(userId, '读取列表', false, (db, owner) =>
        list(db, owner, options),
      )
    },
    update(userId: string, id: string, patch: Patch): Promise<Row | null> {
      return run(userId, '修改记录', true, (db, owner) =>
        update(db, owner, id, patch),
      )
    },
    remove(userId: string, id: string): Promise<boolean> {
      return run(userId, '删除记录', true, (db, owner) => remove(db, owner, id))
    },
  }
}
