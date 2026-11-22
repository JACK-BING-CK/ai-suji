import { flag, integer, nullable, positiveInteger, text, uuid } from './fields'
import { createRepository } from './repository'

export const stepRepository = createRepository(
  'step',
  {
    idea_id: uuid,
    title: text,
    detail: text,
    duration_min: positiveInteger,
    sort_order: integer,
    depends_on: nullable(uuid),
    done: flag,
  },
  { defaults: { depends_on: null, done: 0 } },
)
