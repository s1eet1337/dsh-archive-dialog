import type { AgentRegistryLike, SessionHeaderLike, SessionListEntry, SessionPersistenceLike, SessionQueryLike, SessionStoreLike, WorkspaceRegistryLike } from '../context.ts';
/**
 * Whether an id is safe to use as one storage path segment.
 *
 * 会话 id 并不都是 `session-<uuid>` 的形状：子代理会话与老存储用的是裸 uuid
 * （例如 d5b8e663-…）。旧路由强制 /^session-[A-Za-z0-9-]+$/，这类未分组对话在
 * 恢复 / 删除时会被直接判成「无效的 sessionId」。这里只排除真正危险的东西：
 * 空串、路径分隔符、路径穿越、控制字符与超长 id。
 */
export declare function isSafeSessionId(raw: unknown): raw is string;
export interface ArchivedRow {
    sessionId: string;
    title: string;
    workspaceId: string | null;
    workspaceTitle: string | null;
    workspacePath: string | null;
    updatedAt: string | null;
    createdAt: string | null;
}
export interface RestoreResult {
    restored: boolean;
    archivedSessionIds: string[];
}
export interface DeleteResult {
    deleted: boolean;
    filesDeleted: boolean;
    detachedWorkspaceId: string | null;
}
/**
 * 提取 `sessionPersistence.list()` 返回项里的 header。
 *
 * 0.1.5-rc.2 起官方返回 snapshot（`{ header, revision, sizeBytes }`），更早版本
 * 直接返回 header。旧代码只按 header 解析 snapshot，得到空 id  有效归档被当成
 * 墓碑：面板空白、purge 误清归档集合。两种形状都必须支持。
 */
export declare function snapshotHeader(entry: SessionListEntry | undefined): SessionHeaderLike | undefined;
export declare function isSessionLogFile(name: string): boolean;
/**
 * 扫描 <sessionsRoot> 下的所有 <projectKey>/<encodeSegment(sessionId)> 目录。
 * 返回「编码后的目录名  绝对路径列表」，作为持久化列表之外的磁盘真相。
 */
export declare function scanStoredSessionDirs(sessionsRoot: string): Map<string, string[]>;
/**
 * 定位一个会话的日志目录：先用 header.cwd 推出的规范路径（与持久化层同算法），
 * 定位不到再全量扫描。这样即使 header 缺失 / cwd 变化 / 列表形状变化也不会漏删。
 */
export declare function locateSessionDirs(sessionsRoot: string, cwd: string | undefined, sessionId: string): string[];
/** 列出所有已归档会话。日志已不存在的「墓碑」行不展示（可删不可恢复，交给
 *  purgeStaleArchived 清理）；持久化暂不可用时回退为展示全部（标题回退 sessionId）。 */
export interface ArchivedListOptions {
    /** 可选标题来源：v3 header 不带 title，向 sessionQuery 折取日志里的标题。 */
    query?: SessionQueryLike;
}
export declare function listArchived(registry: WorkspaceRegistryLike, persistence: SessionPersistenceLike | undefined, liveSessions: SessionStoreLike | undefined, options?: ArchivedListOptions): Promise<ArchivedRow[]>;
/**
 * v3 header 只有 id / createdAt / cwd，没有 title：向 `sessionQuery` 折取日志标题，
 * 失败就保留 sessionId 兜底（绝不因为没有标题而隐藏这一行）。原地修改并返回。
 */
export declare function applyQueryTitles(rows: ArchivedRow[], query: SessionQueryLike | undefined): Promise<ArchivedRow[]>;
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
export declare function listUngrouped(registry: WorkspaceRegistryLike, persistence: SessionPersistenceLike | undefined, liveSessions: SessionStoreLike | undefined, options?: ArchivedListOptions): Promise<ArchivedRow[]>;
export interface ArchiveResult {
    archived: boolean;
    archivedSessionIds: string[];
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
export declare function archiveSession(registry: WorkspaceRegistryLike, sessionId: string): Promise<ArchiveResult>;
/** 记住这个 id 是本进程删掉的（墓碑暂时不许清理）。 */
export declare function markRecentlyDeleted(sessionId: string): void;
export declare function isRecentlyDeleted(sessionId: string): boolean;
/** 仅测试用：忘掉「本进程删过」的记忆，让墓碑重新可被 purge 回收。 */
export declare function clearRecentlyDeleted(): void;
export interface PurgeDeps {
    registry: WorkspaceRegistryLike;
    persistence: SessionPersistenceLike;
    /** `ctx.sessions`：活着的僵尸会话不清（要等它随 DSH 退出消失）。 */
    sessions?: SessionStoreLike;
    /** 提供后启用磁盘二次证伪：日志目录仍在的归档 id 一律不清（防持久化列表异常时误删）。 */
    sessionsRoot?: string;
}
/**
 * 清理归档集合里的「墓碑」：日志已不存在且当前也没有活动会话的归档 id。
 * 幂等、可反复调用；没有可清理项时不做任何写入。返回清理的数量。
 */
export declare function purgeStaleArchived(deps: PurgeDeps): Promise<number>;
/** 从归档集合移除一个会话（恢复）。幂等：已不在集合时直接返回。 */
export declare function restoreSession(registry: WorkspaceRegistryLike, sessionId: string): Promise<RestoreResult>;
export interface DeleteDeps {
    registry: WorkspaceRegistryLike;
    persistence: SessionPersistenceLike;
    /** `ctx.sessions`：驻留在内存里的会话（打开过就存在，即使完全空闲）。 */
    sessions?: SessionStoreLike;
    /** `ctx.agents`：活动 agent 注册表。用它区分「真的在执行」和「只是驻留」。 */
    agents?: AgentRegistryLike;
    sessionsRoot: string;
    projectCacheRoot: string;
}
/**
 * Agent 的实际活动状态：
 *  - `running` / `maintenance` → 正在写日志，不能删；
 *  - `idle` → 驻留在内存但没有任何执行，可安全删除；
 *  - `unknown` → agents 注册表不可用（拿不到状态）。
 */
export type AgentActivity = 'running' | 'maintenance' | 'idle' | 'unknown';
export declare function agentActivity(agents: AgentRegistryLike | undefined, sessionId: string): AgentActivity;
export declare function deleteSession(deps: DeleteDeps, sessionId: string): Promise<DeleteResult>;
