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
 *   2. 先删除会话日志目录（安全检查：目录里必须存在 session.jsonl(.zstd)）。
 *      此时会话仍在归档集合里（对 UI 隐藏），这一步失败会抛错且尚未动注册表，
 *      因此会话保持归档状态，绝不会被漏成「未分组」孤儿；
 *   3. 清理投影缓存（失败不致命）；
 *   4. 文件已删除后再清注册表：取消归档 + 移出工作区记账（幂等）。此时
 *      domain/changed 触发前端刷新，而会话日志已不存在，列表自然不再显示它。
 */
export declare function deleteSession(deps: DeleteDeps, sessionId: string): Promise<DeleteResult>;
