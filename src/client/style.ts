/**
 * dsh-archive-dialog 的独立样式表。颜色全部走 DSH 主题 token
 * (`--dsw-alias-*`)，自动适配浅色/深色主题；`<style data-plugin>` 标签
 * 由模块加载器在插件卸载时统一回收。
 */
export const css = `
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

.ad-list {
  margin: 0;
  padding: 6px;
  list-style: none;
  overflow-y: auto;
  flex: 1 1 auto;
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
`
