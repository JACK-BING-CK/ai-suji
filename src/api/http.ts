import { useAuthStore } from '../store/auth'

type RequestOptions =
  | Pick<UniApp.RequestOptions, 'method' | 'data'>
  | { filePath: string; name: string }
type ErrorCode = number | 'NETWORK' | 'TIMEOUT' | 'CONFIG' | 'FORMAT'

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'HttpError'
  }
}

const messages: Record<number, string> = {
  401: '登录已失效，请重新登录。',
  403: '没有访问这项数据的权限。',
  429: '请求过于频繁，请稍后再试。',
  42901: '今日 AI 额度已用完。',
  500: '服务暂时不可用，请稍后重试。',
}

let loginNavigation: Promise<void> | undefined

async function expireSession(
  auth: ReturnType<typeof useAuthStore>,
  revision: number,
) {
  // 已切换账号或已处理过这一批请求时，旧响应不能撤销当前会话。
  if (auth.revision !== revision) return
  try {
    auth.logout()
  } finally {
    const pages = getCurrentPages()
    if (pages[pages.length - 1]?.route !== 'pages/auth/login') {
      loginNavigation ??= new Promise<void>((resolve, reject) => {
        uni.reLaunch({
          url: '/pages/auth/login',
          success: () => resolve(),
          fail: reject,
        })
      }).finally(() => {
        loginNavigation = undefined
      })
      await loginNavigation
    }
  }
}

function endpoint(base: string | undefined, path: string) {
  if (!base || !/^https?:\/\/[^/?#@\s\\]+(?:\/[^?#\s\\]*)?$/i.test(base))
    throw new HttpError('CONFIG', '请先配置有效的后端地址 VITE_API_BASE_URL。')
  if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/.test(path))
    throw new HttpError('CONFIG', '接口路径无效。')
  return base.replace(/\/+$/, '') + path
}

function send(url: string, options: RequestOptions, token: string | null) {
  return new Promise<{ statusCode: number; data: unknown }>(
    (resolve, reject) => {
      const transport = {
        url,
        timeout: 15000,
        header: token ? { Authorization: 'Bearer ' + token } : {},
        fail: (reason: { errMsg: string }) => {
          const timeout = /timeout|timed out|超时/i.test(reason.errMsg)
          reject(
            new HttpError(
              timeout ? 'TIMEOUT' : 'NETWORK',
              timeout
                ? '请求超时，请稍后再试。'
                : '网络连接失败，请检查网络后重试。',
            ),
          )
        },
      }
      if ('filePath' in options) {
        uni.uploadFile({
          ...transport,
          name: options.name,
          filePath: options.filePath,
          success: ({ data, statusCode }) => {
            try {
              resolve({ statusCode, data: JSON.parse(data) })
            } catch {
              // 网关也可能返回纯文本错误，优先按 HTTP 状态处理。
              resolve({ statusCode, data: null })
            }
          },
        })
      } else {
        uni.request({
          ...transport,
          ...options,
          dataType: 'json',
          success: resolve,
        })
      }
    },
  )
}

export function createHttpClient(baseUrl: string | undefined) {
  return async function request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    try {
      const url = endpoint(baseUrl, path)
      const auth = useAuthStore()
      auth.restore()
      const revision = auth.revision
      const publicRequest = path === '/api/auth/login' || path === '/health'
      const response = await send(
        url,
        options,
        publicRequest ? null : auth.token,
      )
      const data: unknown = response.data
      const body = data && typeof data === 'object' ? data : undefined
      const code =
        body && 'code' in body && typeof body.code === 'number'
          ? body.code
          : undefined
      const message =
        body && 'msg' in body && typeof body.msg === 'string'
          ? body.msg.trim()
          : ''
      if (response.statusCode === 401 || code === 401) {
        if (publicRequest)
          throw new HttpError(
            401,
            message || '登录失败，请检查手机号和验证码。',
          )
        try {
          await expireSession(auth, revision)
        } catch (cause) {
          throw new HttpError(401, '登录已失效，请在“我的”中重新登录。', {
            cause,
          })
        }
        throw new HttpError(401, messages[401])
      }
      if (
        response.statusCode < 200 ||
        response.statusCode >= 300 ||
        (code !== undefined && code !== 0)
      ) {
        const errorCode = code || response.statusCode
        throw new HttpError(
          errorCode,
          message || messages[errorCode] || '请求失败，请稍后重试。',
        )
      }
      // SPEC 的公开健康检查直接返回状态，其余业务接口使用统一信封。
      if (
        path === '/health' &&
        body &&
        'status' in body &&
        body.status === 'ok'
      )
        return data as T
      if (code !== 0 || !body || !('data' in body))
        throw new HttpError('FORMAT', '服务响应格式异常，请稍后重试。')
      return body.data as T
    } catch (cause) {
      if (cause instanceof HttpError) throw cause
      throw new HttpError('NETWORK', '请求未能完成，请重试。', { cause })
    }
  }
}

export const request = createHttpClient(import.meta.env?.VITE_API_BASE_URL)
