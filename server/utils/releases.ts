import type { PublishedRelease } from '../../shared/releases'

const releasesUrl = 'https://api.github.com/repos/inchidev/llll/releases?per_page=100&page=1'
const releasesCacheTtl = 5 * 60

type GitHubRelease = {
  tag_name?: string
  name?: string | null
  published_at?: string | null
  html_url?: string
  body?: string | null
  draft?: boolean
  prerelease?: boolean
}

export async function llllReleases(fetcher: typeof fetch = fetch): Promise<PublishedRelease[]> {
  const response = await fetcher(releasesUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'L4 update check',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cf: {
      cacheEverything: true,
      cacheTtl: releasesCacheTtl,
    },
  } as RequestInit & { cf: { cacheEverything: boolean, cacheTtl: number } })
  if (!response.ok) throw new Error(`GitHub releases returned ${response.status}`)

  const payload = await response.json() as GitHubRelease[]
  if (!Array.isArray(payload)) throw new Error('GitHub releases returned an invalid response')
  return payload.flatMap((release): PublishedRelease[] => {
    if (release.draft || release.prerelease || !release.tag_name || !release.published_at || !release.html_url) return []
    return [{
      tagName: release.tag_name,
      name: release.name?.trim() || release.tag_name,
      publishedAt: release.published_at,
      url: release.html_url,
      notes: release.body?.trim() || '',
    }]
  })
}
