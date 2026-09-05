import type { SessionPersistenceLike, SessionStoreLike, WorkspaceRegistryLike } from '../context.ts';
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
/** 列出所有已归档会话（标题缺失时回退为 sessionId）。 */
export declare function listArchived(registry: WorkspaceRegistryLike, persistence: SessionPersistenceLike | undefined, liveSessions: SessionStoreLike | undefined): Promise<ArchivedRow[]>;
/** 从归档集合移除一个会话（恢复）。幂等：已不在集合时直接返回。 */
export declare function restoreSession(registry: WorkspaceRegistryLike, sessionId: string): Promise<RestoreResult>;
export interface DeleteDeps {
    registry: WorkspaceRegistryLike;
    persistence: SessionPersistenceLike;
    liveSessions?: SessionStoreLike;
    sessionsRoot: string;
    projectCacheRoot: string;
}
/**
 * 彻底删除一个会话：
 *   1. 拒绝删除正在打开/运行的会话；
 *   2. 从归档集合移除（幂等）；
 *   3. 从所属工作区记账移除（先于文件删除，保证注册表校验一致）；
 *   4. 删除会话日志目录（安全检查：目录里必须存在 session.jsonl(.zstd)）；
 *   5. 清理投影缓存（失败不致命）。
 */
export declare function deleteSession(deps: DeleteDeps, sessionId: string): Promise<DeleteResult>;
