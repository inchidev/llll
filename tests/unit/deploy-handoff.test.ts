import { expect, it } from 'vitest'
import { readDeploymentClaim } from '../../shared/deploy-handoff'

it('reads the owner credential from the fragment', () => {
  const token = 'private-owner-token-'.padEnd(64, 'x')
  expect(readDeploymentClaim('#' + new URLSearchParams({ claim: token }))).toBe(token)
  expect(readDeploymentClaim('')).toBeUndefined()
})

it('ignores malformed owner credentials', () => {
  for (const token of ['short', 'x'.repeat(257), 'x'.repeat(32) + '&next=evil', 'x'.repeat(32) + '/'])
    expect(readDeploymentClaim('#' + new URLSearchParams({ claim: token }))).toBeUndefined()
})
