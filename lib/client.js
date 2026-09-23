window.__ModuleLoader__.load({ id: "dsh-archive-dialog", factory: (__hostRequire) => {
var module = { exports: {} }; var exports = module.exports;

var __registry = {};
var __loaded = {};
function define(key, fn) { __registry[key] = fn; }
function __dirOf(key) { var i = key.lastIndexOf('/'); return i < 0 ? '' : key.slice(0, i); }
function __load(key) {
  if (__loaded[key]) return __registry[key].exports;
  if (!__registry[key]) { throw new Error('dsh-archive-dialog: unknown module ' + key); }
  var m = { exports: {} };
  __registry[key].exports = m.exports;
  __loaded[key] = true;
  var r = function (spec) {
    if (typeof spec === 'string' && spec.charCodeAt(0) === 46) { return __load(resolveRelative(__dirOf(key), spec)); }
    return __hostRequire(spec);
  };
  __registry[key](m, m.exports, r);
  return __registry[key].exports;
}
function resolveRelative(fromDir, spec) {
  var parts = fromDir === '' ? [] : fromDir.split('/');
  var segs = spec.split('/');
  for (var i = 0; i < segs.length; i++) { var seg = segs[i];
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}
define("client/api", function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getArchived = getArchived;
exports.getUngrouped = getUngrouped;
exports.postArchive = postArchive;
exports.postRestore = postRestore;
exports.postDelete = postDelete;
const API_PREFIX = '/plugins/dsh-archive-dialog';
async function request(path, init) {
    try {
        const res = await fetch(path, {
            cache: 'no-store',
            ...init,
            headers: init?.body !== undefined ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
        });
        const body = (await res.json());
        if (body.ok === true)
            return { ok: true, data: body.data };
        return { ok: false, error: typeof body.error === 'string' && body.error !== '' ? body.error : `HTTP ${res.status}` };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
/** Shared row-list fetcher: both /archived and /ungrouped answer `{ rows }`. */
async function getRows(path) {
    const res = await request(path);
    if (!res.ok)
        return res;
    const payload = res.data;
    const rowsRaw = payload?.rows;
    if (!Array.isArray(rowsRaw))
        return { ok: false, error: '响应格式异常（缺少 rows）' };
    const rows = rowsRaw
        .map((r) => {
        const rec = (r ?? {});
        const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : '';
        return {
            sessionId,
            title: typeof rec.title === 'string' && rec.title !== '' ? rec.title : sessionId,
            workspaceId: typeof rec.workspaceId === 'string' ? rec.workspaceId : null,
            workspaceTitle: typeof rec.workspaceTitle === 'string' ? rec.workspaceTitle : null,
            workspacePath: typeof rec.workspacePath === 'string' ? rec.workspacePath : null,
            updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : null,
            createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : null,
        };
    })
        .filter((r) => r.sessionId !== '');
    return { ok: true, data: rows };
}
function getArchived() {
    return getRows(`${API_PREFIX}/archived`);
}
/** 「未分组」对话：未归档、也没有工作区记账的会话。 */
function getUngrouped() {
    return getRows(`${API_PREFIX}/ungrouped`);
}
async function postArchive(sessionId) {
    return request(`${API_PREFIX}/archive`, { method: 'POST', body: JSON.stringify({ sessionId }) });
}
async function postRestore(sessionId) {
    return request(`${API_PREFIX}/restore`, { method: 'POST', body: JSON.stringify({ sessionId }) });
}
async function postDelete(sessionId) {
    return request(`${API_PREFIX}/delete`, { method: 'POST', body: JSON.stringify({ sessionId }) });
}

});
define("client/components", function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Trigger = Trigger;
exports.Panel = Panel;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * React components for dsh-archive-dialog's web UI.
 *  - `Trigger` → sidebar.footer.action（左侧栏底部按钮，打开面板）
 *  - `Panel`   → shell.overlay（悬浮面板：已归档 + 未分组列表，恢复/归档/删除二次确认）
 */
const react_1 = require("react");
const store_1 = require("./store");
/* ================================================================== *
 * Trigger — 左侧栏底部按钮
 * ================================================================== */
function Trigger(props) {
    const open = (0, store_1.useUi)((s) => s.open);
    const archived = (0, store_1.useUi)((s) => s.rows.length);
    const ungrouped = (0, store_1.useUi)((s) => s.ungrouped.length);
    const count = archived + ungrouped;
    return ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: "ad-trigger", "aria-label": "\u5F52\u6863\u5BF9\u8BDD", title: count > 0 ? `归档对话（已归档 ${archived} · 未分组 ${ungrouped}）` : '归档对话', "aria-pressed": open, onClick: store_1.toggleOpen, children: [(0, jsx_runtime_1.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("rect", { x: "3", y: "4", width: "18", height: "5", rx: "1" }), (0, jsx_runtime_1.jsx)("path", { d: "M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" }), (0, jsx_runtime_1.jsx)("path", { d: "M10 13h4" })] }), props.wide === true ? (0, jsx_runtime_1.jsx)("span", { className: "ad-trigger-label", children: "\u5F52\u6863\u5BF9\u8BDD" }) : null, count > 0 ? (0, jsx_runtime_1.jsx)("span", { className: "ad-count", children: count > 99 ? '99+' : count }) : null] }));
}
/* ================================================================== *
 * Panel — 悬浮面板
 * ================================================================== */
function Panel() {
    const open = (0, store_1.useUi)((s) => s.open);
    const rows = (0, store_1.useUi)((s) => s.rows);
    const ungrouped = (0, store_1.useUi)((s) => s.ungrouped);
    const total = rows.length + ungrouped.length;
    const phase = (0, store_1.useUi)((s) => s.phase);
    const error = (0, store_1.useUi)((s) => s.error);
    const busy = (0, store_1.useUi)((s) => s.busy);
    const notice = (0, store_1.useUi)((s) => s.notice);
    const [confirming, setConfirming] = (0, react_1.useState)(null);
    (0, react_1.useEffect)(() => {
        if (!open)
            return;
        const onKey = (e) => {
            if (e.key === 'Escape')
                (0, store_1.setOpen)(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);
    (0, react_1.useEffect)(() => {
        if (!open)
            setConfirming(null);
    }, [open]);
    if (!open)
        return null;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "ad-panel", role: "dialog", "aria-label": "\u5F52\u6863\u5BF9\u8BDD", children: [(0, jsx_runtime_1.jsxs)("header", { className: "ad-panel-header", children: [(0, jsx_runtime_1.jsxs)("div", { className: "ad-panel-title", children: ["\u5F52\u6863\u5BF9\u8BDD", total > 0 ? (0, jsx_runtime_1.jsxs)("span", { className: "ad-panel-count", children: [total, " \u4E2A"] }) : null] }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "ad-icon-btn", "aria-label": "\u5173\u95ED", onClick: () => (0, store_1.setOpen)(false), children: (0, jsx_runtime_1.jsx)("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("path", { d: "M18 6 6 18M6 6l12 12" }) }) })] }), notice !== null ? ((0, jsx_runtime_1.jsxs)("div", { className: notice.kind === 'success' ? 'ad-notice ad-notice-ok' : 'ad-notice ad-notice-err', role: "status", children: [(0, jsx_runtime_1.jsx)("span", { children: notice.text }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "ad-icon-btn", "aria-label": "\u5173\u95ED\u63D0\u793A", onClick: store_1.dismissNotice, children: (0, jsx_runtime_1.jsx)("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("path", { d: "M18 6 6 18M6 6l12 12" }) }) })] })) : null, phase === 'loading' ? ((0, jsx_runtime_1.jsx)("div", { className: "ad-empty", children: "\u52A0\u8F7D\u4E2D\u2026" })) : phase === 'error' ? ((0, jsx_runtime_1.jsxs)("div", { className: "ad-empty ad-empty-err", children: [error ?? '加载失败', (0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: "ad-btn", onClick: () => void (0, store_1.refresh)(), children: "\u91CD\u8BD5" }) })] })) : rows.length === 0 && ungrouped.length === 0 ? ((0, jsx_runtime_1.jsxs)("div", { className: "ad-empty", children: ["\u6682\u65E0\u5F52\u6863\u6216\u672A\u5206\u7EC4\u7684\u5BF9\u8BDD", (0, jsx_runtime_1.jsx)("div", { className: "ad-hint", children: "\u5728\u4F1A\u8BDD\u5217\u8868\u53F3\u952E\u83DC\u5355\u91CC\u4F7F\u7528 DSH \u81EA\u5E26\u7684\u300C\u5F52\u6863\u4F1A\u8BDD\u300D\uFF0C\u5BF9\u8BDD\u5C31\u4F1A\u6536\u8FDB\u8FD9\u91CC\uFF1B \u5DE5\u4F5C\u533A\u91CC\u6B8B\u7559\u7684\u300C\u672A\u5206\u7EC4\u300D\u5BF9\u8BDD\u4E5F\u4F1A\u5217\u5728\u8FD9\u91CC\uFF0C\u53EF\u76F4\u63A5\u5F52\u6863\u6216\u5F7B\u5E95\u5220\u9664" })] })) : ((0, jsx_runtime_1.jsxs)("div", { className: "ad-body", children: [rows.length > 0 ? ((0, jsx_runtime_1.jsxs)("section", { className: "ad-section", children: [(0, jsx_runtime_1.jsxs)("div", { className: "ad-section-title", children: ["\u5DF2\u5F52\u6863", (0, jsx_runtime_1.jsx)("span", { className: "ad-panel-count", children: rows.length })] }), (0, jsx_runtime_1.jsx)("ul", { className: "ad-list", children: rows.map((row) => ((0, jsx_runtime_1.jsx)(Row, { row: row, archived: true, busy: busy[row.sessionId], confirming: confirming === row.sessionId, onAskDelete: () => setConfirming(row.sessionId), onCancelDelete: () => setConfirming(null) }, row.sessionId))) })] })) : null, ungrouped.length > 0 ? ((0, jsx_runtime_1.jsxs)("section", { className: "ad-section", children: [(0, jsx_runtime_1.jsxs)("div", { className: "ad-section-title", children: ["\u672A\u5206\u7EC4", (0, jsx_runtime_1.jsx)("span", { className: "ad-panel-count", children: ungrouped.length })] }), (0, jsx_runtime_1.jsx)("ul", { className: "ad-list", children: ungrouped.map((row) => ((0, jsx_runtime_1.jsx)(Row, { row: row, archived: false, busy: busy[row.sessionId], confirming: confirming === row.sessionId, onAskDelete: () => setConfirming(row.sessionId), onCancelDelete: () => setConfirming(null) }, row.sessionId))) })] })) : null] }))] }));
}
/* ================================================================== *
 * Row — 单条对话（已归档行 = 恢复；未分组行 = 归档）
 * ================================================================== */
function Row(props) {
    const { row, archived, busy, confirming, onAskDelete, onCancelDelete } = props;
    if (confirming) {
        return ((0, jsx_runtime_1.jsxs)("li", { className: "ad-row ad-confirm", children: [(0, jsx_runtime_1.jsxs)("div", { className: "ad-confirm-text", children: ["\u786E\u5B9A\u5F7B\u5E95\u5220\u9664\u300C", row.title, "\u300D\uFF1F\u5220\u9664\u540E\u65E0\u6CD5\u6062\u590D\u3002"] }), (0, jsx_runtime_1.jsxs)("div", { className: "ad-confirm-actions", children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: "ad-btn", disabled: busy !== undefined, onClick: onCancelDelete, children: "\u53D6\u6D88" }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "ad-btn ad-btn-danger", disabled: busy !== undefined, onClick: () => void (0, store_1.remove)(row.sessionId), children: busy === 'delete' ? '删除中…' : '确认删除' })] })] }));
    }
    return ((0, jsx_runtime_1.jsxs)("li", { className: "ad-row", children: [(0, jsx_runtime_1.jsxs)("div", { className: "ad-row-main", children: [(0, jsx_runtime_1.jsx)("div", { className: "ad-row-title", title: row.sessionId, children: row.title }), (0, jsx_runtime_1.jsxs)("div", { className: "ad-row-meta", children: [row.workspaceTitle ?? (archived ? '未归入工作区' : '未分组'), row.updatedAt !== null ? ` · ${relativeTime(row.updatedAt)}` : ''] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "ad-row-actions", children: [archived ? ((0, jsx_runtime_1.jsx)("button", { type: "button", className: "ad-btn", disabled: busy !== undefined, onClick: () => void (0, store_1.restore)(row.sessionId), children: busy === 'restore' ? '恢复中…' : '恢复' })) : ((0, jsx_runtime_1.jsx)("button", { type: "button", className: "ad-btn", disabled: busy !== undefined, onClick: () => void (0, store_1.archive)(row.sessionId), children: busy === 'archive' ? '归档中…' : '归档' })), (0, jsx_runtime_1.jsx)("button", { type: "button", className: "ad-btn ad-btn-danger", disabled: busy !== undefined, onClick: onAskDelete, children: busy === 'delete' ? '删除中…' : '删除' })] })] }));
}
function relativeTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t))
        return '';
    const diff = Date.now() - t;
    if (diff < 60_000)
        return '刚刚';
    if (diff < 3_600_000)
        return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 30 * 86_400_000)
        return `${Math.floor(diff / 86_400_000)} 天前`;
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

});
define("client/index", function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.name = void 0;
exports.apply = apply;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * dsh-archive-dialog client half.
 *
 * Registers two additive seats:
 *  - `sidebar.footer.action` → 「归档对话」按钮（设置旁，打开面板）
 *  - `shell.overlay`         → 悬浮面板（已归档 + 未分组列表 + 恢复/归档 + 删除二次确认）
 * 数据来自 host 的 `/plugins/dsh-archive-dialog` 路由（同源 fetch）。
 *
 * 归档/恢复/删除成功后，会额外触发 DSH 官方的会话列表刷新（client `sessions`
 * 服务的 `refresh()`），让侧栏/「未分组」里的行立即消失，无需重启。
 */
const components_1 = require("./components");
const store_1 = require("./store");
const style_1 = require("./style");
/** Plugin identity for the client bundle id (same as the host row). */
exports.name = 'dsh-archive-dialog';
/** Services required before apply. `sessions` = 官方会话控制器（提供 refresh）。 */
exports.inject = ['slots', 'sessions'];
function apply(ctx) {
    // 独立样式表：模块加载器会在卸载时回收 <style data-plugin="…">
    if (typeof document !== 'undefined') {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-archive-dialog';
        tag.textContent = style_1.css;
        document.head.appendChild(tag);
    }
    // 预热列表：让侧栏按钮的角标在未打开面板时也能显示数量
    void (0, store_1.refresh)();
    // 恢复/删除成功后刷新 DSH 官方会话列表。只读不写：拿不到服务或没有 refresh()
    // 时静默降级（行会等下次重连才消失）。
    (0, store_1.setSessionListRefresher)(() => {
        try {
            const viaGet = ctx.get !== undefined ? ctx.get('sessions') : undefined;
            const sessions = ctx.sessions ?? viaGet;
            if (sessions !== undefined && typeof sessions.refresh === 'function')
                void sessions.refresh();
        }
        catch (err) {
            console.warn('[dsh-archive-dialog] session list refresh unavailable:', err);
        }
    });
    const slots = ctx.slots;
    if (slots === undefined)
        return;
    const registerTrigger = () => slots.register({ name: 'sidebar.footer.action', id: 'dsh-archive-dialog-trigger', order: 100, label: '归档对话' }, (props) => (0, jsx_runtime_1.jsx)(components_1.Trigger, { wide: Boolean(props?.wide) }));
    const registerPanel = () => slots.register({ name: 'shell.overlay', id: 'dsh-archive-dialog-panel', order: 300, label: '归档对话' }, () => (0, jsx_runtime_1.jsx)(components_1.Panel, {}));
    if (ctx.effect !== undefined) {
        ctx.effect(() => slots.inject('sidebar.footer.action', registerTrigger), 'dsh-archive-dialog: sidebar trigger');
        ctx.effect(() => slots.inject('shell.overlay', registerPanel), 'dsh-archive-dialog: overlay panel');
    }
    else {
        slots.inject('sidebar.footer.action', registerTrigger);
        slots.inject('shell.overlay', registerPanel);
    }
}

});
define("client/store", function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscribe = subscribe;
exports.useUi = useUi;
exports.refresh = refresh;
exports.setOpen = setOpen;
exports.toggleOpen = toggleOpen;
exports.dismissNotice = dismissNotice;
exports.setSessionListRefresher = setSessionListRefresher;
exports.archive = archive;
exports.restore = restore;
exports.remove = remove;
/**
 * Tiny module-level UI store with a subscribe() API (external-store style).
 * Components use `useUi` to select slices; `refresh` uses latest-wins
 * sequencing so overlapping fetches can never apply stale data.
 */
const react_1 = require("react");
const api_1 = require("./api");
const state = {
    open: false,
    rows: [],
    ungrouped: [],
    phase: 'idle',
    error: null,
    busy: {},
    notice: null,
};
const listeners = new Set();
let noticeSeq = 0;
const emit = () => {
    for (const fn of [...listeners])
        fn();
};
function subscribe(fn) {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}
function patch(partial) {
    Object.assign(state, partial);
    emit();
}
function useUi(select) {
    return (0, react_1.useSyncExternalStore)(subscribe, () => select(state), () => select(state));
}
/* ------------------------------------------------------------------ *
 * 列表刷新（latest-wins：重叠请求只应用最新一次的结果）
 * ------------------------------------------------------------------ */
let refreshSeq = 0;
/** 已归档 + 未分组两节一起刷新（一次 refreshSeq，两节始终同代）。 */
function refresh() {
    const mySeq = ++refreshSeq;
    if (state.phase !== 'ready')
        patch({ phase: 'loading' });
    return Promise.all([(0, api_1.getArchived)(), (0, api_1.getUngrouped)()])
        .then(([archived, ungrouped]) => {
        if (mySeq !== refreshSeq)
            return;
        if (!archived.ok) {
            patch({ phase: 'error', error: archived.error });
            return;
        }
        // 宿主还是旧版本（没有 /ungrouped 路由）时，降级成「只显示已归档」，
        // 而不是让整块面板报错——插件刚更新、DSH 还没重启时会短暂处于这种版本落差。
        if (!ungrouped.ok) {
            console.warn('[dsh-archive-dialog] 未分组列表不可用（宿主版本较旧？）:', ungrouped.error);
        }
        patch({
            rows: archived.data,
            ungrouped: ungrouped.ok ? ungrouped.data : [],
            phase: 'ready',
            error: null,
        });
    })
        .catch(() => {
        if (mySeq !== refreshSeq)
            return;
        patch({ phase: 'error', error: '加载失败' });
    });
}
/* ------------------------------------------------------------------ *
 * 面板开关 / 通知
 * ------------------------------------------------------------------ */
function setOpen(open) {
    patch({ open });
    if (open)
        void refresh();
}
function toggleOpen() {
    setOpen(!state.open);
}
function dismissNotice() {
    patch({ notice: null });
}
function showNotice(kind, text) {
    const id = ++noticeSeq;
    patch({ notice: { id, kind, text } });
    window.setTimeout(() => {
        if (state.notice?.id === id)
            patch({ notice: null });
    }, 4_000);
}
let sessionListRefresher;
function setSessionListRefresher(fn) {
    sessionListRefresher = fn;
}
function notifySessionListChanged() {
    try {
        sessionListRefresher?.();
    }
    catch (err) {
        console.warn('[dsh-archive-dialog] session list refresh failed:', err);
    }
}
/* ------------------------------------------------------------------ *
 * 动作：恢复 / 彻底删除
 * ------------------------------------------------------------------ */
/** 归档一个「未分组」会话：收进第一节，侧栏同步消失。 */
async function archive(sessionId) {
    if (state.busy[sessionId] !== undefined)
        return;
    patch({ busy: { ...state.busy, [sessionId]: 'archive' } });
    const res = await (0, api_1.postArchive)(sessionId);
    if (res.ok) {
        showNotice('success', '已归档，可在上方「已归档」里找回');
        await refresh();
        notifySessionListChanged();
    }
    else {
        showNotice('error', `归档失败：${res.error}`);
    }
    const busy = { ...state.busy };
    delete busy[sessionId];
    patch({ busy });
}
async function restore(sessionId) {
    if (state.busy[sessionId] !== undefined)
        return;
    patch({ busy: { ...state.busy, [sessionId]: 'restore' } });
    const res = await (0, api_1.postRestore)(sessionId);
    if (res.ok) {
        showNotice('success', '已恢复，该对话已回到工作区列表');
        await refresh();
        notifySessionListChanged();
    }
    else {
        showNotice('error', `恢复失败：${res.error}`);
    }
    const busy = { ...state.busy };
    delete busy[sessionId];
    patch({ busy });
}
async function remove(sessionId) {
    if (state.busy[sessionId] !== undefined)
        return;
    patch({ busy: { ...state.busy, [sessionId]: 'delete' } });
    const res = await (0, api_1.postDelete)(sessionId);
    if (res.ok) {
        await refresh();
        // 复核：宿主若还在跑旧版删除逻辑（官方 delete 只删当前 generation，或干脆返回
        // false），会话会「删完又回到未分组」。列表里还能看到就必须明说，绝不谎报成功。
        const stillListed = state.rows.some((row) => row.sessionId === sessionId) ||
            state.ungrouped.some((row) => row.sessionId === sessionId);
        if (stillListed) {
            showNotice('error', '删除未生效：会话记录仍然存在（宿主可能未加载新版插件，重启 DSH 后再试）');
        }
        else {
            showNotice('success', '已彻底删除，该对话无法恢复');
            notifySessionListChanged();
        }
    }
    else {
        showNotice('error', `删除失败：${res.error}`);
    }
    const busy = { ...state.busy };
    delete busy[sessionId];
    patch({ busy });
}

});
define("client/style", function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.css = void 0;
/**
 * dsh-archive-dialog 的独立样式表。颜色全部走 DSH 主题 token
 * (`--dsw-alias-*`)，自动适配浅色/深色主题；`<style data-plugin>` 标签
 * 由模块加载器在插件卸载时统一回收。
 */
exports.css = `
.ad-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
}
.ad-trigger:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
}
.ad-trigger[aria-pressed='true'] {
  color: var(--dsw-alias-brand-primary);
}
.ad-count {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--dsw-alias-brand-primary);
  color: #fff;
  font-size: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
}

.ad-panel {
  pointer-events: auto;
  position: fixed;
  top: 50%;
  right: 20px;
  transform: translateY(-50%);
  width: min(400px, calc(100vw - 40px));
  max-height: min(560px, calc(100vh - 140px));
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.22);
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  z-index: 40;
}

.ad-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: none;
}
.ad-panel-title {
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ad-panel-count {
  color: var(--dsw-alias-label-secondary);
  font-weight: 400;
  font-size: 12px;
}
.ad-icon-btn {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  border-radius: 6px;
  padding: 4px;
  display: inline-flex;
}
.ad-icon-btn:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
}

/* 面板主体：两节（已归档 / 未分组）共同的可滚动区域。 */
.ad-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.ad-section + .ad-section {
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.ad-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  position: sticky;
  top: 0;
  background: var(--dsw-alias-bg-overlay);
  z-index: 1;
}
.ad-list {
  margin: 0;
  padding: 6px;
  list-style: none;
  overflow: visible;
  flex: none;
}
.ad-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid transparent;
}
.ad-row:hover {
  background: var(--dsw-alias-bg-layer-1);
}
.ad-row-main {
  flex: 1 1 auto;
  min-width: 0;
}
.ad-row-title {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ad-row-meta {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ad-row-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.ad-btn {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.ad-btn:hover:not(:disabled) {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.ad-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.ad-btn-danger {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
  background: transparent;
}
.ad-btn-danger:hover:not(:disabled) {
  background: var(--dsw-alias-state-error-primary);
  color: #fff;
  border-color: var(--dsw-alias-state-error-primary);
}

.ad-confirm {
  flex-direction: column;
  align-items: stretch;
  border-color: var(--dsw-alias-state-warn-primary);
  background: var(--dsw-alias-bg-layer-1);
}
.ad-confirm-text {
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 8px;
  word-break: break-all;
}
.ad-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.ad-empty {
  padding: 28px 16px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
}
.ad-empty-err {
  color: var(--dsw-alias-state-error-primary);
}
.ad-hint {
  margin-top: 8px;
  font-size: 11px;
  opacity: 0.85;
  line-height: 1.5;
}
.ad-empty .ad-btn {
  margin-top: 10px;
}

.ad-notice {
  margin: 8px 10px 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: none;
}
.ad-notice-ok {
  background: rgba(46, 160, 67, 0.12);
  color: var(--dsw-alias-state-success-primary);
}
.ad-notice-err {
  background: rgba(248, 81, 73, 0.12);
  color: var(--dsw-alias-state-error-primary);
}

@media (prefers-reduced-motion: reduce) {
  .ad-panel,
  .ad-trigger {
    transition: none;
  }
}
`;

});

return __load("client/index");
} });
