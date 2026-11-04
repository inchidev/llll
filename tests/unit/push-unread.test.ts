import { expect, it } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { unreadNavigationCount } from '../../workers/unread'

it('counts unread visible conversations once, excluding private and hidden conversations', async () => {
  const f = mcpFixture()
  try {
    f.db.prepare('UPDATE roles SET permissions_bitmask=0 WHERE id=?').run(ids.memberRole)
    f.db.exec(`INSERT INTO channels(id,name,type,visibility) VALUES
      ('secret','Secret','text','private'),('archived','Archived','text','server'),
      ('dm-visible','DM','dm','private'),('dm-hidden','Hidden DM','dm','private'),('dm-agent','Agent DM','dm','private');
      UPDATE channels SET archived_at='2026-01-01' WHERE id='archived';`)
    const member = f.db.prepare("INSERT INTO channel_members(channel_id,user_id,hidden_at,joined_at) VALUES (?,?,?,'2026-01-01')")
    for (const channel of ['dm-visible', 'dm-hidden', 'dm-agent']) member.run(channel, ids.member, channel === 'dm-hidden' ? '2026-01-01' : null)
    member.run('dm-agent', ids.agent, null)
    const message = f.db.prepare('INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)')
    for (const channel of ['public-chat', 'secret', 'archived', 'dm-visible', 'dm-hidden', 'dm-agent']) message.run('msg-' + channel, channel, ids.owner, 'hello', '2026-01-01')
    message.run('msg-public-chat-2', 'public-chat', ids.owner, 'again', '2026-01-01')
    expect(await unreadNavigationCount(f.env.DB, ids.member)).toBe(2)
    f.db.prepare('INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at) VALUES(?,?,?,?)')
      .run('public-chat', ids.member, 'msg-public-chat-2', '2026-01-01')
    expect(await unreadNavigationCount(f.env.DB, ids.member)).toBe(1)
  } finally { f.db.close() }
})
