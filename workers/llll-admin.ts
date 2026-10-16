import type { L4Env } from './env'
import type { InstallationDomainSettingsDTO } from '../shared/releases'

/**
 * What this workspace may ask of its account's L4 Admin over the
 * `LLLL_ADMIN` service binding. The Admin identifies the caller from the
 * binding itself, so no method takes a workspace name.
 */
export type L4Admin = {
  status: () => Promise<{ admin: { version: string | null, origin: string | null }, latestVersion: string | null, adminUpdateAvailable: boolean }>
  domains: () => Promise<Omit<InstallationDomainSettingsDTO, 'managed'>>
  connectAppDomain: (input: { zoneId: string, hostname: string }) => Promise<{ hostname: string }>
  disconnectAppDomain: () => Promise<{ hostname: string }>
  connectEmailDomain: (input: { zoneId: string, domain: string }) => Promise<{ id: string, domain: string, zoneId: string, zoneName: string, sendingEnabled?: boolean }>
  disconnectEmailDomain: (emailDomainId: string) => Promise<{ disconnected: boolean }>
  createMailboxRoute: (address: string) => Promise<unknown>
  deleteMailboxRoute: (address: string) => Promise<unknown>
  liveStatus: () => Promise<{ provisioned: boolean, appId: string | null }>
  liveCreateMeeting: (title: string) => Promise<{ id: string }>
  liveAddParticipant: (meetingId: string, seat: { name: string, customId: string, host: boolean }) => Promise<{ id: string, token: string }>
  liveRemoveParticipants: (meetingId: string, participantIds: string[]) => Promise<void>
  liveEndMeeting: (meetingId: string) => Promise<void>
}

export function llllAdmin(env: L4Env): L4Admin | null {
  return env.LLLL_ADMIN ? env.LLLL_ADMIN as unknown as L4Admin : null
}

let cachedOrigin: string | null = null

/** Where the owner manages this workspace, or null when no Admin is linked. */
export async function llllAdminOrigin(env: L4Env): Promise<string | null> {
  const admin = llllAdmin(env)
  if (!admin) return null
  if (cachedOrigin) return cachedOrigin
  try {
    cachedOrigin = (await admin.status()).admin.origin
  }
  catch {
    return null
  }
  return cachedOrigin
}

/** The Admin page for this workspace, where updates and deletion happen. */
export async function llllAdminWorkspaceUrl(env: L4Env, hash?: Record<string, string>): Promise<string | null> {
  const origin = await llllAdminOrigin(env)
  const workerName = env.LLLL_WORKER_NAME?.trim()
  if (!origin || !workerName) return null
  const url = new URL(`/workspaces/${encodeURIComponent(workerName)}`, origin)
  if (hash) url.hash = new URLSearchParams(hash).toString()
  return url.toString()
}
