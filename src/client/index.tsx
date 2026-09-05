/**
 * dsh-archive-dialog client half.
 *
 * Registers two additive seats:
 *  - `sidebar.footer.action` → 「归档对话」按钮（设置旁，打开面板）
 *  - `shell.overlay`         → 悬浮面板（已归档列表 + 恢复 + 删除二次确认）
 * 数据来自 host 的 `/plugins/dsh-archive-dialog` 路由（同源 fetch）。
 */
import { Panel, Trigger } from './components'
import { refresh } from './store'
import { css } from './style'

/** Plugin identity for the client bundle id (same as the host row). */
export const name = 'dsh-archive-dialog'

/** Services required before apply. */
export const inject = ['slots']

type Disposer = () => void

interface SlotsFace {
  inject(key: string, callback: () => Disposer): Disposer
  register(registration: Record<string, unknown>, render: (props: unknown) => unknown): Disposer
}

interface ClientCtx {
  slots?: SlotsFace
  effect?(fn: () => (() => void) | void, label?: string): unknown
}

export function apply(ctx: ClientCtx): void {
  // 独立样式表：模块加载器会在卸载时回收 <style data-plugin="…">
  if (typeof document !== 'undefined') {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-archive-dialog'
    tag.textContent = css
    document.head.appendChild(tag)
  }

  // 预热列表：让侧栏按钮的角标在未打开面板时也能显示数量
  void refresh()

  const slots = ctx.slots
  if (slots === undefined) return

  const registerTrigger = (): Disposer =>
    slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-archive-dialog-trigger', order: 100, label: '归档对话' },
      (props) => <Trigger wide={Boolean((props as { wide?: boolean } | undefined)?.wide)} />,
    )

  const registerPanel = (): Disposer =>
    slots.register(
      { name: 'shell.overlay', id: 'dsh-archive-dialog-panel', order: 300, label: '归档对话' },
      () => <Panel />,
    )

  if (ctx.effect !== undefined) {
    ctx.effect(() => slots.inject('sidebar.footer.action', registerTrigger), 'dsh-archive-dialog: sidebar trigger')
    ctx.effect(() => slots.inject('shell.overlay', registerPanel), 'dsh-archive-dialog: overlay panel')
  } else {
    slots.inject('sidebar.footer.action', registerTrigger)
    slots.inject('shell.overlay', registerPanel)
  }
}
