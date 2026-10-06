/**
 * React components for dsh-archive-dialog's web UI.
 *  - `Trigger` → sidebar.footer.action（左侧栏底部按钮，打开面板）
 *  - `Panel`   → shell.overlay（悬浮面板：已归档 + 未分组列表，恢复/归档/删除二次确认）
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ArchivedRow } from './api'
import { archive, dismissNotice, refresh, remove, restore, setOpen, toggleOpen, useUi } from './store'
import type { BusyKind } from './store'

/* ================================================================== *
 * Trigger — 左侧栏底部按钮
 * ================================================================== */

export function Trigger(props: { wide?: boolean }): ReactElement {
  const open = useUi((s) => s.open)
  const archived = useUi((s) => s.rows.length)
  const ungrouped = useUi((s) => s.ungrouped.length)
  const count = archived + ungrouped
  return (
    <button
      type="button"
      className="ad-trigger"
      aria-label="归档对话"
      title={count > 0 ? `归档对话（已归档 ${archived} · 未分组 ${ungrouped}）` : '归档对话'}
      aria-pressed={open}
      onClick={toggleOpen}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
        <path d="M10 13h4" />
      </svg>
      {props.wide === true ? <span className="ad-trigger-label">归档对话</span> : null}
      {count > 0 ? <span className="ad-count">{count > 99 ? '99+' : count}</span> : null}
    </button>
  )
}

/* ================================================================== *
 * Panel — 悬浮面板
 * ================================================================== */

export function Panel(): ReactElement | null {
  const open = useUi((s) => s.open)
  const rows = useUi((s) => s.rows)
  const ungrouped = useUi((s) => s.ungrouped)
  const total = rows.length + ungrouped.length
  const phase = useUi((s) => s.phase)
  const error = useUi((s) => s.error)
  const busy = useUi((s) => s.busy)
  const notice = useUi((s) => s.notice)
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (!open) setConfirming(null)
  }, [open])

  if (!open) return null

  return (
    <div className="ad-panel" role="dialog" aria-label="归档对话">
      <header className="ad-panel-header">
        <div className="ad-panel-title">
          归档对话
          {total > 0 ? <span className="ad-panel-count">{total} 个</span> : null}
        </div>
        <button type="button" className="ad-icon-btn" aria-label="关闭" onClick={() => setOpen(false)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      {notice !== null ? (
        <div className={notice.kind === 'success' ? 'ad-notice ad-notice-ok' : 'ad-notice ad-notice-err'} role="status">
          <span>{notice.text}</span>
          <button type="button" className="ad-icon-btn" aria-label="关闭提示" onClick={dismissNotice}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : null}

      {phase === 'loading' ? (
        <div className="ad-empty">加载中…</div>
      ) : phase === 'error' ? (
        <div className="ad-empty ad-empty-err">
          {error ?? '加载失败'}
          <div>
            <button type="button" className="ad-btn" onClick={() => void refresh()}>重试</button>
          </div>
        </div>
      ) : rows.length === 0 && ungrouped.length === 0 ? (
        <div className="ad-empty">
          暂无归档或未分组的对话
          <div className="ad-hint">
            在会话列表右键菜单里使用 DSH 自带的「归档会话」，对话就会收进这里；
            工作区里残留的「未分组」对话也会列在这里，可直接归档或彻底删除
          </div>
        </div>
      ) : (
        <div className="ad-body">
          {rows.length > 0 ? (
            <section className="ad-section">
              <div className="ad-section-title">
                已归档<span className="ad-panel-count">{rows.length}</span>
              </div>
              <ul className="ad-list">
                {rows.map((row) => (
                  <Row
                    key={row.sessionId}
                    row={row}
                    archived
                    busy={busy[row.sessionId]}
                    confirming={confirming === row.sessionId}
                    onAskDelete={() => setConfirming(row.sessionId)}
                    onCancelDelete={() => setConfirming(null)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {ungrouped.length > 0 ? (
            <section className="ad-section">
              <div className="ad-section-title">
                未分组<span className="ad-panel-count">{ungrouped.length}</span>
              </div>
              <ul className="ad-list">
                {ungrouped.map((row) => (
                  <Row
                    key={row.sessionId}
                    row={row}
                    archived={false}
                    busy={busy[row.sessionId]}
                    confirming={confirming === row.sessionId}
                    onAskDelete={() => setConfirming(row.sessionId)}
                    onCancelDelete={() => setConfirming(null)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}

/* ================================================================== *
 * Row — 单条对话（已归档行 = 恢复；未分组行 = 归档）
 * ================================================================== */

function Row(props: {
  row: ArchivedRow
  /** true = 已归档行（动作是恢复）；false = 未分组行（动作是归档）。 */
  archived: boolean
  busy: BusyKind | undefined
  confirming: boolean
  onAskDelete: () => void
  onCancelDelete: () => void
}): ReactElement {
  const { row, archived, busy, confirming, onAskDelete, onCancelDelete } = props

  if (confirming) {
    return (
      <li className="ad-row ad-confirm">
        <div className="ad-confirm-text">确定彻底删除「{row.title}」？删除后无法恢复。</div>
        <div className="ad-confirm-actions">
          <button type="button" className="ad-btn" disabled={busy !== undefined} onClick={onCancelDelete}>取消</button>
          <button type="button" className="ad-btn ad-btn-danger" disabled={busy !== undefined} onClick={() => void remove(row.sessionId)}>
            {busy === 'delete' ? '删除中…' : '确认删除'}
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="ad-row">
      <div className="ad-row-main">
        <div className="ad-row-title" title={row.sessionId}>{row.title}</div>
        <div className="ad-row-meta">
          {row.workspaceTitle ?? (archived ? '未归入工作区' : '未分组')}
          {row.updatedAt !== null ? ` · ${relativeTime(row.updatedAt)}` : ''}
        </div>
      </div>
      <div className="ad-row-actions">
        {archived ? (
          <button type="button" className="ad-btn" disabled={busy !== undefined} onClick={() => void restore(row.sessionId)}>
            {busy === 'restore' ? '恢复中…' : '恢复'}
          </button>
        ) : (
          <button type="button" className="ad-btn" disabled={busy !== undefined} onClick={() => void archive(row.sessionId)}>
            {busy === 'archive' ? '归档中…' : '归档'}
          </button>
        )}
        <button type="button" className="ad-btn ad-btn-danger" disabled={busy !== undefined} onClick={onAskDelete}>
          {busy === 'delete' ? '删除中…' : '删除'}
        </button>
      </div>
    </li>
  )
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
