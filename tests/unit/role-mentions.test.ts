import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { editChannelMessage, listMentionRoles, requireMessageMember, sendChannelMessage } from '../../server/utils/message-service'
import { readableMentions } from '../../server/utils/member-names'
import { ROLE_MENTION_LIMIT, roleMentionRecipients } from '../../workers/role-mentions'
import { messageNotificationStatement } from '../../workers/notifications'

const serverId = '00000000-0000-4000-8000-000000000001'
const design = '20000000-0000-4000-8000-00000000000d'
const ops = '20000000-0000-4000-8000-00000000000e'
const user = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ids = { owner: user(1), sender: user(2), manager: user(3), ada: user(4), bea: user(5), otto: user(6), agent: user(7) }

let sqlite: DatabaseSync
let env: L4Env
let pending: Promise<unknown>[]
let receiveMessage: ReturnType<typeof vi.fn>
let largestBind = 0

/** The test D1 also enforces D1's limit of 100 bound parameters per statement. */
function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const statement = {
        bind(...next: SQLInputValue[]) {
          if (next.length > 100) throw new Error(`too many SQL variables: ${next.length}`)
          largestBind = Math.max(largestBind, next.length)
          values = next
          return statement
        },
        async first<T>() { return (database.prepare(sql).get(...values) as T | undefined) ?? null },
        async all<T>() { return { results: database.prepare(sql).all(...values) as T[] } },
        async raw() { const query = database.prepare(sql); query.setReturnArrays(true); return query.all(...values) },
        async run() { return { success: true, meta: database.prepare(sql).run(...values) } },
      }
      return statement
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      database.exec('BEGIN')
      try { const values = []; for (const statement of statements) values.push(await statement.run()); database.exec('COMMIT'); return values }
      catch (error) { database.exec('ROLLBACK'); throw error }
    },
  } as unknown as D1Database
}

beforeEach(() => {
  pending = []
  largestBind = 0
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  sqlite.exec(INIT_SQL)
  const member = Permission.mcpConnect | Permission.sendMessages
  sqlite.exec(`
    INSERT INTO server_identity(singleton,id) VALUES (1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask,mentionable) VALUES
      ('owner-role','owner','owner',0,0),
      ('member-role','custom:people','People',${member},0),
      ('manager-role','custom:manager','Moderators',${member | Permission.manageChannels},0),
      ('${design}','custom:design','Design',${member},1),
      ('${ops}','custom:ops','Ops',${member},0);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('${ids.owner}','human','Owner','active','owner-role','2026-10-28'),
      ('${ids.sender}','human','Sender','active','member-role','2026-10-28'),
      ('${ids.manager}','human','Manager','active','manager-role','2026-10-28'),
      ('${ids.ada}','human','Ada','active','${design}','2026-10-28'),
      ('${ids.bea}','human','Bea','active','${design}','2026-10-28'),
      ('${ids.otto}','human','Otto','active','${ops}','2026-10-28'),
      ('${ids.agent}','agent','Design Agent','active','${design}','2026-10-28');
    INSERT INTO server(id,name,owner_id) VALUES ('${serverId}','Role mentions','${ids.owner}');
    INSERT INTO agents(user_id,created_by) VALUES ('${ids.agent}','${ids.owner}');
    INSERT INTO channels(id,name,type,visibility) VALUES ('public-chat','general','text','server'),('private-chat','secret','text','private');
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES
      ('private-chat','${ids.sender}','2026-10-28'),('private-chat','${ids.ada}','2026-10-28'),('private-chat','${ids.agent}','2026-10-28');
  `)
  for (const id of [ids.ada, ids.bea, ids.otto, ids.agent]) subscribe(id)
  receiveMessage = vi.fn(async () => 'run')
  env = {
    DB: d1(sqlite), AI: {},
    AGENT_DO: { getByName: () => ({ receiveMessage }) },
    CHANNEL_DO: { getByName: () => ({ fanout: async () => {} }) },
    NOTIFICATION_DO: { getByName: () => ({ kick: async () => {} }) },
    SERVER_DO: { getByName: () => ({ notifyChannelActivity: async () => {}, notifyChannelRead: async () => {} }) },
  } as unknown as L4Env
})
afterEach(async () => { await Promise.all(pending); sqlite.close() })

function subscribe(id: string) {
  sqlite.prepare("INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at) VALUES (?,?,?,'k','a','2026-10-28','2026-10-28')")
    .run(`push-${id}`, id, `https://push.example/${id}`)
}
const schedule = (promise: Promise<unknown>) => { pending.push(promise) }
function context(id: string): AuthorizationContext {
  return { serverId, principal: { id, kind: 'human', roleId: 'stale', roleName: 'stale', permissions: ALL_PERMISSIONS, isOwner: false },
    credential: { kind: 'mcp', id: 'connection', clientId: 'client', scopes: ['messages:read', 'messages:write'] } }
}
const send = async (content: string, author = ids.sender, channelId = 'public-chat') =>
  (await sendChannelMessage(env, await requireMessageMember(env, context(author), 'messages:write'), channelId, { content }, schedule)).message
const edit = async (messageId: string, content: string, author = ids.sender) =>
  (await editChannelMessage(env, await requireMessageMember(env, context(author), 'messages:write'), messageId, { content }, schedule)).message
const mentioned = (messageId: string) => sqlite.prepare('SELECT user_id AS userId, role_id AS roleId FROM message_mentions WHERE message_id=? ORDER BY user_id').all(messageId)
const notified = () => sqlite.prepare('SELECT recipient_id AS id FROM notification_outbox ORDER BY recipient_id').all().map(row => row.id)

describe('role mentions', () => {
  it('reach the human holders of a mentionable Role with a mention row each, never invoking Agents', async () => {
    const message = await send(`<@&${design}> please review`)
    await Promise.all(pending)
    expect(mentioned(message.id)).toEqual([{ userId: ids.ada, roleId: design }, { userId: ids.bea, roleId: design }])
    expect(notified()).toEqual([ids.ada, ids.bea])
    expect(message).toMatchObject({ mentions: [], roleMentions: [design] })
    expect(receiveMessage).not.toHaveBeenCalled()
  })

  it('reach nobody when the sender may not mention the Role, unless they manage channels or own the Server', async () => {
    const blocked = await send(`<@&${ops}> deploy?`)
    expect(mentioned(blocked.id)).toEqual([])
    expect(blocked.roleMentions).toEqual([])
    expect(blocked.content).toBe(`<@&${ops}> deploy?`)
    expect(notified()).toEqual([])

    const managed = await send(`<@&${ops}> deploy?`, ids.manager)
    expect(mentioned(managed.id)).toEqual([{ userId: ids.otto, roleId: ops }])
    const owned = await send(`<@&${ops}> again`, ids.owner)
    expect(mentioned(owned.id)).toEqual([{ userId: ids.otto, roleId: ops }])
  })

  it('reach only Role holders who can read a private conversation', async () => {
    const message = await send(`<@&${design}> in here`, ids.sender, 'private-chat')
    expect(mentioned(message.id)).toEqual([{ userId: ids.ada, roleId: design }])
    expect(notified()).toEqual([ids.ada])
  })

  it('reach in a Mailbox only Role holders with its grant and a mail permission', async () => {
    sqlite.exec(`
      INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES('domain','zone','example.com','app.example.com');
      INSERT INTO channels(id,name,type,visibility) VALUES ('support','support','text','server');
      INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES('support','domain','support','Support');
      INSERT INTO email_mailbox_access(channel_id,user_id,permission) VALUES ('support','${ids.ada}','read');
    `)
    const reach = () => roleMentionRecipients(env, { channelId: 'support', authorId: ids.owner, content: `<@&${design}>`, mentions: [] })
    expect(await reach()).toEqual([])
    sqlite.exec(`UPDATE roles SET permissions_bitmask = permissions_bitmask | ${Permission.readMail} WHERE id = '${design}'`)
    expect(await reach()).toEqual([{ userId: ids.ada, roleId: design }])
  })

  it('push a direct mention in a Mailbox only to people who can read that Mailbox', async () => {
    sqlite.exec(`
      INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES('domain','zone','example.com','app.example.com');
      INSERT INTO channels(id,name,type,visibility) VALUES ('support','support','text','server');
      INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES('support','domain','support','Support');
      INSERT INTO email_mailbox_access(channel_id,user_id,permission) VALUES ('support','${ids.ada}','read');
      UPDATE roles SET permissions_bitmask = permissions_bitmask | ${Permission.readMail} WHERE id = '${design}';
    `)
    sqlite.exec(`INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES ('note','support','${ids.owner}','note','2026-10-28')`)
    const statement = await messageNotificationStatement(env, { id: 'note', channelId: 'support', author: { id: ids.owner, kind: 'human', displayName: 'Owner', avatarR2Key: null },
      content: `<@${ids.ada}> and <@${ids.bea}> see this note`, mentions: [ids.ada, ids.bea], attachmentCount: 0 })
    await statement!.run()
    // Bea holds the same Role but has no grant on this Mailbox, so the preview must not reach her.
    expect(notified()).toEqual([ids.ada])
  })

  it('push a direct mention in a Task discussion only to people who can read that Task', async () => {
    sqlite.exec(`
      INSERT INTO task_boards(id,name,created_by) VALUES ('board','Board','${ids.owner}'),('other','Other','${ids.owner}');
      INSERT INTO channels(id,name,type,visibility) VALUES ('discussion','task','text','server');
      INSERT INTO tasks(id,board_id,title,created_by,assignee_id,discussion_channel_id) VALUES ('task','board','Ship','${ids.owner}','${ids.otto}','discussion');
      UPDATE roles SET permissions_bitmask = permissions_bitmask | ${Permission.readTasks}, resource_access_json = '{"boards":["other"]}' WHERE id = '${design}';
    `)
    sqlite.exec(`INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES ('comment','discussion','${ids.owner}','c','2026-10-28')`)
    const statement = await messageNotificationStatement(env, { id: 'comment', channelId: 'discussion', author: { id: ids.owner, kind: 'human', displayName: 'Owner', avatarR2Key: null },
      content: 'c', mentions: [ids.ada, ids.otto], attachmentCount: 0 })
    await statement!.run()
    // Ada's Role reads only another Board; Otto is the assignee.
    expect(notified()).toEqual([ids.otto])
  })

  it('leave the author and directly mentioned Members to their direct mention', async () => {
    const message = await send(`<@&${design}> and <@${ids.bea}>`, ids.ada)
    expect(mentioned(message.id)).toEqual([{ userId: ids.bea, roleId: null }])
    expect(message).toMatchObject({ mentions: [ids.bea], roleMentions: [] })
    expect(notified()).toEqual([ids.bea])
  })

  it('reach hundreds of Members in statements under the bound-parameter limit, capped at the fan-out limit', async () => {
    const insert = sqlite.prepare(`INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES (?,'human',?,'active','${design}','2026-10-28')`)
    for (let n = 100; n < 100 + ROLE_MENTION_LIMIT + 20; n += 1) {
      insert.run(user(n), `Designer ${n}`)
      subscribe(user(n))
    }
    const message = await send(`<@&${design}> all hands`)
    expect(largestBind).toBeLessThanOrEqual(100)
    expect(mentioned(message.id)).toHaveLength(ROLE_MENTION_LIMIT)
    expect(notified()).toHaveLength(ROLE_MENTION_LIMIT)
  })

  it('notify on edit only the Members a newly added role mention reaches', async () => {
    const message = await send(`Hi <@${ids.ada}>`)
    expect(notified()).toEqual([ids.ada])
    await edit(message.id, `Hi <@${ids.ada}> and <@&${design}>`)
    await Promise.all(pending)
    expect(notified()).toEqual([ids.ada, ids.bea])
    expect(mentioned(message.id)).toEqual([{ userId: ids.ada, roleId: null }, { userId: ids.bea, roleId: design }])
    await edit(message.id, `Hi <@&${design}>, thanks`)
    expect(sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get()).toMatchObject({ n: 2 })
    expect(receiveMessage).not.toHaveBeenCalled()
  })

  it('read as @RoleName for Agents and excerpts', async () => {
    expect(await readableMentions(env, [`<@&${design}> and <@${ids.ada}>`, '<@&20000000-0000-4000-8000-000000000999>']))
      .toEqual(['@Design and @Ada', '<@&20000000-0000-4000-8000-000000000999>'])
  })

  it('list the mention tokens a Member may use', async () => {
    const roles = async (id: string) => (await listMentionRoles(env, await requireMessageMember(env, context(id), 'messages:read'))).roles
    expect(await roles(ids.sender)).toEqual([{ id: design, name: 'Design', mentionable: true, memberCount: 2, mentionToken: `<@&${design}>` }])
    expect((await roles(ids.manager)).map(role => role.name)).toEqual(expect.arrayContaining(['Owner', 'People', 'Moderators', 'Design', 'Ops']))
  })
})
