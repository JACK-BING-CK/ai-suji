import { ideaRepository } from '../repositories/idea'
import { characterCount, maxIdeaLength } from '../utils/ideaText'

export type Idea = NonNullable<Awaited<ReturnType<typeof ideaRepository.get>>>
export type IdeaFilterStatus = 'active' | Idea['status']

export const ideaStatusLabels = {
  inbox: '待整理',
  processed: '已处理',
  archived: '已归档',
} as const

export function listIdeas(userId: string) {
  return ideaRepository.list(userId, { orderBy: 'created_at' })
}

export function loadIdea(userId: string, id: string) {
  return ideaRepository.get(userId, id)
}

export function filterIdeas(
  rows: Idea[],
  filters: { keyword: string; tag: string; status: IdeaFilterStatus },
) {
  const needle = filters.keyword.trim().toLowerCase()
  return rows.filter((idea) => {
    const matchesStatus =
      filters.status === 'active'
        ? idea.status !== 'archived'
        : idea.status === filters.status
    return (
      matchesStatus &&
      (!filters.tag || idea.tags.includes(filters.tag)) &&
      (!needle ||
        idea.content.toLowerCase().includes(needle) ||
        idea.tags.some((tag) => tag.toLowerCase().includes(needle)))
    )
  })
}

export function listIdeaTags(rows: Idea[]) {
  const tags = new Set<string>()
  for (const idea of rows) {
    for (const tag of idea.tags) tags.add(tag)
  }
  return Array.from(tags)
}

function requireIdea(idea: Idea | null) {
  if (!idea) throw new Error('找不到这条想法，可能已删除。')
  return idea
}

export async function saveIdeaEdits(
  userId: string,
  id: string,
  content: string,
  tags: string[],
) {
  if (!content.trim()) throw new Error('原文不能为空。')
  if (characterCount(content) > maxIdeaLength)
    throw new Error('单条想法最多 2000 字。')
  return requireIdea(
    await ideaRepository.update(userId, id, {
      content,
      tags: Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))),
    }),
  )
}

export async function advanceIdeaStatus(
  userId: string,
  id: string,
  currentStatus: Idea['status'],
) {
  return requireIdea(
    await ideaRepository.update(userId, id, (idea) => {
      // 在同一事务内核对状态，避免重复点击或过期页面跳过中间状态。
      if (idea.status !== currentStatus || idea.status === 'archived') return {}
      return { status: idea.status === 'inbox' ? 'processed' : 'archived' }
    }),
  )
}
