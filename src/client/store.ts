/**
 * Tiny module-level UI store with a subscribe() API (external-store style).
 * Components use `useUi` to select slices; `refresh` uses latest-wins
 * sequencing so overlapping fetches can never apply stale data.
 */
import { useSyncExternalStore } from 'react'
import { getArchived, postDelete, postRestore } from './api'
import type { ArchivedRow } from './api'

export interface Notice {
  id: number
  kind: 'success' | 'error'
  text: string
}

export type BusyKind = 'restore' | 'delete'

interface UiState {
  open: boolean
  rows: ArchivedRow[]
  phase: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  busy: Record<string, BusyKind>
  notice: Notice | null
}

const state: UiState = {
  open: false,
  rows: [],
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

export function refresh(): Promise<void> {
  const mySeq = ++refreshSeq
  if (state.phase !== 'ready') patch({ phase: 'loading' })
  return getArchived()
    .then((res) => {
      if (mySeq !== refreshSeq) return
      if (res.ok) patch({ rows: res.data, phase: 'ready', error: null })
      else patch({ phase: 'error', error: res.error })
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
    showNotice('success', '已彻底删除，该对话无法恢复')
    await refresh()
    notifySessionListChanged()
  } else {
    showNotice('error', `删除失败：${res.error}`)
  }
  const busy = { ...state.busy }
  delete busy[sessionId]
  patch({ busy })
}
