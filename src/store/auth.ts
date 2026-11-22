import { defineStore } from 'pinia'

export interface SessionUser {
  id: string
  nickname: string
  phone?: string
}

interface Session {
  user: SessionUser
  token: string | null
  needsFullSync?: boolean
}

const sessionKey = 'ai-suji.auth.v1'
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function validSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object' || !('user' in value)) return false
  const user = value.user
  return (
    !!user &&
    typeof user === 'object' &&
    'id' in user &&
    typeof user.id === 'string' &&
    uuidPattern.test(user.id) &&
    'nickname' in user &&
    typeof user.nickname === 'string' &&
    'token' in value &&
    (value.token === null ||
      (typeof value.token === 'string' && /^\S+$/.test(value.token)))
  )
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as SessionUser | null,
    token: null as string | null,
    restored: false,
    needsFullSync: false,
    revision: 0,
  }),
  actions: {
    restore() {
      if (this.restored) return
      try {
        const saved: unknown = uni.getStorageSync(sessionKey)
        if (saved !== '' && saved != null) {
          if (!validSession(saved)) {
            this.logout()
            throw new Error('登录记录已失效，请重新登录。')
          }
          this.user = saved.user
          this.token = saved.token
          this.needsFullSync = saved.needsFullSync === true
        }
        this.restored = true
      } catch (cause) {
        throw new Error('无法恢复登录状态，请重新登录。', { cause })
      }
    },
    setSession(user: SessionUser, token: string) {
      if (!token) throw new Error('服务未返回登录凭据。')
      this.save({ user, token, needsFullSync: true })
    },
    completeFullSync() {
      if (!this.needsFullSync || !this.user || !this.token) return
      uni.setStorageSync(sessionKey, {
        user: { ...this.user },
        token: this.token,
        needsFullSync: false,
      })
      this.needsFullSync = false
    },
    save(session: Session) {
      if (!validSession(session)) throw new Error('登录信息无效，请重新登录。')
      try {
        uni.setStorageSync(sessionKey, session)
        this.$patch({ ...session, restored: true, revision: this.revision + 1 })
      } catch (cause) {
        throw new Error('登录状态保存失败，请重试。', { cause })
      }
    },
    logout() {
      // 先在内存撤销令牌，避免存储写入异常时后续请求继续携带旧身份。
      this.$patch({
        user: null,
        token: null,
        needsFullSync: false,
        restored: true,
        revision: this.revision + 1,
      })
      try {
        uni.removeStorageSync(sessionKey)
      } catch (cause) {
        throw new Error('清除设备登录记录失败，请检查设备存储后重试。', {
          cause,
        })
      }
    },
  },
})
