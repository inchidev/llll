import type { z } from 'zod'
import { fail } from './cf'

export function parseBody<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    const first = result.error.issues[0]
    fail(400, 'bad_request', first?.message || 'Invalid input')
  }
  return result.data
}
