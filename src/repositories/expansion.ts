import { stringList, text, uuid } from './fields'
import { createRepository } from './repository'

export const expansionRepository = createRepository(
  'expansion',
  {
    idea_id: uuid,
    background: text,
    points: stringList,
    risks: text,
    next_steps: text,
    model: text,
  },
  { latestBy: 'idea_id' },
)
