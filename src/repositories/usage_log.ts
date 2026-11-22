import { nonnegativeInteger, oneOf } from './fields'
import { createRepository } from './repository'

export const usageLogRepository = createRepository('usage_log', {
  type: oneOf('expand', 'breakdown', 'research', 'asr'),
  tokens: nonnegativeInteger,
})
