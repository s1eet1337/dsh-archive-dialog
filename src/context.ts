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

/**
 * One entry of `sessionPersistence.list()`.
 *
 * DSH 0.1.5-rc.2 起官方返回的是 snapshot（`{ header, revision, sizeBytes }`）；
 * 更早的版本直接返回 header 本身。两种形状都必须兼容按旧的 header 形状去读
 * snapshot 会得到空 id，进而把有效归档误判成墓碑（面板空白 + 误清归档集合）。
 */
export type SessionListEntry = SessionHeaderLike | { header?: SessionHeaderLike }

export interface SessionPersistenceLike {
  list(): Promise<SessionListEntry[]>
  /**
   * 官方删除（DSH 0.1.5-rc.2 起）：自带写锁 / 目录租约 / generation 文件名处理。
   * 返回是否真的移除了持久化产物。老宿主没有这个方法  插件走本地回退。
   */
  delete?(sessionId: string): Promise<boolean>
  /**
   * 官方单会话快照读取（DSH 0.1.5-rc.2 起）。删除后用它复核磁盘真相：官方
   * `delete()` 只删当前 generation 文件，返回值不能单独作数。
   */
  stat?(sessionId: string): Promise<unknown>
}

/** `sessionQuery` 服务面：从日志里折取标题（v3 header 不再自带 title）。 */
export interface SessionTitleSnapshotLike {
  header?: SessionHeaderLike
  title?: unknown
}

export interface SessionQueryLike {
  readTitleSnapshots?(sessionIds: string[]): Promise<SessionTitleSnapshotLike[]>
}

export interface LiveSessionLike {
  header?: SessionHeaderLike
}

export interface SessionStoreLike {
  get(id: string): LiveSessionLike | undefined | null
  /**
   * Every Session currently attached in this process (resident != running).
   * Used to list conversations that exist in memory but are absent from any
   * Workspace account — the "未分组" rows the sidebar shows.
   */
  list?(): LiveSessionLike[]
  /**
   * The store's durability checkpoint (`SessionStore.flush`) — drains the
   * write-behind queue of ONE live session so its log is complete before we
   * delete the files. Optional on the face: hosts that predate it skip the
   * flush (deletion still proceeds, with a small resurrection risk).
   */
  flush?(session: LiveSessionLike): Promise<boolean>
}

/**
 * Minimal face of a live agent loop (`ReactLoopAgent`). Official DSH derives
 * a row's “running” state from here — `status === 'running'` — NOT from mere
 * presence in `ctx.sessions`. An idle agent (phase `idle`) is resident but is
 * not executing anything.
 */
export interface AgentPhaseLike {
  kind?: unknown
}

export interface AgentLike {
  status?: unknown
  phase?: AgentPhaseLike
  /** Clear queued work without starting a turn (public on ReactLoopAgent). */
  cancel?(cause?: unknown, options?: { keepInbox?: boolean }): unknown
}

/** Live agent registry (`ctx.agents`), keyed by session id. */
export interface AgentRegistryLike {
  get(id: string): AgentLike | undefined
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
  /**
   * 官方「永久删除后的记账清理」（DSH 0.1.5-rc.2 起）：把 id 移出工作区记账
   * **和归档集合**，并清掉注册表内部 header / 路径缓存。老宿主没有  本地回退。
   */
  forgetSession?(sessionId: string): Promise<unknown>
  /** 官方「取消归档」（当前版本还没有；官方加上后插件自动让位）。 */
  unarchiveSession?(sessionId: string): Promise<unknown>
  /**
   * 官方「归档」（DSH 0.1.5-rc.2 起）。官方实现带 sessionKnown 校验：会话既不在
   * 内存也不是持久化 header 时抛 WorkspaceUnknownSessionError，于是侧栏里那些
   * 「未分组」幽灵永远归档不掉。插件优先走官方，官方拒绝时退回下面的 setState
   * （与官方同一条持久化写入路径），保证面板里的归档动作一定生效。
   */
  archiveSession?(sessionId: string): Promise<unknown>
}

/** Minimal Cordis context surface used by the plugin. */
export interface CordisContextLike {
  effect(fn: () => (() => void) | void, label?: string): unknown
  on(event: string, listener: (...args: unknown[]) => void): (() => void) | void
  get<K extends string>(key: K): unknown
}

export interface HostContext extends CordisContextLike {}
