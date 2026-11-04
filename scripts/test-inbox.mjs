import assert from 'node:assert/strict'

/** Real HTTP and authenticated channel sockets, including partial reads in another tab. */
export async function testInbox({ api, ids, heldSocket }) {
  const root = `/api/servers/${ids.alpha}`
  const channel = (await api('alpha', root + '/channels', { method: 'POST', body: { name: 'inbox-regression' } })).payload.channel
  const send = async (id, content) => (await api('alpha', `/api/channels/${id}/messages`, { method: 'POST', body: { content } })).payload.message
  const list = async () => (await api('alpha', root + '/channels', { actor: 'alpha-member' })).payload
  const current = async () => (await list()).channels.find(item => item.id === channel.id)
  const first = await send(channel.id, 'Thread root')
  const thread = (await api('alpha', `/api/channels/${channel.id}/threads`, { method: 'POST', body: { messageId: first.id, name: 'Inbox replies' } })).payload.channel
  const reply = await send(thread.id, 'Never-opened reply')
  const rootTab = await heldSocket(`/ws/channel/${channel.id}`, 'alpha-member')
  let threadTab
  async function read(tab, message) {
    const start = tab.messages.length
    tab.socket.send(JSON.stringify({ t: 'read', messageId: message.id }))
    for (let attempt = 0; attempt < 100; attempt++) {
      const ack = tab.messages.slice(start).find(event => event.t === 'read.ack' && event.messageId === message.id)
      if (ack) return ack
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw Error('Inbox read acknowledgement timeout')
  }
  try {
    assert.equal((await read(rootTab, first)).unread, false)
    assert.equal((await current()).unreadCount, 0)
    threadTab = await heldSocket(`/ws/channel/${thread.id}`, 'alpha-member')
    await read(threadTab, reply)
    const unreadReply = await send(thread.id, 'Opened-thread reply')
    assert.equal((await current()).unreadCount, 1)
    assert.equal((await current()).lastMessageAt, unreadReply.createdAt)
    const rootReply = await send(channel.id, 'Unread root')
    assert.equal((await current()).unreadCount, 2)
    assert.equal((await read(rootTab, rootReply)).unread, true)
    assert.equal((await current()).unreadCount, 1)
    await read(threadTab, unreadReply)
    assert.equal((await current()).unreadCount, 0)
    const removed = await send(channel.id, 'Delete before reading')
    await api('alpha', `/api/messages/${removed.id}`, { method: 'DELETE' })
    assert.equal((await current()).unreadCount, 0)
    assert.equal((await current()).lastMessageAt, rootReply.createdAt)
    const privateChannel = (await api('alpha', root + '/channels', { method: 'POST', body: { name: 'inbox-private', visibility: 'private' } })).payload.channel
    await send(privateChannel.id, 'Private canary')
    assert.equal((await list()).channels.some(item => item.id === privateChannel.id), false)
    console.log('PASS: Inbox HTTP + real socket reads agree on unopened/opened threads, partial counts, deleted messages, root/thread activity and private-channel isolation')
  } finally { rootTab.socket.close(); threadTab?.socket.close() }
}
