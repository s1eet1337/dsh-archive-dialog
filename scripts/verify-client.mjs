/**
 * 客户端离线冒烟（无需浏览器、无需 DSH 运行）：
 *   - 把 `tsconfig.client.json` 编译到临时目录（不改动 lib/）
 *   - 用极小的 react / react-jsx-runtime 替身让 CJS 产物能在 Node 里 require
 *   - 用可编程的 fetch 替身驱动 store：刷新、latest-wins、降级、删除复核、通知
 *
 * 运行：`npm run verify`（或 `npm run verify:client`）。
 * 没装 typescript（消费方 profile 里通常没有）时打印跳过信息并以 0 退出。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const CLIENT_CFG = join(root, 'tsconfig.client.json')

let ts = null
try {
  ts = require('typescript')
} catch {
  console.log('[verify:client] typescript not installed here — skipped (run `npm install` to enable)')
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * 1. 编译客户端程序到临时目录
 * ------------------------------------------------------------------ */

const workDir = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-client-'))
const stageDir = join(workDir, 'stage')

function compileClient() {
  const parsed = ts.getParsedCommandLineOfConfigFile(CLIENT_CFG, { outDir: stageDir }, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(d) {
      console.error('[verify:client] config:', ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    },
  })
  if (parsed === undefined) throw new Error(`failed to parse ${CLIENT_CFG}`)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const emit = program.emit()
  const errors = [...ts.getPreEmitDiagnostics(program), ...emit.diagnostics].filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  )
  if (errors.length > 0) {
    for (const d of errors) console.error('[verify:client]', ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    throw new Error(`client program has ${errors.length} error(s)`)
  }
}

/** 让 `require('react')` / `require('react/jsx-runtime')` 在 Node 里可用。 */
function writeReactStubs() {
  const reactDir = join(workDir, 'node_modules', 'react')
  mkdirSync(reactDir, { recursive: true })
  writeFileSync(join(reactDir, 'package.json'), JSON.stringify({ name: 'react', version: '0.0.0-stub', main: 'index.js' }))
  writeFileSync(
    join(reactDir, 'index.js'),
    [
      '// 测试替身：store/components 只用到这几个 hook 的取值语义。',
      'exports.useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();',
      'exports.useState = (initial) => [typeof initial === "function" ? initial() : initial, () => {}];',
      'exports.useEffect = () => {};',
      '',
    ].join('\n'),
  )
  writeFileSync(join(reactDir, 'jsx-runtime.js'), 'exports.jsx = () => null; exports.jsxs = () => null; exports.Fragment = {};\n')
}

/* ------------------------------------------------------------------ *
 * 2. 测试脚手架
 * ------------------------------------------------------------------ */

const tests = []
const check = (label, fn) => tests.push([label, fn])

const API = '/plugins/dsh-archive-dialog'

/** 可编程 fetch 替身：resolver(path, init) → { status?, body }。 */
function installFetch(resolver) {
  globalThis.fetch = async (path, init) => {
    const res = await resolver(String(path), init)
    return {
      status: res.status ?? 200,
      json: async () => res.body,
    }
  }
}

/** 宿主成功响应包：`{ ok: true, data }`。 */
const ok = (data) => ({ body: { ok: true, data } })
/** 列表类路由（/archived、/ungrouped）的数据是 `{ rows }`。 */
const okRows = (rows) => ok({ rows })
const fail = (error, status = 200) => ({ status, body: { ok: false, error } })

function row(sessionId, extra = {}) {
  return {
    sessionId,
    title: `标题-${sessionId}`,
    workspaceId: null,
    workspaceTitle: null,
    workspacePath: null,
    updatedAt: null,
    createdAt: null,
    ...extra,
  }
}

/** 一个可手动结算的 promise（用于制造重叠请求）。 */
function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

compileClient()
writeReactStubs()

// store 通过 window.setTimeout 管理通知自动消失，Node 里没有 window。
globalThis.window = { setTimeout: (fn, ms) => setTimeout(fn, ms) }

const store = require(join(stageDir, 'client', 'store.js'))
const api = require(join(stageDir, 'client', 'api.js'))
const state = () => store.useUi((s) => s)
const ids = (list) => list.map((r) => r.sessionId)

/** 断言存在一条通知并返回它。 */
function notice() {
  const n = state().notice
  assert.notEqual(n, null, 'expected a notice, got none')
  return n
}

/** 记录「官方会话列表刷新」被触发了几次。 */
function trackRefresher() {
  const log = { calls: 0 }
  store.setSessionListRefresher(() => {
    log.calls += 1
  })
  return log
}

/* ------------------------------------------------------------------ *
 * 3. 用例
 * ------------------------------------------------------------------ */

check('refresh：一次刷新同时装载「已归档」与「未分组」，phase=ready', async () => {
  installFetch((path) => {
    if (path === `${API}/archived`) return okRows([row('session-a')])
    if (path === `${API}/ungrouped`) return okRows([row('session-b'), row('session-c')])
    throw new Error(`unexpected path ${path}`)
  })
  await store.refresh()
  const s = state()
  assert.equal(s.phase, 'ready')
  assert.equal(s.error, null)
  assert.deepEqual(ids(s.rows), ['session-a'])
  assert.deepEqual(ids(s.ungrouped), ['session-b', 'session-c'])
})

check('refresh：latest-wins —— 先发的慢响应不得覆盖后发的快响应', async () => {
  const slow = deferred()
  const fast = deferred()
  let call = 0
  installFetch((path) => {
    if (path === `${API}/archived`) {
      call += 1
      return call === 1 ? slow.promise : fast.promise
    }
    return okRows([])
  })
  const first = store.refresh()
  const second = store.refresh()
  fast.resolve(okRows([row('session-new')]))
  await second
  slow.resolve(okRows([row('session-stale')]))
  await first
  assert.deepEqual(ids(state().rows), ['session-new'])
})

check('refresh：已归档接口失败 → phase=error（面板显示重试）', async () => {
  installFetch((path) => (path === `${API}/archived` ? fail('boom') : okRows([])))
  await store.refresh()
  const s = state()
  assert.equal(s.phase, 'error')
  assert.equal(s.error, 'boom')
})

check('refresh：未分组接口不可用（旧宿主）→ 降级成只显示已归档，不整块报错', async () => {
  installFetch((path) => (path === `${API}/archived` ? okRows([row('session-a')]) : fail('not found', 404)))
  await store.refresh()
  const s = state()
  assert.equal(s.phase, 'ready')
  assert.deepEqual(ids(s.rows), ['session-a'])
  assert.deepEqual(s.ungrouped, [])
})

check('api：响应形状防御（缺 rows / 空 sessionId / 类型不符 都被收敛）', async () => {
  installFetch(() => ({
    body: {
      ok: true,
      data: { rows: [row('session-a'), { sessionId: '' }, null, { sessionId: 'session-d', title: 42, updatedAt: 7 }] },
    },
  }))
  const result = await api.getArchived()
  assert.equal(result.ok, true)
  assert.deepEqual(ids(result.data), ['session-a', 'session-d'])
  // title 非字符串 → 回退 sessionId；updatedAt 非字符串 → null
  assert.equal(result.data[1].title, 'session-d')
  assert.equal(result.data[1].updatedAt, null)

  installFetch(() => ok({ rows: 'nope' }))
  const bad = await api.getArchived()
  assert.equal(bad.ok, false)
  assert.match(bad.error, /rows/)

  installFetch(() => {
    throw new Error('network down')
  })
  const down = await api.getUngrouped()
  assert.equal(down.ok, false)
  assert.match(down.error, /network down/)
})

check('delete：宿主没删掉（刷新后仍在列表）→ 报错而不是谎报成功', async () => {
  installFetch((path) => {
    if (path === `${API}/delete`) return ok({ deleted: true })
    if (path === `${API}/archived`) return okRows([])
    if (path === `${API}/ungrouped`) return okRows([row('session-loose')]) // 删除没生效
    throw new Error(`unexpected path ${path}`)
  })
  const refresher = trackRefresher()
  await store.remove('session-loose')
  assert.equal(notice().kind, 'error')
  assert.match(notice().text, /删除未生效/)
  assert.equal(refresher.calls, 0)
})

check('delete：真正删掉后提示成功，并触发官方会话列表刷新', async () => {
  installFetch((path) => (path === `${API}/delete` ? ok({ deleted: true }) : okRows([])))
  const refresher = trackRefresher()
  await store.remove('session-loose')
  assert.equal(notice().kind, 'success')
  assert.equal(refresher.calls, 1)
  assert.equal(state().busy['session-loose'], undefined)
})

check('delete：宿主返回失败 → 原样报错，且不发刷新', async () => {
  installFetch((path) => (path === `${API}/delete` ? fail('该对话正在执行中，无法删除') : okRows([])))
  const refresher = trackRefresher()
  await store.remove('session-busy')
  assert.equal(notice().kind, 'error')
  assert.match(notice().text, /正在执行中/)
  assert.equal(refresher.calls, 0)
})

check('archive：未分组行归档成功后从列表移除并提示可找回', async () => {
  let archived = []
  installFetch((path) => {
    if (path === `${API}/archive`) return ok({ archived: true })
    if (path === `${API}/archived`) return okRows(archived)
    if (path === `${API}/ungrouped`) return okRows(archived.length > 0 ? [] : [row('session-loose')])
    throw new Error(`unexpected path ${path}`)
  })
  await store.refresh()
  archived = [row('session-loose')]
  await store.archive('session-loose')
  assert.equal(notice().kind, 'success')
  assert.deepEqual(ids(state().rows), ['session-loose'])
  assert.deepEqual(state().ungrouped, [])
})

check('restore：恢复失败时只报错，不改动列表', async () => {
  installFetch((path) => {
    if (path === `${API}/restore`) return fail('WorkspaceActiveSessionError: busy')
    if (path === `${API}/archived`) return okRows([row('session-a')])
    return okRows([])
  })
  await store.refresh()
  await store.restore('session-a')
  assert.equal(notice().kind, 'error')
  assert.deepEqual(ids(state().rows), ['session-a'])
})

/* ------------------------------------------------------------------ */

let failures = 0
try {
  for (const [label, fn] of tests) {
    try {
      await fn()
      console.log(`ok   ${label}`)
    } catch (err) {
      failures += 1
      console.error(`FAIL ${label}`)
      console.error(err)
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log(`\nall client checks passed (${tests.length})`)
// showNotice 会挂 4s 定时器；显式退出，别让用例跑完还干等自动消失。
process.exit(0)
