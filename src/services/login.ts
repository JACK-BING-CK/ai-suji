import { authenticate } from '../api/auth'
import { claimLegacyData, hasLegacyData } from '../repositories/sync'
import { useAuthStore } from '../store/auth'

export { hasLegacyData }

export async function loginWithPhone(
  phone: string,
  code: string,
  importLegacy: boolean,
) {
  const auth = useAuthStore()
  const revision = auth.revision
  const session = await authenticate(phone.trim(), code.trim())
  if (auth.revision !== revision) throw new Error('账号已切换，请重新登录。')
  if (!session?.user?.id || !session.token)
    throw new Error('登录信息不完整，请重试。')
  if (importLegacy) await claimLegacyData(session.user.id)
  auth.setSession(session.user, session.token)
}
