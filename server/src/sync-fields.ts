import { HttpError } from './errors.js'

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
type Value = string | number | null | string[]
type Check = (input: unknown) => boolean
const text: Check = (value) => typeof value === 'string'
const uuid: Check = (value) =>
  typeof value === 'string' && uuidPattern.test(value)
const stringList: Check = (value) => Array.isArray(value) && value.every(text)
const date: Check = (value) =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  Number.isFinite(new Date(value).getTime())
const time: Check = (value) =>
  typeof value === 'number' && value >= 0 && date(value)
const integer: Check = (value) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= -2147483648 &&
  value <= 2147483647
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value)
const choice =
  (...values: (number | string)[]): Check =>
  (value) =>
    values.some((candidate) => candidate === value)
const flag = choice(0, 1)
const fields = {
  idea: {
    content: (value: unknown) =>
      typeof value === 'string' && Array.from(value).length <= 2000,
    source: choice('text', 'voice', 'photo', 'share'),
    tags: stringList,
    status: choice('inbox', 'processed', 'archived'),
  },
  expansion: {
    idea_id: uuid,
    background: text,
    points: stringList,
    risks: text,
    next_steps: text,
    model: text,
  },
  material: {
    idea_id: uuid,
    title: text,
    url: text,
    summary: text,
    source_name: text,
    published_at: date,
  },
  step: {
    idea_id: uuid,
    title: text,
    detail: text,
    duration_min: (value: unknown) =>
      typeof value === 'number' && integer(value) && value > 0,
    sort_order: integer,
    depends_on: nullable(uuid),
    done: flag,
  },
  schedule: {
    idea_id: nullable(uuid),
    step_id: nullable(uuid),
    title: text,
    start_at: date,
    end_at: date,
    repeat_rule: nullable(text),
    completed_slots: (value: unknown) =>
      Array.isArray(value) &&
      value.every(
        (slot) => typeof slot === 'string' && /^[1-9]\d{0,8}$/.test(slot),
      ) &&
      new Set(value).size === value.length,
    priority: flag,
    done: flag,
  },
  reminder: {
    schedule_id: uuid,
    remind_at: date,
    level: flag,
    sound: nullable(text),
    snooze_min: integer,
    enabled: flag,
    native_id: nullable(text),
  },
} satisfies Record<string, Record<string, Check>>

export type SyncTable = keyof typeof fields
export const tables = Object.keys(fields) as SyncTable[]
export type SyncRow = {
  id: string
  user_id: string
  created_at: number
  updated_at: number
  deleted_at: number | null
  [field: string]: Value
}
export type SyncBatch = Record<SyncTable, SyncRow[]>

export function emptyBatch(): SyncBatch {
  return {
    idea: [],
    expansion: [],
    material: [],
    step: [],
    schedule: [],
    reminder: [],
  }
}

function object(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function readRow(table: SyncTable, input: unknown, owner: string): SyncRow {
  if (!object(input)) throw new HttpError(400, '同步记录格式错误。')
  if (input.user_id !== owner) throw new HttpError(403, '无权同步该记录。')
  const checks = {
    id: uuid,
    user_id: uuid,
    created_at: time,
    updated_at: time,
    deleted_at: nullable(time),
    ...fields[table],
  }
  const row: Record<string, Value> = {}
  for (const [field, check] of Object.entries(checks)) {
    const value = input[field]
    // 旧版没有逐次打卡字段。更新时保留已有记录，新建时使用数据库默认值。
    if (
      table === 'schedule' &&
      field === 'completed_slots' &&
      value === undefined
    )
      continue
    if (!check(value))
      throw new HttpError(400, `${table} 的 ${field} 格式错误。`)
    row[field] = value as Value
    if (
      typeof value === 'string' &&
      (field === 'id' || field.endsWith('_id') || field === 'depends_on') &&
      field !== 'native_id'
    )
      row[field] = value.toLowerCase()
  }
  // 系统分配的提醒编号只在创建它的设备上有效。
  if (table === 'reminder') row.native_id = null
  return row as SyncRow
}

export function parseBatch(input: unknown, owner: string): SyncBatch {
  if (
    !object(input) ||
    Object.keys(input).some((key) => !tables.includes(key as SyncTable))
  )
    throw new HttpError(400, '同步请求包含未知的数据表。')
  const result = emptyBatch()
  for (const table of tables) {
    if (!(table in input)) continue
    const entries = input[table]
    if (!Array.isArray(entries))
      throw new HttpError(400, `${table} 必须为数组。`)
    const ids = new Set<string>()
    for (const entry of entries) {
      const row = readRow(table, entry, owner)
      if (ids.has(row.id))
        throw new HttpError(400, `${table} 含有重复的记录编号。`)
      ids.add(row.id)
      result[table].push(row)
    }
  }
  return result
}

export function parseSince(value: unknown): number {
  if (value === undefined) return 0
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new HttpError(400, 'since 必须为非负 UTC 毫秒时间戳。')
  return Number(value)
}
