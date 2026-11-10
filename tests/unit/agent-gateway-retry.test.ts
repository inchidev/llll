import { expect, it } from 'vitest'
import { retryableInference } from '../../server/utils/agent-gateway'

it('asks a provider again after a drop, a timeout, a conflict, a throttle or a server error, never after a refusal', () => {
  expect(retryableInference(new TypeError('terminated'))).toBe(true)
  expect(retryableInference(Object.assign(new Error('Service Unavailable'), { statusCode: 503 }))).toBe(true)
  expect(retryableInference({ statusCode: 429 })).toBe(true)
  expect(retryableInference({ status: 408 })).toBe(true)
  expect(retryableInference({ cause: { statusCode: 502 } })).toBe(true)
  expect(retryableInference({ statusCode: 402 })).toBe(false)
  expect(retryableInference({ statusCode: 401 })).toBe(false)
  expect(retryableInference({ statusCode: 400 })).toBe(false)
  expect(retryableInference(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false)
})
