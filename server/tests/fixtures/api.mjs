import { randomBytes, randomInt } from 'node:crypto'
import { once } from 'node:events'
import { createApp } from '../../src/app.ts'
import { debugSmsProvider } from '../../src/sms.ts'

// HTTP 测试用内存记录账号与用量，供应商响应由用例注入。
export async function startApi(t, options = {}) {
  const accounts = new Map()
  const usage = []
  const pool = {
    async execute(sql, params) {
      if (sql.startsWith('INSERT INTO usage_log')) {
        const [id, user_id, created_at, updated_at] = params
        usage.push({
          id,
          user_id,
          type: 'asr',
          tokens: 0,
          created_at,
          updated_at,
        })
        return [{ affectedRows: 1 }, []]
      }
      if (sql.startsWith('UPDATE usage_log')) {
        const [tokens, now, owner, id] = params
        const row = usage.find(
          (item) => item.id === id && item.user_id === owner,
        )
        if (row)
          Object.assign(row, {
            tokens,
            updated_at: Math.max(row.updated_at, now),
          })
        return [{ affectedRows: row ? 1 : 0 }, []]
      }
      if (sql.startsWith('INSERT INTO `user`')) {
        const [id, phone, nickname, avatar_url] = params
        if (!accounts.has(phone))
          accounts.set(phone, { id, phone, nickname, avatar_url, status: 1 })
        return [[], []]
      }
      const user = sql.includes('WHERE phone = ?')
        ? accounts.get(params[0])
        : Array.from(accounts.values()).find((user) => user.id === params[0])
      return [user?.status === 1 ? [user] : [], []]
    },
  }
  const code = String(randomInt(100000, 1000000))
  const app = createApp({
    ...options,
    pool,
    jwtSecret: randomBytes(32).toString('hex'),
    smsProvider: debugSmsProvider(code),
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const login = (phone, value = code) =>
    globalThis.fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code: value }),
    })
  return { base, accounts, login, usage }
}
