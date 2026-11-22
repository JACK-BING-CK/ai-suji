import type { ErrorRequestHandler } from 'express'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = status,
  ) {
    super(message)
  }
}

export const respondError: ErrorRequestHandler = (
  cause,
  _request,
  response,
  next,
) => {
  if (response.headersSent) return next(cause)
  // 解析器、数据库及外部服务异常可能带有原始请求内容，仅返回预设说明。
  const known =
    cause instanceof HttpError
      ? cause
      : cause?.type === 'entity.parse.failed'
        ? new HttpError(400, '请求内容必须是有效的 JSON。')
        : cause?.type === 'entity.too.large'
          ? new HttpError(413, '请求内容过大，请分批提交。')
          : new HttpError(500, '服务暂时不可用，请稍后重试。')
  response
    .status(known.status)
    .json({ code: known.code, msg: known.message, data: null })
}
