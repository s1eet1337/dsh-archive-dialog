# dsh-archive-dialog · 归档对话

给 DSH（DeepSeek Harness 桌面 / Web）加一个「归档对话」面板的插件：

- 左侧栏底部（设置按钮旁）新增 **「归档对话」按钮**；
- 点开弹出悬浮面板，分两节：**已归档** 与 **未分组**（标题、所属工作区、时间）；
- 已归档行可 **恢复**（立即回到工作区列表，全界面自动刷新）或 **彻底删除**；
- 未分组行可 **归档**（收进「已归档」节，同时从侧栏所有分组消失）或 **彻底删除**；
- **彻底删除前必须二次确认**，确认文案写明「删除后无法恢复」。

> 「未分组」是工作区里那类既不属于任何工作区、又没有归档记录的会话。DSH 自带
> 右键菜单对它们常常两头落空：**归档**走 `workspaceRegistry.archiveSession`，
> 官方要求会话 `sessionKnown`；**删除**走 `sessionPersistence.delete`，官方要求
> 持久化产物还在。历史残留（工作区被删、日志被外部清掉、驻留僵尸）正好两条都不满足，
> 于是这些行永远挂在侧栏删不掉。本插件把它们列进面板，用自己的链路处理：
> 归档优先走官方、官方拒绝时退回注册表 `setState`（同一条持久化写入路径，绝不绕过
> 注册表）；删除复用插件已验证的「先落盘 → 删日志 → 清记账 → 补墓碑」流程。

> 侧栏里正常的归档动作仍然复用 DSH 自带功能（会话右键菜单里的「归档会话」）；
> 插件只负责官方链路够不到的那部分（未分组残影）。

## 原理

DSH 的归档 = 工作区注册表（`storages/workspace.json`）全局状态里的
`archivedSessionIds` 列表。本插件：

- **读**：Host 注册 `GET /plugins/dsh-archive-dialog/archived`（已归档 id 列表）与
  `GET /plugins/dsh-archive-dialog/ungrouped`（未分组会话），拼上会话标题（来自持久化
  header / `sessionQuery`）和工作区信息返回给面板；
- **归档**（未分组行）：优先 `workspaceRegistry.archiveSession()`；官方因
  `sessionKnown` 校验拒绝时退回 `setState` 把 ID 加进集合 → 官方 `domain/changed`
  feed 自动推送前端刷新，**无需刷新页面**；
- **恢复**：走 `workspaceRegistry` 的公开写入路径（`setState`，与官方
  `archiveSession` 完全同一条链）把 ID 从集合移除 → 官方 `domain/changed`
  feed 自动推送前端刷新，**无需刷新页面**；
- **彻底删除**：仅拒绝删除**真正在执行**（agent 忙碌：运行/后台维护）的会话；
  已打开但空闲的会话照常删除——先落盘（`sessions.flush`）再删文件、删完清空
  agent 收件箱，保证退出时不会把已删会话重新写回 → `detachSession` 移出工作区
  记账 → 删除会话日志目录（`<DSH_HOME>/sessions/...`，删除前校验目录内确有
  会话日志文件）→ 清理投影缓存 → **确保归档集合里留下墓碑**。墓碑是关键：
  DSH 的 `sessionVisible` 只看归档集合，删掉日志并不足以让一行消失（驻留 agent
  还在内存里，客户端列表也没刷新）。所以删除后一律把 id 写进归档集合——即使它
  删之前根本没被归档（未分组对话），这样侧栏才不会立刻再冒出同一行的「未分组」残影；
  无日志的墓碑行面板不再展示，并在下次打开面板 / 删除时自动从注册表清除。

> 说明一：DSH 中“曾经打开过”的会话其 agent 会一直驻留到进程退出——驻留 ≠ 在运行。
> 本插件以 agent 的实际活动状态（与官方列表的 running 语义一致）判断是否可删，
> 因此归档后不必重启即可删除本进程内打开过的对话。
>
> 说明二：删除会保留归档集合里的墓碑 id，**并且本进程内不会再清理它**：前端会话列表是
> 异步刷新的，墓碑若在删除当下就被清掉，前端会先收到「取消归档」推送、再等列表刷新，
> 中间那一瞬它仍持有这一行，于是侧栏把这一行渲染回「未分组」——也就是「删完一闪而过」。
> 墓碑要等 DSH 重启（进程结束，这些 id 也不可能再出现在任何列表里）后，由面板的列表
> 接口自动回收。这只是为了让界面始终干净，不影响任何功能。

所有写入都经过注册表公开方法，绝不直接改 `workspace.json`（官方 invariant
明确禁止绕过注册表的写入路径）。

## 兼容性

- **DSH 0.1.5-rc.2（桌面 0.9.0）** 起 `sessionPersistence.list()` 返回的是
  snapshot（`{ header, revision, sizeBytes }`），更早版本直接返回 header；
  两者都支持（回归用例见 `scripts/verify.mjs`）。
- 会话日志文件名覆盖所有 generation：`session.jsonl`、`session.jsonl.zstd`、
  `session.vN.jsonl.zstd`（v3 迁移后为 `session.v3.jsonl.zstd`）。
- v3 header 不再自带 `title`：标题改由 `sessionQuery.readTitleSnapshots()`
  从日志折取，取不到就回退显示 sessionId（绝不因缺标题而隐藏行）。
- 删除/清理都带**磁盘二次证伪**：持久化列表异常（形状变化、根目录错位）时，
  只要日志目录还在，就不会把有效归档当墓碑误清。
- 官方 `sessionPersistence.delete()` 只 `rm` **当前 generation** 的文件
  （`session.v3.jsonl.zstd`）：从未迁移到 v3 的老会话（只有 `session.jsonl.zstd`）
  它会返回 `false`，DSH 自带删除于是报 `session/not-found`；迁移过但留着旧
  generation 的会话它会返回 `true` 却删不干净 —— 刷新一下又回来了。插件不采信
  这个返回值，删完用 `stat` 复核磁盘，删不干净就整目录删除（回归用例见
  `scripts/verify.mjs`）。
- 会话 id 不都是 `session-<uuid>`：子代理会话与老存储用裸 uuid，旧路由的
  `/^session-[A-Za-z0-9-]+$/` 会把它们判成「无效的 sessionId」而拒绝操作；
  现在只排除空串、路径分隔符、路径穿越、控制字符与超长 id（`isSafeSessionId`）。

## 官方优先（自动让位）

插件对官方能力做运行时探测：官方有就走官方链路，官方没有才用本地实现。

| 能力 | 官方 API | 插件行为 |
| --- | --- | --- |
| 彻底删除 | `sessionPersistence.delete()`（0.1.5-rc.2 起） | 非驻留会话先走官方（写锁 / 目录租约 / generation 文件名全交给官方），**删完用 `stat` 复核**：官方只删当前 generation 文件，删不干净或直接返回 false 时落到本地整目录删除；老宿主或驻留（idle 僵尸）会话直接走本地。收尾统一由插件自己 `detachSession` 记账 + 留归档墓碑，**刻意不调 `forgetSession`**（它会解除归档隐藏，让前端闪回「未分组」） |
| 归档 | `workspaceRegistry.archiveSession()`（要求会话 `sessionKnown`） | 非驻留会话直接走官方；官方以 `WorkspaceUnknownSessionError` 拒绝「未分组」残影时退回 `setState` 本地写入 |
| 取消归档 | `workspaceRegistry.unarchiveSession()`（官方尚未提供） | 探测到即走官方；没有则 `setState` 本地回退 |
| 未分组列表 | 官方无此能力 | 持久化列表 ∪ 本进程驻留会话，扣除已归档 / 已记账 / 子代理 |
| 会话标题 | `sessionQuery.readTitleSnapshots()` | v3 header 无 title 时从日志折取，取不到回退 sessionId |

官方哪天把归档找回补上，本插件会自动降级成「增强面板」，不会和官方链路打架。

## 项目结构

```
├── package.json            # dsh.bundle.patch + dsh.client manifest + exports
├── cordis.patch.yml        # 向 host 组合插入插件行
├── tsconfig.json           # host 程序（Node ESM）
├── tsconfig.client.json    # client 程序（CommonJS → 浏览器 bundle）
├── scripts/
│   ├── build.mjs           # tsc 双程序 + client bundle 拼接（无打包器依赖）
│   └── verify.mjs          # 离线冒烟：路径编码回归 + 归档/恢复/删除文件往返
└── src/
    ├── index.ts            # host 入口：注册 /plugins/dsh-archive-dialog 路由
    ├── context.ts          # 结构化服务面（不 import dsh 类型包）
    ├── host/
    │   ├── archive.ts      # 列表 / 恢复 / 删除 业务逻辑
    │   ├── paths.ts        # DSH home、会话目录编码（与持久化层一致）
    │   └── wire.ts         # JSON 响应 + 同源请求围栏
    └── client/
        ├── index.tsx       # client 入口：注册侧栏按钮 + 悬浮面板
        ├── components.tsx  # Trigger / Panel / Row（删除二次确认）
        ├── store.ts        # 面板状态 + 列表刷新（latest-wins）
        ├── api.ts          # 同源 fetch（响应形状校验）
        └── style.ts        # 独立样式（主题 token，浅/深色自适应）
```

## 开发

```sh
npm install
npm run typecheck   # 双程序类型检查
npm run build       # host ESM + client bundle → lib/
npm run verify      # 离线冒烟测试（先 build）
```

## 安装到 DSH（桌面版）

本项目是「本地目录」插件，安装方式与 `dsh-usage-monitor` 相同：

1. 先构建：`npm run build`（确保 `lib/` 存在）；
2. 编辑 `<DSH_HOME>/profiles/web/package.json`：
   - `dependencies` 里加一行
     `"dsh-archive-dialog": "link:<本项目绝对路径>"`；
   - `dsh.profile.bundles` 数组末尾加 `"dsh-archive-dialog"`；
3. 在 `profiles/web` 目录里执行 `pnpm install`；
4. 重启 DSH 桌面应用（client 包注册表在进程内缓存，新增插件必须重启）。

> 也可用官方 CLI：`dsh plugin --profile web add <本项目绝对路径>`。

## 卸载

从 `profiles/web/package.json` 移除 dependencies 与 bundles 里的条目，重新
`pnpm install` 并重启 DSH。插件本身不保存任何自有状态，卸载无残留。

## 安全

- HTTP 路由仅接受本机同源请求（Host / Origin / sec-fetch-site 校验）；
- 删除前双重保险：面板内二次确认 + Host 端校验（仅拒绝真正执行中的会话、
  删除前先落盘、目标目录必须包含会话日志文件才执行删除、删除后清空驻留
  agent 的收件箱防止写回）；
- 路由参数校验：`sessionId` 必须通过 `isSafeSessionId`（无路径分隔符 / 无穿越）
  才会进入路径拼接；
- 归档/恢复/删除只改注册表与目标会话自己的日志，不触碰其他数据。
