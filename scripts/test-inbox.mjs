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
  async function read(tab, message, generation = 0) {
    const start = tab.messages.length
    tab.socket.send(JSON.stringify({ t: 'read', messageId: message.id, generation }))
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
    await send(thread.id, 'Reading does not follow')
    assert.equal((await current()).unreadCount, 0)
    await api('alpha', `/api/channels/${thread.id}/attention`, { actor: 'alpha-member', method: 'PATCH', body: { following: true } })
    const unreadReply = await send(thread.id, 'Followed-thread reply')
    assert.equal((await current()).unreadCount, 1)
    assert.equal((await current()).lastMessageAt, unreadReply.createdAt)
    const rootReply = await send(channel.id, 'Unread root')
    assert.equal((await current()).unreadCount, 2)
    assert.equal((await read(rootTab, rootReply)).unread, true)
    assert.equal((await current()).unreadCount, 1)
    await read(threadTab, unreadReply)
    assert.equal((await current()).unreadCount, 0)
    await api('alpha', `/api/channels/${thread.id}/unread`, { actor: 'alpha-member', method: 'POST', body: { messageId: unreadReply.id } })
    assert.equal((await current()).unreadCount, 1)
    const preview = (await api('alpha', `/api/channels/${channel.id}/unread-preview`, { actor: 'alpha-member' })).payload
    assert.deepEqual(preview.messages.map(message => message.id), [unreadReply.id])
    assert.equal((await current()).unreadCount, 1, 'Preview must not read')
    const followed = (await api('alpha', root + '/followed-threads', { actor: 'alpha-member' })).payload
    assert.ok(followed.threads.some(item => item.id === thread.id && item.unreadCount === 1))
    // Old tab sends another message after Mark unread; its old generation is rejected.
    threadTab.socket.send(JSON.stringify({ t: 'read', messageId: unreadReply.id, generation: 0 }))
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await current()).unreadCount, 1)
    const attention = (await api('alpha', `/api/channels/${thread.id}/attention`, { actor: 'alpha-member' })).payload
    await read(threadTab, unreadReply, attention.readGeneration)
    assert.equal((await current()).unreadCount, 0)
    await api('alpha', `/api/channels/${thread.id}/attention`, { actor: 'alpha-member', method: 'PATCH', body: { following: false } })
    const unfollowedReply = await send(thread.id, 'Unfollowed reply')
    assert.equal((await current()).unreadCount, 0)
    for (const notifications of ['all', 'mentions', 'muted', 'default']) {
      const changed = await api('alpha', `/api/channels/${channel.id}/attention`, { actor: 'alpha-member', method: 'PATCH', body: { notifications } })
      assert.equal(changed.payload.notifications, notifications)
    }
    const removed = await send(channel.id, 'Delete before reading')
    await api('alpha', `/api/messages/${removed.id}`, { method: 'DELETE' })
    assert.equal((await current()).unreadCount, 0)
    assert.equal((await current()).lastMessageAt, unfollowedReply.createdAt)
    const privateChannel = (await api('alpha', root + '/channels', { method: 'POST', body: { name: 'inbox-private', visibility: 'private' } })).payload.channel
    await send(privateChannel.id, 'Private canary')
    assert.equal((await list()).channels.some(item => item.id === privateChannel.id), false)
    await api('alpha', `/api/channels/${privateChannel.id}/attention`, { actor: 'alpha-member', expected: 404 })
    await api('alpha', `/api/channels/${privateChannel.id}/unread-preview`, { actor: 'alpha-member', expected: 404 })
    console.log('PASS: Inbox HTTP + real socket reads agree on explicit thread follows, mark unread generations, non-reading previews, notification settings, partial counts, deleted messages, root/thread activity and private-channel isolation')
  } finally { rootTab.socket.close(); threadTab?.socket.close() }
}
