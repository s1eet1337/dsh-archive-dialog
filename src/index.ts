/**
 * dsh-archive-dialog host plugin.
 *
 * 在 `/plugins/dsh-archive-dialog` 下注册三个同源 JSON 路由：
 *   GET  /plugins/dsh-archive-dialog/archived → 已归档会话列表
 *   POST /plugins/dsh-archive-dialog/restore  { sessionId } → 恢复（取消归档）
 *   POST /plugins/dsh-archive-dialog/delete   { sessionId } → 彻底删除
 *
 * 客户端（左侧栏按钮 + 悬浮面板）通过这些路由读数据、执行恢复/删除；
 * 恢复/删除会写入工作区注册表 → 官方 `domain/changed` feed 自动刷新所有
 * 前端界面，无需手动刷新页面。
 *
 * `/api/*` 由桌面端自带控制器保留，插件一律挂 `/plugins/<name>`（生态约定）。
 */
import { deleteSession, listArchived, restoreSession } from './host/archive.ts'
import { projectionCacheRoot, resolveDshHome, sessionsRoot } from './host/paths.ts'
import { isTrustedApiRequest, readJsonBody, writeJson } from './host/wire.ts'
import type {
  HostContext,
  RouteRequest,
  RouteResponse,
  SessionPersistenceLike,
  SessionStoreLike,
  WebServerLike,
  WorkspaceRegistryLike,
} from './context.ts'

/** Plugin identity for the cordis.patch.yml row (and the client bundle id). */
export const name = 'dsh-archive-dialog'

/** webServer 硬依赖：loader 会等服务出现后再 apply，路由注册不会和启动顺序赛跑。
 *  其余服务按需懒读（bundle 行常早于兄弟服务行挂载）。 */
export const inject: string[] = ['webServer']

const API_PREFIX = '/plugins/dsh-archive-dialog'
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9-]+$/

export function apply(ctx: HostContext): void {
  const readWeb = (): WebServerLike | undefined => (ctx.get('webServer') ?? ctx.get('httpServer')) as WebServerLike | undefined
  const readRegistry = (): WorkspaceRegistryLike | undefined => ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  const readPersistence = (): SessionPersistenceLike | undefined => ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
  const readSessions = (): SessionStoreLike | undefined => ctx.get('sessions') as SessionStoreLike | undefined

  const requireRegistry = (): WorkspaceRegistryLike => {
    const registry = readRegistry()
    if (registry === undefined) throw new Error('workspaceRegistry 服务不可用')
    return registry
  }
  const requirePersistence = (): SessionPersistenceLike => {
    const persistence = readPersistence()
    if (persistence === undefined) throw new Error('sessionPersistence 服务不可用')
    return persistence
  }

  async function readSessionId(req: RouteRequest): Promise<string> {
    const body = (await readJsonBody(req)) as { sessionId?: unknown } | undefined
    const id = body?.sessionId
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) throw new Error('无效的 sessionId')
    return id
  }

  async function route(req: RouteRequest, res: RouteResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const pathname = url.pathname

    if (pathname === `${API_PREFIX}/archived` && req.method === 'GET') {
      const rows = await listArchived(requireRegistry(), readPersistence(), readSessions())
      writeJson(res, 200, { ok: true, data: { rows } }, { 'cache-control': 'no-store' })
      return
    }

    if (pathname === `${API_PREFIX}/restore` && req.method === 'POST') {
      const sessionId = await readSessionId(req)
      const result = await restoreSession(requireRegistry(), sessionId)
      writeJson(res, 200, { ok: true, data: result }, { 'cache-control': 'no-store' })
      return
    }

    if (pathname === `${API_PREFIX}/delete` && req.method === 'POST') {
      const sessionId = await readSessionId(req)
      const home = resolveDshHome()
      const result = await deleteSession(
        {
          registry: requireRegistry(),
          persistence: requirePersistence(),
          liveSessions: readSessions(),
          sessionsRoot: sessionsRoot(home),
          projectCacheRoot: projectionCacheRoot(home),
        },
        sessionId,
      )
      writeJson(res, 200, { ok: true, data: result }, { 'cache-control': 'no-store' })
      return
    }

    writeJson(res, 404, { ok: false, error: 'not found' }, { 'cache-control': 'no-store' })
  }

  // ---- 挂载路由：webServer 出现即挂（幂等），服务晚到时通过 internal/service 补挂 ----
  let mounted = false
  const mountRoutes = (): void => {
    if (mounted) return
    const web = readWeb()
    if (web === undefined) return
    mounted = true
    ctx.effect(
      () =>
        web.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req, res) => {
            if (!isTrustedApiRequest(req)) {
              writeJson(res, 403, { ok: false, error: 'forbidden' }, { 'cache-control': 'no-store' })
              return
            }
            if (req.method !== 'GET' && req.method !== 'POST') {
              writeJson(res, 405, { ok: false, error: 'method not allowed' }, { 'cache-control': 'no-store' })
              return
            }
            try {
              await route(req, res)
            } catch (err) {
              writeJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) }, { 'cache-control': 'no-store' })
            }
          },
        }),
      'dsh-archive-dialog: routes',
    )
  }
  mountRoutes()
  const disposeServiceWait = ctx.on('internal/service', (svc: unknown) => {
    if (svc === 'webServer' || svc === 'httpServer') mountRoutes()
  })
  if (typeof disposeServiceWait === 'function') ctx.effect(disposeServiceWait, 'dsh-archive-dialog: late route mount')
}
