import { flag, integer, nullable, text, uuid } from './fields'
import { createRepository } from './repository'

export const reminderRepository = createRepository(
  'reminder',
  {
    schedule_id: uuid,
    remind_at: integer,
    level: flag,
    sound: nullable(text),
    snooze_min: integer,
    enabled: flag,
    native_id: nullable(text),
  },
  {
    defaults: {
      level: 0,
      sound: null,
      snooze_min: 10,
      enabled: 1,
      native_id: null,
    },
  },
)
