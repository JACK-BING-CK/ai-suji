import { requestExpansion, type ExpansionTemplate } from '../api/expansion'
import { expansionRepository } from '../repositories/expansion'
import { storeGeneratedExpansion } from '../repositories/sync'
import { prepareIdeaForAi } from './ai-source'
import { syncedDataRevision } from './sync'

export type { Expansion, ExpansionTemplate } from '../api/expansion'

export async function loadExpansion(userId: string, ideaId: string) {
  const [saved] = await expansionRepository.list(userId, {
    where: { idea_id: ideaId },
  })
  return saved ?? null
}

export async function generateExpansion(
  userId: string,
  ideaId: string,
  template: ExpansionTemplate,
) {
  const checkSession = await prepareIdeaForAi(userId, ideaId, 'expand')
  checkSession()
  const result = await requestExpansion(ideaId, template)
  checkSession()
  if (
    result?.user_id !== userId ||
    result.idea_id !== ideaId ||
    result.deleted_at !== null
  )
    throw new Error('返回的思路与当前想法不符，请重试。')
  if (await storeGeneratedExpansion(userId, { ...result }))
    syncedDataRevision.value++
  const saved = await loadExpansion(userId, ideaId)
  checkSession()
  if (!saved) throw new Error('思路已发生变化，请刷新后重试。')
  return saved
}
