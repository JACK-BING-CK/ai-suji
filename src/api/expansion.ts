import type { expansionRepository } from '../repositories/expansion'
import { request } from './http'

export type Expansion = NonNullable<
  Awaited<ReturnType<typeof expansionRepository.get>>
>
export type ExpansionTemplate =
  'article' | 'video' | 'product' | 'study' | 'general'

export function requestExpansion(ideaId: string, template: ExpansionTemplate) {
  return request<Expansion>('/api/ai/expand', {
    method: 'POST',
    data: { idea_id: ideaId, template },
  })
}
