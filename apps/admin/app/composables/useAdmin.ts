export type AdminSession = {
  owner: { id: string, email: string } | null
  claimed: boolean
  accountId?: string
  credential?: { connected: boolean, kind: 'oauth' | 'token' | null, problem: string | null, updatedAt: string | null, pendingHandover: boolean }
  version?: string | null
  latestVersion?: string | null
  updateAvailable?: boolean
  automaticUpdates?: { admin: boolean, workspaces: boolean }
  directory?: boolean
}

export type Workspace = {
  workerName: string
  appName: string
  origin: string
  version: string | null
  linked: boolean
  updateAvailable: boolean
  filesEnabled: boolean
}

export type ProgressState = 'pending' | 'active' | 'complete'

/** Every Admin mutation carries this header; the server refuses cross-site requests without it. */
export function adminFetch<T>(url: string, options: Parameters<typeof $fetch>[1] = {}) {
  return $fetch<T>(url, {
    ...options,
    headers: { 'x-llll-admin': '1', ...(options.headers as Record<string, string> | undefined) },
  })
}

export function failureMessage(cause: unknown, fallback = 'Something went wrong') {
  const error = cause as { data?: { statusMessage?: string, data?: { error?: { message?: string } } }, statusMessage?: string, message?: string }
  return error?.data?.data?.error?.message || error?.data?.statusMessage || error?.statusMessage || error?.message || fallback
}

/** Read an NDJSON progress stream from a long Cloudflare operation. */
export async function streamProgress<T>(
  url: string,
  body: unknown,
  onProgress: (step: string, state: ProgressState, detail?: string) => void,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', 'x-llll-admin': '1' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null) as { statusMessage?: string, data?: { error?: { message?: string } } } | null
    throw new Error(payload?.data?.error?.message || payload?.statusMessage || 'The Admin could not start this operation')
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let result: T | undefined
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as { type: string, step?: string, state?: ProgressState, detail?: string, result?: T, message?: string }
      if (message.type === 'progress' && message.step && message.state) onProgress(message.step, message.state, message.detail)
      else if (message.type === 'complete') result = message.result
      else if (message.type === 'error') throw new Error(message.message || 'The operation stopped')
    }
  }
  if (result === undefined) throw new Error('The operation ended before the Admin confirmed it')
  return result
}
