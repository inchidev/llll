import { QueryClient } from '@tanstack/vue-query'
import { expect, it, vi } from 'vitest'
import { applyServerRealtimeEvent } from '../../app/utils/server-realtime'

it('removes revoked channel and Thread data while retaining unrelated conversations', () => {
  const cache = new QueryClient()
  cache.setQueryData(['channels', 'server'], { channels: [{ id: 'secret' }, { id: 'general' }], threads: [{ id: 'thread', parentId: 'secret' }, { id: 'other-thread', parentId: 'general' }] })
  for (const kind of ['channel', 'messages', 'files', 'pins', 'threads', 'message-search', 'readCursor', 'private-channel-members']) {
    for (const id of ['secret', 'thread', 'general']) cache.setQueryData([kind, id], { retained: id })
  }
  applyServerRealtimeEvent(cache, { t: 'channel.access.changed', serverId: 'server', channelId: 'secret', conversationIds: ['secret', 'thread'], revoked: true })
  expect(cache.getQueryData(['channels', 'server'])).toEqual({ channels: [{ id: 'general' }], threads: [{ id: 'other-thread', parentId: 'general' }] })
  for (const kind of ['channel', 'messages', 'files', 'pins', 'threads', 'message-search', 'readCursor', 'private-channel-members']) {
    for (const id of ['secret', 'thread']) expect(cache.getQueryData([kind, id])).toBeUndefined()
    expect(cache.getQueryData([kind, 'general'])).toEqual({ retained: 'general' })
  }
  cache.clear()
})

it('refreshes discovery for a newly granted channel without deleting existing data', () => {
  const cache = new QueryClient()
  const refresh = vi.spyOn(cache, 'invalidateQueries')
  cache.setQueryData(['messages', 'general'], { messages: ['kept'] })
  applyServerRealtimeEvent(cache, { t: 'channel.access.changed', serverId: 'server', channelId: 'secret', conversationIds: ['secret'], revoked: false })
  expect(refresh).toHaveBeenCalledWith({ queryKey: ['channels', 'server'] })
  expect(cache.getQueryData(['messages', 'general'])).toEqual({ messages: ['kept'] })
  cache.clear()
})
