# dsh-archive-dialog · 归档对话

给 DSH（DeepSeek Harness 桌面 / Web）加一个「归档对话」面板的插件：

- 左侧栏底部（设置按钮旁）新增 **「归档对话」按钮**；
- 点开弹出悬浮面板，分两节：**已归档** 与 **未分组**（标题、所属工作区、时间）；
- 已归档行可 **恢复**（立即回到工作区列表，全界面自动刷新）或 **彻底删除**；
- 未分组行可 **归档**（收进「已归档」节，同时从侧栏所有分组消失）或 **彻底删除**；
- **彻底删除前必须二次确认**，确认文案写明「删除后无法恢复」。

> 「未分组」是工作区里那类既不属于任何工作区、又没有归档记录的会话。DSH 自带
> 右键菜单对它们常常够不着：**归档**走 `workspaceRegistry.archiveSession`，
> 官方要求会话 `sessionKnown`，而残影既不驻留内存、也没有持久化产物；**删除**
> 在 DSH 0.2.0-rc.2 上**根本没有官方入口**——`sessionPersistence` 只提供
> `create / open / stat / list / flush`，会话菜单文案也只有「归档会话 / 取消归档」。
> 历史残留（工作区被删、日志被外部清掉、驻留僵尸）于是永远挂在侧栏删不掉。
> 本插件把它们列进面板，用自己的链路处理：归档优先走官方、官方**仅以「会话未知」
> 拒绝**时退回注册表 `setState`（同一条持久化写入路径，绝不绕过注册表）；删除复用
> 插件已验证的「先落盘 → 删日志 → 清记账 → 补墓碑」流程。

> 侧栏里正常的归档动作仍然复用 DSH 自带功能（会话右键菜单里的「归档会话」）；
> 插件只负责官方链路够不到的那部分（未分组残影）。

## 原理

DSH 的归档 = 工作区注册表（`storages/workspace.json`）全局状态里的
`archivedSessionIds` 列表。本插件：

- **读**：Host 注册 `GET /plugins/dsh-archive-dialog/archived`（已归档 id 列表）与
  `GET /plugins/dsh-archive-dialog/ungrouped`（未分组会话），拼上会话标题（来自持久化
  header / `sessionQuery`）和工作区信息返回给面板；
- **归档**（未分组行）：优先 `workspaceRegistry.archiveSession()`；官方**以
  `WorkspaceUnknownSessionError` 拒绝**（会话不在内存也不在持久化层）时退回 `setState`
  把 ID 加进集合 → 官方 `domain/changed` feed 自动推送前端刷新，**无需刷新页面**。
  官方以别的理由拒绝——最典型的是 `WorkspaceActiveSessionError`（会话正在执行，
  官方 UI 会先要求确认/停止）——插件**原样上抛**，绝不绕过这道守卫；
- **恢复**：优先官方 `workspaceRegistry.unarchiveSession()`（0.2.0-rc.2 起已提供）；
  官方没生效（集合里还留着）或报「会话未知」时退回 `setState` 移除 ID →
  `domain/changed` 自动推送前端刷新，**无需刷新页面**；
- **彻底删除**：仅拒绝删除**真正在执行**（agent 忙碌：运行/后台维护）的会话；
  已打开但空闲的会话照常删除——先落盘（`sessions.flush`）再删文件、删完清空
  agent 收件箱，保证退出时不会把已删会话重新写回 → `detachSession` 移出工作区
  记账 → 删除会话日志目录（`<DSH_HOME>/sessions/...`，删除前校验目录内确有
  会话日志文件）→ 清理投影缓存 → **确保归档集合里留下墓碑**。墓碑是关键：
  DSH 的 `sessionVisible` 只看归档集合，删掉日志并不足以让一行消失（驻留 agent
  还在内存里，客户端列表也没刷新）。所以删除后一律把 id 写进归档集合——即使它
  删之前根本没被归档（未分组对话），这样侧栏才不会立刻再冒出同一行的「未分组」残影；
  无日志的墓碑行面板不再展示，并在下次打开面板 / 删除时自动从注册表清除。
  （0.2.0-rc.2 的持久化层没有 `delete()`，所以删除一律走上面这条本地链路；
  代码里保留了「宿主若提供官方 `delete` 则先走官方并用 `stat` 复核」的兼容分支。）

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

对照真实宿主（`app.asar`）逐条核验过的版本：**DSH 0.2.0-rc.2（桌面 = 运行时 =
0.2.0-rc.2）**，会话日志格式 **v4**。此前的说明以 0.1.5-rc.2 / 桌面 0.9.0 为基线，
下列差异已按实机修正：

- `sessionPersistence.list()` 自 0.1.5-rc.2 起返回 snapshot（`{ header, revision,
  sizeBytes }`），更早版本直接返回 header；两者都支持（回归用例见 `scripts/verify.mjs`）。
- `sessionPersistence.stat()` 在会话不存在时返回 `undefined`（不抛错），删除后的
  磁盘复核据此判断。
- **0.2.0-rc.2 的持久化层没有 `delete()`**：官方菜单也没有删除入口，删除完全由本插件承担。
- `workspaceRegistry.unarchiveSession()` **已存在**（插件探测到即走官方）；
  `workspaceRegistry.forgetSession()` **不存在**（插件从不依赖它，只用自己的
  `detachSession` 清记账）。
- 会话日志文件名覆盖所有 generation：`session.jsonl`、`session.jsonl.zstd`、
  `session.vN.jsonl.zstd`（当前为 `session.v4.jsonl.zstd`）。
- v3+ header 不再自带 `title`：标题改由 `sessionQuery.readTitleSnapshots()` 从日志折取。
  该接口在 0.2.0-rc.2 返回的是 `projectMany` 结算记录
  （`{ sessionId, status, value: { session, title? } }`），插件同时兼容旧的
  `{ header, title }` 直给形状；取不到标题就回退显示 sessionId（绝不因缺标题而隐藏行）。
- 删除/清理都带**磁盘二次证伪**：持久化列表异常（形状变化、根目录错位）时，
  只要日志目录还在，就不会把有效归档当墓碑误清。
- 会话 id 不都是 `session-<uuid>`：子代理会话与老存储用裸 uuid（例如
  `d5b8e663-…`），它们必须能归档 / 恢复 / 删除，`isSafeSessionId` 因此只挡
  空串、路径分隔符、路径穿越、控制字符与超长 id。
- 侧栏的归档过滤器（`archivedFilter`）有 `default / show / only` 三态：默认态下
  归档集合就是隐藏依据（墓碑策略成立）；切到「显示归档」时是另一套语义，属预期行为。
- 插件删除的投影缓存是 `<DSH_HOME>/storages/session_projcache/sessions/<key>.json`，
  与官方 per-record 存储一致（对 UUID 形状的 id，`encodeSegment` 就是原始 key）。

## 官方优先（自动让位）

插件对官方能力做运行时探测：官方有就走官方链路，官方没有才用本地实现。

| 能力 | 官方 API（0.2.0-rc.2 实测） | 插件行为 |
| --- | --- | --- |
| 彻底删除 | **不存在**（`sessionPersistence` 只有 `create/open/stat/list/flush`，菜单无删除项） | 走本地链路：flush → 校验后删日志目录 → 清缓存 → `detachSession` → 留归档墓碑。代码保留「宿主若提供 `delete()` 则先走官方 + `stat` 复核」的兼容分支，但本机不执行 |
| 归档 | `workspaceRegistry.archiveSession()`（先校验 `sessionKnown`，再校验 `WorkspaceActiveSessionError`） | 非驻留会话直接走官方；官方**仅以 `WorkspaceUnknownSessionError`** 拒绝「未分组」残影时退回 `setState`；以「会话正在执行」等其它理由拒绝时**原样上抛**，不绕过守卫 |
| 取消归档 | `workspaceRegistry.unarchiveSession()`（**已提供**） | 走官方；官方报「会话未知」或调用后集合没变（静默无效）时退回 `setState` 本地写入 |
| 未分组列表 | 无此能力 | 持久化列表 ∪ 本进程驻留会话，扣除已归档 / 已记账 / 子代理（`origin === 'subagent'`） |
| 会话标题 | `sessionQuery.readTitleSnapshots()` | 读 `projectMany` 结算记录（`value.session` + `value.title`），兼容旧形状；取不到回退 sessionId |
| 侧栏刷新 | 客户端 `sessions.refresh()`（未文档化） | 惰性可选调用：拿不到就退化成等下一次列表刷新，**不作为硬依赖** |
| 记账清理 | `forgetSession()` **不存在** | 从不调用；记账由插件自己 `detachSession` 清（归档标记留作墓碑，避免闪回） |

官方哪天补齐这些能力，本插件会自动降级成「增强面板」，不会和官方链路打架。

## 变更（0.1.5）

对照真实宿主（0.2.0-rc.2 的 `app.asar`）逐条核验后修掉的问题：

1. **标题链路失效（静默）**：`readTitleSnapshots()` 的真实返回是 `projectMany` 结算记录
   `{ sessionId, status, value: { session, title? } }`，旧代码按 `{ header, title }` 读 →
   标题永远折取不到，面板每一行都显示裸 sessionId。现在两种形状都认（含回归用例）。
2. **归档绕过官方守卫**：官方 `archiveSession` 除 `sessionKnown` 外还有
   `WorkspaceActiveSessionError`（会话正在执行）。旧代码 `catch {}` 后一律回退
   `setState`，等于把这道守卫绕过去了；现在只对 `WorkspaceUnknownSessionError`
   回退，其它错误原样上抛给面板。
3. **恢复缺少复核**：官方 `unarchiveSession()` 没报错也可能没生效；现在复核归档集合，
   没生效就落回本地 `setState`，官方报「会话未知」时同样回退（与归档路径对称）。
4. **路由语义**：非法参数 → 400、请求体 > 64 KB → 413、宿主侧故障 → 500
   （此前一律 200 + `{ok:false}`）；响应体仍是 JSON，客户端行为不变。
5. **客户端激活风险**：`inject` 由 `['slots','sessions']` 收窄为 `['slots']`，
   `sessions.refresh()` 改为惰性可选调用——未文档化 API 一旦改名，不会再让整个
   插件（连按钮）都不激活。
6. **bundle 加载器**：改为返回 `m.exports`（避免分片用 `module.exports = X` 时拿到
   陈旧对象），并支持 `./x.js`、`./dir/index.js` 两种相对解析。
7. **测试**：新增客户端套件 `scripts/verify-client.mjs`（10 项，临时编译 + react/fetch
   替身驱动 store）；host 侧补 10 条真实宿主契约回归（标题形状、守卫上抛、恢复复核、
   路由状态码、请求体上限）。`npm run verify` 现在跑 host 46 + client 10。
8. **仓库卫生**：补 `LICENSE`（MIT，加入 `files`）、`dsh.testedWith`，
   DSH agent-team 运行产物目录 `.agent-teams/` 加入 `.gitignore`。

## 项目结构

```
├── package.json            # dsh.bundle.patch + dsh.client manifest + exports
├── cordis.patch.yml        # 向 host 组合插入插件行
├── LICENSE                 # MIT
├── tsconfig.json           # host 程序（Node ESM）
├── tsconfig.client.json    # client 程序（CommonJS → 浏览器 bundle）
├── scripts/
│   ├── build.mjs           # tsc 双程序 + client bundle 拼接（无打包器依赖）
│   ├── verify.mjs          # host 离线冒烟：路径编码 + 归档/恢复/删除 + 真实宿主契约回归
│   └── verify-client.mjs   # client 离线冒烟：临时编译 + react 替身 + fetch 替身驱动 store
└── src/
    ├── index.ts            # host 入口：注册 /plugins/dsh-archive-dialog 路由
    ├── context.ts          # 结构化服务面（不 import dsh 类型包）
    ├── host/
    │   ├── archive.ts      # 列表 / 归档 / 恢复 / 删除 / 墓碑清理
    │   ├── paths.ts        # DSH home、会话目录编码（与持久化层一致）
    │   └── wire.ts         # JSON 响应 + 同源围栏 + 请求体上限
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
npm run verify      # 离线冒烟（先 build）：host 46 项 + client 10 项
```

`verify-client.mjs` 会把客户端程序编译到系统临时目录，用极小的 react / fetch 替身
在 Node 里驱动 `store`，因此**不需要浏览器、也不需要 DSH 在跑**；没装 typescript
时它会打印跳过信息并正常退出（消费方 profile 里通常没有 typescript）。

## 安装到 DSH

本项目是「本地目录」插件，安装方式与 `dsh-usage-monitor` 相同。**profile 名要按实际
环境取**（由 `DSH_PROFILE` 决定；本机是 `desktop`，不是 `web`）：

1. 先构建：`npm run build`（确保 `lib/` 存在）；
2. 编辑 `<DSH_HOME>/profiles/<profile>/package.json`：
   - `dependencies` 里加一行
     `"dsh-archive-dialog": "link:<本项目绝对路径>"`；
   - `dsh.profile.bundles` 数组末尾加 `"dsh-archive-dialog"`；
3. 在该 profile 目录里执行 `pnpm install`；
4. 重启 DSH（client 包注册表在进程内缓存，新增插件必须重启）。

> 也可用官方 CLI：`dsh plugin --profile <profile> add <本项目绝对路径>`。
> 装好后自检：`curl http://127.0.0.1:<端口>/plugins/dsh-archive-dialog/archived`
> 应返回 `{"ok":true,...}`（未安装时是 DSH 自己的 404 页面）。

## 卸载

从该 profile 的 `package.json` 移除 dependencies 与 bundles 里的条目，重新
`pnpm install` 并重启 DSH。插件本身不保存任何自有状态，卸载无残留
（删除动作在归档集合里留下的墓碑会在下次启动后由面板自动回收）。

## 安全

- HTTP 路由仅接受本机同源请求（Host / Origin / sec-fetch-site 校验）；
- 请求体上限 64 KB（超限 → 413），参数非法 → 400，宿主侧故障 → 500，
  响应体始终是 JSON，面板照旧读取 `error` 文案；
- 删除前双重保险：面板内二次确认 + Host 端校验（仅拒绝真正执行中的会话、
  删除前先落盘、目标目录必须包含会话日志文件才执行删除、删除后清空驻留
  agent 的收件箱防止写回）；
- 路由参数校验：`sessionId` 必须通过 `isSafeSessionId`（无路径分隔符 / 无穿越）
  才会进入路径拼接；
- 归档不绕过官方守卫：官方以「会话正在执行」拒绝时插件原样上抛，不做本地兜底；
- 归档/恢复/删除只改注册表与目标会话自己的日志，不触碰其他数据。
