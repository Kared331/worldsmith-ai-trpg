import type { Request, Response, NextFunction } from 'express'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'

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

/** 中间件: 解析 x-world-id header, 校验世界存在, 挂到 req.worldId */
export async function worldContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const headerWorldId = req.header('x-world-id')
  if (headerWorldId) {
    // 校验世界存在
    const world = await db.query.worlds.findFirst({
      where: eq(schema.worlds.id, headerWorldId),
    })
    if (world) {
      req.worldId = world.id
    } else {
      req.worldId = DEFAULT_WORLD_ID
    }
  } else {
    req.worldId = DEFAULT_WORLD_ID
  }
  next()
}

/** 从请求中获取当前世界 ID (兜底默认世界) */
export function getWorldId(req: Request): string {
  return req.worldId ?? DEFAULT_WORLD_ID
}

export { DEFAULT_WORLD_ID }
