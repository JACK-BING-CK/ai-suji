import { createHash, timingSafeEqual } from 'node:crypto'
import { HttpError } from './errors.js'

export interface SmsProvider {
  /** 正式短信服务在这里接入验证码发送。 */
  sendCode?(phone: string): Promise<void>
  verifyCode(phone: string, code: string): Promise<boolean>
}

export function debugSmsProvider(configuredCode?: string): SmsProvider {
  return {
    async verifyCode(_phone, code) {
      if (!configuredCode) throw new HttpError(503, '短信验证服务尚未配置。')
      const digest = (value: string) =>
        createHash('sha256').update(value).digest()
      return timingSafeEqual(digest(configuredCode), digest(code))
    },
  }
}
