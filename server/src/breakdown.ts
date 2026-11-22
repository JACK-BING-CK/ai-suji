import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
  generateValidated,
  ideaIdPattern,
  readIdeaSource,
  type GenerateModel,
} from './ai-generation.js'
import { parseBreakdown } from './breakdown-model.js'
import { HttpError } from './errors.js'
import { publish, withUserTransaction } from './sync.js'

async function readSource(
  db: PoolConnection,
  owner: string,
  ideaId: string,
  expected?: string,
) {
  const content = await readIdeaSource(db, owner, ideaId)
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT background,points,risks,next_steps FROM expansion WHERE user_id=? AND idea_id=? AND deleted_at IS NULL FOR UPDATE',
    [owner, ideaId],
  )
  const source = JSON.stringify({ content, expansion: rows[0] ?? null })
  if (expected !== undefined && source !== expected)
    throw new HttpError(409, '原文或 AI 思路已更新，请重新拆解。')
  return source
}

async function breakdown(
  pool: Pool,
  owner: string,
  ideaId: string,
  model: GenerateModel,
) {
  const { source, fields } = await generateValidated(
    pool,
    owner,
    'breakdown',
    (db, expected) => readSource(db, owner, ideaId, expected),
    model,
    parseBreakdown,
  )
  return withUserTransaction(pool, owner, async (db, cursor) => {
    await readSource(db, owner, ideaId, source)
    const [existing] = await db.execute<RowDataPacket[]>(
      'SELECT MAX(sort_order) AS last_position FROM `step` WHERE user_id=? AND idea_id=? AND deleted_at IS NULL',
      [owner, ideaId],
    )
    const start = Number(existing[0].last_position ?? -1) + 1
    if (start + fields.length - 1 > 2147483647)
      throw new HttpError(409, '步骤顺序已达上限，请先重新排序。')
    const now = Date.now()
    const ids = fields.map(() => randomUUID())
    const steps = fields.map((item, offset) => ({
      id: ids[item.index],
      user_id: owner,
      idea_id: ideaId,
      title: item.title,
      detail: item.detail,
      duration_min: item.duration_min,
      sort_order: start + offset,
      depends_on:
        item.depends_on_index === null ? null : ids[item.depends_on_index],
      done: 0,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    }))
    const stamp = Math.max(cursor + 1, now)
    for (const step of steps) {
      await db.execute(
        'INSERT INTO `step` (id,user_id,idea_id,title,detail,duration_min,sort_order,depends_on,done,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)',
        [
          step.id,
          owner,
          ideaId,
          step.title,
          step.detail,
          step.duration_min,
          step.sort_order,
          step.depends_on,
          now,
          now,
        ],
      )
      await publish(db, owner, 'step', step.id, stamp)
    }
    return steps
  })
}

export function createBreakdownRouter(pool: Pool, model?: GenerateModel) {
  const router = Router()
  router.post('/breakdown', async (request, response) => {
    const ideaId: unknown = request.body?.idea_id
    if (typeof ideaId !== 'string' || !ideaIdPattern.test(ideaId))
      throw new HttpError(400, '想法编号无效。')
    if (!model) throw new HttpError(503, '后端尚未配置大模型服务。')
    const data = await breakdown(
      pool,
      response.locals.userId,
      ideaId.toLowerCase(),
      model,
    )
    response.set('Cache-Control', 'no-store').json({ code: 0, msg: '', data })
  })
  return router
}
