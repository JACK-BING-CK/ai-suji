import { requestBreakdown } from '../api/breakdown'
import { storeGeneratedSteps } from '../repositories/sync'
import { prepareIdeaForAi } from './ai-source'
import { syncedDataRevision } from './sync'

export async function generateBreakdown(userId: string, ideaId: string) {
  const checkSession = await prepareIdeaForAi(userId, ideaId, 'breakdown')
  checkSession()
  const steps = await requestBreakdown(ideaId)
  checkSession()
  try {
    if (await storeGeneratedSteps(userId, ideaId, steps))
      syncedDataRevision.value++
  } catch (cause) {
    throw new Error('服务端已生成步骤。请重新同步以读取结果。', { cause })
  }
}
