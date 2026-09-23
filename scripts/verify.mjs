/**
 * 离线冒烟验证（无需启动 DSH）：
 *   - 路径编码算法与真实目录名回归对照
 *   - restore / delete / list 的纯逻辑 + 真实临时文件往返
 * 运行：`npm run build` 之后 `npm run verify`
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSegment, projectKey } from '../lib/host/paths.js'
import {
  archiveSession,
  clearRecentlyDeleted,
  deleteSession,
  isSafeSessionId,
  listArchived,
  listUngrouped,
  purgeStaleArchived,
  restoreSession,
} from '../lib/host/archive.js'
import { apply as applyHostPlugin } from '../lib/index.js'

// 先登记、最后串行 await 执行：异步用例的失败必须被计数（旧驱动不 await，断言会被吞掉）。
const tests = []
const check = (label, fn) => {
  tests.push([label, fn])
}

/* ------------------------------------------------------------------ *
 * 路径编码（对照桌面端真实目录名，来自 DSH_HOME/sessions/）
 * ------------------------------------------------------------------ */

check('projectKey 与真实工作区目录名一致', () => {
  assert.equal(projectKey('C:\\Users\\sjyhz\\Desktop\\归档对话选择'), '--C-Users-sjyhz-Desktop-~5F52~6863~5BF9~8BDD~9009~62E9--')
  assert.equal(projectKey('C:\\Users\\sjyhz\\Desktop\\笔记文件'), '--C-Users-sjyhz-Desktop-~7B14~8BB0~6587~4EF6--')
  assert.equal(projectKey('C:\\Users\\sjyhz\\Desktop\\dsh-usage-monitor'), '--C-Users-sjyhz-Desktop-dsh-usage-monitor--')
  assert.equal(
    projectKey('C:\\Users\\sjyhz\\Desktop\\deepseek harness mode usage monitor'),
    '--C-Users-sjyhz-Desktop-deepseek~0020harness~0020mode~0020usage~0020monitor--',
  )
  assert.equal(projectKey('/home/user/project'), '--home-user-project--')
})

check('encodeSegment 安全性', () => {
  assert.equal(encodeSegment('session-77d6d0fe-39cf-479d-acaa-d898d108b177'), 'session-77d6d0fe-39cf-479d-acaa-d898d108b177')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.throws(() => encodeSegment(''), /empty/)
})

/* ------------------------------------------------------------------ *
 * 假注册表（在内存里模拟 workspaceRegistry 的公开面）
 * ------------------------------------------------------------------ */

function fakeRegistry(archived, options = {}) {
  let state = { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [...archived] }
  const entities = [
    {
      id: 'ws-1',
      path: 'C:\\fake\\ws',
      title: '测试工作区',
      record: { sessionIds: ['session-a', 'session-b'] },
      detached: [],
      detachSession: async (id) => {
        entities[0].record.sessionIds = entities[0].record.sessionIds.filter((x) => x !== id)
        entities[0].detached.push(id)
      },
    },
  ]
  const queue = { tail: Promise.resolve() }
  const api = {
    get archivedSessionIds() {
      return state.archivedSessionIds
    },
    list: () => entities,
    requireState: () => state,
    setState: async (next) => {
      state = next
    },
    enqueueOperation: (op) => {
      const run = queue.tail.then(op)
      queue.tail = run.then(() => undefined, () => undefined)
      return run
    },
    _entities: entities,
    _state: () => state,
    _forgetCalls: 0,
    _unarchiveCalls: 0,
  }
  if (options.forgetSession === true) {
    api.forgetSession = async (id) => {
      api._forgetCalls += 1
      state = { ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => x !== id) }
      entities[0].record.sessionIds = entities[0].record.sessionIds.filter((x) => x !== id)
    }
  }
  if (options.unarchiveSession === true) {
    api.unarchiveSession = async (id) => {
      api._unarchiveCalls += 1
      state = { ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => x !== id) }
    }
  }
  return api
}

function fakePersistence(headers) {
  return { list: async () => headers }
}

/** 假 sessions 存储：get 返回驻留会话；flush 记录调用。 */
function fakeSessions(liveById, log = { flushCalls: 0, flushError: undefined }) {
  return {
    get: (id) => liveById[id],
    flush: async (session) => {
      log.flushCalls += 1
      if (log.flushError !== undefined) throw log.flushError
      return true
    },
    _log: log,
  }
}

/** 假 agents 注册表：phase.kind/status 与 cancel 记录。 */
function fakeAgents(byId, log = { cancelCalls: [] }) {
  return {
    get: (id) => {
      const entry = byId[id]
      if (entry === undefined) return undefined
      return {
        status: entry.status,
        phase: entry.phase,
        cancel: () => {
          log.cancelCalls.push(id)
        },
      }
    },
    _log: log,
  }
}

check('restoreSession：从归档集合移除并走注册表写入', async () => {
  const registry = fakeRegistry(['session-a', 'session-b'])
  const result = await restoreSession(registry, 'session-a')
  assert.equal(result.restored, true)
  assert.deepEqual(registry.archivedSessionIds, ['session-b'])
  // 幂等
  const again = await restoreSession(registry, 'session-a')
  assert.equal(again.restored, false)
})

check('listArchived：拼接标题与工作区', async () => {
  const registry = fakeRegistry(['session-a'])
  const persistence = fakePersistence([
    { id: 'session-a', title: '我的对话', cwd: 'C:\\fake\\ws', createdAt: '2026-01-01T00:00:00.000Z' },
  ])
  const rows = await listArchived(registry, persistence, undefined)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, '我的对话')
  assert.equal(rows[0].workspaceTitle, '测试工作区')
  assert.equal(rows[0].sessionId, 'session-a')
})

check('listArchived：隐藏无日志的「墓碑」行（不展示不可恢复的残留）', async () => {
  // session-a 有日志（有 header）→ 展示；session-tomb 无日志 → 隐藏
  const registry = fakeRegistry(['session-a', 'session-tomb'])
  const persistence = fakePersistence([{ id: 'session-a', title: 'A', cwd: 'C:\\fake\\ws' }])
  const rows = await listArchived(registry, persistence, undefined)
  assert.deepEqual(rows.map((r) => r.sessionId), ['session-a'])
})

check('purgeStaleArchived：清理无日志且无活动会话的墓碑 id', async () => {
  const registry = fakeRegistry(['session-live', 'session-cold-gone'])
  // session-live 虽然没日志，但当前进程还驻留着（僵尸）→ 必须保留（它还被归档过滤隐藏）
  const persistence = fakePersistence([])
  const sessions = fakeSessions({ 'session-live': { header: { id: 'session-live' } } })
  const purged = await purgeStaleArchived({ registry, persistence, sessions })
  assert.equal(purged, 1)
  assert.deepEqual(registry.archivedSessionIds, ['session-live'])
  // 幂等：再跑一次无写入、返回 0
  const again = await purgeStaleArchived({ registry, persistence, sessions })
  assert.equal(again, 0)
  assert.deepEqual(registry.archivedSessionIds, ['session-live'])
})

check('deleteSession：拒绝删除真正在执行（running）的会话', async () => {
  const registry = fakeRegistry(['session-a'])
  const persistence = fakePersistence([{ id: 'session-a', cwd: 'C:\\fake\\ws' }])
  const sessions = fakeSessions({ 'session-a': { header: { id: 'session-a' } } })
  const agents = fakeAgents({ 'session-a': { status: 'running', phase: { kind: 'running' } } })
  await assert.rejects(
    deleteSession(
      { registry, persistence, sessions, agents, sessionsRoot: 'X:\\none', projectCacheRoot: 'X:\\none' },
      'session-a',
    ),
    /正在执行中/,
  )
  // 未动任何状态
  assert.deepEqual(registry.archivedSessionIds, ['session-a'])
  assert.equal(agents._log.cancelCalls.length, 0)
  assert.equal(sessions._log.flushCalls, 0)
})

check('deleteSession：拒绝删除正在后台维护的会话', async () => {
  const registry = fakeRegistry(['session-a'])
  const persistence = fakePersistence([{ id: 'session-a', cwd: 'C:\\fake\\ws' }])
  const agents = fakeAgents({ 'session-a': { phase: { kind: 'maintenance' } } })
  await assert.rejects(
    deleteSession(
      { registry, persistence, agents, sessionsRoot: 'X:\\none', projectCacheRoot: 'X:\\none' },
      'session-a',
    ),
    /后台维护/,
  )
  assert.deepEqual(registry.archivedSessionIds, ['session-a'])
})

check('deleteSession：拿不到 agent 状态且会话驻留时保守拒绝（旧宿主）', async () => {
  const registry = fakeRegistry(['session-a'])
  const persistence = fakePersistence([{ id: 'session-a', cwd: 'C:\\fake\\ws' }])
  const sessions = fakeSessions({ 'session-a': { header: { id: 'session-a' } } })
  await assert.rejects(
    deleteSession(
      { registry, persistence, sessions, sessionsRoot: 'X:\\none', projectCacheRoot: 'X:\\none' },
      'session-a',
    ),
    /无法确认其运行状态/,
  )
  assert.deepEqual(registry.archivedSessionIds, ['session-a'])
})

check('deleteSession：空闲但驻留的会话可删除（先落盘，删后清空收件箱）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-verify-'))
  try {
    const registry = fakeRegistry(['session-a'])
    const persistence = fakePersistence([{ id: 'session-a', cwd: 'C:\\fake\\ws', title: 't' }])
    const sessionsRoot = join(tmp, 'sessions')
    const cacheRoot = join(tmp, 'projcache', 'sessions')
    const dir = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-a'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), '{"type":"session/title"}\n')
    mkdirSync(cacheRoot, { recursive: true })
    const cacheFile = join(cacheRoot, encodeSegment('session-a') + '.json')
    writeFileSync(cacheFile, '{}')

    // agent 驻留但 idle（曾经打开过、没有在执行）——删除必须放行
    const sessions = fakeSessions({ 'session-a': { header: { id: 'session-a' } } })
    const agents = fakeAgents({ 'session-a': { status: 'idle', phase: { kind: 'idle' } } })

    const result = await deleteSession(
      { registry, persistence, sessions, agents, sessionsRoot, projectCacheRoot: cacheRoot },
      'session-a',
    )
    assert.equal(result.deleted, true)
    assert.equal(result.filesDeleted, true)
    assert.equal(existsSync(dir), false)
    assert.equal(existsSync(cacheFile), false)
    // 会话驻留（僵尸）：保持归档当墓碑 → 侧栏/未分组绝不会显示它
    assert.deepEqual(registry.archivedSessionIds, ['session-a'])
    assert.equal(registry._entities[0].record.sessionIds.includes('session-a'), false)
    // 关键：删除前先落盘（防退出时把已删会话写回），删除后清空 agent 收件箱
    assert.equal(sessions._log.flushCalls, 1)
    assert.deepEqual(agents._log.cancelCalls, ['session-a'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('deleteSession：空闲驻留但落盘失败 → 拒绝且保持归档原状', async () => {
  const registry = fakeRegistry(['session-a'])
  const persistence = fakePersistence([{ id: 'session-a', cwd: 'C:\\fake\\ws' }])
  const sessions = fakeSessions({ 'session-a': { header: { id: 'session-a' } } }, { flushError: new Error('disk full') })
  const agents = fakeAgents({ 'session-a': { status: 'idle', phase: { kind: 'idle' } } })
  await assert.rejects(
    deleteSession(
      { registry, persistence, sessions, agents, sessionsRoot: 'X:\\none', projectCacheRoot: 'X:\\none' },
      'session-a',
    ),
    /尚未完成落盘/,
  )
  assert.deepEqual(registry.archivedSessionIds, ['session-a'])
})

check('deleteSession：记账清理失败 → 报错且会话保持归档（可从面板重试）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-verify-'))
  try {
    const registry = fakeRegistry(['session-a'])
    // 让 detachSession 抛错，模拟注册表记账清理中途失败
    registry._entities[0].detachSession = async () => {
      throw new Error('registry exploded')
    }
    const persistence = fakePersistence([{ id: 'session-a', cwd: 'C:\\fake\\ws', title: 't' }])
    const sessionsRoot = join(tmp, 'sessions')
    const cacheRoot = join(tmp, 'projcache', 'sessions')
    const dir = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-a'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), '{"type":"session/title"}\n')
    mkdirSync(cacheRoot, { recursive: true })

    const sessions = fakeSessions({})
    await assert.rejects(
      deleteSession(
        { registry, persistence, sessions, sessionsRoot, projectCacheRoot: cacheRoot },
        'session-a',
      ),
      /registry exploded/,
    )
    // 文件已删但记账失败：会话保持归档（不会变成未分组），可从归档面板重试删除
    assert.equal(existsSync(dir), false)
    assert.deepEqual(registry.archivedSessionIds, ['session-a'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('deleteSession：真实文件往返 + 安全校验（未驻留会话，墓碑由 purge 清理）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-verify-'))
  try {
    const registry = fakeRegistry(['session-a'])
    const persistence = fakePersistence([{ id: 'session-a', cwd: 'C:\\fake\\ws', title: 't' }])
    const sessionsRoot = join(tmp, 'sessions')
    const cacheRoot = join(tmp, 'projcache', 'sessions')
    const dir = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-a'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), '{"type":"session/title"}\n')
    mkdirSync(cacheRoot, { recursive: true })
    const cacheFile = join(cacheRoot, encodeSegment('session-a') + '.json')
    writeFileSync(cacheFile, '{}')

    const sessions = fakeSessions({})
    const result = await deleteSession(
      { registry, persistence, sessions, sessionsRoot, projectCacheRoot: cacheRoot },
      'session-a',
    )
    assert.equal(result.deleted, true)
    assert.equal(result.filesDeleted, true)
    assert.equal(existsSync(dir), false)
    assert.equal(existsSync(cacheFile), false)
    // 删除后归档集合留下墓碑（保持隐藏），且**本进程内不许清掉**：
    // 前端会话列表是异步刷新的，墓碑当场被清会让这一行闪回「未分组」。
    assert.deepEqual(registry.archivedSessionIds, ['session-a'])
    assert.equal(registry._entities[0].record.sessionIds.includes('session-a'), false)
    const purged = await purgeStaleArchived({ registry, persistence: fakePersistence([]), sessions })
    assert.equal(purged, 0)
    assert.deepEqual(registry.archivedSessionIds, ['session-a'])
    // 模拟 DSH 重启（进程结束）：记忆清空后，这条墓碑才允许被回收
    clearRecentlyDeleted()
    const purgedAfterRestart = await purgeStaleArchived({ registry, persistence: fakePersistence([]), sessions })
    assert.equal(purgedAfterRestart, 1)
    assert.deepEqual(registry.archivedSessionIds, [])

    // 安全校验：目录里没有会话日志文件 → 拒绝删除
    const dir2 = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-b'))
    mkdirSync(dir2, { recursive: true })
    writeFileSync(join(dir2, 'notes.txt'), 'nope')
    await assert.rejects(
      deleteSession(
        {
          registry: fakeRegistry([]),
          persistence: fakePersistence([{ id: 'session-b', cwd: 'C:\\fake\\ws' }]),
          sessions: fakeSessions({}),
          sessionsRoot,
          projectCacheRoot: cacheRoot,
        },
        'session-b',
      ),
      /安全校验未通过/,
    )
    assert.equal(existsSync(dir2), true)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('deleteSession：数据已丢失时仍成功并留下墓碑（本进程内不清，重启后才回收）', async () => {
  const registry = fakeRegistry(['session-gone'])
  const persistence = fakePersistence([])
  const sessions = fakeSessions({})
  const result = await deleteSession(
    { registry, persistence, sessions, sessionsRoot: 'X:\none', projectCacheRoot: 'X:\none' },
    'session-gone',
  )
  assert.equal(result.deleted, true)
  assert.equal(result.filesDeleted, false)
  assert.deepEqual(registry.archivedSessionIds, ['session-gone'])
  // 本进程内墓碑必须留着（防闪回未分组）
  assert.equal(await purgeStaleArchived({ registry, persistence, sessions }), 0)
  assert.deepEqual(registry.archivedSessionIds, ['session-gone'])
  // 重启（记忆清空）后才回收
  clearRecentlyDeleted()
  assert.equal(await purgeStaleArchived({ registry, persistence, sessions }), 1)
  assert.deepEqual(registry.archivedSessionIds, [])
})

check('deleteSession：日志存在但目录定位失败 → 拒绝删除且保持归档（不变成未分组）', async () => {
  const registry = fakeRegistry(['session-missing'])
  const persistence = fakePersistence([{ id: 'session-missing', cwd: 'C:\\fake\\ws' }])
  // sessionsRoot 里没有对应目录（模拟定位失败），header 却存在
  await assert.rejects(
    deleteSession(
      { registry, persistence, sessions: fakeSessions({}), sessionsRoot: 'X:\none', projectCacheRoot: 'X:\none' },
      'session-missing',
    ),
    /未找到会话日志目录/,
  )
  // 关键回归：文件删除失败时不得先动归档记账，会话保持归档，不会变成未分组
  assert.deepEqual(registry.archivedSessionIds, ['session-missing'])
})

/* ------------------------------------------------------------------ *
 * 回归用例：DSH 0.1.5-rc.2 的持久化列表形状变化
 * （sessionPersistence.list() 由 header[] 变成 snapshot[{header,...}]）
 * ------------------------------------------------------------------ */

check('listArchived：兼容 0.1.5-rc.2 的 snapshot 形状（回归：面板曾永远为空）', async () => {
  const registry = fakeRegistry(['session-a'])
  const persistence = fakePersistence([
    { header: { id: 'session-a', cwd: 'C:\\fake\\ws', createdAt: 1767225600000 }, revision: 'r1', sizeBytes: 12 },
  ])
  const rows = await listArchived(registry, persistence, undefined)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, 'session-a')
  assert.equal(rows[0].workspaceTitle, '测试工作区')
  assert.equal(rows[0].createdAt, new Date(1767225600000).toISOString())
})

check('listArchived：v3 header 无 title 时向 sessionQuery 折取标题', async () => {
  const registry = fakeRegistry(['session-a'])
  const persistence = fakePersistence([{ header: { id: 'session-a', cwd: 'C:\\fake\\ws' }, revision: 'r1' }])
  const query = {
    readTitleSnapshots: async (ids) => ids.map((id) => ({ header: { id }, title: `标题-${id}` })),
  }
  const rows = await listArchived(registry, persistence, undefined, { query })
  assert.equal(rows[0].title, '标题-session-a')
})

check('purgeStaleArchived：snapshot 形状下不得误清有效归档（回归：曾清空真实归档集合）', async () => {
  const registry = fakeRegistry(['session-a', 'session-b'])
  const persistence = fakePersistence([
    { header: { id: 'session-a' }, revision: 'r1' },
    { header: { id: 'session-b' }, revision: 'r2' },
  ])
  const purged = await purgeStaleArchived({ registry, persistence, sessions: fakeSessions({}) })
  assert.equal(purged, 0)
  assert.deepEqual(registry.archivedSessionIds, ['session-a', 'session-b'])
})

check('purgeStaleArchived：列表异常为空但磁盘日志仍在  不清归档（磁盘二次证伪）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-purge-'))
  try {
    const registry = fakeRegistry(['session-a'])
    const persistence = fakePersistence([])
    const sessionsRoot = join(tmp, 'sessions')
    mkdirSync(join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-a')), { recursive: true })
    const purged = await purgeStaleArchived({ registry, persistence, sessions: fakeSessions({}), sessionsRoot })
    assert.equal(purged, 0)
    assert.deepEqual(registry.archivedSessionIds, ['session-a'])
    // 磁盘上确实没有目录时，墓碑照常清理
    const purged2 = await purgeStaleArchived({
      registry,
      persistence,
      sessions: fakeSessions({}),
      sessionsRoot: join(tmp, 'empty-root'),
    })
    assert.equal(purged2, 1)
    assert.deepEqual(registry.archivedSessionIds, [])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('deleteSession：persistence 未给出 header 时靠磁盘扫描删除 v3 日志（回归）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-scan-'))
  try {
    const registry = fakeRegistry(['session-v3'])
    const sessionsRoot = join(tmp, 'sessions')
    const dir = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-v3'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'binary')
    const result = await deleteSession(
      {
        registry,
        persistence: fakePersistence([]),
        sessions: fakeSessions({}),
        sessionsRoot,
        projectCacheRoot: join(tmp, 'cache'),
      },
      'session-v3',
    )
    assert.equal(result.deleted, true)
    assert.equal(result.filesDeleted, true)
    assert.equal(existsSync(dir), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('deleteSession：snapshot 形状 + v3 文件名（session.v3.jsonl.zstd）可正常删除', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-snap-'))
  try {
    const registry = fakeRegistry(['session-a'])
    const sessionsRoot = join(tmp, 'sessions')
    const dir = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-a'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'binary')
    const persistence = fakePersistence([
      { header: { id: 'session-a', cwd: 'C:\\fake\\ws' }, revision: 'r1', sizeBytes: 1 },
    ])
    const result = await deleteSession(
      { registry, persistence, sessions: fakeSessions({}), sessionsRoot, projectCacheRoot: join(tmp, 'cache') },
      'session-a',
    )
    assert.equal(result.filesDeleted, true)
    assert.equal(existsSync(dir), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * 优化用例：官方 API 优先（unarchiveSession / delete + forgetSession）
 * ------------------------------------------------------------------ */

check('restoreSession：官方提供 unarchiveSession 时优先走官方（不再自己 setState）', async () => {
  const registry = fakeRegistry(['session-a'], { unarchiveSession: true })
  let setStateCalls = 0
  const originalSetState = registry.setState
  registry.setState = async (next) => {
    setStateCalls += 1
    await originalSetState(next)
  }
  const result = await restoreSession(registry, 'session-a')
  assert.equal(result.restored, true)
  assert.equal(registry._unarchiveCalls, 1)
  assert.equal(setStateCalls, 0)
  assert.deepEqual(registry.archivedSessionIds, [])
})

check('deleteSession：非驻留 + 官方 API 可用  官方删文件，但不动归档墓碑（防止闪回未分组）', async () => {
  const registry = fakeRegistry(['session-a'], { forgetSession: true })
  const officialDeleteIds = []
  const persistence = {
    list: async () => [{ header: { id: 'session-a', cwd: 'C:\\fake\\ws' } }],
    delete: async (id) => {
      officialDeleteIds.push(id)
      return true
    },
    // 官方确实删掉了产物（v3 会话）：stat 查不到，才允许走官方收工。
    stat: async () => undefined,
  }
  const result = await deleteSession(
    {
      registry,
      persistence,
      sessions: fakeSessions({}),
      agents: fakeAgents({}),
      sessionsRoot: 'X:\\none',
      projectCacheRoot: 'X:\\none',
    },
    'session-a',
  )
  assert.equal(result.deleted, true)
  assert.equal(result.filesDeleted, true)
  assert.deepEqual(officialDeleteIds, ['session-a'])
  // 刻意不调官方 forgetSession（它会解除归档隐藏，让这一行闪回「未分组」）：
  // 记账由插件自己 detach，归档标记留作墓碑。
  assert.equal(registry._forgetCalls, 0)
  assert.deepEqual(registry.archivedSessionIds, ['session-a'])
  assert.equal(result.detachedWorkspaceId, 'ws-1')
  // 墓碑在本进程内不会被 purge 清掉
  const purged = await purgeStaleArchived({ registry, persistence, sessions: fakeSessions({}) })
  assert.equal(purged, 0)
  assert.deepEqual(registry.archivedSessionIds, ['session-a'])
})

check('deleteSession：驻留（idle）会话不走官方链路，仍用本地删除 + 墓碑策略', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-resident-'))
  try {
    const registry = fakeRegistry(['session-a'], { forgetSession: true })
    let officialDeleteCalls = 0
    const sessionsRoot = join(tmp, 'sessions')
    const dir = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-a'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'binary')
    const persistence = {
      list: async () => [{ header: { id: 'session-a', cwd: 'C:\\fake\\ws' } }],
      delete: async () => {
        officialDeleteCalls += 1
        return true
      },
    }
    const result = await deleteSession(
      {
        registry,
        persistence,
        sessions: fakeSessions({ 'session-a': { header: { id: 'session-a' } } }),
        agents: fakeAgents({ 'session-a': { phase: { kind: 'idle' } } }),
        sessionsRoot,
        projectCacheRoot: join(tmp, 'cache'),
      },
      'session-a',
    )
    assert.equal(result.filesDeleted, true)
    assert.equal(existsSync(dir), false)
    assert.equal(officialDeleteCalls, 0)
    assert.equal(registry._forgetCalls, 0)
    assert.deepEqual(registry.archivedSessionIds, ['session-a'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('deleteSession：官方 delete 返回 false（未迁移 v3 的老会话）→ 本地整目录删除', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-legacy-'))
  try {
    const registry = fakeRegistry(['session-a'], { forgetSession: true })
    const sessionsRoot = join(tmp, 'sessions')
    const dir = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-a'))
    mkdirSync(dir, { recursive: true })
    // 从未迁移到 v3：只有 generation 0 的 session.jsonl.zstd。
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'binary')
    const persistence = {
      list: async () => [{ header: { id: 'session-a', cwd: 'C:\\fake\\ws' } }],
      delete: async () => false, // 官方 rm 的是 session.v3.jsonl.zstd，ENOENT → false
      stat: async () => ({ header: { id: 'session-a', cwd: 'C:\\fake\\ws' } }),
    }
    const result = await deleteSession(
      {
        registry,
        persistence,
        sessions: fakeSessions({}),
        agents: fakeAgents({}),
        sessionsRoot,
        projectCacheRoot: join(tmp, 'cache'),
      },
      'session-a',
    )
    assert.equal(result.deleted, true)
    assert.equal(result.filesDeleted, true)
    assert.equal(existsSync(dir), false)
    // 官方没删干净，所以没有走 forgetSession；本地链路负责记账与墓碑
    assert.equal(registry._forgetCalls, 0)
    assert.deepEqual(registry.archivedSessionIds, ['session-a'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('deleteSession：官方返回 true 但旧 generation 仍在 → 复核后仍走本地整目录删除', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-partial-'))
  try {
    const registry = fakeRegistry(['session-a'], { forgetSession: true })
    const sessionsRoot = join(tmp, 'sessions')
    const dir = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-a'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'legacy')
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'current')
    let forgetCalls = 0
    const persistence = {
      list: async () => [{ header: { id: 'session-a', cwd: 'C:\\fake\\ws' } }],
      delete: async () => {
        // 模拟官方只删掉当前 generation：返回值是 true，可旧文件还在。
        rmSync(join(dir, 'session.v3.jsonl.zstd'), { force: true })
        return true
      },
      stat: async () => ({ header: { id: 'session-a', cwd: 'C:\\fake\\ws' } }),
    }
    registry.forgetSession = async (id) => {
      forgetCalls += 1
      await registry.setState({ ...registry._state(), archivedSessionIds: registry._state().archivedSessionIds.filter((x) => x !== id) })
    }
    const result = await deleteSession(
      {
        registry,
        persistence,
        sessions: fakeSessions({}),
        agents: fakeAgents({}),
        sessionsRoot,
        projectCacheRoot: join(tmp, 'cache'),
      },
      'session-a',
    )
    assert.equal(result.filesDeleted, true)
    // 整个会话目录（含遗留 generation）都被删掉，会话不会刷新后又回来
    assert.equal(existsSync(dir), false)
    assert.equal(forgetCalls, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('deleteSession：官方 delete 抛错  原样上抛且不动记账', async () => {
  const registry = fakeRegistry(['session-a'], { forgetSession: true })
  const persistence = {
    list: async () => [{ header: { id: 'session-a', cwd: 'C:\\fake\\ws' } }],
    delete: async () => {
      throw new Error('cannot delete session while its unmaterialized create is live')
    },
  }
  await assert.rejects(
    deleteSession(
      {
        registry,
        persistence,
        sessions: fakeSessions({}),
        agents: fakeAgents({}),
        sessionsRoot: 'X:\\none',
        projectCacheRoot: 'X:\\none',
      },
      'session-a',
    ),
    /unmaterialized create is live/,
  )
  assert.deepEqual(registry.archivedSessionIds, ['session-a'])
  assert.equal(registry._forgetCalls, 0)
})

/* ------------------------------------------------------------------ *
 * 回归用例：工作区里的「未分组」对话（未归档 + 无工作区记账）
 * 背景：这类行在 DSH 自带菜单里既归档不掉（官方 archiveSession 要求
 * sessionKnown）也删不掉（官方 delete 要求持久化产物），于是永远挂在侧栏。
 * ------------------------------------------------------------------ */

check('isSafeSessionId：接受裸 uuid，拒绝路径穿越与空串', () => {
  assert.equal(isSafeSessionId('session-77d6d0fe-39cf-479d-acaa-d898d108b177'), true)
  // 子代理 / 老存储的裸 uuid：旧形状校验把它们全部拒掉（未分组对话删不掉的元凶之一）
  assert.equal(isSafeSessionId('d5b8e663-1f74-45db-96c7-a0ba5afec593'), true)
  assert.equal(isSafeSessionId(''), false)
  assert.equal(isSafeSessionId('..'), false)
  assert.equal(isSafeSessionId('.hidden'), false)
  assert.equal(isSafeSessionId('a/b'), false)
  assert.equal(isSafeSessionId('a\\b'), false)
  assert.equal(isSafeSessionId('-leading'), false)
  assert.equal(isSafeSessionId('a'.repeat(201)), false)
  assert.equal(isSafeSessionId(undefined), false)
  assert.equal(isSafeSessionId(42), false)
})

check('listUngrouped：只列未归档且无工作区记账的会话（子代理除外，驻留会话也算）', async () => {
  const registry = fakeRegistry(['session-archived'])
  const persistence = fakePersistence([
    { header: { id: 'session-a', cwd: 'C:\\fake\\ws', createdAt: 1767225600000 } },
    { header: { id: 'session-b', cwd: 'C:\\fake\\ws' } },
    { header: { id: 'session-loose', cwd: 'C:\\loose', createdAt: 1767225600000 } },
    { header: { id: 'session-archived', cwd: 'C:\\loose' } },
    { header: { id: 'd5b8e663-1f74-45db-96c7-a0ba5afec593', cwd: 'C:\\loose', origin: 'subagent' } },
  ])
  const live = fakeSessions({ 'session-mem': { header: { id: 'session-mem', cwd: 'C:\\gone' } } })
  live.list = () => [{ header: { id: 'session-mem', cwd: 'C:\\gone' } }]
  const rows = await listUngrouped(registry, persistence, live)
  assert.deepEqual(rows.map((row) => row.sessionId), ['session-loose', 'session-mem'])
  // 「未分组」行没有工作区归属，标题缺省回退 sessionId
  assert.equal(rows[1].workspaceTitle, null)
  assert.equal(rows[1].title, 'session-mem')
})

check('listUngrouped：持久化列表不可用时退化为驻留会话，不清空也不误报', async () => {
  const registry = fakeRegistry([])
  const broken = {
    list: async () => {
      throw new Error('storage unavailable')
    },
  }
  const live = fakeSessions({ 'session-mem': { header: { id: 'session-mem' } } })
  live.list = () => [{ header: { id: 'session-mem' } }]
  const rows = await listUngrouped(registry, broken, live)
  assert.deepEqual(rows.map((row) => row.sessionId), ['session-mem'])
})

check('archiveSession：官方可用时走官方，不自己写 setState', async () => {
  const registry = fakeRegistry([])
  let officialCalls = 0
  let setStateCalls = 0
  const originalSetState = registry.setState
  registry.setState = async (next) => {
    setStateCalls += 1
    await originalSetState(next)
  }
  registry.archiveSession = async (id) => {
    officialCalls += 1
    const current = registry._state()
    await originalSetState({ ...current, archivedSessionIds: [...current.archivedSessionIds, id] })
  }
  const result = await archiveSession(registry, 'session-x')
  assert.equal(result.archived, true)
  assert.equal(officialCalls, 1)
  assert.equal(setStateCalls, 0)
  assert.deepEqual(registry.archivedSessionIds, ['session-x'])
})

check('archiveSession：官方拒绝未分组幽灵时回退到注册表 setState（回归：无法归档）', async () => {
  const registry = fakeRegistry([])
  registry.archiveSession = async () => {
    throw new Error('cannot archive unknown session')
  }
  const result = await archiveSession(registry, 'session-ghost')
  assert.equal(result.archived, true)
  assert.deepEqual(registry.archivedSessionIds, ['session-ghost'])
})

check('archiveSession：已归档时幂等，不产生任何写入', async () => {
  const registry = fakeRegistry(['session-x'])
  let setStateCalls = 0
  const originalSetState = registry.setState
  registry.setState = async (next) => {
    setStateCalls += 1
    await originalSetState(next)
  }
  const result = await archiveSession(registry, 'session-x')
  assert.equal(result.archived, false)
  assert.equal(setStateCalls, 0)
})

check('deleteSession：删除未分组的驻留会话后补上归档墓碑（回归：删完侧栏又冒出未分组）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-tombstone-'))
  try {
    const registry = fakeRegistry([]) // 未归档 = 面板里的「未分组」
    const sessionsRoot = join(tmp, 'sessions')
    const dir = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-loose'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'binary')
    const persistence = fakePersistence([{ header: { id: 'session-loose', cwd: 'C:\\fake\\ws' } }])
    const result = await deleteSession(
      {
        registry,
        persistence,
        sessions: fakeSessions({ 'session-loose': { header: { id: 'session-loose' } } }),
        agents: fakeAgents({ 'session-loose': { phase: { kind: 'idle' } } }),
        sessionsRoot,
        projectCacheRoot: join(tmp, 'cache'),
      },
      'session-loose',
    )
    assert.equal(result.filesDeleted, true)
    assert.equal(existsSync(dir), false)
    assert.deepEqual(registry.archivedSessionIds, ['session-loose'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * 路由层回归：用假 cordis 上下文直接驱动 lib/index.js 的 apply()
 * （覆盖 URL 解析、方法/同源围栏、JSON body、sessionId 校验与响应封装）
 * ------------------------------------------------------------------ */

function fakeHost(services) {
  const handlers = []
  const webServer = {
    register(def) {
      handlers.push(def)
      return () => {}
    },
  }
  const ctx = {
    get: (key) => (key === 'webServer' ? webServer : services[key]),
    // cordis 的 effect(fn) 会立即执行 fn（返回值即 disposer）——路由正是在这里挂上。
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
  }
  return { ctx, handlers }
}

function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
}

/** 最小 IncomingMessage：readJsonBody 只需要 on('data'|'end'|'error')。 */
function fakeReq(method, url, body, headers = {}) {
  const listeners = {}
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:43129', ...headers },
    on(event, cb) {
      ;(listeners[event] ??= []).push(cb)
      return req
    },
  }
  setTimeout(() => {
    if (body !== undefined) for (const cb of listeners.data ?? []) cb(Buffer.from(JSON.stringify(body)))
    for (const cb of listeners.end ?? []) cb()
  }, 0)
  return req
}

async function callRoute(handler, method, url, body, headers) {
  const res = fakeRes()
  await handler(fakeReq(method, url, body, headers), res)
  return { status: res.status, json: res.body === '' ? undefined : JSON.parse(res.body) }
}

check('路由：GET /ungrouped 返回未分组列表，JSON body 版 /archive 写入注册表', async () => {
  const registry = fakeRegistry([])
  const persistence = fakePersistence([
    { header: { id: 'session-a', cwd: 'C:\\fake\\ws' } },
    { header: { id: 'session-loose', cwd: 'C:\\loose' } },
  ])
  const { ctx, handlers } = fakeHost({ workspaceRegistry: registry, sessionPersistence: persistence })
  applyHostPlugin(ctx)
  assert.equal(handlers.length, 1)
  const handler = handlers[0].handler
  assert.equal(handlers[0].path, '/plugins/dsh-archive-dialog')

  const list = await callRoute(handler, 'GET', '/plugins/dsh-archive-dialog/ungrouped')
  assert.equal(list.status, 200)
  assert.equal(list.json.ok, true)
  assert.deepEqual(list.json.data.rows.map((row) => row.sessionId), ['session-loose'])

  const archived = await callRoute(handler, 'POST', '/plugins/dsh-archive-dialog/archive', { sessionId: 'session-loose' })
  assert.equal(archived.status, 200)
  assert.equal(archived.json.ok, true)
  assert.equal(archived.json.data.archived, true)
  assert.deepEqual(registry.archivedSessionIds, ['session-loose'])

  // 归档后 /ungrouped 不再列出它
  const after = await callRoute(handler, 'GET', '/plugins/dsh-archive-dialog/ungrouped')
  assert.deepEqual(after.json.data.rows, [])
})

check('路由：裸 uuid 可通过校验，危险 id / 跨站 / 未知路径被拒', async () => {
  const registry = fakeRegistry([])
  const persistence = fakePersistence([])
  const { ctx, handlers } = fakeHost({ workspaceRegistry: registry, sessionPersistence: persistence })
  applyHostPlugin(ctx)
  const handler = handlers[0].handler

  // 子代理 / 老存储的裸 uuid 不再被判成「无效的 sessionId」
  const bare = await callRoute(handler, 'POST', '/plugins/dsh-archive-dialog/archive', {
    sessionId: 'd5b8e663-1f74-45db-96c7-a0ba5afec593',
  })
  assert.equal(bare.json.ok, true)

  for (const bad of ['../evil', '', 'a/b', '..']) {
    const res = await callRoute(handler, 'POST', '/plugins/dsh-archive-dialog/archive', { sessionId: bad })
    assert.equal(res.json.ok, false)
    assert.match(res.json.error, /无效的 sessionId/)
  }

  const crossSite = await callRoute(handler, 'GET', '/plugins/dsh-archive-dialog/archived', undefined, {
    'sec-fetch-site': 'cross-site',
  })
  assert.equal(crossSite.status, 403)

  const unknown = await callRoute(handler, 'GET', '/plugins/dsh-archive-dialog/nope')
  assert.equal(unknown.status, 404)

  const wrongMethod = await callRoute(handler, 'DELETE', '/plugins/dsh-archive-dialog/archive')
  assert.equal(wrongMethod.status, 405)
})

/* ------------------------------------------------------------------ */

let failures = 0
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log(`\nall checks passed (${tests.length})`)
