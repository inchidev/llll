import { expect, it, vi } from 'vitest'
import { authorizedSockets } from '../../workers/socket-access'

function socket(userId: string | null) {
  return { deserializeAttachment: () => userId ? { userId } : null, close: vi.fn() }
}

it('rechecks held sockets after removal and excludes unauthenticated connections', async () => {
  const owner = socket('owner')
  const member = socket('member')
  const anonymous = socket(null)
  const active = new Set(['owner', 'member'])
  const check = async (id: string) => active.has(id)
  expect(await authorizedSockets([owner, member, anonymous], check)).toEqual([owner, member])
  active.delete('member')
  expect(await authorizedSockets([owner, member, anonymous], check)).toEqual([owner])
  expect(member.close).toHaveBeenCalledWith(4403, 'access_revoked')
  expect(owner.close).not.toHaveBeenCalled()
})

it('checks a user once per fanout while keeping every authorized tab', async () => {
  const tabs = [socket('owner'), socket('owner')]
  const check = vi.fn(async () => true)
  expect(await authorizedSockets(tabs, check)).toEqual(tabs)
  expect(check).toHaveBeenCalledOnce()
})

it('fails closed when current authorization cannot be established', async () => {
  const member = socket('member')
  expect(await authorizedSockets([member], async () => { throw new Error('D1 unavailable') })).toEqual([])
  expect(member.close).toHaveBeenCalledWith(4403, 'access_revoked')
})
