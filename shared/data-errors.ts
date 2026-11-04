import { z } from 'zod'

export type DataError = { code: string; message: string; fields?: Array<{ path: string; message: string }> }
export function dataError(error: unknown): DataError {
  if (error instanceof z.ZodError) return { code: 'validation_error', message: 'Check the supplied values', fields: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }
  if (error && typeof error === 'object' && 'data' in error) {
    const data = error.data as { error?: { code?: unknown; message?: unknown } } | undefined
    if (typeof data?.error?.code === 'string' && typeof data.error.message === 'string') return { code: data.error.code, message: data.error.message }
  }
  return { code: 'data_operation_failed', message: 'The operation could not be completed. Reload before retrying.' }
}
