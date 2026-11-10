import { expect, it } from 'vitest'
import { inferenceFailure } from '../../server/utils/agent-inference-errors'
it.each([
  [{ statusCode: 429 }, 'rate limit'],
  [{ status: 503 }, 'unavailable (503)'],
  [{ statusCode: 401 }, 'rejected access (401)'],
  [{ name: 'TimeoutError' }, 'timed out'],
  [{ code: 'ECONNREFUSED' }, 'DNS, proxy'],
  [{ code: 'CERT_HAS_EXPIRED' }, 'trusted CA'],
  [{ message: 'fetch failed', cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify certificate' } }, 'trusted CA'],
  [{ message: 'fetch failed', cause: { code: 'ECONNRESET' } }, 'DNS, proxy'],
  [{ cause: { statusCode: 429 } }, 'rate limit'],
])('returns actionable sanitized diagnostics for %j', (error, message) => {
  expect(inferenceFailure({ ...error, responseBody: 'secret-token private prompt' })).toContain(message)
  expect(inferenceFailure({ ...error, responseBody: 'secret-token private prompt' })).not.toMatch(/secret-token|private prompt/)
})
it('bounds recursive causes and never copies an unknown provider error', () => {
  const error: { message: string; cause?: unknown } = { message: 'credential=secret-token private prompt' }
  error.cause = { cause: error }
  expect(inferenceFailure(error)).toBe('Model inference was interrupted or unavailable. Check the provider connection before retrying.')
})

it('says when the provider account has no credits left, by status or in a stream error', async () => {
  const { inferenceFailure } = await import('../../server/utils/agent-inference-errors')
  expect(inferenceFailure({ statusCode: 402 })).toMatch(/no credits left \(402\)/u)
  expect(inferenceFailure(new Error('Insufficient credits. Add more using https://openrouter.ai/settings/credits'))).toMatch(/no credits left/u)
  expect(inferenceFailure({ message: 'stream ended' })).toMatch(/interrupted or unavailable/u)
})
