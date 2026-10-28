import { describe, expect, it } from 'vitest'
import { liveJoinProblem, liveMediaProblem } from '../../app/utils/live-errors'

function domError(name: string, message = '') {
  return Object.assign(new Error(message), { name })
}

describe('Live media problems', () => {
  it('replaces raw browser errors with copy for the control that failed', () => {
    expect(liveMediaProblem('microphone', domError('NotAllowedError', 'Permission denied'))).toEqual({
      title: 'Microphone blocked',
      message: 'Allow microphone access for this site in your browser settings, then try again.',
    })
    expect(liveMediaProblem('camera', domError('NotReadableError', 'Could not start video source'))?.title).toBe('Camera problem')
    expect(liveMediaProblem('camera', domError('NotFoundError'))?.message).toBe('No camera was found. Connect one, or choose another device.')
    expect(liveMediaProblem('devices', domError('OverconstrainedError'))?.title).toBe('Check browser permissions')
  })

  it('never shows the raw message', () => {
    const problem = liveMediaProblem('camera', new Error('RTK internal: producer failed 0x13'))
    expect(problem?.message).not.toContain('RTK')
  })

  it('reads a DOMException name that the SDK wrapped in its message', () => {
    expect(liveMediaProblem('microphone', new Error('NotAllowedError: Permission denied'))?.title).toBe('Microphone blocked')
  })

  it('ignores a cancelled screen picker but explains a system block', () => {
    expect(liveMediaProblem('screen', domError('NotAllowedError', 'Permission denied'))).toBeNull()
    expect(liveMediaProblem('screen', domError('AbortError'))).toBeNull()
    expect(liveMediaProblem('screen', domError('NotAllowedError', 'Permission denied by system'))?.title).toBe('Screen sharing is blocked')
  })
})

describe('Live join problems', () => {
  it('keeps Server messages and hides SDK and network errors', () => {
    expect(liveJoinProblem({ data: { error: { message: 'Live needs RealtimeKit' } } })).toBe('Live needs RealtimeKit')
    expect(liveJoinProblem(new TypeError('Failed to fetch'))).toMatch(/Check your connection/u)
    expect(liveJoinProblem(Object.assign(new Error('x'), { statusCode: 502 }))).toMatch(/could not start/u)
  })
})
