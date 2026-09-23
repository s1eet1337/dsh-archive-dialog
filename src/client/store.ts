/**
 * Tiny module-level UI store with a subscribe() API (external-store style).
 * Components use `useUi` to select slices; `refresh` uses latest-wins
 * sequencing so overlapping fetches can never apply stale data.
 */
import { useSyncExternalStore } from 'react'
import { getArchived, getUngrouped, postArchive, postDelete, postRestore } from './api'
import type { ArchivedRow } from './api'

export interface Notice {
  id: number
  kind: 'success' | 'error'
  text: string
}

export type BusyKind = 'archive' | 'restore' | 'delete'

interface UiState {
  open: boolean
  /** 已归档会话（面板第一节）。 */
  rows: ArchivedRow[]
  /** 「未分组」会话：未归档、也没有工作区记账（面板第二节）。 */
  ungrouped: ArchivedRow[]
  phase: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  busy: Record<string, BusyKind>
  notice: Notice | null
}

const state: UiState = {
  open: false,
  rows: [],
  ungrouped: [],
  phase: 'idle',
  error: null,
  busy: {},
  notice: null,
}

const listeners = new Set<() => void>()
let noticeSeq = 0

const emit = (): void => {
  for (const fn of [...listeners]) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function patch(partial: Partial<UiState>): void {
  Object.assign(state, partial)
  emit()
}

export function useUi<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select(state),
  )
}

/* ------------------------------------------------------------------ *
 * 列表刷新（latest-wins：重叠请求只应用最新一次的结果）
 * ------------------------------------------------------------------ */

let refreshSeq = 0

/** 已归档 + 未分组两节一起刷新（一次 refreshSeq，两节始终同代）。 */
export function refresh(): Promise<void> {
  const mySeq = ++refreshSeq
  if (state.phase !== 'ready') patch({ phase: 'loading' })
  return Promise.all([getArchived(), getUngrouped()])
    .then(([archived, ungrouped]) => {
      if (mySeq !== refreshSeq) return
      if (!archived.ok) {
        patch({ phase: 'error', error: archived.error })
        return
      }
      // 宿主还是旧版本（没有 /ungrouped 路由）时，降级成「只显示已归档」，
      // 而不是让整块面板报错——插件刚更新、DSH 还没重启时会短暂处于这种版本落差。
      if (!ungrouped.ok) {
        console.warn('[dsh-archive-dialog] 未分组列表不可用（宿主版本较旧？）:', ungrouped.error)
      }
      patch({
        rows: archived.data,
        ungrouped: ungrouped.ok ? ungrouped.data : [],
        phase: 'ready',
        error: null,
      })
    })
    .catch(() => {
      if (mySeq !== refreshSeq) return
      patch({ phase: 'error', error: '加载失败' })
    })
}

/* ------------------------------------------------------------------ *
 * 面板开关 / 通知
 * ------------------------------------------------------------------ */

export function setOpen(open: boolean): void {
  patch({ open })
  if (open) void refresh()
}

export function toggleOpen(): void {
  setOpen(!state.open)
}

export function dismissNotice(): void {
  patch({ notice: null })
}

function showNotice(kind: Notice['kind'], text: string): void {
  const id = ++noticeSeq
  patch({ notice: { id, kind, text } })
  window.setTimeout(() => {
    if (state.notice?.id === id) patch({ notice: null })
  }, 4_000)
}

/* ------------------------------------------------------------------ *
 * DSH 官方会话列表刷新钩子
 *
 * 删除/恢复会改磁盘与注册表，但 DSH 侧栏的会话列表（含「未分组」）只在自己
 * 重新拉取时才更新。删除成功后主动触发官方 `sessions.refresh()`，该 RPC 会在
 * host 端把搜索索引与磁盘对账，并让侧栏立即丢掉已删除的行（否则要重启才消失，
 * 期间会以「未分组」幽灵形式残留）。由 index.tsx 在 apply 时注入；拿不到
 * 服务时静默降级。
 * ------------------------------------------------------------------ */

type SessionListRefresher = () => void
let sessionListRefresher: SessionListRefresher | undefined

export function setSessionListRefresher(fn: SessionListRefresher | undefined): void {
  sessionListRefresher = fn
}

function notifySessionListChanged(): void {
  try {
    sessionListRefresher?.()
  } catch (err) {
    console.warn('[dsh-archive-dialog] session list refresh failed:', err)
  }
}

/* ------------------------------------------------------------------ *
 * 动作：恢复 / 彻底删除
 * ------------------------------------------------------------------ */

/** 归档一个「未分组」会话：收进第一节，侧栏同步消失。 */
export async function archive(sessionId: string): Promise<void> {
  if (state.busy[sessionId] !== undefined) return
  patch({ busy: { ...state.busy, [sessionId]: 'archive' } })
  const res = await postArchive(sessionId)
  if (res.ok) {
    showNotice('success', '已归档，可在上方「已归档」里找回')
    await refresh()
    notifySessionListChanged()
  } else {
    showNotice('error', `归档失败：${res.error}`)
  }
  const busy = { ...state.busy }
  delete busy[sessionId]
  patch({ busy })
}

export async function restore(sessionId: string): Promise<void> {
  if (state.busy[sessionId] !== undefined) return
  patch({ busy: { ...state.busy, [sessionId]: 'restore' } })
  const res = await postRestore(sessionId)
  if (res.ok) {
    showNotice('success', '已恢复，该对话已回到工作区列表')
    await refresh()
    notifySessionListChanged()
  } else {
    showNotice('error', `恢复失败：${res.error}`)
  }
  const busy = { ...state.busy }
  delete busy[sessionId]
  patch({ busy })
}

export async function remove(sessionId: string): Promise<void> {
  if (state.busy[sessionId] !== undefined) return
  patch({ busy: { ...state.busy, [sessionId]: 'delete' } })
  const res = await postDelete(sessionId)
  if (res.ok) {
    await refresh()
    // 复核：宿主若还在跑旧版删除逻辑（官方 delete 只删当前 generation，或干脆返回
    // false），会话会「删完又回到未分组」。列表里还能看到就必须明说，绝不谎报成功。
    const stillListed =
      state.rows.some((row) => row.sessionId === sessionId) ||
      state.ungrouped.some((row) => row.sessionId === sessionId)
    if (stillListed) {
      showNotice('error', '删除未生效：会话记录仍然存在（宿主可能未加载新版插件，重启 DSH 后再试）')
    } else {
      showNotice('success', '已彻底删除，该对话无法恢复')
      notifySessionListChanged()
    }
  } else {
    showNotice('error', `删除失败：${res.error}`)
  }
  const busy = { ...state.busy }
  delete busy[sessionId]
  patch({ busy })
}
