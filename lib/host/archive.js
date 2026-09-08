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
/** 列出所有已归档会话。日志已不存在的「墓碑」行不展示（可删不可恢复，交给
 *  purgeStaleArchived 清理）；持久化暂不可用时回退为展示全部（标题回退 sessionId）。 */
export async function listArchived(registry, persistence, liveSessions) {
    const archived = [...registry.archivedSessionIds].map(String);
    // headers 装载成功与否需要区分：失败时应展示全部（旧行为），避免误伤。
    let headersLoaded = false;
    const headers = new Map();
    if (persistence !== undefined) {
        try {
            for (const h of await persistence.list()) {
                const id = String(h.id ?? h.sessionId ?? '');
                if (id !== '')
                    headers.set(id, h);
            }
            headersLoaded = true;
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
    const rows = [];
    for (const sessionId of archived) {
        // 墓碑行（有归档 id 但日志已不存在）：面板不展示
        if (headersLoaded && !headers.has(sessionId))
            continue;
        const header = headerFields(headers.get(sessionId));
        const live = liveSessions?.get?.(sessionId);
        const liveHeader = headerFields(live?.header);
        const title = header?.title ?? liveHeader?.title ?? sessionId;
        const ws = workspaceBySession.get(sessionId);
        const createdAt = header?.createdAt ?? liveHeader?.createdAt ?? null;
        const updatedAt = header?.updatedAt ?? liveHeader?.updatedAt ?? createdAt;
        rows.push({
            sessionId,
            title,
            workspaceId: ws === undefined ? null : String(ws.id),
            workspaceTitle: typeof ws?.title === 'string' ? ws.title : null,
            workspacePath: typeof ws?.path === 'string' ? ws.path : null,
            updatedAt,
            createdAt,
        });
    }
    return rows;
}
/**
 * 清理归档集合里的「墓碑」：日志已不存在且当前也没有活动会话的归档 id。
 * 幂等、可反复调用；没有可清理项时不做任何写入。返回清理的数量。
 */
export async function purgeStaleArchived(deps) {
    const archived = [...deps.registry.archivedSessionIds].map(String);
    if (archived.length === 0)
        return 0;
    let known;
    try {
        known = new Set((await deps.persistence.list()).map((h) => String(h.id ?? h.sessionId ?? '')));
    }
    catch {
        return 0; // 持久化暂不可用：跳过，别误删
    }
    const stale = archived.filter((id) => !known.has(id) && deps.sessions?.get?.(id) == null);
    if (stale.length === 0)
        return 0;
    const run = deps.registry.enqueueOperation !== undefined ? deps.registry.enqueueOperation.bind(deps.registry) : (op) => op();
    await run(async () => {
        const fresh = deps.registry.requireState();
        const freshIds = Array.isArray(fresh.archivedSessionIds) ? fresh.archivedSessionIds.map(String) : [];
        const next = freshIds.filter((id) => !stale.includes(id));
        if (next.length === freshIds.length)
            return;
        await deps.registry.setState({ ...fresh, archivedSessionIds: next });
    });
    return stale.length;
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
export function agentActivity(agents, sessionId) {
    const agent = agents?.get?.(sessionId);
    if (agent === undefined)
        return 'unknown';
    const kind = typeof agent.phase?.kind === 'string' ? agent.phase.kind : undefined;
    const status = typeof agent.status === 'string' ? agent.status : undefined;
    if (kind === 'running' || status === 'running')
        return 'running';
    if (kind === 'maintenance')
        return 'maintenance';
    return 'idle';
}
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
export async function deleteSession(deps, sessionId) {
    const live = deps.sessions?.get?.(sessionId);
    const agent = deps.agents?.get?.(sessionId);
    const activity = agentActivity(deps.agents, sessionId);
    if (activity === 'running') {
        throw new Error('该对话正在执行中，无法删除。请等待回复完成，或先点击“停止”后再试。');
    }
    if (activity === 'maintenance') {
        throw new Error('该对话正在进行后台维护，无法删除。请稍等片刻后再试。');
    }
    if (live !== undefined && live !== null && activity === 'unknown') {
        // agents 注册表不可用（极旧宿主）：拿不到真实状态，保守拒绝驻留会话。
        throw new Error('该对话当前处于打开状态且无法确认其运行状态，无法删除。请重启 DSH 后再试。');
    }
    // 打开但空闲：先落盘再删文件。若 flush 失败说明耐久写入有问题，此刻删除
    // 可能把未写全的日志丢掉（或之后被写回），因此中止并保持归档原状。
    if (live !== undefined && live !== null && typeof deps.sessions?.flush === 'function') {
        try {
            await deps.sessions.flush(live);
        }
        catch (err) {
            throw new Error(`无法删除：该对话的日志尚未完成落盘（${err instanceof Error ? err.message : String(err)}），请稍后再试。`);
        }
    }
    const headers = await deps.persistence.list();
    const header = headers.find((h) => String(h.id ?? h.sessionId ?? '') === sessionId);
    // header 缺失 = 会话日志早已不存在（例如之前已被外部清理）。此时跳过文件删除，
    // 只做记账清理并把 id 留作墓碑，由 purgeStaleArchived 统一收拾。
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
    // 3. 移出工作区记账（幂等）。会话保持归档（墓碑），见函数注释第 4 条。
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
    // 4. 空闲 agent 收尾：清空收件箱，防止删除后还有排队消息把它唤醒并写日志。
    //    agent 本身无法从插件侧销毁（生命周期归宿主），但落盘已完成、收件箱已清，
    //    它不会再产生任何写入，退出时也不会把已删除的会话写回来。
    if (agent !== undefined && typeof agent.cancel === 'function') {
        try {
            agent.cancel();
        }
        catch {
            // 收件箱清理失败不影响删除结果
        }
    }
    return { deleted: true, filesDeleted, detachedWorkspaceId };
}
