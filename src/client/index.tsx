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
import { Panel, Trigger } from './components'
import { refresh, setSessionListRefresher } from './store'
import { css } from './style'

/** Plugin identity for the client bundle id (same as the host row). */
export const name = 'dsh-archive-dialog'

/**
 * 只硬依赖 `slots`（按钮 + 面板的注册面）。
 *
 * `sessions.refresh()` 能立刻让侧栏丢掉已删/已恢复的行，但它是**未文档化**的服务方法：
 * 一旦改名，硬 inject 会让整个插件不激活（按钮都出不来），代价远大于收益。这里改成
 * 惰性可选获取——拿不到就退化成"等下一次列表刷新"，功能不受影响。
 */
export const inject = ['slots']

type Disposer = () => void

interface SlotsFace {
  inject(key: string, callback: () => Disposer): Disposer
  register(registration: Record<string, unknown>, render: (props: unknown) => unknown): Disposer
}

interface SessionsServiceFace {
  /** 重新拉取会话基线（host 端会顺带把搜索索引与磁盘对账）。 */
  refresh?(): unknown
}

interface ClientCtx {
  slots?: SlotsFace
  sessions?: SessionsServiceFace
  effect?(fn: () => (() => void) | void, label?: string): unknown
  /** 从客户端作用域里取官方服务。 */
  get?(key: string): unknown
}

/**
 * 惰性解析官方会话服务：`sessions` 不再列入 inject，所以它既可能在 apply 时还没就绪，
 * 也可能这个宿主根本没有它。**每次调用时**重新解析，拿不到就静默降级。
 */
function resolveSessions(ctx: ClientCtx): SessionsServiceFace | undefined {
  try {
    if (ctx.sessions !== undefined) return ctx.sessions
    return ctx.get?.('sessions') as SessionsServiceFace | undefined
  } catch {
    return undefined
  }
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

  // 恢复/删除成功后刷新 DSH 官方会话列表。只读不写：拿不到服务或没有 refresh()
  // 时静默降级（行会等下次重连才消失）。
  setSessionListRefresher(() => {
    try {
      const sessions = resolveSessions(ctx)
      if (sessions !== undefined && typeof sessions.refresh === 'function') void sessions.refresh()
    } catch (err) {
      console.warn('[dsh-archive-dialog] session list refresh unavailable:', err)
    }
  })

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
