import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import {
  ideaIdPattern,
  readIdeaSource,
  generateValidated,
} from './ai-generation.js'
import { HttpError } from './errors.js'
import {
  searchSources,
  parseMaterials,
  type ResearchProviders,
} from './research-model.js'
import type { SearchResult } from './research-search.js'
import { publish, withUserTransaction } from './sync.js'

async function research(
  pool: Pool,
  owner: string,
  ideaId: string,
  providers: ResearchProviders,
) {
  let sources = new Map<string, SearchResult>()
  const deadline = AbortSignal.timeout(14_000)
  const { source, fields: candidates } = await generateValidated(
    pool,
    owner,
    'research',
    (db, expected) => readIdeaSource(db, owner, ideaId, expected),
    async (idea, retry, signal = AbortSignal.timeout(13_000)) => {
      // 关键词在本机提取，正常只需调用一次模型；格式重试沿用同一批原始搜索结果。
      if (!retry) sources = await searchSources(idea, providers.search, signal)
      if (!sources.size) return { content: '[]', model: '', tokens: 0 }
      return providers.summarize(
        JSON.stringify({ idea, results: [...sources.values()] }),
        retry,
        signal,
      )
    },
    (content) => parseMaterials(content, sources),
  )
  const verify = providers.verifyLink
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(3_000)])
  const reachable = verify
    ? await Promise.all(candidates.map((row) => verify(row.url, signal)))
    : candidates.map(() => true)
  const materials = candidates.filter((_, i) => reachable[i])
  if (candidates.length && !materials.length && signal.aborted)
    throw new HttpError(503, '原文链接验证超时，请稍后再找题材。')
  return withUserTransaction(pool, owner, async (db, cursor) => {
    await readIdeaSource(db, owner, ideaId, source)
    if (!materials.length) return []
    const [existing] = await db.execute<RowDataPacket[]>(
      `SELECT id,user_id,idea_id,title,url,summary,source_name,published_at,created_at,updated_at,deleted_at FROM material
       WHERE user_id=? AND idea_id=? AND url IN (${materials.map(() => '?').join(',')})
       ORDER BY (deleted_at IS NULL), updated_at`,
      [owner, ideaId, ...materials.map((row) => row.url)],
    )
    const byUrl = new Map(existing.map((row) => [row.url as string, row]))
    const now = Date.now()
    const stamp = Math.max(now, cursor + 1)
    const results = []
    for (const fields of materials) {
      const saved = byUrl.get(fields.url)
      if (saved) {
        // 重复搜索保留已收藏的同一条记录，也尊重用户之前的删除。
        if (saved.deleted_at === null) results.push(saved)
        continue
      }
      const id = randomUUID()
      await db.execute(
        'INSERT INTO material (id,user_id,idea_id,title,url,summary,source_name,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [
          id,
          owner,
          ideaId,
          fields.title,
          fields.url,
          fields.summary,
          fields.source_name,
          fields.published_at,
          now,
          now,
        ],
      )
      await publish(db, owner, 'material', id, stamp)
      results.push({
        id,
        user_id: owner,
        idea_id: ideaId,
        ...fields,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
    }
    return results
  })
}

export function createResearchRouter(
  pool: Pool,
  providers?: ResearchProviders,
) {
  const router = Router()
  router.post('/research', async (request, response) => {
    const ideaId: unknown = request.body?.idea_id
    if (typeof ideaId !== 'string' || !ideaIdPattern.test(ideaId))
      throw new HttpError(400, '想法编号无效。')
    if (!providers) throw new HttpError(503, '后端尚未配置素材生成服务。')
    const data = await research(
      pool,
      response.locals.userId,
      ideaId.toLowerCase(),
      providers,
    )
    response.set('Cache-Control', 'no-store').json({ code: 0, msg: '', data })
  })
  return router
}
