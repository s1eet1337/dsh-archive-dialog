/**
 * Client-side same-origin fetchers for the host JSON API.
 * All payloads are validated defensively (shape mismatch → error, never crash).
 */
export interface ArchivedRow {
  sessionId: string
  title: string
  workspaceId: string | null
  workspaceTitle: string | null
  workspacePath: string | null
  updatedAt: string | null
  createdAt: string | null
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

interface Envelope {
  ok?: unknown
  error?: unknown
  data?: unknown
}

const API_PREFIX = '/plugins/dsh-archive-dialog'

async function request(path: string, init?: RequestInit): Promise<ApiResult<unknown>> {
  try {
    const res = await fetch(path, {
      cache: 'no-store',
      ...init,
      headers: init?.body !== undefined ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
    })
    const body = (await res.json()) as Envelope
    if (body.ok === true) return { ok: true, data: body.data }
    return { ok: false, error: typeof body.error === 'string' && body.error !== '' ? body.error : `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function getArchived(): Promise<ApiResult<ArchivedRow[]>> {
  const res = await request(`${API_PREFIX}/archived`)
  if (!res.ok) return res
  const payload = res.data as { rows?: unknown } | undefined
  const rowsRaw = payload?.rows
  if (!Array.isArray(rowsRaw)) return { ok: false, error: '响应格式异常（缺少 rows）' }
  const rows: ArchivedRow[] = rowsRaw
    .map((r) => {
      const rec = (r ?? {}) as Record<string, unknown>
      const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : ''
      return {
        sessionId,
        title: typeof rec.title === 'string' && rec.title !== '' ? rec.title : sessionId,
        workspaceId: typeof rec.workspaceId === 'string' ? rec.workspaceId : null,
        workspaceTitle: typeof rec.workspaceTitle === 'string' ? rec.workspaceTitle : null,
        workspacePath: typeof rec.workspacePath === 'string' ? rec.workspacePath : null,
        updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : null,
        createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : null,
      }
    })
    .filter((r) => r.sessionId !== '')
  return { ok: true, data: rows }
}

export async function postRestore(sessionId: string): Promise<ApiResult<unknown>> {
  return request(`${API_PREFIX}/restore`, { method: 'POST', body: JSON.stringify({ sessionId }) })
}

export async function postDelete(sessionId: string): Promise<ApiResult<unknown>> {
  return request(`${API_PREFIX}/delete`, { method: 'POST', body: JSON.stringify({ sessionId }) })
}
