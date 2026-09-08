import type { AgentRegistryLike, SessionPersistenceLike, SessionStoreLike, WorkspaceRegistryLike } from '../context.ts';
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
/** 列出所有已归档会话。日志已不存在的「墓碑」行不展示（可删不可恢复，交给
 *  purgeStaleArchived 清理）；持久化暂不可用时回退为展示全部（标题回退 sessionId）。 */
export declare function listArchived(registry: WorkspaceRegistryLike, persistence: SessionPersistenceLike | undefined, liveSessions: SessionStoreLike | undefined): Promise<ArchivedRow[]>;
export interface PurgeDeps {
    registry: WorkspaceRegistryLike;
    persistence: SessionPersistenceLike;
    /** `ctx.sessions`：活着的僵尸会话不清（要等它随 DSH 退出消失）。 */
    sessions?: SessionStoreLike;
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
/**
 * 彻底删除一个会话：
 *   1. 只有 agent 真正在执行（running/maintenance）才拒绝；已打开但空闲的
 *      会话允许删除——先把内存事件落盘（flush），确保删除后不会有残留
 *      事件在退出时把日志重新写回（“删除后复活”）。
 *   2. 删除会话日志目录（安全检查：目录里必须存在 session.jsonl(.zstd)）。
 *      此时会话仍在归档集合里（对 UI 隐藏），这一步失败会抛错且尚未动注册表，
 *      因此会话保持归档状态，绝不会被漏成「未分组」孤儿；
 *   3. 清理投影缓存（失败不致命）；
 *   4. 移出工作区记账（幂等）。**不取消归档**：id 留在归档集合当「墓碑」，
 *      保证会话永远不出现在侧栏任何分组（含未分组）——即使它的 agent 还驻留、
 *      客户端列表没刷新。墓碑由 purgeStaleArchived 在后续打开面板/删除时清理；
 *   5. 对空闲 agent 清空收件箱（cancel），避免任何排队消息把它唤醒。
 */
export declare function deleteSession(deps: DeleteDeps, sessionId: string): Promise<DeleteResult>;
