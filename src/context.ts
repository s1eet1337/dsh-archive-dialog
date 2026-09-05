/**
 * Structural service faces this plugin reads from the host Cordis context.
 *
 * Deliberately minimal (mirroring the convention used by ecosystem plugins):
 * only the members this plugin touches are declared, so the package builds
 * without importing `@deepseek-ai/cordis` type packages. The real runtime
 * objects satisfy these faces structurally.
 */

export interface RouteRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
}

export interface RouteResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(chunk?: unknown): unknown
}

export interface WebRouteDef {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: RouteRequest, res: RouteResponse) => void | Promise<void>
}

export interface WebServerLike {
  register(def: WebRouteDef): () => void
}

/** One persisted session header (fields are defensive: unknown shape). */
export interface SessionHeaderLike {
  id?: unknown
  sessionId?: unknown
  cwd?: unknown
  title?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

export interface SessionPersistenceLike {
  list(): Promise<SessionHeaderLike[]>
}

export interface LiveSessionLike {
  header?: SessionHeaderLike
}

export interface SessionStoreLike {
  get(id: string): LiveSessionLike | undefined | null
}

/**
 * The WorkspaceRegistry public surface this plugin uses:
 *  - `archivedSessionIds` getter
 *  - `list()` → entities (each carries `id`, `path`, `title`, `record`)
 *  - `requireState()` / `setState()` — the registry's own durable write path
 *    (this is exactly what the product's `archiveSession` uses internally)
 *  - `enqueueOperation()` — serializes our mutation with the registry's own
 *    operation chain when present
 *  - entity `detachSession()` — removes a session from workspace accounting
 *
 * 写数据绝不绕过注册表（官方 invariant 会因此失败），全部走这些公开方法。
 */
export interface WorkspaceEntityLike {
  id: unknown
  path?: unknown
  title?: unknown
  record?: { sessionIds?: unknown[] }
  detachSession?(sessionId: string): Promise<void>
}

export interface WorkspaceStateLike {
  initialized?: boolean
  workspaceIds: unknown[]
  archivedSessionIds: unknown[]
  pendingMutation?: unknown
  [key: string]: unknown
}

export interface WorkspaceRegistryLike {
  readonly archivedSessionIds: readonly unknown[]
  list(): WorkspaceEntityLike[]
  requireState(): WorkspaceStateLike
  setState(state: WorkspaceStateLike): Promise<void>
  enqueueOperation?<T>(op: () => Promise<T>): Promise<T>
}

/** Minimal Cordis context surface used by the plugin. */
export interface CordisContextLike {
  effect(fn: () => (() => void) | void, label?: string): unknown
  on(event: string, listener: (...args: unknown[]) => void): (() => void) | void
  get<K extends string>(key: K): unknown
}

export interface HostContext extends CordisContextLike {}
