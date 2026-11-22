import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import {
  generateValidated,
  readIdeaSource,
  ideaIdPattern,
} from './ai-generation.js'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import {
  isExpandTemplate,
  parseExpansion,
  type ExpandModel,
  type ExpandResult,
  type ExpandTemplate,
} from './expand-model.js'
import { HttpError } from './errors.js'
import { publish, withUserTransaction } from './sync.js'

function saveExpansion(
  pool: Pool,
  owner: string,
  ideaId: string,
  source: string,
  fields: ExpandResult,
  model: string,
) {
  return withUserTransaction(pool, owner, async (db, cursor) => {
    // 模型请求在事务外执行。原文被修改或删除时丢弃这次结果。
    await readIdeaSource(db, owner, ideaId, source)
    const [existing] = await db.execute<RowDataPacket[]>(
      'SELECT id,created_at,updated_at FROM expansion WHERE user_id = ? AND idea_id = ? AND deleted_at IS NULL FOR UPDATE',
      [owner, ideaId],
    )
    const previous = existing[0]
    const id: string = previous?.id ?? randomUUID()
    const now = Math.max(Date.now(), Number(previous?.updated_at ?? 0) + 1)
    const createdAt = Number(previous?.created_at ?? now)
    const values = [
      fields.background,
      JSON.stringify(fields.points),
      fields.risks,
      fields.next_steps,
      model,
    ]
    if (previous) {
      await db.execute(
        'UPDATE expansion SET background=?,points=?,risks=?,next_steps=?,model=?,updated_at=? WHERE user_id=? AND id=?',
        [...values, now, owner, id],
      )
    } else {
      await db.execute(
        'INSERT INTO expansion (id,user_id,idea_id,created_at,updated_at,background,points,risks,next_steps,model) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id, owner, ideaId, createdAt, now, ...values],
      )
    }
    await publish(db, owner, 'expansion', id, Math.max(cursor + 1, now))
    return {
      id,
      user_id: owner,
      idea_id: ideaId,
      created_at: createdAt,
      updated_at: now,
      deleted_at: null,
      ...fields,
      model,
    }
  })
}

async function expand(
  pool: Pool,
  owner: string,
  ideaId: string,
  template: ExpandTemplate,
  generate: ExpandModel,
) {
  const { source, fields, model } = await generateValidated(
    pool,
    owner,
    'expand',
    (db, expected) => readIdeaSource(db, owner, ideaId, expected),
    (content, retry, signal) => generate(content, template, retry, signal),
    parseExpansion,
  )
  return saveExpansion(pool, owner, ideaId, source, fields, model)
}

export function createExpandRouter(pool: Pool, model?: ExpandModel) {
  const router = Router()
  router.post('/expand', async (request, response) => {
    const ideaId: unknown = request.body?.idea_id
    const template: unknown = request.body?.template
    if (
      typeof ideaId !== 'string' ||
      !ideaIdPattern.test(ideaId) ||
      !isExpandTemplate(template)
    )
      throw new HttpError(400, '想法编号或思路模板无效。')
    if (!model) throw new HttpError(503, '后端尚未配置大模型服务。')
    const data = await expand(
      pool,
      response.locals.userId,
      ideaId.toLowerCase(),
      template,
      model,
    )
    response.set('Cache-Control', 'no-store').json({ code: 0, msg: '', data })
  })
  return router
}
