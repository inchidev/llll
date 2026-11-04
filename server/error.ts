import type { NitroErrorHandler } from 'nitropack'

const handler: NitroErrorHandler = async (error, event) => {
  const status = error.statusCode || 500
  setResponseStatus(event, status)
  const data = error.data as { error?: { code: string; message: string } } | undefined
  const payload = data?.error
    ? { error: data.error }
    : { error: { code: status === 500 ? 'internal' : 'error', message: error.message || 'Request failed' } }
  await send(event, JSON.stringify(payload), 'application/json')
}

export default handler
