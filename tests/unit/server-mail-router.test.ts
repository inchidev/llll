import { expect, it, vi } from 'vitest'
import { routeServerEmail } from '../../workers/server-mail-router'
it('rejects mail for an unconfigured domain without forwarding it', async () => {
  const message = { to: 'person@unknown.example.com', setReject: vi.fn() }
  await routeServerEmail(message as never, {} as never)
  expect(message.setReject).toHaveBeenCalledWith('Unknown L4 mail domain')
})
