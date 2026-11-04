/** The Live control or step that failed, which decides the title and wording. */
export type LiveMediaControl = 'microphone' | 'camera' | 'screen' | 'devices'

export type LiveProblem = { title: string, message: string }

const TITLES: Record<LiveMediaControl, string> = {
  microphone: 'Microphone problem',
  camera: 'Camera problem',
  screen: 'Screen sharing problem',
  devices: 'Check browser permissions',
}

const DEVICE: Record<LiveMediaControl, string> = {
  microphone: 'microphone',
  camera: 'camera',
  screen: 'screen',
  devices: 'camera or microphone',
}

const KNOWN_NAMES = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError', 'NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError', 'NotReadableError', 'TrackStartError', 'AbortError', 'NotSupportedError'] as const

/** The DOMException name of a browser or RealtimeKit media error, also when the SDK wraps it in its message. */
function errorName(cause: unknown): string {
  const name = cause && typeof cause === 'object' && 'name' in cause ? String((cause as { name: unknown }).name) : ''
  if (name && name !== 'Error') return name
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  const named = KNOWN_NAMES.find(item => message.includes(item))
  if (named) return named
  return /permission denied/iu.test(message) ? 'NotAllowedError' : name
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
}

/**
 * Friendly copy for a camera, microphone or screen-share failure, in place of
 * raw `DOMException` text. Null when the person cancelled the screen picker.
 */
export function liveMediaProblem(control: LiveMediaControl, cause: unknown): LiveProblem | null {
  const title = TITLES[control]
  const device = DEVICE[control]
  const name = errorName(cause)
  if (control === 'screen') {
    // Closing the browser's screen picker rejects with NotAllowedError or AbortError.
    if ((name === 'NotAllowedError' || name === 'PermissionDeniedError') && /system/iu.test(errorText(cause))) {
      return { title: 'Screen sharing is blocked', message: 'Allow screen recording for your browser in your system settings, then try again.' }
    }
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'AbortError') return null
    if (name === 'NotSupportedError') return { title, message: 'This browser cannot share your screen.' }
    return { title, message: 'Your screen could not be shared. Try again.' }
  }
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        title: control === 'devices' ? title : `${device[0]!.toUpperCase()}${device.slice(1)} blocked`,
        message: `Allow ${device} access for this site in your browser settings, then try again.`,
      }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { title, message: `No ${device} was found. Connect one, or choose another device.` }
    case 'OverconstrainedError':
      return { title, message: `The selected ${device} is no longer available. Choose another device.` }
    case 'NotReadableError':
    case 'TrackStartError':
      return { title, message: `Your ${device} could not start. Close other apps that may be using it, then try again.` }
    default:
      return { title, message: `Your ${device} could not be turned on. Try again.` }
  }
}

/**
 * Copy for a join that failed. Server refusals already carry a message meant
 * for people; anything else came from the media SDK or the network.
 */
export function liveJoinProblem(cause: unknown): string {
  const data = cause && typeof cause === 'object' && 'data' in cause
    ? (cause as { data?: { error?: { message?: string } } }).data
    : undefined
  if (data?.error?.message) return data.error.message
  const status = cause && typeof cause === 'object' && 'statusCode' in cause ? Number((cause as { statusCode: unknown }).statusCode) : 0
  if (status === 429) return 'Too many attempts. Wait a moment and try again.'
  if (status >= 500) return 'The Server could not start the live session. Try again in a moment.'
  return 'Could not reach the live media service. Check your connection and try again.'
}
