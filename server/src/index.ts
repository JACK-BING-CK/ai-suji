import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import mysql from 'mysql2/promise'
import { createApp } from './app.js'
import { debugSmsProvider } from './sms.js'
import { createExpandModel } from './expand-model.js'
import { createBreakdownModel } from './breakdown-model.js'
import { createResearchProviders } from './research-model.js'
import { createTranscriber } from './asr.js'

config({
  path: fileURLToPath(new URL('../.env', import.meta.url)),
  quiet: true,
})
const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, JWT_SECRET, SMS_DEBUG_CODE } =
  process.env
const pool =
  DB_HOST && DB_USER && DB_PASSWORD !== undefined && DB_NAME
    ? mysql.createPool({
        host: DB_HOST,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        charset: 'utf8mb4',
      })
    : undefined
const environment =
  process.env.NODE_ENV ??
  (process.argv.includes('--dev') ? 'development' : 'production')
const app = createApp({
  pool,
  expandModel: createExpandModel(process.env),
  breakdownModel: createBreakdownModel(process.env),
  research: createResearchProviders(process.env),
  asrModel: createTranscriber(process.env),
  jwtSecret: JWT_SECRET,
  smsProvider: debugSmsProvider(
    ['development', 'test'].includes(environment) ? SMS_DEBUG_CODE : undefined,
  ),
})
const port = Number(process.env.PORT ?? 3000)
app.listen(port, (error) => {
  if (error) {
    console.error('后端启动失败', error.message)
    process.exitCode = 1
    return
  }
  console.info(`AI速记后端已启动 http://localhost:${port}`)
})
