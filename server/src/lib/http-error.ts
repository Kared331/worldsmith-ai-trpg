import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'

// ============================================================
// HTTP 错误处理: 统一错误类 + async 包装 + 全局中间件
// route handler 抛出 HttpError 或 ZodError, 由中间件统一序列化
// ============================================================

/** 业务错误, 携带 HTTP 状态码 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 包装 async route handler, 自动捕获 rejection 转到 next(err) */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/** 全局错误处理中间件: 统一 JSON 错误响应格式 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Zod 校验错误 → 400
  if (err instanceof ZodError) {
    res.status(400).json({
      error: err.issues[0]?.message ?? 'validation failed',
    })
    return
  }

  // 业务错误 → 自定义状态码
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }

  // 未知错误 → 500, 不泄露内部细节
  console.error('[worldsmith] unhandled error:', err)
  res.status(500).json({ error: 'internal server error' })
}
