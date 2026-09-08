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
import { deleteSession, listArchived, purgeStaleArchived, restoreSession } from '../lib/host/archive.js'

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (err) {
    failures += 1
    console.error(`FAIL ${label}`)
    console.error(err)
  }
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

function fakeRegistry(archived) {
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
  return {
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
  }
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
    // 删除后归档集合留下墓碑（保持隐藏）→ purge 清理（未驻留；磁盘重扫已无该日志）
    assert.deepEqual(registry.archivedSessionIds, ['session-a'])
    assert.equal(registry._entities[0].record.sessionIds.includes('session-a'), false)
    const purged = await purgeStaleArchived({ registry, persistence: fakePersistence([]), sessions })
    assert.equal(purged, 1)
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

check('deleteSession：数据已丢失时仍成功并留下墓碑（purge 可清理）', async () => {
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
  const purged = await purgeStaleArchived({ registry, persistence, sessions })
  assert.equal(purged, 1)
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
