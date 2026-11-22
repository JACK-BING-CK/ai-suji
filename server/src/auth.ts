import { randomUUID } from 'node:crypto'
import { Router, type RequestHandler } from 'express'
import { jwtVerify, SignJWT } from 'jose'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { HttpError } from './errors.js'
import type { SmsProvider } from './sms.js'

const issuer = 'ai-suji'
const audience = 'ai-suji:app'
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

function signingKey(secret: string | undefined) {
  if (!secret?.trim()) throw new HttpError(503, '后端尚未配置 JWT_SECRET。')
  return Buffer.from(secret)
}

export function createLoginRouter(
  pool: Pool,
  secret: string | undefined,
  sms: SmsProvider,
) {
  const router = Router()
  router.post('/login', async (request, response, next) => {
    try {
      const phone =
        typeof request.body?.phone === 'string'
          ? request.body.phone.trim().replace(/^\+86/, '')
          : ''
      const code: unknown = request.body?.code
      if (!/^(?:1[3-9]\d{9}|\+[1-9]\d{6,14})$/.test(phone))
        throw new HttpError(400, '请输入有效的手机号。')
      if (
        typeof code !== 'string' ||
        !code ||
        Buffer.byteLength(code) > 128 ||
        !(await sms.verifyCode(phone, code))
      )
        throw new HttpError(400, '验证码无效，请重新输入。')
      const key = signingKey(secret)
      const now = Date.now()
      // 唯一手机号约束保证两台设备首次同时登录也只生成一个账号。
      await pool.execute(
        'INSERT INTO `user` (id, phone, nickname, avatar_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON DUPLICATE KEY UPDATE id = id',
        [randomUUID(), phone, '用户' + phone.slice(-4), '', now, now],
      )
      // 首次认证尚无 user_id，只有通过验证码验证后才按手机号查找账户。
      const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT id, phone, nickname, avatar_url, status FROM `user` WHERE phone = ? AND status = 1 AND deleted_at IS NULL',
        [phone],
      )
      const user = rows[0]
      if (!user) throw new HttpError(403, '此账号已注销或无法登录。')
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.id)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('30d')
        .sign(key)
      response
        .set('Cache-Control', 'no-store')
        .json({ code: 0, msg: '', data: { token, user } })
    } catch (cause) {
      next(cause)
    }
  })
  return router
}

export function requireAuth(
  pool: Pool | undefined,
  secret: string | undefined,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const token = request.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      if (!token) throw new HttpError(401, '请先登录。')
      const key = signingKey(secret)
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        issuer,
        audience,
        typ: 'JWT',
        requiredClaims: ['sub', 'exp'],
      }).catch(() => {
        throw new HttpError(401, '登录已失效，请重新登录。')
      })
      if (!payload.sub || !uuid.test(payload.sub))
        throw new HttpError(401, '登录身份无效，请重新登录。')
      if (!pool) throw new HttpError(503, '后端尚未配置数据库。')
      const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT id FROM `user` WHERE id = ? AND status = 1 AND deleted_at IS NULL',
        [payload.sub],
      )
      if (!rows.length) throw new HttpError(401, '此登录账号已失效。')
      response.locals.userId = payload.sub
      next()
    } catch (cause) {
      next(cause)
    }
  }
}
