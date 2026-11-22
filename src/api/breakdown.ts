import type { stepRepository } from '../repositories/step'
import { request } from './http'

type Step = NonNullable<Awaited<ReturnType<typeof stepRepository.get>>>

export function requestBreakdown(ideaId: string) {
  return request<Step[]>('/api/ai/breakdown', {
    method: 'POST',
    data: { idea_id: ideaId },
  })
}
