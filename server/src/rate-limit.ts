import type { RequestHandler } from 'express'
import { HttpError } from './errors.js'

export function limitByIp(): RequestHandler {
  const hits = new Map<string, number[]>()
  const minute = 60_000
  let nextCleanup = 0
  return (request, response, next) => {
    const now = Date.now()
    const cutoff = now - minute
    if (now >= nextCleanup) {
      for (const [ip, timestamps] of hits) {
        if (timestamps[timestamps.length - 1] <= cutoff) hits.delete(ip)
      }
      nextCleanup = now + minute
    }
    // 使用直连来源，忽略客户端自行填写的转发头。
    const ip = request.socket.remoteAddress ?? 'unknown'
    const recent = (hits.get(ip) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    )
    if (recent.length >= 60) {
      response.set(
        'Retry-After',
        String(Math.max(1, Math.ceil((recent[0] - cutoff) / 1000))),
      )
      return next(new HttpError(429, '请求过于频繁，请稍后重试。'))
    }
    recent.push(now)
    hits.set(ip, recent)
    next()
  }
}
