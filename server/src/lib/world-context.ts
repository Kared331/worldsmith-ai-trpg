import type { Request, Response, NextFunction } from 'express'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { HttpError } from './http-error.js'

// ============================================================
// 世界上下文: 通过 HTTP header x-world-id 传递当前世界
// 前端每次请求带上当前世界 ID, 后端中间件解析并校验
// 所有需要世界隔离的路由通过 getWorldId(req) 获取
// ============================================================

const DEFAULT_WORLD_ID = 'default-world'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
        worldId?: string
    }
  }
}

// ============================================================
// 世界存在性缓存
// 每个请求都校验一次世界会多一次查询, 而世界增删频率极低,
// 因此用 5s TTL 缓存挡住绝大多数查询; 删除世界时主动失效。
// ============================================================
const WORLD_CACHE_TTL_MS = 5_000
const worldExistsCache = new Map<string, { ok: boolean; at: number }>()

/** 失效世界存在性缓存 (不传 id 则清空全部) —— 世界被创建/删除后调用 */
export function invalidateWorldCache(id?: string): void {
  if (id) worldExistsCache.delete(id)
  else worldExistsCache.clear()
}

async function worldExists(id: string): Promise<boolean> {
  const now = Date.now()
  const hit = worldExistsCache.get(id)
  if (hit && now - hit.at < WORLD_CACHE_TTL_MS) return hit.ok
  const world = await db.query.worlds.findFirst({
    where: eq(schema.worlds.id, id),
    columns: { id: true },
  })
  const ok = Boolean(world)
  worldExistsCache.set(id, { ok, at: now })
  return ok
}

/**
 * 世界管理接口本身不参与世界校验。
 * 否则当前世界被删 (例如另一个标签页删掉) 后连 GET /api/worlds 都会被 400,
 * 前端就失去自我修复能力。
 */
const WORLD_AGNOSTIC_PREFIXES = ['/api/worlds', '/api/health', '/api/system']

function isWorldAgnostic(path: string): boolean {
  return WORLD_AGNOSTIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

/**
 * 中间件: 解析 x-world-id header, 校验世界存在, 挂到 req.worldId
 *
 * 两个关键点:
 * 1. Express 4 不捕获 async 中间件的 rejection —— 未 catch 的异常会让请求永久挂起
 *    (前端看到无限 loading 而不是 500), 所以必须整体 try/catch。
 * 2. 未知世界**不再静默降级**为默认世界。静默降级会让写操作落到错误的世界,
 *    正是"UI 显示世界 A、数据写进世界 B"这类问题的服务端成因。
 */
export async function worldContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const headerWorldId = req.header('x-world-id')
    if (!headerWorldId) {
      req.worldId = DEFAULT_WORLD_ID
      next()
      return
    }
    if (isWorldAgnostic(req.path)) {
      // 世界管理接口: 原样带上, 不做存在性校验
      req.worldId = headerWorldId
      next()
      return
    }
    if (await worldExists(headerWorldId)) {
      req.worldId = headerWorldId
      next()
      return
    }
    next(new HttpError(400, `unknown world: ${headerWorldId}`))
  } catch (err) {
    next(err)
  }
}

/** 从请求中获取当前世界 ID (兜底默认世界) */
export function getWorldId(req: Request): string {
  return req.worldId ?? DEFAULT_WORLD_ID
}

export { DEFAULT_WORLD_ID }
