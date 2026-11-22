import { integer, text, uuid } from './fields'
import { createRepository } from './repository'

export const materialRepository = createRepository('material', {
  idea_id: uuid,
  title: text,
  url: text,
  summary: text,
  source_name: text,
  published_at: integer,
})
