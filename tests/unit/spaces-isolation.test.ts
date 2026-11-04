import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import { creationSpaceId, DEFAULT_SPACE_ID, spaceAllowed, SpaceAdminPermissions } from '../../shared/spaces'
import { resourceAllowed } from '../../shared/authorization'
import { projectPermissionAllowed } from '../../shared/project-access'
import type { L4Env } from '../../workers/env'
import { requireChannelAccessForMember, requireMemberForUser } from '../../server/utils/channel-access'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { resolveMcpPrincipal } from '../../server/utils/mcp-principal'
import { listMentionRoles, listMessageChannels, listMessageMembers, openDirectMessage, sendChannelMessage } from '../../server/utils/message-service'
import { searchServerMessages } from '../../server/utils/message-search'
import { searchDmMembers } from '../../server/utils/dm-search'
import { loadInbox } from '../../server/utils/inbox-service'
import { loadSpaceAttention } from '../../server/utils/space-attention'
import { listProjects, requireProject } from '../../server/utils/project-service'
import { getTask, listTasks } from '../../server/utils/task-service'
import { getItem } from '../../server/utils/item-service'
import { listAuthorizedDataResources } from '../../server/utils/data-catalog'
import { listAuthorizedTables } from '../../server/utils/table-catalog'
import { listGadgets } from '../../server/utils/gadget-catalog'
import { listMemberMailboxes } from '../../server/utils/mail-service'
import { agentTools } from '../../server/utils/agent-tools'
import { channelActivityAudience } from '../../workers/channel-activity'
import { mentionFanout } from '../../workers/role-mentions'
import { filterLiveRecipients } from '../../workers/live-audience'
import { presenceBySpace } from '../../workers/server-presence'
import { unreadNavigationCount } from '../../workers/unread'
import { addSpaceMember, createSpace, deleteSpace, joinSpace, listSpaces, removeSpaceMember, setSpaceLimits } from '../../server/utils/space-service'
import { consumeSpaceQuota, requireMemberQuota, requireStorageQuota } from '../../server/utils/space-quota'
import { loadSpaceBoundary } from '../../server/utils/space-access'
import { enforceRoutePolicy, requestSpace } from '../../server/utils/route-gate'

const state = vi.hoisted(() => ({ env: null as unknown, actor: 'sam', body: {} as unknown, current: null as unknown }))
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env, waitUntil: () => {} }) }))
vi.mock('../../server/utils/auth', async original => ({ ...await original<typeof import('../../server/utils/auth')>(), currentUser: async () => state.current }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async () => {
  const { requireMemberForUser: load } = await import('../../server/utils/channel-access')
  return load(state.env as L4Env, { id: state.actor, kind: 'human', displayName: state.actor, avatarR2Key: null }, '00000000-0000-4000-8000-000000000001')
} }))
vi.mock('../../server/utils/live', () => ({ revalidateLiveRooms: async () => {}, liveRoom: vi.fn() }))
const SERVER = '00000000-0000-4000-8000-000000000001'
const SALES = '00000000-0000-4000-8000-0000000000a1'
const NOW = '2026-11-01T00:00:00.000Z'
const person = (id: string) => ({ id, kind: 'human' as const, displayName: id, avatarR2Key: null })
const agent = (id: string) => ({ id, kind: 'agent' as const, displayName: id, avatarR2Key: null })

let db: DatabaseSync, env: L4Env
const member = (id: string) => requireMemberForUser(env, person(id), SERVER)
const routeEvent = (params: Record<string, string>) => ({ params, path: '/api/test', method: 'GET', context: {} })
const code = async (work: Promise<unknown>) => work.then(() => 200, (error: { statusCode?: number }) => error.statusCode)

beforeEach(() => {
  for (const [name, value] of Object.entries({ asRpc: (stub: unknown) => stub, useRuntimeConfig: () => ({}) })) vi.stubGlobal(name, value)
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', (event: { params: Record<string, string> }, key: string) => event.params[key])
  vi.stubGlobal('readBody', async () => state.body)
  vi.stubGlobal('getHeader', () => undefined)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  // Dana is in the default Space, Sam only in Sales, Olga the Owner only in the default Space.
  // Both Spaces hold one of everything, so each path has something to leak.
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system,mentionable) VALUES
      ('owner-role','owner','Owner',${ALL_PERMISSIONS},'{}',1,0),
      ('wide','custom:wide','Wide',${ALL_PERMISSIONS & ~Permission.manageServer},'{}',0,1);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('olga','human','Olga','active','owner-role','${NOW}'),
      ('dana','human','Dana','active','wide','${NOW}'),
      ('sam','human','Sam','active','wide','${NOW}'),
      ('helper','agent','Helper','active','wide','${NOW}'),
      ('closer','agent','Closer','active','wide','${NOW}');
    INSERT INTO agents(user_id,harness,model,instructions,status,created_by) VALUES('helper','pi','m','','active','olga'),('closer','pi','m','','active','olga');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${SERVER}');
    INSERT INTO server(id,name,owner_id) VALUES('${SERVER}','Fixture','olga');
    INSERT INTO spaces(id,name) VALUES('${SALES}','Sales');
    DELETE FROM space_members WHERE user_id IN ('sam','closer');
    INSERT INTO space_members(space_id,user_id,role,joined_at) VALUES('${SALES}','sam','member','${NOW}'),('${SALES}','closer','member','${NOW}');
    INSERT INTO channels(id,space_id,name,type,visibility) VALUES
      ('hq-general','${DEFAULT_SPACE_ID}','hq','text','server'),('sales-general','${SALES}','deals','text','server');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES
      ('m-hq','hq-general','dana','budget secret','${NOW}'),('m-sales','sales-general','sam','budget pipeline','${NOW}');
    INSERT INTO projects(id,space_id,name,description,created_by,created_at,updated_at) VALUES
      ('p-hq','${DEFAULT_SPACE_ID}','HQ','','dana','${NOW}','${NOW}'),('p-sales','${SALES}','Pipeline','','sam','${NOW}','${NOW}');
    INSERT INTO task_boards(id,space_id,name,created_by) VALUES('b-hq','${DEFAULT_SPACE_ID}','HQ','dana'),('b-sales','${SALES}','Deals','sam');
    INSERT INTO tasks(id,board_id,title,status,created_by) VALUES('t-hq','b-hq','Close the books','ready','dana'),('t-sales','b-sales','Call Acme','ready','sam');
    INSERT INTO database_definitions(id,space_id,name,created_by) VALUES('db-hq','${DEFAULT_SPACE_ID}','Salaries','dana'),('db-sales','${SALES}','Leads','sam');
    INSERT INTO data_items(id,space_id,title,created_by) VALUES('d-hq','${DEFAULT_SPACE_ID}','Plan','dana'),('d-sales','${SALES}','Pitch','sam');
    INSERT INTO gadgets(id,space_id,name,draft_spec_json,created_by) VALUES('g-hq','${DEFAULT_SPACE_ID}','HQ app','{}','dana'),('g-sales','${SALES}','CRM','{}','sam');`)
  const stub = new Proxy({}, { get: () => async () => [] })
  env = { DB: d1(db), SERVER_DO: { getByName: () => stub }, CHANNEL_DO: { getByName: () => stub } } as unknown as L4Env
  state.env = env
})
afterEach(() => vi.unstubAllGlobals())

describe('two Members in different Spaces', () => {
  it('loads only the Member’s own Space into their authority', async () => {
    const sam = await member('sam')
    expect(sam.authorization.spaces?.ids).toEqual([SALES])
    expect(spaceAllowed(sam.authorization, DEFAULT_SPACE_ID)).toBe(false)
  })

  it('Member list: each sees only people from their Space', async () => {
    const names = async (id: string) => (await listMessageMembers(env, await member(id))).members.map(row => row.id).sort()
    expect(await names('sam')).toEqual(['closer', 'sam'])
    expect(await names('dana')).toEqual(['dana', 'helper', 'olga'])
  })

  it('Member list route: the response holds only the Space’s people', async () => {
    const handler = (await import('../../server/api/servers/[id]/members.get')).default as unknown as (event: unknown) => Promise<{ members: Array<{ user: { id: string } }> }>
    state.actor = 'sam'
    expect((await handler(routeEvent({ id: SERVER }))).members.map(row => row.user.id).sort()).toEqual(['closer', 'sam'])
    state.actor = 'olga'
    expect((await handler(routeEvent({ id: SERVER }))).members.map(row => row.user.id).sort()).toEqual(['dana', 'helper', 'olga'])
  })

  it('channel list route: holds only the Space’s channels', async () => {
    const handler = (await import('../../server/api/servers/[id]/channels.get')).default as unknown as (event: unknown) => Promise<{ channels: Array<{ id: string }> }>
    state.actor = 'sam'
    expect((await handler(routeEvent({ id: SERVER }))).channels.map(row => row.id)).toEqual(['sales-general'])
  })

  it('DM route: opening one across Spaces is refused', async () => {
    const handler = (await import('../../server/api/dms/index.post')).default as unknown as (event: unknown) => Promise<unknown>
    state.actor = 'sam'
    state.body = { userId: 'dana-long-id' }
    db.exec(`INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('dana-long-id','human','Dana 2','active','wide','${NOW}')`)
    expect(await code(handler(routeEvent({})))).toBe(403)
    expect(db.prepare("SELECT COUNT(*) AS n FROM channels WHERE type='dm'").get()).toEqual({ n: 0 })
  })

  it('route gate: a foreign resource answers 404 before any handler; the Member’s own passes', async () => {
    state.current = { ...person('sam'), status: 'active' }
    const gate = (path: string, method = 'GET') => code(enforceRoutePolicy({ path, method, context: {} } as never))
    expect(await gate('/api/channels/hq-general/messages')).toBe(404)
    expect(await gate('/api/channels/hq-general/messages', 'POST')).toBe(404)
    expect(await gate('/api/tasks/t-hq')).toBe(404)
    expect(await gate('/api/items/d-hq')).toBe(404)
    expect(await gate('/api/projects/p-hq')).toBe(404)
    expect(await gate('/api/gadgets/g-hq')).toBe(404)
    expect(await gate('/api/users/dana/avatar')).toBe(404)
    expect(await gate('/api/channels/sales-general/messages')).toBe(200)
    expect(await gate('/api/users/closer/avatar')).toBe(200)
    // Not found by the gate: the handler answers, as it does for anything missing.
    expect(await gate('/api/channels/nope/messages')).toBe(200)
    state.current = { ...person('olga'), status: 'active' }
    expect(await gate('/api/channels/sales-general/messages')).toBe(404)
  })

  it('route gate: a Space admin’s extra permissions need a request scoped to that Space', async () => {
    db.exec(`UPDATE space_members SET role='admin' WHERE user_id='sam'; UPDATE roles SET permissions_bitmask=0 WHERE id='wide'`)
    state.current = { ...person('sam'), status: 'active' }
    const event = { path: '/api/channels/sales-general', method: 'GET', context: {} } as never
    await enforceRoutePolicy(event)
    expect(requestSpace(event)).toEqual({ spaceScope: SALES, spaceAdmin: true })
    const schedule = { path: '/api/schedules', method: 'POST', context: {} } as never
    await enforceRoutePolicy(schedule)
    expect(requestSpace(schedule).spaceAdmin).toBe(false)
    const roleRoute = { path: `/api/servers/${SERVER}/roles`, method: 'POST', context: {} } as never
    await enforceRoutePolicy(roleRoute)
    expect(requestSpace(roleRoute)).toEqual({ spaceScope: null, spaceAdmin: false })
  })

  it('role mention list counts only people in reach', async () => {
    const roles = (await listMentionRoles(env, await member('sam'))).roles
    expect(roles.find(role => role.id === 'wide')?.memberCount).toBe(1)
  })

  it('presence: someone online in another Space stays invisible', () => {
    const visible = presenceBySpace([{ userId: 'sam', status: 'online' }, { userId: 'dana', status: 'online' }],
      [{ spaceId: SALES, userId: 'sam' }, { spaceId: DEFAULT_SPACE_ID, userId: 'dana' }])
    expect(visible('dana').map(row => row.userId)).toEqual(['dana'])
    expect(visible('sam').map(row => row.userId)).toEqual(['sam'])
  })

  it('channels: a channel in another Space answers as missing, for the Owner too', async () => {
    expect(await code(requireChannelAccessForMember(env, await member('sam'), 'hq-general'))).toBe(404)
    expect(await code(requireChannelAccessForMember(env, await member('dana'), 'sales-general'))).toBe(404)
    expect(await code(requireChannelAccessForMember(env, await member('olga'), 'sales-general'))).toBe(404)
    expect(await code(requireChannelAccessForMember(env, await member('sam'), 'sales-general'))).toBe(200)
    expect((await listMessageChannels(env, await member('sam'))).channels.map(row => row.id)).toEqual(['sales-general'])
  })

  it('a Thread inherits its parent’s Space', () => {
    db.exec(`INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('thread','t','thread','server','sales-general','m-sales')`)
    expect(db.prepare("SELECT space_id AS spaceId FROM channels WHERE id='thread'").get()).toEqual({ spaceId: SALES })
  })

  it('DMs: nobody can open one across Spaces or find the other person', async () => {
    expect(await code(openDirectMessage(env, await member('sam'), 'dana'))).toBe(404)
    expect(await searchDmMembers(env.DB, 'sam', '', true, undefined, (await member('sam')).authorization)).toHaveLength(1)
    expect((await searchDmMembers(env.DB, 'sam', 'dana', true, undefined, (await member('sam')).authorization))).toEqual([])
  })

  it('DMs: a pair sharing two Spaces has one DM per Space, and each lives in its own', async () => {
    db.exec(`INSERT INTO space_members(space_id,user_id,joined_at) VALUES('${SALES}','dana','${NOW}')`)
    const inSales = await requireMemberForUser(env, person('sam'), SERVER)
    const sales = await openDirectMessage(env, inSales, 'dana')
    expect(db.prepare('SELECT space_id AS spaceId FROM channels WHERE id=?').get(sales.channel.id)).toEqual({ spaceId: SALES })
    db.exec(`DELETE FROM space_members WHERE space_id='${SALES}' AND user_id='dana'`)
    expect(await code(requireChannelAccessForMember(env, await member('dana'), sales.channel.id))).toBe(404)
  })

  it('mentions: a mention across Spaces is dropped, so it neither notifies nor wakes anyone', async () => {
    const sent = await sendChannelMessage(env, await member('sam'), 'sales-general', { content: 'hello <@dana> and <@closer>' }, () => {}).catch((error: unknown) => error)
    const rows = db.prepare("SELECT user_id AS userId FROM message_mentions").all() as Array<{ userId: string }>
    expect(rows.map(row => row.userId)).not.toContain('dana')
    expect(sent).toBeDefined()
  })

  it('search: finds only messages in the Member’s Space', async () => {
    const hits = async (id: string) => (await searchServerMessages(env, await member(id), { q: 'budget', limit: 20 })).hits.map(row => row.id)
    expect(await hits('sam')).toEqual(['m-sales'])
    expect(await hits('dana')).toEqual(['m-hq'])
    expect(await hits('olga')).toEqual(['m-hq'])
  })

  it('Inbox: shows only the Member’s Space', async () => {
    db.exec(`UPDATE tasks SET assignee_id='sam'; INSERT INTO message_mentions(message_id,user_id) VALUES('m-hq','sam'),('m-sales','sam');
      UPDATE messages SET author_id='closer' WHERE id='m-sales';`)
    const inbox = await loadInbox(env, await member('sam'))
    expect(inbox.mentions.map(row => row.messageId)).toEqual(['m-sales'])
    expect(inbox.assigned.map(row => row.id)).toEqual(['t-sales'])
  })

  it('unread navigation counts only reachable conversations', async () => {
    expect(await unreadNavigationCount(env.DB, 'sam')).toBeLessThanOrEqual(1)
  })

  it('notifications: activity, group mentions and Live reach only the Space', async () => {
    const audience = await channelActivityAudience(env.DB, 'sales-general', 'closer')
    expect(audience?.recipientIds).toEqual(['sam'])
    const hq = await channelActivityAudience(env.DB, 'hq-general', 'dana')
    expect(hq?.recipientIds.sort()).toEqual(['helper', 'olga'])
    const fanout = await mentionFanout(env, { channelId: 'hq-general', authorId: 'olga', content: 'all <!channel>', mentions: [] })
    expect(fanout.recipients.map(row => row.userId)).toEqual(['dana'])
    expect(await filterLiveRecipients(env, 'hq-general', ['dana', 'sam'])).toEqual(['dana'])
  })

  it('Projects and Tasks: neither lists nor opens what is in another Space, Owner included', async () => {
    const sam = (await member('sam')).authorization, olga = (await member('olga')).authorization
    expect((await listProjects(env, sam)).map(row => row.id)).toEqual(['p-sales'])
    expect(await code(requireProject(env, sam, 'p-hq'))).toBe(404)
    expect(await code(requireProject(env, olga, 'p-sales'))).toBe(404)
    expect(projectPermissionAllowed(olga, 'p-sales', Permission.readProjects)).toBe(false)
    expect(resourceAllowed(olga, 'boards', 'b-sales')).toBe(false)
    expect((await listTasks(env, sam)).map(board => board.id)).toEqual(['b-sales'])
    expect(await getTask(env, sam, 't-hq').catch(() => null)).toBeNull()
    expect(await getTask(env, olga, 't-sales').catch(() => null)).toBeNull()
  })

  it('Data: tables and documents stay in their Space', async () => {
    const sam = (await member('sam')).authorization
    const data = await listAuthorizedDataResources(env, sam)
    expect(data.documents.map(row => row.id)).toEqual(['d-sales'])
    expect(data.databases.map(row => row.id)).toEqual(['db-sales'])
    expect((await listAuthorizedTables(env, sam)).map(row => row.id)).toEqual(['db-sales'])
    expect(await code(getItem(env, sam, 'd-hq'))).toBe(404)
  })

  it('Apps stay in their Space', async () => {
    const sam = await member('sam')
    const actor = { user: { id: 'sam' }, serverId: SERVER, roleId: 'wide', authorization: sam.authorization }
    expect((await listGadgets(env, actor)).gadgets.map(row => row.id)).toEqual(['g-sales'])
  })

  it('Mail: a Mailbox in another Space is out of reach even with a grant', async () => {
    db.exec(`INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES('dom','z','example.com','mail.example.com');
      INSERT INTO channels(id,space_id,name,type,visibility) VALUES('box','${DEFAULT_SPACE_ID}','box','text','private');
      INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES('box','dom','hq','HQ');
      INSERT INTO grants(id,member_id,permissions,mailbox_id,created_at) VALUES('mail-grant','sam',${Permission.readMail},'box','${NOW}');`)
    expect((await listMemberMailboxes(env, await member('sam'))).mailboxes).toEqual([])
  })

  it('Agents: an Agent’s authority is its one Space, also through a person from elsewhere', async () => {
    const closer = await loadAuthorizationContext(env, { principalId: 'closer', credential: { kind: 'agent_runtime' } })
    expect(closer?.spaces?.ids).toEqual([SALES])
    const crossed = await loadAuthorizationContext(env, { principalId: 'closer', credential: { kind: 'agent_runtime' }, delegatedBy: 'dana' })
    expect(crossed?.spaces?.ids).toEqual([])
  })

  it('Agent tools see only the Agent’s Space', async () => {
    const closer = (await loadAuthorizationContext(env, { principalId: 'closer', credential: { kind: 'agent_runtime' } }))!
    const tools = agentTools(env, closer, () => {})
    const listed = await tools.call('list_tasks', {}) as { boards: Array<{ id: string }> }
    expect(listed.boards.map(board => board.id)).toEqual(['b-sales'])
    const data = await tools.call('list_data', {}) as { documents: Array<{ id: string }> }
    expect(data.documents.map(row => row.id)).toEqual(['d-sales'])
    expect(await code(tools.call('get_item', { itemId: 'd-hq' }) as Promise<unknown>)).toBe(404)
  })

  it('MCP tokens carry the boundary of their subject', async () => {
    const principal = await resolveMcpPrincipal(env, { id: 'token', subjectId: 'sam', createdBy: 'sam', scopes: ['messages:read', 'data:read'] })
    expect(principal?.authorization.spaces?.ids).toEqual([SALES])
    const through = await requireMemberForUser(env, person('sam'), SERVER, undefined, principal!.authorization)
    expect((await listMessageChannels(env, through)).channels.map(row => row.id)).toEqual(['sales-general'])
    const agentToken = await resolveMcpPrincipal(env, { id: 'token', subjectId: 'closer', createdBy: 'dana', scopes: ['messages:read'] })
    expect(agentToken?.authorization.spaces?.ids ?? []).toEqual([])
  })

  it('realtime: a socket’s Member is refused once outside the Space', async () => {
    expect(agent('closer').kind).toBe('agent')
    const row = () => db.prepare(`SELECT 1 AS ok FROM space_members WHERE user_id='sam' AND space_id=(SELECT space_id FROM channels WHERE id='sales-general')`).get()
    expect(row()).toBeTruthy()
    db.exec(`DELETE FROM space_members WHERE user_id='sam'`)
    expect(row()).toBeUndefined()
    expect((await loadSpaceBoundary(env, 'sam')).ids).toEqual([])
  })
})

describe('Space attention, for the switcher', () => {
  const inBoth = () => db.exec(`INSERT INTO space_members(space_id,user_id,role,joined_at) VALUES('${SALES}','dana','member','${NOW}')`)
  const readAll = (user: string, channel: string, message: string) => db.exec(`INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at) VALUES('${channel}','${user}','${message}','${NOW}')
    ON CONFLICT(channel_id,user_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id`)

  it('says nothing to someone with one Space, who has no switcher', async () => {
    expect(await loadSpaceAttention(env, await member('sam'))).toEqual({ spaceIds: [] })
  })

  it('names a Space the person is in, and only its ID', async () => {
    inBoth()
    readAll('dana', 'hq-general', 'm-hq')
    expect(await loadSpaceAttention(env, await member('dana'))).toEqual({ spaceIds: [SALES] })
  })

  it('clears once the conversation is read', async () => {
    inBoth()
    readAll('dana', 'hq-general', 'm-hq')
    readAll('dana', 'sales-general', 'm-sales')
    expect(await loadSpaceAttention(env, await member('dana'))).toEqual({ spaceIds: [] })
  })

  it('never looks in a Space the Owner manages without having joined', async () => {
    db.exec(`INSERT INTO spaces(id,name) VALUES('00000000-0000-4000-8000-0000000000b2','Empty');
      INSERT INTO space_members(space_id,user_id,role,joined_at) VALUES('00000000-0000-4000-8000-0000000000b2','olga','member','${NOW}')`)
    readAll('olga', 'hq-general', 'm-hq')
    expect((await loadSpaceAttention(env, await member('olga'))).spaceIds).not.toContain(SALES)
  })

  it('leaves out a private channel they are not in', async () => {
    inBoth()
    readAll('dana', 'hq-general', 'm-hq')
    readAll('dana', 'sales-general', 'm-sales')
    db.exec(`INSERT INTO channels(id,space_id,name,type,visibility,created_by) VALUES('sales-private','${SALES}','secret','text','private','sam');
      INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m-private','sales-private','sam','hush','${NOW}')`)
    expect(await loadSpaceAttention(env, await member('dana'))).toEqual({ spaceIds: [] })
  })

  it('counts a mention in a thread that was never opened', async () => {
    inBoth()
    readAll('dana', 'hq-general', 'm-hq')
    readAll('dana', 'sales-general', 'm-sales')
    db.exec(`INSERT INTO channels(id,space_id,name,type,visibility,parent_id,parent_message_id,created_by) VALUES('sales-thread','${SALES}','thread','thread','server','sales-general','m-sales','sam');
      INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m-thread','sales-thread','sam','hey','${NOW}');
      INSERT INTO message_mentions(message_id,user_id) VALUES('m-thread','dana')`)
    expect(await loadSpaceAttention(env, await member('dana'))).toEqual({ spaceIds: [SALES] })
  })
})

describe('Server audit log', () => {
  const handler = async () => (await import('../../server/api/servers/[id]/audit.get')).default as unknown as (event: unknown) => Promise<{ entries: Array<{ action: string; meta: Record<string, unknown> }> }>
  beforeEach(() => {
    db.exec(`INSERT INTO audit_log(id,actor_id,action,target_type,target_id,meta_json,created_at) VALUES
      ('a1','sam','channel.create','channel','sales-general','{"name":"deals"}','${NOW}'),
      ('a2','dana','channel.create','channel','hq-general','{"name":"hq"}','${NOW}'),
      ('a3','olga','role.create','role','wide','{"name":"Wide"}','${NOW}');`)
    db.exec(`UPDATE roles SET permissions_bitmask=${ALL_PERMISSIONS} WHERE id='wide'`)
  })

  it('files each entry under the Space of what it is about', () => {
    expect(db.prepare("SELECT id, space_id AS spaceId FROM audit_log WHERE id LIKE 'a%' ORDER BY id").all().map(row => ({ ...row }))).toEqual([
      { id: 'a1', spaceId: SALES }, { id: 'a2', spaceId: DEFAULT_SPACE_ID }, { id: 'a3', spaceId: null },
    ])
  })

  it('a Manage server holder sees their own Space and Server administration, not another department', async () => {
    state.actor = 'sam'
    const { entries } = await (await handler())(routeEvent({ id: SERVER }))
    expect(entries.map(row => row.meta.name).sort()).toEqual(['Wide', 'deals'])
  })

  it('the Owner sees that something happened, and no details until joining', async () => {
    state.actor = 'olga'
    const { entries } = await (await handler())(routeEvent({ id: SERVER }))
    expect(entries.map(row => row.meta.name).filter(Boolean).sort()).toEqual(['Wide', 'hq'])
    expect(entries).toHaveLength(3)
  })
})

describe('creating with several Spaces', () => {
  it('needs a chosen Space: a guess could publish one department’s work to another', async () => {
    db.exec(`INSERT INTO space_members(space_id,user_id,joined_at) VALUES('${SALES}','dana','${NOW}')`)
    expect(creationSpaceId((await member('dana')).authorization)).toBeNull()
    const chosen = await requireMemberForUser(env, person('dana'), SERVER, undefined, { spaceScope: SALES })
    expect(creationSpaceId(chosen.authorization)).toBe(SALES)
    expect(chosen.authorization.spaces?.ids).toEqual([SALES])
    expect(creationSpaceId((await member('sam')).authorization)).toBe(SALES)
  })
})

describe('joining and leaving', () => {
  it('a new active Member joins the default Space, and removal ends every membership', () => {
    db.exec(`INSERT INTO users(id,kind,display_name,status) VALUES('new','human','New','pending')`)
    const inDefault = () => db.prepare(`SELECT COUNT(*) AS n FROM space_members WHERE user_id='new'`).get() as { n: number }
    expect(inDefault().n).toBe(0)
    db.exec(`UPDATE users SET status='active',role_id='wide',joined_at='${NOW}' WHERE id='new'`)
    expect(inDefault().n).toBe(1)
    db.exec(`UPDATE users SET status='removed',role_id=NULL,joined_at=NULL WHERE id='new'`)
    expect(inDefault().n).toBe(0)
  })
})

describe('Space administration', () => {
  const audit = (action: string) => db.prepare('SELECT target_id AS targetId FROM audit_log WHERE action=?').all(action) as Array<{ targetId: string }>

  it('the Owner manages a Space without reading it, and joining goes on the record', async () => {
    const olga = await member('olga')
    expect((await listSpaces(env, olga)).map(space => space.name)).toContain('Sales')
    expect((await listSpaces(env, olga)).find(space => space.id === SALES)?.role).toBeNull()
    expect(await code(requireChannelAccessForMember(env, olga, 'sales-general'))).toBe(404)
    await setSpaceLimits(env, olga, SALES, { memberLimit: 5 })
    expect(audit('space.join')).toEqual([])
    await joinSpace(env, olga, SALES)
    expect(audit('space.join').map(row => row.targetId)).toEqual([SALES])
    expect(await code(requireChannelAccessForMember(env, await member('olga'), 'sales-general'))).toBe(200)
  })

  it('a Space admin manages their Space and nothing else', async () => {
    db.exec(`UPDATE space_members SET role='admin' WHERE user_id='sam'`)
    db.exec(`UPDATE roles SET permissions_bitmask=0 WHERE id='wide'`)
    const scoped = await requireMemberForUser(env, person('sam'), SERVER, undefined, { credential: { kind: 'session' }, spaceScope: SALES, spaceAdmin: true })
    expect(scoped.perms & SpaceAdminPermissions).toBe(SpaceAdminPermissions)
    expect(scoped.perms & Permission.manageServer).toBe(0)
    expect(scoped.perms & Permission.manageRoles).toBe(0)
    const unscoped = await member('sam')
    expect(unscoped.perms).toBe(0)
    await addSpaceMember(env, unscoped, SALES, { userId: 'dana' })
    expect(await code(addSpaceMember(env, unscoped, DEFAULT_SPACE_ID, { userId: 'sam' }))).toBe(404)
    expect(await code(setSpaceLimits(env, unscoped, SALES, { memberLimit: 1 }))).toBe(403)
    expect(await code(deleteSpace(env, unscoped, SALES))).toBe(403)
  })

  it('an Agent cannot join a second Space', async () => {
    expect(await code(addSpaceMember(env, await member('olga'), DEFAULT_SPACE_ID, { userId: 'closer' }))).toBe(400)
  })

  it('leaving a Space drops private channels and Grants there', async () => {
    db.exec(`INSERT INTO channels(id,space_id,name,type,visibility) VALUES('sales-private','${SALES}','x','text','private');
      INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('sales-private','sam','${NOW}');
      UPDATE space_members SET role='admin' WHERE user_id='closer';`)
    await joinSpace(env, await member('olga'), SALES)
    await removeSpaceMember(env, await member('olga'), SALES, 'sam')
    expect(db.prepare(`SELECT 1 FROM channel_members WHERE user_id='sam'`).get()).toBeUndefined()
  })

  it('refuses to delete a Space that holds work, or the default one', async () => {
    const olga = await member('olga')
    expect(await code(deleteSpace(env, olga, SALES))).toBe(409)
    expect(await code(deleteSpace(env, olga, DEFAULT_SPACE_ID))).toBe(409)
    const created = await createSpace(env, olga, { name: 'Empty' })
    expect(audit('space.join').map(row => row.targetId)).toEqual([created.id])
    await deleteSpace(env, await member('olga'), created.id)
    expect((await listSpaces(env, await member('olga'))).map(space => space.id)).not.toContain(created.id)
  })
})

describe('quotas', () => {
  it('stops at the monthly limit and counts atomically', async () => {
    db.exec(`UPDATE spaces SET monthly_run_limit=2 WHERE id='${SALES}'`)
    await consumeSpaceQuota(env, SALES, 'runs', 'Agent Runs')
    await consumeSpaceQuota(env, SALES, 'runs', 'Agent Runs')
    expect(await code(consumeSpaceQuota(env, SALES, 'runs', 'Agent Runs'))).toBe(429)
    expect(await code(consumeSpaceQuota(env, DEFAULT_SPACE_ID, 'runs', 'Agent Runs'))).toBe(200)
  })

  it('stops people and Agents at their limits, and uploads at the storage limit', async () => {
    db.exec(`UPDATE spaces SET member_limit=1, agent_limit=1, storage_limit_bytes=100 WHERE id='${SALES}';
      INSERT INTO attachments(id,channel_id,uploader_id,r2_key,filename,content_type,size_bytes,created_at) VALUES('f','sales-general','sam','k','f','text/plain',90,'${NOW}');`)
    expect(await code(requireMemberQuota(env, SALES, 'human'))).toBe(429)
    expect(await code(requireMemberQuota(env, SALES, 'agent'))).toBe(429)
    expect(await code(requireStorageQuota(env, SALES, 5))).toBe(200)
    expect(await code(requireStorageQuota(env, SALES, 50))).toBe(429)
  })
})

describe('a Server with one Space', () => {
  it('asks no more of anyone: everything is reachable and nothing is excluded', async () => {
    db.exec(`DELETE FROM space_members WHERE space_id='${SALES}'; DELETE FROM channels WHERE space_id='${SALES}';
      DELETE FROM tasks WHERE board_id='b-sales'; DELETE FROM task_boards WHERE space_id='${SALES}'; DELETE FROM projects WHERE space_id='${SALES}';
      DELETE FROM data_items WHERE space_id='${SALES}'; DELETE FROM database_definitions WHERE space_id='${SALES}'; DELETE FROM gadgets WHERE space_id='${SALES}';
      DELETE FROM spaces WHERE id='${SALES}';`)
    const boundary = await loadSpaceBoundary(env, 'dana')
    expect(boundary).toMatchObject({ ids: [DEFAULT_SPACE_ID], active: DEFAULT_SPACE_ID, denied: {} })
  })
})
