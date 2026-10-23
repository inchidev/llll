/** Provider exceptions may contain credentials or request payloads. Return only known classifications. */
export function inferenceFailure(error: unknown): string {
  const detail = error && typeof error === 'object' ? error as { statusCode?: number; status?: number; responseBody?: unknown; message?: unknown; cause?: unknown } : {}
  const status = detail.statusCode ?? detail.status
  if (status === 401 || status === 403) return `The model provider rejected access (${status}). Check the connection and model permissions.`
  if (status === 409) return 'The selected model or provider is no longer available. Choose an available model in settings.'
  if (status === 429) return 'The model provider reached its usage or rate limit. Retry later or choose another model.'
  if (status === 400 || status === 404 || status === 422) return 'The model provider did not accept this model or request. Check the selected model and its tool support.'
  if (detail.cause && detail.cause !== error) return inferenceFailure(detail.cause)
  return 'Model inference was interrupted or unavailable. Check the provider connection before retrying.'
}
