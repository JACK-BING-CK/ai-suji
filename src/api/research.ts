import { request } from './http'
import type { materialRepository } from '../repositories/material'

export type Material = NonNullable<
  Awaited<ReturnType<typeof materialRepository.get>>
>

export function requestMaterials(ideaId: string) {
  return request<Material[]>('/api/ai/research', {
    method: 'POST',
    data: { idea_id: ideaId },
  })
}
