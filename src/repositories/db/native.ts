export type SqlValue = string | number | null
export type SqlRow = Record<string, SqlValue>

export interface SqlExecutor {
  execute(sql: string, params?: readonly SqlValue[]): Promise<void>
  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>
}

const database = { name: 'ai-suji', path: '_doc/ai-suji.db' }

function bridge(): PlusSqlite {
  // Android、iOS 由 App-Plus 提供 SQLite，网页端没有这个原生模块。
  // #ifdef APP-PLUS
  if (typeof plus !== 'undefined' && plus.sqlite) return plus.sqlite
  // #endif
  throw new Error('无法使用本地数据库，请在启用 SQLite 模块的 App 中运行。')
}

function nativeCall<T>(
  message: string,
  invoke: (callbacks: {
    success(value: T): void
    fail(reason: unknown): void
  }) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const fail = (cause: unknown) => reject(new Error(message, { cause }))
    try {
      invoke({ success: resolve, fail })
    } catch (error) {
      fail(error)
    }
  })
}

function literal(value: SqlValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') throw new Error('本地数据库参数类型无效。')

  // 5+ 桥只接收完整 SQL。将文本编码为 UTF-8 十六进制，保留引号、换行和空字节。
  const bytes = encodeURIComponent(value).replace(
    /%([0-9A-F]{2})|./g,
    (token, byte?: string) => {
      return byte ?? token.charCodeAt(0).toString(16).padStart(2, '0')
    },
  )
  return `CAST(X'${bytes}' AS TEXT)`
}

function bind(sql: string, params: readonly SqlValue[] = []): string {
  if (!params.length) return sql
  // 仓储只在值的位置写 ?；替换发生在原始模板上，不会再次解析参数内容。
  const parts = sql.split('?')
  if (parts.length !== params.length + 1)
    throw new Error('本地数据库参数数量不匹配。')
  return params.reduce<string>(
    (result, value, i) => result + literal(value) + parts[i + 1],
    parts[0],
  )
}

export function open(): Promise<void> {
  const sqlite = bridge()
  if (sqlite.isOpenDatabase(database)) return Promise.resolve()
  return nativeCall(
    '本地数据库打开失败，请检查设备存储空间后重试。',
    (callbacks) => sqlite.openDatabase({ ...database, ...callbacks }),
  )
}

export function close(): Promise<void> {
  const sqlite = bridge()
  if (!sqlite.isOpenDatabase(database)) return Promise.resolve()
  return nativeCall('本地数据库连接无法关闭，请重新启动 App。', (callbacks) =>
    sqlite.closeDatabase({ name: database.name, ...callbacks }),
  )
}

export function transaction(
  operation: 'begin' | 'commit' | 'rollback',
): Promise<void> {
  return nativeCall('本地数据库事务操作失败。', (callbacks) =>
    bridge().transaction({ name: database.name, operation, ...callbacks }),
  )
}

export const executor: SqlExecutor = {
  execute(sql, params) {
    return nativeCall('本地数据写入失败，请检查数据后重试。', (callbacks) =>
      bridge().executeSql({
        name: database.name,
        sql: [bind(sql, params)],
        ...callbacks,
      }),
    )
  },
  query(sql, params) {
    return nativeCall('本地数据读取失败，请重试。', (callbacks) =>
      bridge().selectSql({
        name: database.name,
        sql: bind(sql, params),
        ...callbacks,
      }),
    )
  },
}
