/// <reference types="@cloudflare/workers-types" />
import { drizzle } from 'drizzle-orm/d1'
import baselineSql from '../../drizzle/server-migrations/0000_server_baseline.sql?raw'
import serverUpdatesSql from '../../drizzle/server-migrations/0001_server_updates.sql?raw'
import mcpOauthSql from '../../drizzle/server-migrations/0002_mcp_oauth.sql?raw'
import mcpConnectSql from '../../drizzle/server-migrations/0003_mcp_connect_grant.sql?raw'
import agentPermissionsSql from '../../drizzle/server-migrations/0004_agent_permissions.sql?raw'
import roleResourcesSql from '../../drizzle/server-migrations/0005_role_resources.sql?raw'
import piRunsSql from '../../drizzle/server-migrations/0006_pi_runs.sql?raw'
import schedulesSql from '../../drizzle/server-migrations/0007_schedules.sql?raw'
import codeEnvironmentsSql from '../../drizzle/server-migrations/0008_code_environments.sql?raw'
import serverOriginsSql from '../../drizzle/server-migrations/0009_server_origins.sql?raw'
import serverSettingsSql from '../../drizzle/server-migrations/0010_server_settings.sql?raw'
import dmPrivacySql from '../../drizzle/server-migrations/0011_dm_privacy.sql?raw'
import storageChannelsSql from '../../drizzle/server-migrations/0012_server_storage_and_channels.sql?raw'
import modelCallsSql from '../../drizzle/server-migrations/0013_agent_model_calls.sql?raw'
import runDeliverySql from '../../drizzle/server-migrations/0014_agent_run_delivery.sql?raw'
import mailDeliverySql from '../../drizzle/server-migrations/0015_mail_delivery.sql?raw'
import mailFileCleanupSql from '../../drizzle/server-migrations/0016_file_cleanup.sql?raw'
import agentTaskEditsSql from '../../drizzle/server-migrations/0017_agent_task_edits.sql?raw'
import outboundMcpSql from '../../drizzle/server-migrations/0018_outbound_mcp.sql?raw'
import agentToolSecuritySql from '../../drizzle/server-migrations/0019_agent_tool_security.sql?raw'
import runPublicationsSql from '../../drizzle/server-migrations/0020_run_publications.sql?raw'
import projectsSql from '../../drizzle/server-migrations/0021_projects.sql?raw'
import gitConnectionsSql from '../../drizzle/server-migrations/0022_git_connections.sql?raw'
import softwareFactorySql from '../../drizzle/server-migrations/0023_software_factory.sql?raw'
import projectPoliciesSql from '../../drizzle/server-migrations/0024_project_policies.sql?raw'
import taskDelegationSql from '../../drizzle/server-migrations/0025_task_delegation.sql?raw'
import rolePoliciesSql from '../../drizzle/server-migrations/0026_role_policies.sql?raw'
import scheduleFixesSql from '../../drizzle/server-migrations/0027_schedule_fixes.sql?raw'
import chatLifecycleSql from '../../drizzle/server-migrations/0028_chat_lifecycle.sql?raw'
import chatSearchSql from '../../drizzle/server-migrations/0029_chat_search.sql?raw'
import { schema } from '../../drizzle/schema'
import { isUuidV4 } from '../../shared/server-settings'

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema })
}

/** Convert Drizzle's migration markers into the format accepted by D1 exec. */
export function d1ExecSql(sql: string): string {
  return sql
    .split('--> statement-breakpoint')
    .map(statement => statement
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .map(statement => statement.endsWith(';') ? statement : `${statement};`)
    .join('\n')
}

export const INIT_SQL = d1ExecSql([
  baselineSql,
  serverUpdatesSql,
  mcpOauthSql,
  mcpConnectSql,
  agentPermissionsSql,
  roleResourcesSql,
  piRunsSql,
  schedulesSql,
  codeEnvironmentsSql,
  serverOriginsSql,
  serverSettingsSql,
  dmPrivacySql,
  storageChannelsSql,
  modelCallsSql,
  runDeliverySql,
  mailDeliverySql,
  mailFileCleanupSql,
  agentTaskEditsSql,
  outboundMcpSql,
  agentToolSecuritySql,
  runPublicationsSql,
  projectsSql,
  gitConnectionsSql,
  softwareFactorySql,
  projectPoliciesSql,
  taskDelegationSql,
  rolePoliciesSql,
  scheduleFixesSql,
  chatLifecycleSql,
  chatSearchSql,
].join('\n--> statement-breakpoint\n'))

/** Bootstrap is only for an empty database. Deployed changes use D1 migrations. */
// An isolate serves one Server, so a schema that was present once stays
// present for the isolate's lifetime. Skipping the probes saves three D1 round
// trips on every public request.
const migratedDatabases = new WeakSet<D1Database>()

function celldRuntime(env?: { LLLL_RUNTIME?: string }): boolean {
  return env?.LLLL_RUNTIME?.trim().toLowerCase() === 'celld'
}

export async function ensureMigrated(db: D1Database, env?: { LLLL_RUNTIME?: string, SERVER_ID?: string }): Promise<boolean> {
  if (migratedDatabases.has(db)) return true
  const marker = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='server_schema'").first()
  if (!marker) {
    const existing = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations', '_cf_KV') LIMIT 1").first()
    if (existing || celldRuntime(env)) throw new Error('This Server requires a fresh server-v1 database')
    await db.exec(INIT_SQL)
  }
  const schemaVersion = await db.prepare('SELECT version FROM server_schema WHERE id = 1').first<{ version: string }>()
  if (schemaVersion?.version !== 'server-v1') throw new Error('Unsupported Server schema')
  if (isUuidV4(env?.SERVER_ID)) {
    await db.prepare('INSERT INTO server_identity(singleton,id) VALUES (1,?) ON CONFLICT(singleton) DO NOTHING')
      .bind(env!.SERVER_ID!.toLowerCase()).run()
  }
  await Promise.all([
    db.prepare('SELECT kind FROM users LIMIT 1').first(),
    db.prepare('SELECT user_id FROM agents LIMIT 1').first(),
  ])
  // The installer applies additive SQL before uploading code. Defer incompatible
  // conversation changes until this new Worker is actually serving the database.
  await db.batch([
    db.prepare("UPDATE channels SET type='text', visibility='private', created_by=dm_owner_id, name=CASE WHEN name='dm' THEN 'private-chat-'||substr(id,1,8) ELSE name END WHERE type='dm' AND dm_kind='group'"),
    db.prepare("UPDATE channels SET created_by=(SELECT actor_id FROM audit_log WHERE action='channel.create' AND target_id=channels.id ORDER BY created_at LIMIT 1) WHERE type='text' AND created_by IS NULL"),
  ])
  migratedDatabases.add(db)
  return true
}

export async function userCount(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'active'").first<{ c: number }>()
    return row?.c ?? 0
  }
  catch {
    return 0
  }
}

export async function serverReady(db: D1Database): Promise<boolean> {
  try {
    return Boolean(await db.prepare("SELECT id FROM server LIMIT 1").first())
  }
  catch {
    return false
  }
}
