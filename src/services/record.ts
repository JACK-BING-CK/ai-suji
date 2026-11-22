import { ideaRepository } from '../repositories/idea'
import { characterCount, maxIdeaLength } from '../utils/ideaText'

export type DraftSource = 'text' | 'voice'

export function listInbox(owner: string) {
  return ideaRepository.list(owner, {
    where: { status: 'inbox' },
    orderBy: 'created_at',
  })
}

export async function saveDraft(
  owner: string,
  content: string,
  source: DraftSource = 'text',
) {
  if (!content.trim()) throw new Error('先写下一点想法。')
  if (characterCount(content) > maxIdeaLength)
    throw new Error('单条想法最多 2000 字。')
  // #ifdef H5
  // H5 仅用于预览，持久化写入使用手机 App 的 SQLite。
  if (typeof plus === 'undefined')
    throw new Error('请在手机 App 中保存，当前草稿可继续预览。')
  // #endif
  return ideaRepository.create(owner, { content, source, status: 'inbox' })
}

export function deleteIdea(owner: string, id: string) {
  return ideaRepository.remove(owner, id)
}
