/**
 * DSH home / session path helpers.
 *
 * `projectKey` 与 `encodeSegment` 与 DSH 持久化层
 * (`@deepseek-ai/dsh-session-persistence-jsonl`) 的编码算法保持一致：
 * 会话日志位于 `<sessionsRoot>/<projectKey(cwd)>/session-<encodeSegment(id)>/session.jsonl(.zstd)`。
 * 两个函数是确定性算法，verify 脚本用真实目录名做了回归测试。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Encode an arbitrary string as a single safe path segment (same algorithm as
 * DSH's persistence layer): safe code units stay literal, every other unit
 * (including `~`) becomes `~XXXX`; `.`/`..` are escaped to prevent traversal.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Build the readable directory key for a project path (same algorithm as
 * DSH's persistence layer). Separators and drive separators become `-`;
 * unsafe code units use the `~XXXX` escape; result is wrapped in `--…--`.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Resolve the DSH home directory: `$DSH_HOME` first, then `~/.dsh`
 * (mirrors `@deepseek-ai/dsh-home-paths`'s `resolveDshHome`).
 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME
  const base = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return resolve(expandHomePath(base))
}

function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Directory where session log files live. */
export function sessionsRoot(home: string): string {
  return join(home, 'sessions')
}

/** Directory where per-session projection caches live. */
export function projectionCacheRoot(home: string): string {
  return join(home, 'storages', 'session_projcache', 'sessions')
}
