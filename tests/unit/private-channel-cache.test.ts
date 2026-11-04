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

it('drops a deleted Thread and its link from the parent while the channel list refreshes', () => {
  const cache = new QueryClient()
  const refresh = vi.spyOn(cache, 'invalidateQueries')
  cache.setQueryData(['channels', 'server'], { channels: [{ id: 'general' }], threads: [{ id: 'thread', parentId: 'general' }] })
  cache.setQueryData(['messages', 'general'], { pages: [{ messages: [{ id: 'root', threadId: 'thread' }, { id: 'other', threadId: 'kept' }] }] })
  cache.setQueryData(['messages', 'thread'], { pages: [] })
  applyServerRealtimeEvent(cache, { t: 'channels.changed', serverId: 'server', deletedIds: ['thread'], parentIds: ['general'] })
  expect(cache.getQueryData(['channels', 'server'])).toEqual({ channels: [{ id: 'general' }], threads: [] })
  expect(cache.getQueryData(['messages', 'general'])).toEqual({ pages: [{ messages: [{ id: 'root', threadId: null }, { id: 'other', threadId: 'kept' }] }] })
  expect(cache.getQueryData(['messages', 'thread'])).toBeUndefined()
  expect(refresh).toHaveBeenCalledWith({ queryKey: ['threads', 'general'] })
  expect(refresh).toHaveBeenCalledWith({ queryKey: ['channels', 'server'] })
  cache.clear()
})

it('refreshes an archived or restored channel in place, keeping its history cached', () => {
  const cache = new QueryClient()
  const refresh = vi.spyOn(cache, 'invalidateQueries')
  cache.setQueryData(['messages', 'random'], { pages: [{ messages: [{ id: 'kept' }] }] })
  applyServerRealtimeEvent(cache, { t: 'channels.changed', serverId: 'server', deletedIds: [], parentIds: [], updatedIds: ['random', 'thread'] })
  expect(refresh).toHaveBeenCalledWith({ queryKey: ['channel', 'random'] })
  expect(refresh).toHaveBeenCalledWith({ queryKey: ['channel', 'thread'] })
  expect(refresh).toHaveBeenCalledWith({ queryKey: ['archived-channels', 'server'] })
  expect(refresh).toHaveBeenCalledWith({ queryKey: ['channels', 'server'] })
  expect(cache.getQueryData(['messages', 'random'])).toEqual({ pages: [{ messages: [{ id: 'kept' }] }] })
  cache.clear()
})
