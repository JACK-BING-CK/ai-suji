import { useAuthStore } from '../store/auth'
import { HttpError, request } from './http'

export async function transcribeAudio(filePath: string): Promise<string> {
  try {
    const auth = useAuthStore()
    auth.restore()
    const revision = auth.revision
    if (!auth.token) throw new Error('请先用手机号登录后再转写。')
    const result = await request<{ text: string }>('/api/asr', {
      filePath,
      name: 'audio',
    })
    if (auth.revision !== revision) throw new Error('账号已切换，请重新录音。')
    if (typeof result?.text !== 'string' || !result.text.trim())
      throw new HttpError('FORMAT', '未能识别文字，请重新录音。')
    return result.text
  } catch (cause) {
    if (cause instanceof Error) throw cause
    throw new Error('语音转写失败，请重试。', { cause })
  }
}
