import { HttpError } from './errors.js'

export interface ModelReply {
  content: string
  model: string
  tokens: number
}

export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function nonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function tokensUsed(usage: unknown): number {
  if (!object(usage)) return 0
  const validCount = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2147483647
  if (validCount(usage.total_tokens)) return usage.total_tokens
  if (validCount(usage.prompt_tokens) && validCount(usage.completion_tokens)) {
    const sum = usage.prompt_tokens + usage.completion_tokens
    if (validCount(sum)) return sum
  }
  return 0
}

function providerError(status: number, payload: unknown): HttpError {
  // 仅匹配固定的上游错误标识，不转发可能含有密钥或原文的 message。
  const error = object(payload) && object(payload.error) ? payload.error : {}
  const codes = [error.code, error.type]
  if (
    status === 402 ||
    codes.includes('insufficient_quota') ||
    codes.includes('billing_hard_limit_reached')
  )
    return new HttpError(
      500,
      '模型服务账户余额不足或已达到消费上限，请检查模型服务的账单。',
    )
  if (status === 429)
    return new HttpError(500, '模型服务暂时限流，请稍后重试。')
  if (status === 401 || codes.includes('invalid_api_key'))
    return new HttpError(500, '模型服务鉴权失败，请检查后端模型密钥。')
  if (
    status === 403 ||
    codes.includes('model_not_found') ||
    codes.includes('model_access_denied')
  )
    return new HttpError(
      500,
      '当前模型不可用或无权访问，请检查后端模型名称和访问权限。',
    )
  return new HttpError(
    500,
    '模型服务未能完成请求，请检查后端模型配置或稍后重试。',
  )
}

export function createChatModel(env: NodeJS.ProcessEnv) {
  const key = env.LLM_API_KEY?.trim()
  const base = env.LLM_BASE_URL?.trim()
  if (!key || !base || !URL.canParse(base)) return undefined
  const endpoint = new URL(base)
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    return undefined
  const path = endpoint.pathname.replace(/\/+$/, '')
  endpoint.pathname = path.endsWith('/chat/completions')
    ? path
    : path + '/chat/completions'
  const model = env.LLM_MODEL?.trim() || 'default'
  return async (
    instructions: string,
    content: string,
    format: 'json_object' | 'text',
    signal = AbortSignal.timeout(13_000),
  ) => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content },
          ],
          response_format: { type: format },
          stream: false,
        }),
      })
      // 上游封装损坏也交给同一次格式重试处理；错误提示不携带原文和响应体。
      const payload: unknown = await response.json().catch((cause: unknown) => {
        if (cause instanceof SyntaxError) return null
        throw cause
      })
      if (!response.ok) throw providerError(response.status, payload)
      const body = object(payload) ? payload : {}
      const choice: unknown = Array.isArray(body.choices)
        ? body.choices[0]
        : null
      const message =
        object(choice) && object(choice.message) ? choice.message : {}
      return {
        content: typeof message.content === 'string' ? message.content : '',
        model: nonemptyText(body.model) ? body.model.trim() : model,
        tokens: tokensUsed(body.usage),
      }
    } catch (cause) {
      if (cause instanceof HttpError) throw cause
      throw new HttpError(
        500,
        signal.aborted
          ? '模型生成超时，请稍后重试。'
          : '无法连接模型服务，请稍后重试。',
      )
    }
  }
}
