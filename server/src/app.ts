import express from 'express'
import type { Pool } from 'mysql2/promise'
import { createAsrRouter, type TranscribeAudio } from './asr.js'
import { createLoginRouter, requireAuth } from './auth.js'
import { HttpError, respondError } from './errors.js'
import { limitByIp } from './rate-limit.js'
import type { SmsProvider } from './sms.js'
import { createSyncRouter } from './sync.js'
import { createExpandRouter } from './expand.js'
import type { ExpandModel } from './expand-model.js'
import { createBreakdownRouter } from './breakdown.js'
import type { GenerateModel } from './ai-generation.js'
import { createResearchRouter } from './research.js'
import type { ResearchProviders } from './research-model.js'

export function createApp(options: {
  pool?: Pool
  jwtSecret?: string
  smsProvider: SmsProvider
  expandModel?: ExpandModel
  breakdownModel?: GenerateModel
  research?: ResearchProviders
  asrModel?: TranscribeAudio
}) {
  const { pool, jwtSecret, smsProvider } = options
  const app = express()
  app.disable('x-powered-by')
  app.use(limitByIp())
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' })
  })
  if (pool) {
    app.use(
      '/api/auth',
      express.json({ limit: '4kb' }),
      createLoginRouter(pool, jwtSecret, smsProvider),
    )
  } else {
    app.post('/api/auth/login', (_request, _response, next) =>
      next(new HttpError(503, '后端尚未配置数据库。')),
    )
  }
  app.use('/api', requireAuth(pool, jwtSecret))
  if (pool) {
    app.use('/api/asr', createAsrRouter(pool, options.asrModel))
    app.use(
      '/api/ai',
      express.json({ limit: '4kb' }),
      createExpandRouter(pool, options.expandModel),
      createBreakdownRouter(pool, options.breakdownModel),
      createResearchRouter(pool, options.research),
    )
    app.use(
      '/api/sync',
      express.json({ limit: '16mb' }),
      createSyncRouter(pool),
    )
  }
  app.use((_request, _response, next) =>
    next(new HttpError(404, '接口不存在。')),
  )
  app.use(respondError)
  return app
}
