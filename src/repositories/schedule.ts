import { flag, integer, nullable, stringList, text, uuid } from './fields'
import { createRepository } from './repository'

export const scheduleRepository = createRepository(
  'schedule',
  {
    idea_id: nullable(uuid),
    step_id: nullable(uuid),
    title: text,
    start_at: integer,
    end_at: integer,
    repeat_rule: nullable(text),
    completed_slots: stringList,
    priority: flag,
    done: flag,
  },
  {
    defaults: {
      idea_id: null,
      step_id: null,
      repeat_rule: null,
      completed_slots: [],
      priority: 0,
      done: 0,
    },
  },
)

export type ScheduleRow = Awaited<ReturnType<typeof scheduleRepository.create>>
