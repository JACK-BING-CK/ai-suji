import type { SessionUser } from '../store/auth'
import { request } from './http'

export function authenticate(phone: string, code: string) {
  return request<{ user: SessionUser; token: string }>('/api/auth/login', {
    method: 'POST',
    data: { phone, code },
  })
}
