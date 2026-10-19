import { describe, expect, it, vi } from 'vitest'
import { compareStableVersions, llllReleaseUrl, newerStableReleases, stableSemver, type PublishedRelease } from '../../shared/releases'
import { llllReleases } from '../../server/utils/releases'

function release(tagName: string): PublishedRelease {
  return { tagName, name: tagName, publishedAt: '2026-09-05T00:00:00Z', url: `https://example.com/${tagName}`, notes: '' }
}

describe('release versions', () => {
  it('links an installed version to its GitHub release', () => {
    expect(llllReleaseUrl('0.3.3')).toBe('https://github.com/inchidev/llll/releases/tag/v0.3.3')
    expect(llllReleaseUrl('v0.3.3')).toBe('https://github.com/inchidev/llll/releases/tag/v0.3.3')
  })

  it('accepts stable tags and rejects prereleases', () => {
    expect(stableSemver('v0.1.3')).toEqual([0, 1, 3])
    expect(stableSemver('0.1.3')).toEqual([0, 1, 3])
    expect(stableSemver('v0.2.0-rc.1')).toBeNull()
  })

  it('compares numeric version parts', () => {
    expect(compareStableVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareStableVersions('v1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareStableVersions('0.1.3', 'v0.1.3')).toBe(0)
  })

  it('counts and orders every published stable release after the server', () => {
    const newer = newerStableReleases('0.0.3', [
      release('v0.1.2'),
      release('v0.0.2'),
      release('v0.1.0'),
      release('v0.1.3'),
      release('v0.1.1'),
      release('v0.2.0-rc.1'),
    ])
    expect(newer.map(item => item.tagName)).toEqual(['v0.1.3', 'v0.1.2', 'v0.1.1', 'v0.1.0'])
  })
})

describe('GitHub release discovery', () => {
  it('uses a short edge cache and a paged cache key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([
      {
        tag_name: 'v0.3.3',
        name: 'L4 v0.3.3',
        published_at: '2026-09-07T00:00:00Z',
        html_url: 'https://github.com/inchidev/llll/releases/tag/v0.3.3',
        body: 'Current release',
        draft: false,
        prerelease: false,
      },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(llllReleases(fetcher)).resolves.toMatchObject([{ tagName: 'v0.3.3' }])
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toContain('per_page=100&page=1')
    expect((init as RequestInit & { cf: { cacheTtl: number } }).cf.cacheTtl).toBe(300)
  })
})
