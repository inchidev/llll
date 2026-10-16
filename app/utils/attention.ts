import type { ChannelDTO } from '~~/shared/types'

type ChannelList = { channels: ChannelDTO[] }

export function unreadChannelCount(lists: Array<ChannelList | undefined>): number {
  const unread = new Set<string>()
  for (const list of lists) {
    for (const channel of list?.channels ?? []) {
      if (channel.unread) unread.add(channel.id)
    }
  }
  return unread.size
}
