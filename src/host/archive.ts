/**
 * 归档面板的业务逻辑（host 侧，可离线测试）。
 *
 * 数据真相：DSH 工作区注册表（`ctx.workspaceRegistry`）全局状态里的
 * `archivedSessionIds`。归档本身由 DSH 自带功能完成；本插件负责：
 *   1. listArchived  — 已归档会话列表（拼接标题 / 工作区 / 时间）
 *   2. restoreSession — 把 id 从归档集合移除（前端会通过 domain/changed
 *      feed 自动刷新，无需刷新页面）
 *   3. deleteSession — 彻底删除：先落盘（如驻留且空闲）→ 移出工作区记账 +
 *      删除会话日志文件（带安全检查）+ 清理投影缓存
 *   4. purgeStaleArchived — 清理「墓碑」：归档集合里既无日志也无活动会话的
 *      残留 id（例如之前删到一半的残留、外部删掉日志的归档项）
 *
 * 所有写操作都走注册表的公开方法（setState / detachSession / enqueueOperation），
 * 绝不直接改 storages/workspace.json —— 官方 invariant 明确禁止绕过注册表。
 *
 * 「正在打开」不等于「正在运行」：DSH 里只要本进程打开过一个会话，它的 agent
 * loop 就会一直驻留（idle）到进程退出。真正在执行的判断依据是 agent 的活动
 * 状态（status/phase），与官方列表的 running 语义一致。删除只拒绝真正在执行
 * （或后台维护）的会话。
 *
 * 删除不取消归档：DSH 会把归档集合里的会话从所有分组隐藏。删除后把 id 留在
 * 归档集合里当「墓碑」是最保险的做法——即使会话的 agent 还驻留（僵尸）或客户端
 * 列表还没刷新，侧栏也绝不会把它显示成「未分组」。面板对无日志的墓碑行不展示，
 * 墓碑由 purgeStaleArchived 在下次打开面板 / 删除后顺带清理（活着的僵尸跳过，
 * 等它随 DSH 退出消失后即可清掉）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AgentLike,
  AgentRegistryLike,
  SessionHeaderLike,
  SessionListEntry,
  SessionPersistenceLike,
  SessionQueryLike,
  SessionStoreLike,
  WorkspaceEntityLike,
  WorkspaceRegistryLike,
} from '../context.ts'
import { encodeSegment, projectKey } from './paths.ts'

/**
 * Whether an id is safe to use as one storage path segment.
 *
 * 会话 id 并不都是 `session-<uuid>` 的形状：子代理会话与老存储用的是裸 uuid
 * （例如 d5b8e663-…）。旧路由强制 /^session-[A-Za-z0-9-]+$/，这类未分组对话在
 * 恢复 / 删除时会被直接判成「无效的 sessionId」。这里只排除真正危险的东西：
 * 空串、路径分隔符、路径穿越、控制字符与超长 id。
 */
export function isSafeSessionId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  if (raw.length === 0 || raw.length > 200) return false
  if (!/^[A-Za-z0-9]/.test(raw)) return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)
}

export interface ArchivedRow {
  sessionId: string
  title: string
  workspaceId: string | null
  workspaceTitle: string | null
  workspacePath: string | null
  updatedAt: string | null
  createdAt: string | null
}

export interface RestoreResult {
  restored: boolean
  archivedSessionIds: string[]
}

export interface DeleteResult {
  deleted: boolean
  filesDeleted: boolean
  detachedWorkspaceId: string | null
}

interface HeaderFields {
  id: string
  cwd?: string
  title?: string
  createdAt?: string
  updatedAt?: string
}

/** Normalize a persisted header timestamp (epoch-ms number or ISO string) to ISO. */
function toIso(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return undefined
}

function headerFields(header: SessionHeaderLike | undefined): HeaderFields | undefined {
  if (header === undefined) return undefined
  const id = String(header.id ?? header.sessionId ?? '')
  if (id === '') return undefined
  return {
    id,
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
    title: typeof header.title === 'string' && header.title.trim() !== '' ? header.title : undefined,
    createdAt: toIso(header.createdAt),
    updatedAt: toIso(header.updatedAt),
  }
}

/**
 * 提取 `sessionPersistence.list()` 返回项里的 header。
 *
 * 0.1.5-rc.2 起官方返回 snapshot（`{ header, revision, sizeBytes }`），更早版本
 * 直接返回 header。旧代码只按 header 解析 snapshot，得到空 id  有效归档被当成
 * 墓碑：面板空白、purge 误清归档集合。两种形状都必须支持。
 */
export function snapshotHeader(entry: SessionListEntry | undefined): SessionHeaderLike | undefined {
  if (entry === undefined || entry === null || typeof entry !== 'object') return undefined
  const wrapped = (entry as { header?: unknown }).header
  if (wrapped !== undefined && wrapped !== null && typeof wrapped === 'object') {
    return wrapped as SessionHeaderLike
  }
  return entry as SessionHeaderLike
}

/** 装载持久化列表：返回 id  header 映射，并区分「装载失败」与「确实为空」。 */
async function loadHeaders(
  persistence: SessionPersistenceLike | undefined,
): Promise<{ loaded: boolean; headers: Map<string, SessionHeaderLike> }> {
  const headers = new Map<string, SessionHeaderLike>()
  if (persistence === undefined) return { loaded: false, headers }
  try {
    for (const entry of await persistence.list()) {
      const header = snapshotHeader(entry)
      if (header === undefined) continue
      const id = String(header.id ?? header.sessionId ?? '')
      if (id !== '') headers.set(id, header)
    }
    return { loaded: true, headers }
  } catch {
    // 持久化暂不可用：列表回退为展示全部（调用方按 loaded=false 处理）
    return { loaded: false, headers }
  }
}

/** 会话日志文件名：session.jsonl / session.jsonl.zstd / session.vN.jsonl(.zstd)。 */
const SESSION_LOG_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/

export function isSessionLogFile(name: string): boolean {
  return SESSION_LOG_FILE.test(name)
}

function encodeSegmentSafe(sessionId: string): string | undefined {
  try {
    return encodeSegment(sessionId)
  } catch {
    return undefined
  }
}

/**
 * 扫描 <sessionsRoot> 下的所有 <projectKey>/<encodeSegment(sessionId)> 目录。
 * 返回「编码后的目录名  绝对路径列表」，作为持久化列表之外的磁盘真相。
 */
export function scanStoredSessionDirs(sessionsRoot: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  let projects: import('node:fs').Dirent[]
  try {
    projects = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(sessionsRoot, project.name)
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(projectDir, entry.name)
      const list = found.get(entry.name)
      if (list === undefined) found.set(entry.name, [dir])
      else list.push(dir)
    }
  }
  return found
}

/**
 * 定位一个会话的日志目录：先用 header.cwd 推出的规范路径（与持久化层同算法），
 * 定位不到再全量扫描。这样即使 header 缺失 / cwd 变化 / 列表形状变化也不会漏删。
 */
export function locateSessionDirs(sessionsRoot: string, cwd: string | undefined, sessionId: string): string[] {
  const encoded = encodeSegmentSafe(sessionId)
  if (encoded === undefined) return []
  const found: string[] = []
  if (cwd !== undefined && cwd.trim() !== '') {
    const candidate = join(sessionsRoot, projectKey(cwd), encoded)
    if (existsSync(candidate)) found.push(candidate)
  }
  if (found.length === 0) {
    for (const dir of scanStoredSessionDirs(sessionsRoot).get(encoded) ?? []) found.push(dir)
  }
  return found
}

/** 列出所有已归档会话。日志已不存在的「墓碑」行不展示（可删不可恢复，交给
 *  purgeStaleArchived 清理）；持久化暂不可用时回退为展示全部（标题回退 sessionId）。 */
export interface ArchivedListOptions {
  /** 可选标题来源：v3 header 不带 title，向 sessionQuery 折取日志里的标题。 */
  query?: SessionQueryLike
}

export async function listArchived(
  registry: WorkspaceRegistryLike,
  persistence: SessionPersistenceLike | undefined,
  liveSessions: SessionStoreLike | undefined,
  options: ArchivedListOptions = {},
): Promise<ArchivedRow[]> {
  const archived = [...registry.archivedSessionIds].map(String)

  // headers 装载成功与否需要区分：失败时应展示全部（旧行为），避免误伤。
  const { loaded: headersLoaded, headers } = await loadHeaders(persistence)

  const workspaceBySession = new Map<string, WorkspaceEntityLike>()
  for (const w of registry.list()) {
    for (const id of w.record?.sessionIds ?? []) workspaceBySession.set(String(id), w)
  }

  const rows: ArchivedRow[] = []
  for (const sessionId of archived) {
    // 墓碑行（有归档 id 但日志已不存在）：面板不展示
    if (headersLoaded && !headers.has(sessionId)) continue

    const header = headerFields(headers.get(sessionId))
    const live = liveSessions?.get?.(sessionId)
    const liveHeader = headerFields(live?.header)
    const title = header?.title ?? liveHeader?.title ?? sessionId
    const ws = workspaceBySession.get(sessionId)
    const createdAt = header?.createdAt ?? liveHeader?.createdAt ?? null
    const updatedAt = header?.updatedAt ?? liveHeader?.updatedAt ?? createdAt
    rows.push({
      sessionId,
      title,
      workspaceId: ws === undefined ? null : String(ws.id),
      workspaceTitle: typeof ws?.title === 'string' ? ws.title : null,
      workspacePath: typeof ws?.path === 'string' ? ws.path : null,
      updatedAt,
      createdAt,
    })
  }

  return applyQueryTitles(rows, options.query)
}

/**
 * v3 header 只有 id / createdAt / cwd，没有 title：向 `sessionQuery` 折取日志标题，
 * 失败就保留 sessionId 兜底（绝不因为没有标题而隐藏这一行）。原地修改并返回。
 */
export async function applyQueryTitles(rows: ArchivedRow[], query: SessionQueryLike | undefined): Promise<ArchivedRow[]> {
  if (query?.readTitleSnapshots === undefined) return rows
  const missing = rows.filter((row) => row.title === row.sessionId).map((row) => row.sessionId)
  if (missing.length === 0) return rows
  try {
    const snapshots = await query.readTitleSnapshots(missing)
    const titles = new Map<string, string>()
    for (const snapshot of snapshots ?? []) {
      const id = String(snapshot?.header?.id ?? snapshot?.header?.sessionId ?? '')
      const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : ''
      if (id !== '' && title !== '') titles.set(id, title)
    }
    for (const row of rows) {
      const title = titles.get(row.sessionId)
      if (title !== undefined) row.title = title
    }
  } catch {
    // 标题折取失败不影响列表本身
  }
  return rows
}

/**
 * 列出「未分组」对话：既没有被归档、也没有被任何工作区记账的会话。
 *
 * 这正是侧栏里那一撮删不掉的行。它们通常来自两种历史：
 *   1. 账目被 detach 过（工作区被删 / 会话被移出）但日志还在磁盘上；
 *   2. 本进程打开过、持久化产物已不在的驻留会话（官方 delete 走 persistence，
 *      找不到产物就抛 session/not-found，于是永远删不掉）。
 *
 * 候选集合 = 持久化列表 ∪ 本进程驻留会话；再排除已归档、已被工作区记账、
 * 以及子代理会话（与官方 sessionVisible 一致：子代理从不作为顶层行展示）。
 */
export async function listUngrouped(
  registry: WorkspaceRegistryLike,
  persistence: SessionPersistenceLike | undefined,
  liveSessions: SessionStoreLike | undefined,
  options: ArchivedListOptions = {},
): Promise<ArchivedRow[]> {
  const archived = new Set([...registry.archivedSessionIds].map(String))
  const accounted = new Set<string>()
  for (const w of registry.list()) {
    for (const id of w.record?.sessionIds ?? []) accounted.add(String(id))
  }

  const { loaded: headersLoaded, headers } = await loadHeaders(persistence)
  // 驻留会话（内存里活着）同样算「侧栏可见」，即便持久化列表里已经没有它。
  const liveHeaders = new Map<string, SessionHeaderLike>()
  try {
    for (const session of liveSessions?.list?.() ?? []) {
      const header = session?.header
      const id = String(header?.id ?? header?.sessionId ?? '')
      if (id !== '') liveHeaders.set(id, header as SessionHeaderLike)
    }
  } catch {
    // 驻留列表读不到时退化为「只列持久化会话」，不影响功能
  }

  const candidates = new Set<string>()
  if (headersLoaded) for (const id of headers.keys()) candidates.add(id)
  for (const id of liveHeaders.keys()) candidates.add(id)

  const rows: ArchivedRow[] = []
  for (const sessionId of candidates) {
    if (archived.has(sessionId) || accounted.has(sessionId)) continue
    const header = headers.get(sessionId)
    const liveHeader = liveHeaders.get(sessionId)
    const raw = (header ?? liveHeader) as { origin?: unknown } | undefined
    if (raw === undefined) continue
    if (String(raw.origin ?? '') === 'subagent') continue
    const fields = headerFields(header)
    const liveFields = headerFields(liveHeader)
    const createdAt = fields?.createdAt ?? liveFields?.createdAt ?? null
    rows.push({
      sessionId,
      title: fields?.title ?? liveFields?.title ?? sessionId,
      workspaceId: null,
      workspaceTitle: null,
      workspacePath: null,
      updatedAt: fields?.updatedAt ?? liveFields?.updatedAt ?? createdAt,
      createdAt,
    })
  }

  // 新的在前（ISO 字符串可直接比较；再按 id 保证稳定）。
  rows.sort((left, right) => {
    const a = left.updatedAt ?? left.createdAt ?? ''
    const b = right.updatedAt ?? right.createdAt ?? ''
    if (a === b) return left.sessionId < right.sessionId ? -1 : 1
    return a < b ? 1 : -1
  })

  return applyQueryTitles(rows, options.query)
}

export interface ArchiveResult {
  archived: boolean
  archivedSessionIds: string[]
}

/**
 * 把一个会话加进归档集合（DSH 会把归档会话从所有分组，含「未分组」里隐藏）。
 *
 * 官方优先：宿主提供 workspaceRegistry.archiveSession 时先走官方（自带操作链）。
 * 但官方实现要求会话 sessionKnown：侧栏那些「未分组」残影既不在内存、也不在
 * 持久化列表时会被它抛 WorkspaceUnknownSessionError 拒绝 —— 用户报的「无法归档」
 * 正是这条路径。官方拒绝后退回注册表自己的 setState（与官方 archiveSession
 * 完全同一条持久化写入路径，绝不绕过注册表），归档动作因此一定生效。
 */
export async function archiveSession(registry: WorkspaceRegistryLike, sessionId: string): Promise<ArchiveResult> {
  const state = registry.requireState()
  const current = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds.map(String) : []
  if (current.includes(sessionId)) return { archived: false, archivedSessionIds: current }

  if (typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(sessionId)
      const after = registry.requireState()
      return {
        archived: Array.isArray(after.archivedSessionIds) && after.archivedSessionIds.map(String).includes(sessionId),
        archivedSessionIds: Array.isArray(after.archivedSessionIds) ? after.archivedSessionIds.map(String) : [],
      }
    } catch {
      // 官方拒绝（会话不在持久化层 / 不在内存）：走下面的注册表回退路径。
    }
  }

  await addToArchive(registry, sessionId)
  const after = registry.requireState()
  const ids = Array.isArray(after.archivedSessionIds) ? after.archivedSessionIds.map(String) : []
  return { archived: ids.includes(sessionId), archivedSessionIds: ids }
}

/**
 * 归档集合的本地写入（注册表 setState，与官方 archiveSession 同一条链）。
 * 幂等：已在集合里就不写。
 */
async function addToArchive(registry: WorkspaceRegistryLike, sessionId: string): Promise<void> {
  const run = registry.enqueueOperation !== undefined ? registry.enqueueOperation.bind(registry) : (op: () => Promise<void>) => op()
  await run(async () => {
    const fresh = registry.requireState()
    const freshIds = Array.isArray(fresh.archivedSessionIds) ? fresh.archivedSessionIds.map(String) : []
    if (freshIds.includes(sessionId)) return
    await registry.setState({ ...fresh, archivedSessionIds: [...freshIds, sessionId] })
  })
}

/* ------------------------------------------------------------------ *
 * 「本进程删过」的记忆
 *
 * 删除会在归档集合里留下「墓碑」把会话藏起来。而 DSH 前端的会话列表是**异步**
 * 刷新的：墓碑要是当场就被 purgeStaleArchived 清掉，前端会先收到「取消归档」
 * 推送、再等列表刷新，中间那一瞬它仍持有这一行 → 侧栏把这一行渲染回「未分组」，
 * 于是用户看到「删完一闪而过」。这就是之前那个闪烁的成因。
 *
 * 因此本进程删过的 id 一律不再当墓碑清理：等 DSH 重启（进程结束，这些 id 也
 * 真的不可能再出现在任何列表里）后由 purge 自然回收。有界集合，避免长跑膨胀。
 * ------------------------------------------------------------------ */
const MAX_RECENT_DELETES = 512
const recentlyDeleted = new Set<string>()

/** 记住这个 id 是本进程删掉的（墓碑暂时不许清理）。 */
export function markRecentlyDeleted(sessionId: string): void {
  recentlyDeleted.delete(sessionId)
  recentlyDeleted.add(sessionId)
  while (recentlyDeleted.size > MAX_RECENT_DELETES) {
    const oldest = recentlyDeleted.values().next().value
    if (oldest === undefined) break
    recentlyDeleted.delete(oldest)
  }
}

export function isRecentlyDeleted(sessionId: string): boolean {
  return recentlyDeleted.has(sessionId)
}

/** 仅测试用：忘掉「本进程删过」的记忆，让墓碑重新可被 purge 回收。 */
export function clearRecentlyDeleted(): void {
  recentlyDeleted.clear()
}

export interface PurgeDeps {
  registry: WorkspaceRegistryLike
  persistence: SessionPersistenceLike
  /** `ctx.sessions`：活着的僵尸会话不清（要等它随 DSH 退出消失）。 */
  sessions?: SessionStoreLike
  /** 提供后启用磁盘二次证伪：日志目录仍在的归档 id 一律不清（防持久化列表异常时误删）。 */
  sessionsRoot?: string
}

/**
 * 清理归档集合里的「墓碑」：日志已不存在且当前也没有活动会话的归档 id。
 * 幂等、可反复调用；没有可清理项时不做任何写入。返回清理的数量。
 */
export async function purgeStaleArchived(deps: PurgeDeps): Promise<number> {
  const archived = [...deps.registry.archivedSessionIds].map(String)
  if (archived.length === 0) return 0
  let known: Set<string>
  try {
    known = new Set(
      (await deps.persistence.list())
        .map((entry) => {
          const header = snapshotHeader(entry)
          return header === undefined ? '' : String(header.id ?? header.sessionId ?? '')
        })
        .filter((id) => id !== ''),
    )
  } catch {
    return 0 // 持久化暂不可用：跳过，别误删
  }
  // 磁盘二次证伪：列表形状变化 / 根目录错位导致 known 为空时，只要日志目录还在，
  // 就不能把这条归档 id 当墓碑清掉否则会话会立刻冒出来变成「未分组」。
  const storedDirs = deps.sessionsRoot === undefined ? undefined : scanStoredSessionDirs(deps.sessionsRoot)
  const stale = archived.filter((id) => {
    if (known.has(id)) return false
    if (deps.sessions?.get?.(id) != null) return false
    // 本进程刚删掉的：墓碑必须留着，否则前端列表还没刷新就会把这一行闪回「未分组」
    if (isRecentlyDeleted(id)) return false
    const encoded = encodeSegmentSafe(id)
    if (storedDirs !== undefined && encoded !== undefined && storedDirs.has(encoded)) return false
    return true
  })
  if (stale.length === 0) return 0

  const run = deps.registry.enqueueOperation !== undefined ? deps.registry.enqueueOperation.bind(deps.registry) : (op: () => Promise<void>) => op()
  await run(async () => {
    const fresh = deps.registry.requireState()
    const freshIds = Array.isArray(fresh.archivedSessionIds) ? fresh.archivedSessionIds.map(String) : []
    const next = freshIds.filter((id) => !stale.includes(id))
    if (next.length === freshIds.length) return
    await deps.registry.setState({ ...fresh, archivedSessionIds: next })
  })
  return stale.length
}

/**
 * 磁盘真相复核：官方 `delete()` 的返回值不能单独采信。
 *
 * DSH 的 JSONL 持久化只 `rm` **当前 generation** 的文件（`session.v3.jsonl.zstd`）：
 *   - 从未迁移到 v3 的老会话（只有 `session.jsonl.zstd`）→ rm 命中不存在的 v3 路径
 *     → 抛 ENOENT → 返回 false；DSH 自带删除于是报 `session/not-found`；
 *   - 已迁移但留着旧 generation 的会话 → 返回 true，可旧文件还在，会话仍在
 *     持久化列表里 —— 删完刷新一下又回来了。
 * 所以官方删完必须复核一次：只有确实查不到这个 id 才算成功；能查到就落回插件
 * 自己的整目录删除。读不到（stat 抛错）时以官方返回值为准，不再保守重试。
 */
async function artifactStillPresent(persistence: SessionPersistenceLike, sessionId: string): Promise<boolean> {
  if (typeof persistence.stat === 'function') {
    try {
      return (await persistence.stat(sessionId)) !== undefined
    } catch {
      return false
    }
  }
  try {
    for (const entry of await persistence.list()) {
      const header = snapshotHeader(entry)
      if (header !== undefined && String(header.id ?? header.sessionId ?? '') === sessionId) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 官方删完只剩一个空目录时顺手清理。只删**确实为空**的目录，任何异常都不影响
 * 删除结果（例如 session-9619c149 那类历史空壳）。
 */
async function removeEmptySessionDir(sessionsRoot: string, sessionId: string): Promise<void> {
  const encoded = encodeSegmentSafe(sessionId)
  if (encoded === undefined) return
  for (const dir of scanStoredSessionDirs(sessionsRoot).get(encoded) ?? []) {
    try {
      if (readdirSync(dir).length === 0) await rm(dir, { recursive: true, force: true })
    } catch {
      // 空目录清理失败不影响删除结果
    }
  }
}

/** 清理插件侧的 per-record 投影缓存（失败不致命）。官方删除路径与本地路径共用。 */
async function removeProjectionCache(projectCacheRoot: string, sessionId: string): Promise<void> {
  const encoded = encodeSegmentSafe(sessionId)
  if (encoded === undefined) return
  const cacheFile = join(projectCacheRoot, `${encoded}.json`)
  if (!existsSync(cacheFile)) return
  try {
    await rm(cacheFile, { force: true })
  } catch {
    // 缓存清理失败不影响删除结果
  }
}

/** 从归档集合移除一个会话（恢复）。幂等：已不在集合时直接返回。 */
export async function restoreSession(registry: WorkspaceRegistryLike, sessionId: string): Promise<RestoreResult> {
  const state = registry.requireState()
  const ids = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds.map(String) : []
  if (!ids.includes(sessionId)) return { restored: false, archivedSessionIds: ids }

  // 官方优先：官方一旦提供 unarchiveSession 就直接走官方链路（自带操作锁与校验）。
  if (typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(sessionId)
    const official = registry.requireState()
    return {
      restored: true,
      archivedSessionIds: Array.isArray(official.archivedSessionIds) ? official.archivedSessionIds.map(String) : [],
    }
  }

  // 回退：尽量并入注册表自己的操作链（与官方 archiveSession 同一条链），避免并发交错
  const run = registry.enqueueOperation !== undefined ? registry.enqueueOperation.bind(registry) : (op: () => Promise<void>) => op()
  await run(async () => {
    const fresh = registry.requireState()
    const freshIds = Array.isArray(fresh.archivedSessionIds) ? fresh.archivedSessionIds.map(String) : []
    if (!freshIds.includes(sessionId)) return
    await registry.setState({ ...fresh, archivedSessionIds: freshIds.filter((id) => id !== sessionId) })
  })

  const after = registry.requireState()
  return {
    restored: true,
    archivedSessionIds: Array.isArray(after.archivedSessionIds) ? after.archivedSessionIds.map(String) : [],
  }
}

export interface DeleteDeps {
  registry: WorkspaceRegistryLike
  persistence: SessionPersistenceLike
  /** `ctx.sessions`：驻留在内存里的会话（打开过就存在，即使完全空闲）。 */
  sessions?: SessionStoreLike
  /** `ctx.agents`：活动 agent 注册表。用它区分「真的在执行」和「只是驻留」。 */
  agents?: AgentRegistryLike
  sessionsRoot: string
  projectCacheRoot: string
}

/**
 * Agent 的实际活动状态：
 *  - `running` / `maintenance` → 正在写日志，不能删；
 *  - `idle` → 驻留在内存但没有任何执行，可安全删除；
 *  - `unknown` → agents 注册表不可用（拿不到状态）。
 */
export type AgentActivity = 'running' | 'maintenance' | 'idle' | 'unknown'

export function agentActivity(agents: AgentRegistryLike | undefined, sessionId: string): AgentActivity {
  const agent = agents?.get?.(sessionId)
  if (agent === undefined) return 'unknown'
  const kind = typeof agent.phase?.kind === 'string' ? agent.phase.kind : undefined
  const status = typeof agent.status === 'string' ? agent.status : undefined
  if (kind === 'running' || status === 'running') return 'running'
  if (kind === 'maintenance') return 'maintenance'
  return 'idle'
}

/**
 * 彻底删除一个会话：
 *   0. **官方优先，但返回值必须复核**：宿主提供 sessionPersistence.delete +
 *      workspaceRegistry.forgetSession（DSH 0.1.5-rc.2 起）、且会话不在内存里
 *      驻留时，先走官方链路（写锁 / 目录租约 / generation 文件名交给官方），
 *      删完用 `stat` 复核磁盘：**官方只删当前 generation 文件**，未迁移到 v3 的
 *      老会话它会直接返回 false（DSH 自带删除于是报 `session/not-found`），迁移过
 *      但留了旧 generation 的会话则返回 true 却删不干净——两种情况都落到下面的
 *      本地整目录删除。老宿主 / 驻留会话同样直接走下面。
 *   1. 只有 agent 真正在执行（running/maintenance）才拒绝；已打开但空闲的
 *      会话允许删除——先把内存事件落盘（flush），确保删除后不会有残留
 *      事件在退出时把日志重新写回（“删除后复活”）。
 *   2. （本地路径）定位并删除会话日志目录，安全检查：目录里必须存在
 *      session[.vN].jsonl[.zstd]。此时会话仍在归档集合里（对 UI 隐藏），
 *      这一步失败会抛错且尚未动注册表，因此会话保持归档状态，
 *      绝不会被漏成「未分组」孤儿；
 *   3. 清理投影缓存（失败不致命）；
 *   4. 移出工作区记账（幂等）后**确保归档集合里留下墓碑**（首次归档也一并补上）。
 *      删除会话日志并不足以让它从侧栏消失：驻留 agent 还在内存里，DSH 的
 *      `sessionVisible` 只看归档集合。未分组对话删完若不补墓碑，侧栏会立刻再冒出
 *      「未分组」残影——这正是用户报的「删不掉」。墓碑由 purgeStaleArchived 在
 *      会话随 DSH 退出消失后回收；
 *   5. 对空闲 agent 清空收件箱（cancel），避免任何排队消息把它唤醒。
 */
/**
 * 删除收尾（官方路径与本地路径共用）：清投影缓存 → 移出工作区记账 → **留下归档墓碑**
 * 并登记「本进程删过」→ 清空闲 agent 的收件箱。
 *
 * 这里刻意**不调用官方 forgetSession**：它会顺手把 id 移出归档集合，也就是解除隐藏；
 * 而前端会话列表是异步刷新的，解除隐藏会让这一行在列表更新前闪回「未分组」。记账我们
 * 自己用 detachSession 清（与官方同样的公开写入路径），归档标记留作墓碑。
 */
async function finishDelete(
  deps: DeleteDeps,
  sessionId: string,
  agent: AgentLike | undefined,
  filesDeleted: boolean,
): Promise<DeleteResult> {
  // 1. 清理投影缓存（per-record 文档：<cacheRoot>/<sessionId>.json；失败不致命）
  await removeProjectionCache(deps.projectCacheRoot, sessionId)

  // 2. 移出工作区记账（幂等）。这一步失败会抛错，此时会话仍在归档集合里（对 UI 隐藏），
  //    可以从面板重试删除。
  let detachedWorkspaceId: string | null = null
  for (const w of deps.registry.list()) {
    const accounted = (w.record?.sessionIds ?? []).some((id) => String(id) === sessionId)
    if (!accounted) continue
    if (typeof w.detachSession !== 'function') throw new Error('当前版本不支持从工作区移除会话（detachSession 缺失）')
    await w.detachSession(sessionId)
    detachedWorkspaceId = String(w.id)
  }

  // 3. 墓碑：确保 id 留在归档集合里，DSH 会把它从所有分组（含「未分组」）隐藏。
  //    删掉日志并不足以让一行从侧栏消失：驻留 agent 还在内存里、前端列表也还没刷新。
  try {
    await addToArchive(deps.registry, sessionId)
  } catch {
    // 墓碑写失败不改变「日志已删除」的事实
  }
  markRecentlyDeleted(sessionId)

  // 4. 空闲 agent 收尾：清空收件箱，防止删除后还有排队消息把它唤醒并写日志。
  if (agent !== undefined && typeof agent.cancel === 'function') {
    try {
      agent.cancel()
    } catch {
      // 收件箱清理失败不影响删除结果
    }
  }

  return { deleted: true, filesDeleted, detachedWorkspaceId }
}

export async function deleteSession(deps: DeleteDeps, sessionId: string): Promise<DeleteResult> {
  const live = deps.sessions?.get?.(sessionId)
  const agent: AgentLike | undefined = deps.agents?.get?.(sessionId)
  const activity = agentActivity(deps.agents, sessionId)

  if (activity === 'running') {
    throw new Error('该对话正在执行中，无法删除。请等待回复完成，或先点击“停止”后再试。')
  }
  if (activity === 'maintenance') {
    throw new Error('该对话正在进行后台维护，无法删除。请稍等片刻后再试。')
  }
  if (live !== undefined && live !== null && activity === 'unknown') {
    // agents 注册表不可用（极旧宿主）：拿不到真实状态，保守拒绝驻留会话。
    throw new Error('该对话当前处于打开状态且无法确认其运行状态，无法删除。请重启 DSH 后再试。')
  }

  // 打开但空闲：先落盘再删文件。若 flush 失败说明耐久写入有问题，此刻删除
  // 可能把未写全的日志丢掉（或之后被写回），因此中止并保持归档原状。
  if (live !== undefined && live !== null && typeof deps.sessions?.flush === 'function') {
    try {
      await deps.sessions.flush(live)
    } catch (err) {
      throw new Error(
        `无法删除：该对话的日志尚未完成落盘（${err instanceof Error ? err.message : String(err)}），请稍后再试。`,
      )
    }
  }

  // 官方优先：宿主提供 sessionPersistence.delete、且会话**不在内存里驻留**时，先走官方
  // （写锁 / 目录租约 / generation 文件名交给官方）。收尾统一走 finishDelete：记账自己
  // detach、归档标记留作墓碑——不调 forgetSession，避免它解除隐藏造成「闪回未分组」。
  //
  // 驻留（idle 僵尸）会话不走官方：插件拿不到官方的 disposeOwned，官方删完 agent 还在
  // 内存里，直接走下面的手工链路 + 墓碑策略。
  const resident = live !== undefined && live !== null
  const officialDelete = deps.persistence.delete?.bind(deps.persistence)
  if (!resident && officialDelete !== undefined) {
    // 官方 delete 只删当前 generation 文件，返回值不可单独采信（见 artifactStillPresent）：
    // 没迁移到 v3 的老会话它会返回 false（DSH 自带删除于是报 session/not-found），
    // 迁移过但留着旧 generation 的会话它返回 true 却删不干净。删完必须复核磁盘真相，
    // 只有确实查不到这个 id 才收工；否则落到下面的本地整目录删除。
    // 官方**抛错**时原样上抛（例如「unmaterialized create is live」这类安全拒绝，
    // 绝不能改走本地文件删除绕开它）；只有官方明确「没有删掉」时才回退。
    const officialRemoved = await officialDelete(sessionId)
    if (officialRemoved && !(await artifactStillPresent(deps.persistence, sessionId))) {
      await removeEmptySessionDir(deps.sessionsRoot, sessionId)
      return finishDelete(deps, sessionId, agent, true)
    }
  }

  const { headers } = await loadHeaders(deps.persistence)
  const header = headers.get(sessionId)
  const fields = headerFields(header)
  const cwd = fields?.cwd !== undefined && fields.cwd.trim() !== '' ? fields.cwd : undefined

  // 1. 先定位并删除日志目录：会话此刻仍在归档集合里（对 UI 隐藏）。这一步失败会抛错，
  //    且尚未动注册表，所以会话保持归档状态，不会变成「未分组」。
  //    定位顺序：header.cwd 推导路径  全量磁盘扫描（header 缺失 / cwd 变化也能命中）。
  //    日志文件名白名单覆盖所有 generation：session.v3.jsonl.zstd 等。
  const candidates = locateSessionDirs(deps.sessionsRoot, cwd, sessionId)
  if (candidates.length > 1) {
    throw new Error(`找到多个同名会话日志目录，拒绝删除：${candidates.join(' | ')}`)
  }
  const sessionDir = candidates[0]
  let filesDeleted = false
  if (sessionDir !== undefined) {
    const names = readdirSync(sessionDir)
    if (!names.some((name) => isSessionLogFile(name))) {
      throw new Error(`安全校验未通过：目录 ${sessionDir} 中未找到会话日志文件，拒绝删除`)
    }
    await rm(sessionDir, { recursive: true, force: true })
    filesDeleted = true
  } else if (header !== undefined) {
    // 持久化层说会话存在，两种定位方式却都找不到目录：状态不一致。此时必须拒绝，
    // 不能静默只清记账（那会把残留日志变成侧栏里的「未分组」幽灵）。
    throw new Error(
      `未找到会话日志目录：会话日志仍存在但目录定位失败，拒绝删除（sessionsRoot=${deps.sessionsRoot}）`,
    )
  }
  // header 缺失且磁盘上也没有目录 = 日志早已不存在  继续下面的记账清理（留墓碑）

  // 2-4. 收尾：清缓存 → 移出工作区记账 → 留归档墓碑（标记「本进程删过」）→ 清收件箱。
  return finishDelete(deps, sessionId, agent, filesDeleted)
}
