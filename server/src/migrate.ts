import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'

config({
  path: fileURLToPath(new URL('../.env', import.meta.url)),
  quiet: true,
})

interface AppliedMigration extends RowDataPacket {
  version: number
  filename: string
  checksum: string
}

function databaseErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code
  }
  return 'UNKNOWN'
}

async function applyMigrations(db: Connection) {
  const [locks] = await db.query<RowDataPacket[]>(
    "SELECT GET_LOCK(SHA2(CONCAT('ai-suji:migrations:', DATABASE()), 256), 30) AS acquired",
  )
  if (locks[0]?.acquired !== 1) throw new Error('未取得迁移锁，请稍后重试')

  const directory = new URL('../migrations/', import.meta.url)
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.sql'))
    .sort()
  if (!files.length) throw new Error('没有找到迁移 SQL 文件')
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT UNSIGNED PRIMARY KEY, filename VARCHAR(255) NOT NULL,
    checksum CHAR(64) NOT NULL, applied_at BIGINT NOT NULL
  ) ENGINE=InnoDB`)
  const [applied] = await db.query<AppliedMigration[]>(
    'SELECT version, filename, checksum FROM schema_migrations ORDER BY version',
  )
  if (applied.length > files.length)
    throw new Error('数据库版本高于当前迁移目录')
  for (const [i, file] of files.entries()) {
    const version = i + 1
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(file)
    if (!match || Number(match[1]) !== version)
      throw new Error('迁移文件编号必须从 001 连续递增')
    const sql = (await readFile(new URL(file, directory), 'utf8')).replace(
      /\r\n/g,
      '\n',
    )
    const checksum = createHash('sha256').update(sql).digest('hex')
    const previous = applied[i]
    if (previous) {
      if (
        previous.version !== version ||
        previous.filename !== file ||
        previous.checksum !== checksum
      ) {
        throw new Error(`迁移历史与 ${file} 不一致，请还原已发布文件并新增迁移`)
      }
      continue
    }

    // MySQL DDL 会隐式提交。迁移 SQL 可重复执行，整份成功后再记录版本。
    try {
      await db.query(sql)
      await db.execute(
        'INSERT INTO schema_migrations (version, filename, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [version, file, checksum, Date.now()],
      )
      console.info(`已应用迁移 ${file}`)
    } catch (error) {
      throw new Error(`${file} 执行失败（${databaseErrorCode(error)}）`, {
        cause: error,
      })
    }
  }
  console.info(`数据库已更新至版本 ${files.length}`)
}

async function main() {
  const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME } = process.env
  if (!DB_HOST || !DB_USER || DB_PASSWORD === undefined || !DB_NAME) {
    throw new Error(
      '请在 server/.env 配置 DB_HOST、DB_USER、DB_PASSWORD 和 DB_NAME',
    )
  }
  const db = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    charset: 'utf8mb4',
    multipleStatements: true,
  })
  try {
    await applyMigrations(db)
  } finally {
    // 关闭独占连接时 MySQL 会自动释放迁移锁。
    await db.end()
  }
}

try {
  await main()
} catch (error) {
  const reason =
    error instanceof Error && !('code' in error)
      ? error.message
      : databaseErrorCode(error)
  console.error(`数据库迁移失败：${reason}`)
  process.exitCode = 1
}
