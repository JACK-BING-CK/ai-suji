import { oneOf, stringList, text, uuid } from './fields'
import { withTransaction } from './db'
import { notifyLocalWrite } from './syncQueue'
import { createRepository } from './repository'
import { characterCount, maxIdeaLength } from '../utils/ideaText'

function content(value: unknown): string {
  const original = text(value)
  if (characterCount(original) > maxIdeaLength)
    throw new Error(`想法原文最多 ${maxIdeaLength} 字`)
  return original
}

export const ideaRepository = createRepository(
  'idea',
  {
    content,
    source: oneOf('text', 'voice', 'photo', 'share'),
    tags: stringList,
    status: oneOf('inbox', 'processed', 'archived'),
  },
  { defaults: { source: 'text', tags: [], status: 'inbox' } },
)

export async function importSharedIdea(
  userId: string,
  shareId: string,
  original: string,
) {
  const owner = uuid(userId)
  const id = uuid(shareId)
  if (!original.trim()) throw new Error('分享内容为空。')
  const inserted = await withTransaction(async (db) => {
    // 原生分享可能在提交之后、确认之前被再次投递。用户已删除的想法也不能复活。
    const rows = await db.query(
      'SELECT id FROM idea WHERE user_id = ? AND id = ?',
      [owner, id],
    )
    if (rows.length) return false
    await ideaRepository.transaction.create(
      db,
      owner,
      { content: original, source: 'share', status: 'inbox' },
      id,
    )
    return true
  })
  if (inserted) notifyLocalWrite(owner)
  return inserted
}
