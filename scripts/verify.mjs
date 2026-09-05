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
import { deleteSession, listArchived, restoreSession } from '../lib/host/archive.js'

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

check('deleteSession：拒绝删除正在打开的会话', async () => {
  const registry = fakeRegistry(['session-a'])
  const persistence = fakePersistence([{ id: 'session-a', cwd: 'C:\\fake\\ws' }])
  const live = { get: (id) => (id === 'session-a' ? { header: { id: 'session-a' } } : undefined) }
  await assert.rejects(
    deleteSession(
      { registry, persistence, liveSessions: live, sessionsRoot: 'X:\\none', projectCacheRoot: 'X:\\none' },
      'session-a',
    ),
    /正在打开或运行中/,
  )
})

check('deleteSession：真实文件往返 + 安全校验', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-archive-dialog-verify-'))
  try {
    const registry = fakeRegistry(['session-a'])
    const persistence = fakePersistence([{ id: 'session-a', cwd: 'C:\\fake\\ws', title: 't' }])
    const sessionsRoot = join(tmp, 'sessions')
    const cacheRoot = join(tmp, 'projcache', 'sessions')
    const dir = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-a'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), '{"type":"session/title"}\n')
    const cacheDir = join(cacheRoot, encodeSegment('session-a'))
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'x.bin'), 'x')

    const result = await deleteSession(
      { registry, persistence, liveSessions: { get: () => undefined }, sessionsRoot, projectCacheRoot: cacheRoot },
      'session-a',
    )
    assert.equal(result.deleted, true)
    assert.equal(result.filesDeleted, true)
    assert.equal(existsSync(dir), false)
    assert.equal(existsSync(cacheDir), false)
    assert.deepEqual(registry.archivedSessionIds, [])
    assert.equal(registry._entities[0].record.sessionIds.includes('session-a'), false)

    // 安全校验：目录里没有会话日志文件 → 拒绝删除
    const dir2 = join(sessionsRoot, projectKey('C:\\fake\\ws'), encodeSegment('session-b'))
    mkdirSync(dir2, { recursive: true })
    writeFileSync(join(dir2, 'notes.txt'), 'nope')
    await assert.rejects(
      deleteSession(
        {
          registry: fakeRegistry([]),
          persistence: fakePersistence([{ id: 'session-b', cwd: 'C:\\fake\\ws' }]),
          liveSessions: { get: () => undefined },
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
