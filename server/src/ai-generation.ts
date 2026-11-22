import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ModelReply } from './chat-model.js'
import { HttpError } from './errors.js'
import { withUserTransaction } from './sync.js'

const dayMs = 24 * 60 * 60 * 1000
export const ideaIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

export async function readIdeaSource(
  db: PoolConnection,
  owner: string,
  ideaId: string,
  expected?: string,
): Promise<string> {
  const [ideas] = await db.execute<RowDataPacket[]>(
    'SELECT content FROM idea WHERE user_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
    [owner, ideaId],
  )
  if (!ideas.length)
    throw new HttpError(404, '未找到这条想法，请先同步后再试。')
  const content: string = ideas[0].content
  if (expected !== undefined && content !== expected)
    throw new HttpError(409, '原文已修改，请按最新原文重新生成。')
  return content
}

type GenerationType = 'expand' | 'breakdown' | 'research'
type ReadSource = (db: PoolConnection, expected?: string) => Promise<string>
export type GenerateModel = (
  source: string,
  retry: boolean,
  signal?: AbortSignal,
) => Promise<ModelReply>

async function reserveAttempt(
  db: PoolConnection,
  owner: string,
  type: GenerationType,
) {
  const now = Date.now()
  const start = now - (now % dayMs)
  const [usage] = await db.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS used FROM usage_log WHERE user_id = ? AND type IN ('expand','breakdown','research') AND created_at >= ? AND created_at < ?",
    [owner, start, start + dayMs],
  )
  if (Number(usage[0].used) >= 20)
    throw new HttpError(429, '今日 AI 额度已用完。', 42901)
  const id = randomUUID()
  await db.execute(
    'INSERT INTO usage_log (id,user_id,type,tokens,created_at,updated_at) VALUES (?,?,?,0,?,?)',
    [id, owner, type, now, now],
  )
  return id
}

export async function generateValidated<T>(
  pool: Pool,
  owner: string,
  type: GenerationType,
  readSource: ReadSource,
  generate: GenerateModel,
  parse: (content: string) => T,
) {
  const signal = AbortSignal.timeout(13000)
  let previousSource: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    // 账号锁内读原文和预留本次额度，提交后才等待模型返回。
    const { source, usageId } = await withUserTransaction(
      pool,
      owner,
      async (db) => {
        const source = await readSource(db, previousSource)
        if (signal.aborted)
          throw new HttpError(500, '模型响应超时，请稍后重试。')
        return { source, usageId: await reserveAttempt(db, owner, type) }
      },
    )
    previousSource = source
    const result = await generate(source, attempt > 0, signal)
    await pool.execute(
      'UPDATE usage_log SET tokens = ?, updated_at = GREATEST(?, updated_at) WHERE user_id = ? AND id = ?',
      [result.tokens, Date.now(), owner, usageId],
    )
    try {
      return { fields: parse(result.content), source, model: result.model }
    } catch (cause) {
      if (attempt === 0) continue
      const reason =
        cause instanceof Error ? cause.message : '缺少有效的 JSON 字段'
      throw new HttpError(500, '模型输出校验失败：' + reason)
    }
  }
  throw new HttpError(500, '未能生成完整结果，请重试。')
}
