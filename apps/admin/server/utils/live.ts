import {
  addParticipant,
  createMeeting,
  LLLL_HOST_PRESET,
  LLLL_PARTICIPANT_PRESET,
  endMeeting,
  ensureLivePresets,
  findOrCreateApp,
  removeParticipants,
  type RealtimeKitApp,
  type RealtimeKitParticipant,
} from '@llll/admin-core'
import type { AdminEnv } from '../env'
import { cloudflareToken } from './credential'
import { audit, ensureSchema, nowIso } from './db'

/**
 * Each workspace gets its own RealtimeKit app with L4's host and
 * participant presets, created the first time someone goes live.
 */
async function liveApp(env: AdminEnv, workerName: string): Promise<RealtimeKitApp> {
  await ensureSchema(env.ADMIN_DB)
  const apiToken = await cloudflareToken(env)
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const row = await env.ADMIN_DB.prepare('SELECT app_id AS appId FROM live_apps WHERE worker_name = ?').bind(workerName).first<{ appId: string }>()
  if (row) return { accountId, appId: row.appId, apiToken }
  const appId = await findOrCreateApp(apiToken, accountId, `L4 ${workerName}`)
  await ensureLivePresets(apiToken, accountId, appId)
  const now = nowIso()
  await env.ADMIN_DB.prepare(
    `INSERT INTO live_apps (worker_name, app_id, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(worker_name) DO UPDATE SET app_id = excluded.app_id, updated_at = excluded.updated_at`,
  ).bind(workerName, appId, now, now).run()
  await audit(env.ADMIN_DB, 'live.provision', workerName, { appId })
  return { accountId, appId, apiToken }
}

export async function liveStatus(env: AdminEnv, workerName: string) {
  await ensureSchema(env.ADMIN_DB)
  const row = await env.ADMIN_DB.prepare('SELECT app_id AS appId FROM live_apps WHERE worker_name = ?').bind(workerName).first<{ appId: string }>()
  return { provisioned: Boolean(row), appId: row?.appId ?? null, hostPreset: LLLL_HOST_PRESET, participantPreset: LLLL_PARTICIPANT_PRESET }
}

export async function provisionLive(env: AdminEnv, workerName: string) {
  const app = await liveApp(env, workerName)
  return { appId: app.appId }
}

export async function liveCreateMeeting(env: AdminEnv, workerName: string, title: string) {
  return createMeeting(await liveApp(env, workerName), title)
}

export async function liveAddParticipant(
  env: AdminEnv,
  workerName: string,
  meetingId: string,
  seat: { name: string, customId: string, host: boolean },
): Promise<RealtimeKitParticipant> {
  return addParticipant(await liveApp(env, workerName), meetingId, {
    name: seat.name,
    customId: seat.customId,
    preset: seat.host ? LLLL_HOST_PRESET : LLLL_PARTICIPANT_PRESET,
  })
}

export async function liveRemoveParticipants(env: AdminEnv, workerName: string, meetingId: string, participantIds: string[]) {
  await removeParticipants(await liveApp(env, workerName), meetingId, participantIds)
}

export async function liveEndMeeting(env: AdminEnv, workerName: string, meetingId: string) {
  await endMeeting(await liveApp(env, workerName), meetingId)
}
