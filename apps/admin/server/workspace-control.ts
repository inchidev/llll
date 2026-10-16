import { WorkerEntrypoint } from 'cloudflare:workers'
import type { WorkspaceControlProps } from '@llll/admin-core'
import type { AdminEnv } from './env'
import { readMeta } from './utils/db'
import {
  addEmailDomain,
  createMailboxRoute,
  readDomains,
  removeAppDomain,
  removeEmailDomain,
  removeMailboxRoute,
  setAppDomain,
} from './utils/domains'
import {
  liveAddParticipant,
  liveCreateMeeting,
  liveEndMeeting,
  liveRemoveParticipants,
  liveStatus,
} from './utils/live'
import { compareVersions, latestVersion } from './utils/releases'

/**
 * What a workspace may ask of its Admin, over the `LLLL_ADMIN` service
 * binding. `ctx.props.workerName` is set by the Admin when it links the
 * workspace and cannot be changed by the caller, so every method acts only on
 * the workspace that called it.
 */
export class WorkspaceControl extends WorkerEntrypoint<AdminEnv, WorkspaceControlProps> {
  private get workerName(): string {
    const name = this.ctx.props?.workerName
    if (!name) throw new Error('This binding does not identify a workspace')
    return name
  }

  private async attempt<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    }
    catch (error) {
      // RPC keeps the message; keep it useful for the workspace owner.
      const value = error as { statusMessage?: string, message?: string, statusCode?: number }
      const failure = new Error(value.statusMessage || value.message || 'The L4 Admin could not complete the request')
      ;(failure as Error & { statusCode?: number }).statusCode = value.statusCode
      throw failure
    }
  }

  async status() {
    return this.attempt(async () => {
      const latest = await latestVersion(this.env)
      const current = this.env.LLLL_VERSION || null
      return {
        admin: { version: current, origin: await readMeta(this.env.ADMIN_DB, 'origin') },
        latestVersion: latest,
        adminUpdateAvailable: Boolean(latest && current && compareVersions(latest, current) > 0),
      }
    })
  }

  domains() {
    return this.attempt(() => readDomains(this.env, this.workerName))
  }

  connectAppDomain(input: { zoneId: string, hostname: string }) {
    return this.attempt(() => setAppDomain(this.env, this.workerName, input))
  }

  disconnectAppDomain() {
    return this.attempt(() => removeAppDomain(this.env, this.workerName))
  }

  connectEmailDomain(input: { zoneId: string, domain: string }) {
    return this.attempt(() => addEmailDomain(this.env, this.workerName, input))
  }

  disconnectEmailDomain(emailDomainId: string) {
    return this.attempt(() => removeEmailDomain(this.env, this.workerName, emailDomainId))
  }

  createMailboxRoute(address: string) {
    return this.attempt(() => createMailboxRoute(this.env, this.workerName, address))
  }

  deleteMailboxRoute(address: string) {
    return this.attempt(() => removeMailboxRoute(this.env, this.workerName, address))
  }

  liveStatus() {
    return this.attempt(() => liveStatus(this.env, this.workerName))
  }

  liveCreateMeeting(title: string) {
    return this.attempt(() => liveCreateMeeting(this.env, this.workerName, title))
  }

  liveAddParticipant(meetingId: string, seat: { name: string, customId: string, host: boolean }) {
    return this.attempt(() => liveAddParticipant(this.env, this.workerName, meetingId, seat))
  }

  liveRemoveParticipants(meetingId: string, participantIds: string[]) {
    return this.attempt(() => liveRemoveParticipants(this.env, this.workerName, meetingId, participantIds))
  }

  liveEndMeeting(meetingId: string) {
    return this.attempt(() => liveEndMeeting(this.env, this.workerName, meetingId))
  }
}
