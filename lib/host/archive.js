/**
 * 归档面板的业务逻辑（host 侧，可离线测试）。
 *
 * 数据真相：DSH 工作区注册表（`ctx.workspaceRegistry`）全局状态里的
 * `archivedSessionIds`。归档本身由 DSH 自带功能完成；本插件负责：
 *   1. listArchived  — 已归档会话列表（拼接标题 / 工作区 / 时间）
 *   2. restoreSession — 把 id 从归档集合移除（前端会通过 domain/changed
 *      feed 自动刷新，无需刷新页面）
 *   3. deleteSession — 彻底删除：取消归档 + 移出工作区记账 + 删除会话日志
 *      文件（带安全检查）+ 清理投影缓存
 *
 * 所有写操作都走注册表的公开方法（setState / detachSession / enqueueOperation），
 * 绝不直接改 storages/workspace.json —— 官方 invariant 明确禁止绕过注册表。
 */
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeSegment, projectKey } from "./paths.js";
function headerFields(header) {
    if (header === undefined)
        return undefined;
    const id = String(header.id ?? header.sessionId ?? '');
    if (id === '')
        return undefined;
    return {
        id,
        cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
        title: typeof header.title === 'string' && header.title.trim() !== '' ? header.title : undefined,
        createdAt: typeof header.createdAt === 'string' ? header.createdAt : undefined,
        updatedAt: typeof header.updatedAt === 'string' ? header.updatedAt : undefined,
    };
}
/** 列出所有已归档会话（标题缺失时回退为 sessionId）。 */
export async function listArchived(registry, persistence, liveSessions) {
    const archived = [...registry.archivedSessionIds].map(String);
    const headers = new Map();
    if (persistence !== undefined) {
        try {
            for (const h of await persistence.list()) {
                const id = String(h.id ?? h.sessionId ?? '');
                if (id !== '')
                    headers.set(id, h);
            }
        }
        catch {
            // 持久化暂不可用时不阻断列表：标题回退为 sessionId
        }
    }
    const workspaceBySession = new Map();
    for (const w of registry.list()) {
        for (const id of w.record?.sessionIds ?? [])
            workspaceBySession.set(String(id), w);
    }
    return archived.map((sessionId) => {
        const header = headerFields(headers.get(sessionId));
        const live = liveSessions?.get?.(sessionId);
        const liveHeader = headerFields(live?.header);
        const title = header?.title ?? liveHeader?.title ?? sessionId;
        const ws = workspaceBySession.get(sessionId);
        const createdAt = header?.createdAt ?? liveHeader?.createdAt ?? null;
        const updatedAt = header?.updatedAt ?? liveHeader?.updatedAt ?? createdAt;
        return {
            sessionId,
            title,
            workspaceId: ws === undefined ? null : String(ws.id),
            workspaceTitle: typeof ws?.title === 'string' ? ws.title : null,
            workspacePath: typeof ws?.path === 'string' ? ws.path : null,
            updatedAt,
            createdAt,
        };
    });
}
/** 从归档集合移除一个会话（恢复）。幂等：已不在集合时直接返回。 */
export async function restoreSession(registry, sessionId) {
    const state = registry.requireState();
    const ids = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds.map(String) : [];
    if (!ids.includes(sessionId))
        return { restored: false, archivedSessionIds: ids };
    const nextState = { ...state, archivedSessionIds: ids.filter((id) => id !== sessionId) };
    // 尽量并入注册表自己的操作链（与官方 archiveSession 同一条链），避免并发交错
    const run = registry.enqueueOperation !== undefined ? registry.enqueueOperation.bind(registry) : (op) => op();
    await run(async () => {
        const fresh = registry.requireState();
        const freshIds = Array.isArray(fresh.archivedSessionIds) ? fresh.archivedSessionIds.map(String) : [];
        if (!freshIds.includes(sessionId))
            return;
        await registry.setState({ ...fresh, archivedSessionIds: freshIds.filter((id) => id !== sessionId) });
    });
    const after = registry.requireState();
    return {
        restored: true,
        archivedSessionIds: Array.isArray(after.archivedSessionIds) ? after.archivedSessionIds.map(String) : [],
    };
}
/**
 * 彻底删除一个会话：
 *   1. 拒绝删除正在打开/运行的会话；
 *   2. 从归档集合移除（幂等）；
 *   3. 从所属工作区记账移除（先于文件删除，保证注册表校验一致）；
 *   4. 删除会话日志目录（安全检查：目录里必须存在 session.jsonl(.zstd)）；
 *   5. 清理投影缓存（失败不致命）。
 */
export async function deleteSession(deps, sessionId) {
    const live = deps.liveSessions?.get?.(sessionId);
    if (live !== undefined && live !== null) {
        throw new Error('该会话当前正在打开或运行中，无法删除。请先关闭该对话再试。');
    }
    const headers = await deps.persistence.list();
    const header = headers.find((h) => String(h.id ?? h.sessionId ?? '') === sessionId);
    if (header === undefined)
        throw new Error(`未找到会话 ${sessionId}，可能已被删除`);
    const fields = headerFields(header);
    const cwd = fields?.cwd !== undefined && fields.cwd.trim() !== '' ? fields.cwd : undefined;
    // 1. 取消归档（幂等）
    await restoreSession(deps.registry, sessionId);
    // 2. 移出工作区记账
    let detachedWorkspaceId = null;
    for (const w of deps.registry.list()) {
        const accounted = (w.record?.sessionIds ?? []).some((id) => String(id) === sessionId);
        if (!accounted)
            continue;
        if (typeof w.detachSession !== 'function')
            throw new Error('当前版本不支持从工作区移除会话（detachSession 缺失）');
        await w.detachSession(sessionId);
        detachedWorkspaceId = String(w.id);
    }
    // 3. 删除会话日志文件
    const projectDir = cwd === undefined ? '_no-cwd' : projectKey(cwd);
    const sessionDir = join(deps.sessionsRoot, projectDir, encodeSegment(sessionId));
    let filesDeleted = false;
    if (existsSync(sessionDir)) {
        const names = readdirSync(sessionDir);
        const hasLog = names.some((n) => n === 'session.jsonl' || n === 'session.jsonl.zstd');
        if (!hasLog) {
            throw new Error(`安全校验未通过：目录 ${sessionDir} 中未找到会话日志文件，拒绝删除`);
        }
        await rm(sessionDir, { recursive: true, force: true });
        filesDeleted = true;
    }
    // 4. 清理投影缓存（存在才删，失败不致命）
    const cacheDir = join(deps.projectCacheRoot, encodeSegment(sessionId));
    if (existsSync(cacheDir)) {
        try {
            await rm(cacheDir, { recursive: true, force: true });
        }
        catch {
            // 缓存清理失败不影响删除结果
        }
    }
    return { deleted: true, filesDeleted, detachedWorkspaceId };
}
