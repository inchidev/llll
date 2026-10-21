import { createMcpHandler } from 'agents/mcp/server'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { version as packageVersion } from '../../package.json'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import { INIT_SQL } from '../../server/utils/db'
import { createL4McpServer } from '../../server/utils/mcp-server'
import type { L4Env } from '../../workers/env'
import type { McpPrincipal } from '../../server/utils/mcp-principal'

let sqlite: DatabaseSync

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const statement = {
        bind(...next: SQLInputValue[]) { values = next; return statement },
        async first<T>() { return (database.prepare(sql).get(...values) as T | undefined) ?? null },
        async all<T>() { return { results: database.prepare(sql).all(...values) as T[] } },
        async run() { return { success: true, meta: database.prepare(sql).run(...values) } },
      }
      return statement
    },
  } as unknown as D1Database
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec("INSERT INTO server_identity(singleton,id) VALUES (1,'00000000-0000-4000-8000-000000000001')")
  sqlite.exec(`
    INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('owner-role', 'owner', 'Owner', 0);
    INSERT INTO users (id, display_name, status, role_id, joined_at)
      VALUES ('owner', 'Owner', 'active', 'owner-role', '2026-09-06T00:00:00.000Z');
    INSERT INTO server (id, name, owner_id) VALUES ('00000000-0000-4000-8000-000000000001', 'L4', 'owner');
  `)
})

afterEach(() => sqlite.close())

function ownerPrincipal(): McpPrincipal {
  const authorization = {
    serverId: '00000000-0000-4000-8000-000000000001',
    principal: { id: 'owner', kind: 'human' as const, roleId: 'owner-role', roleName: 'Owner', permissions: ALL_PERMISSIONS, isOwner: true },
    credential: { kind: 'mcp' as const, id: 'token', scopes: ['tasks:read', 'tasks:write', 'documents:read', 'documents:write'] as const },
  }
  return {
    tokenId: 'token',
    userId: 'owner',
    serverId: '00000000-0000-4000-8000-000000000001',
    roleId: 'owner-role',
    roleName: 'Owner',
    perms: ALL_PERMISSIONS,
    isOwner: true,
    scopes: [...authorization.credential.scopes],
    delegatedBy: null,
    authorization,
  }
}

function createHandler(principal = ownerPrincipal()) {
  return createMcpHandler(() => createL4McpServer({
    env: { DB: d1(sqlite) } as L4Env,
    principal,
    schedule: () => {},
  }), { allowedHostnames: ['localhost'], allowedOriginHostnames: ['localhost'] })
}

async function call(handler: ReturnType<typeof createHandler>, message: Record<string, unknown>) {
  const response = await handler.fetch(new Request('https://localhost/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Host: 'localhost',
    },
    body: JSON.stringify(message),
  }))
  const body = await response.text()
  const json = body.startsWith('event:') ? body.split('\ndata: ')[1]?.trim() : body
  return {
    response,
    payload: JSON.parse(json!) as { result: { tools?: Array<{ name: string }>; content?: Array<{ type: string; text: string }>; isError?: boolean } },
  }
}

describe('L4 MCP server', () => {
  it('reports the package version during MCP initialization', async () => {
    const { payload } = await call(createHandler(), {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    })

    expect(payload.result.serverInfo).toEqual({ name: 'L4', version: packageVersion })
  })

  it('publishes focused Tasks and Documents tools over Streamable HTTP', async () => {
    const { response, payload } = await call(createHandler(), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })

    expect(response.status).toBe(200)
    expect(payload.result.tools?.map(tool => tool.name)).toEqual([
      'create_table', 'read_records', 'create_record', 'update_record',
      'list_task_boards',
      'get_task',
      'create_task',
      'update_task',
      'list_documents',
      'get_document',
      'create_document',
      'update_document',
      'list_channels',
      'list_members',
      'list_messages',
      'send_message',
    ])
  })

  it('gets a task through MCP by its database-assigned number', async () => {
    sqlite.exec(`
      INSERT INTO task_boards (id, name, created_by) VALUES ('board-1', 'Roadmap', 'owner');
      INSERT INTO tasks (id, board_id, title, created_by) VALUES ('task-1', 'board-1', 'Ship native numbers', 'owner');
    `)

    const { response, payload } = await call(createHandler(), {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_task', arguments: { taskId: 1001 } },
    })
    const result = JSON.parse(payload.result.content?.[0]?.text ?? '{}') as { task?: { id: string; number: number; title: string } }

    expect(response.status).toBe(200)
    expect(payload.result.isError).not.toBe(true)
    expect(result.task).toMatchObject({ id: 'task-1', number: 1001, title: 'Ship native numbers' })
  })

  it('creates a server document as an Agent and records its human delegator', async () => {
    sqlite.exec(`
      INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('agent-role', 'agent', 'Agent', ${ALL_PERMISSIONS});
      INSERT INTO users (id, kind, display_name, status, role_id, joined_at)
        VALUES ('agent', 'agent', 'Codex Agent', 'active', 'agent-role', '2026-09-06T00:00:00.000Z');
    `)
    const principal = ownerPrincipal()
    principal.userId = 'agent'
    principal.roleId = 'agent-role'
    principal.roleName = 'Agent'
    principal.isOwner = false
    principal.delegatedBy = 'owner'
    principal.authorization = {
      ...principal.authorization,
      principal: { id: 'agent', kind: 'agent', roleId: 'agent-role', roleName: 'Agent', permissions: ALL_PERMISSIONS, isOwner: false },
      delegation: { by: 'owner' },
    }
    const { response, payload } = await call(createHandler(principal), {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_document',
        arguments: { title: 'Web', content: '<p>Import Slack, Mattermost, and Discord.</p>' },
      },
    })

    expect(response.status).toBe(200)
    expect(payload.result.isError).not.toBe(true)
    expect(sqlite.prepare('SELECT title, content, created_by as createdBy FROM documents').get()).toEqual({
      title: 'Web',
      content: '<p>Import Slack, Mattermost, and Discord.</p>',
      createdBy: 'agent',
    })
    const audit = sqlite.prepare('SELECT action, target_type as targetType, actor_id as actorId, meta_json as metaJson FROM audit_log').get() as { action: string; targetType: string; actorId: string; metaJson: string }
    expect(audit).toMatchObject({
      action: 'document.create',
      targetType: 'document',
      actorId: 'agent',
    })
    expect(JSON.parse(audit.metaJson)).toMatchObject({ delegatedBy: 'owner', credentialKind: 'mcp' })
  })
})
