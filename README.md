# dsh-archive-dialog · 归档对话

给 DSH（DeepSeek Harness 桌面 / Web）加一个「归档对话」面板的插件：

- 左侧栏底部（设置按钮旁）新增 **「归档对话」按钮**；
- 点开弹出悬浮面板，**直接看到所有已归档的对话**（标题、所属工作区、归档时间）；
- 每条对话可 **恢复**（立即回到工作区列表，全界面自动刷新）或 **彻底删除**；
- **彻底删除前必须二次确认**，确认文案写明「删除后无法恢复」。

> 归档动作本身复用 DSH 自带功能（会话右键菜单里的「归档会话」），本插件不重复实现。

## 原理

DSH 的归档 = 工作区注册表（`storages/workspace.json`）全局状态里的
`archivedSessionIds` 列表。本插件：

- **读**：Host 注册 `GET /plugins/dsh-archive-dialog/archived`，把归档 ID 列表
  拼上会话标题（来自持久化 header）和工作区信息返回给面板；
- **恢复**：走 `workspaceRegistry` 的公开写入路径（`setState`，与官方
  `archiveSession` 完全同一条链）把 ID 从集合移除 → 官方 `domain/changed`
  feed 自动推送前端刷新，**无需刷新页面**；
- **彻底删除**：仅拒绝删除**真正在执行**（agent 忙碌：运行/后台维护）的会话；
  已打开但空闲的会话照常删除——先落盘（`sessions.flush`）再删文件、删完清空
  agent 收件箱，保证退出时不会把已删会话重新写回 → `detachSession` 移出工作区
  记账 → 删除会话日志目录（`<DSH_HOME>/sessions/...`，删除前校验目录内确有
  会话日志文件）→ 清理投影缓存。删除后**不取消归档**：id 留在归档集合当
  「墓碑」，DSH 会把归档会话从所有分组（含未分组）隐藏，因此即使会话的 agent
  还在内存里驻留、客户端列表没刷新，侧栏也绝不会冒出「未分组」幽灵；无日志的
  墓碑行面板不再展示，并在下次打开面板 / 删除时自动从注册表清除。

> 说明一：DSH 中“曾经打开过”的会话其 agent 会一直驻留到进程退出——驻留 ≠ 在运行。
> 本插件以 agent 的实际活动状态（与官方列表的 running 语义一致）判断是否可删，
> 因此归档后不必重启即可删除本进程内打开过的对话。
>
> 说明二：删除会保留归档集合里的墓碑 id 直到 DSH 重启后（那时驻留 agent 已消失），
> 面板的列表接口会自动清理这类残留——这只是为了让界面始终干净，不影响任何功能。

所有写入都经过注册表公开方法，绝不直接改 `workspace.json`（官方 invariant
明确禁止绕过注册表的写入路径）。

## 项目结构

```
├── package.json            # dsh.bundle.patch + dsh.client manifest + exports
├── cordis.patch.yml        # 向 host 组合插入插件行
├── tsconfig.json           # host 程序（Node ESM）
├── tsconfig.client.json    # client 程序（CommonJS → 浏览器 bundle）
├── scripts/
│   ├── build.mjs           # tsc 双程序 + client bundle 拼接（无打包器依赖）
│   └── verify.mjs          # 离线冒烟：路径编码回归 + 恢复/删除文件往返
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
- 恢复/删除只改注册表，不触碰其他数据。
