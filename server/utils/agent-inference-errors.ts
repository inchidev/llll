/** Provider exceptions may contain credentials or request payloads. Return only known classifications. */
export function inferenceFailure(error: unknown, depth = 0): string {
  const detail = error && typeof error === 'object' ? error as { statusCode?: number; status?: number; code?: unknown; name?: unknown; responseBody?: unknown; message?: unknown; cause?: unknown } : {}
  const signal = [detail.message, typeof detail.responseBody === 'string' ? detail.responseBody.slice(0, 16000) : ''].filter(value => typeof value === 'string').join(' ').toLowerCase()
  if (/tool.{0,40}(?:not support|unsupported)|(?:not support|unsupported).{0,40}tool/u.test(signal)) return 'This model or endpoint does not support the tool calls required by Pi. Choose a model with tool support.'
  if (/model.{0,40}(?:not found|unknown|does not exist)|unknown model/u.test(signal)) return 'The selected model was not found by the provider. Refresh its catalog and choose an available model.'
  if (/verify.{0,30}email|email.{0,30}verif/u.test(signal)) return 'Verify the provider account email, then reconnect the provider before retrying.'
  const status = detail.statusCode ?? detail.status
  if (status === 401 || status === 403) return `The model provider rejected access (${status}). Check the connection and model permissions.`
  if (status === 409) return 'The selected model or provider is no longer available. Choose an available model in settings.'
  if (status === 429) return 'The model provider reached its usage or rate limit (429). Retry later or choose another model.'
  if (typeof status === 'number' && status >= 500 && status <= 599) return `The model provider is temporarily unavailable (${status}). Retry later or choose another provider.`
  if (status === 400 || status === 404 || status === 422) return 'The model provider did not accept this model or request. Check the selected model and its tool support.'
  if (detail.cause && detail.cause !== error && depth < 3) {
    const cause = inferenceFailure(detail.cause, depth + 1)
    if (cause !== 'Model inference was interrupted or unavailable. Check the provider connection before retrying.') return cause
  }
  const code = typeof detail.code === 'string' ? detail.code : ''
  if (/CERT|TLS|SSL/u.test(code) || /certificate|tls handshake|unable to verify|unknown issuer/u.test(signal)) return 'The runtime could not verify the model provider TLS connection. Ask the operator to configure its trusted CA certificates, then retry.'
  if (detail.name === 'TimeoutError' || code === 'ETIMEDOUT' || /timed? out|timeout/u.test(signal)) return 'The model provider connection timed out. Check runtime connectivity and retry later.'
  if (/^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/u.test(code) || /fetch failed|network error|connection refused|dns/u.test(signal)) return 'The runtime could not reach the model provider. Ask the operator to check DNS, proxy and outbound connectivity, then retry.'
  return 'Model inference was interrupted or unavailable. Check the provider connection before retrying.'
}
