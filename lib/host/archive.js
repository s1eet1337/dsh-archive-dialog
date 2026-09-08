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
/** Normalize a persisted header timestamp (epoch-ms number or ISO string) to ISO. */
function toIso(value) {
    if (typeof value === 'string' && value.trim() !== '')
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return new Date(value).toISOString();
    return undefined;
}
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
        createdAt: toIso(header.createdAt),
        updatedAt: toIso(header.updatedAt),
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
 *   2. 先删除会话日志目录（安全检查：目录里必须存在 session.jsonl(.zstd)）。
 *      此时会话仍在归档集合里（对 UI 隐藏），这一步失败会抛错且尚未动注册表，
 *      因此会话保持归档状态，绝不会被漏成「未分组」孤儿；
 *   3. 清理投影缓存（失败不致命）；
 *   4. 文件已删除后再清注册表：取消归档 + 移出工作区记账（幂等）。此时
 *      domain/changed 触发前端刷新，而会话日志已不存在，列表自然不再显示它。
 */
export async function deleteSession(deps, sessionId) {
    const live = deps.liveSessions?.get?.(sessionId);
    if (live !== undefined && live !== null) {
        throw new Error('该会话当前正在打开或运行中，无法删除。请先关闭该对话再试。');
    }
    const headers = await deps.persistence.list();
    const header = headers.find((h) => String(h.id ?? h.sessionId ?? '') === sessionId);
    // header 缺失 = 会话日志早已不存在（例如之前已被外部清理）。此时跳过文件删除，
    // 但仍要完成取消归档 + 移出工作区记账 + 清理缓存，把残留归档 ID 清掉。
    const fields = header === undefined ? undefined : headerFields(header);
    const cwd = fields?.cwd !== undefined && fields.cwd.trim() !== '' ? fields.cwd : undefined;
    // 1. 先删文件：会话此刻仍在归档集合里（对 UI 隐藏）。这一步失败会抛错，
    //    且尚未动注册表，所以会话保持归档状态，不会变成「未分组」。
    let filesDeleted = false;
    if (header !== undefined) {
        const projectDir = cwd === undefined ? '_no-cwd' : projectKey(cwd);
        const sessionDir = join(deps.sessionsRoot, projectDir, encodeSegment(sessionId));
        if (!existsSync(sessionDir)) {
            throw new Error(`未找到会话日志目录 ${sessionDir}：会话日志仍存在但目录定位失败，拒绝删除`);
        }
        const names = readdirSync(sessionDir);
        const hasLog = names.some((n) => n === 'session.jsonl' || n === 'session.jsonl.zstd');
        if (!hasLog) {
            throw new Error(`安全校验未通过：目录 ${sessionDir} 中未找到会话日志文件，拒绝删除`);
        }
        await rm(sessionDir, { recursive: true, force: true });
        filesDeleted = true;
    }
    // 2. 清理投影缓存（per-record 文档：<cacheRoot>/<sessionId>.json；失败不致命）
    const cacheFile = join(deps.projectCacheRoot, `${encodeSegment(sessionId)}.json`);
    if (existsSync(cacheFile)) {
        try {
            await rm(cacheFile, { force: true });
        }
        catch {
            // 缓存清理失败不影响删除结果
        }
    }
    // 3. 文件已删除后再清注册表（取消归档 + 移出工作区记账），前端在 domain/changed
    //    刷新时列表里已无该会话日志，自然消失，而不是显示成未分组。
    await restoreSession(deps.registry, sessionId);
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
    return { deleted: true, filesDeleted, detachedWorkspaceId };
}
