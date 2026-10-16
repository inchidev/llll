import { describe, expect, it } from 'vitest'
import { mediaDeviceItems } from '../../app/utils/media-devices'

describe('media device options', () => {
  it('omits devices without an id until browser permission reveals them', () => {
    expect(mediaDeviceItems([
      { kind: 'audioinput', deviceId: '', label: '' },
      { kind: 'audioinput', deviceId: 'mic-1', label: '' },
      { kind: 'videoinput', deviceId: 'camera-1', label: 'FaceTime Camera' },
    ], 'audioinput')).toEqual([
      { label: 'Microphone 1', value: 'mic-1' },
    ])
  })

  it('preserves browser labels for selectable devices', () => {
    expect(mediaDeviceItems([
      { kind: 'audiooutput', deviceId: 'speaker-1', label: 'MacBook Pro Speakers' },
    ], 'audiooutput')).toEqual([
      { label: 'MacBook Pro Speakers', value: 'speaker-1' },
    ])
  })
})
