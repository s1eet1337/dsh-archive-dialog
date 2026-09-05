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
- **彻底删除**：取消归档 → `detachSession` 移出工作区记账 → 删除会话日志
  目录（`<DSH_HOME>/sessions/...`，删除前校验目录内确有会话日志文件）→
  清理投影缓存。拒绝删除正在打开/运行的会话。

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
- 删除前双重保险：面板内二次确认 + Host 端校验（拒绝删除运行中的会话、
  目标目录必须包含会话日志文件才执行删除）；
- 恢复/删除只改注册表，不触碰其他数据。
