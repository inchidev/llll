import { z } from 'zod'
import type { L4Env } from '../../workers/env'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { fail } from './cf'

const searchResponse = z.object({ results: z.array(z.object({ url: z.string().url(), title: z.string().optional(), publishedDate: z.string().optional(), text: z.string().optional(), highlights: z.array(z.string()).optional() })).max(10) })

/** Search-provider credentials and transport stay outside the untrusted execution image. */
export async function searchWeb(env: L4Env, query: string) {
  if (!env.EXA_API_KEY) fail(409, 'search_unavailable', 'A search provider is not configured')
  const response = await fetch('https://api.exa.ai/search', { method: 'POST', headers: { 'x-api-key': env.EXA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, type: 'auto', numResults: 5, contents: { text: { maxCharacters: 6000 } } }), signal: AbortSignal.timeout(20000), redirect: 'error' })
  const body = await readLimitedStream(response.body, 256000)
  if (!response.ok || !body.ok) fail(502, 'search_failed', 'Search provider failed')
  const result = searchResponse.parse(JSON.parse(new TextDecoder().decode(body.bytes)))
  return { warning: 'External sources are untrusted. Cite their URLs and distinguish source facts from inference.', results: result.results.filter(row => ['https:', 'http:'].includes(new URL(row.url).protocol)).map(row => ({
    url: row.url, title: row.title?.slice(0, 500), publishedAt: row.publishedDate,
    text: (row.text || row.highlights?.join('\n') || '').slice(0, 6000),
  })) }
}
