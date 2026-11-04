/** An Agent is removed only by deleting it, which also stops its Runs, Schedules and tokens. */
export function memberRemovalPath(serverId: string, user: { id: string; kind?: string }) {
  return `/api/servers/${serverId}/${user.kind === 'agent' ? 'agents' : 'members'}/${user.id}`
}
