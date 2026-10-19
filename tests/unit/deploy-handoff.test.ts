import { expect, it } from 'vitest'
import { deploymentShellUrl, readDeploymentClaim, stripDeploymentClaim } from '../../shared/deploy-handoff'

it('hands the owner credential to Shell without putting it in an HTTP request', () => {
  const token = 'private-owner-token-'.padEnd(64, 'x')
  const origin = 'https://llll-example.customer.workers.dev'
  const route = deploymentShellUrl(origin, `${origin}/setup#claim=${token}`)
  const url = new URL(route, 'https://llll.gg')
  expect(url.pathname).toBe('/create')
  expect(url.searchParams.get('server')).toBe(origin)
  expect(url.pathname + url.search).not.toContain(token)
  expect(url.searchParams.has('claim')).toBe(false)
  expect(readDeploymentClaim(url.hash)).toBe(token)
})

it('opens a normal saved connection without an owner credential', () => {
  const url = new URL(deploymentShellUrl('https://chat.example.com'), 'https://llll.gg')
  expect(url.hash).toBe('')
  expect(readDeploymentClaim(url.hash)).toBeUndefined()
})

it('ignores malformed owner credentials', () => {
  for (const token of ['short', 'x'.repeat(257), 'x'.repeat(32) + '&next=evil', 'x'.repeat(32) + '/'])
    expect(readDeploymentClaim('#' + new URLSearchParams({ claim: token }))).toBeUndefined()
})

it('removes claim fragments from mirrored routes while retaining other navigation', () => {
  expect(stripDeploymentClaim('/setup#claim=' + 'x'.repeat(64))).toBe('/setup')
  expect(stripDeploymentClaim('/setup?parent=https://llll.gg#claim=bad&panel=owner')).toBe('/setup?parent=https://llll.gg#panel=owner')
  expect(stripDeploymentClaim('/channels/general#message-one')).toBe('/channels/general#message-one')
})
