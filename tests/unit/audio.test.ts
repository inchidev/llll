import { describe, expect, it } from 'vitest'
import {
  audioFileExtension,
  formatAudioDuration,
  selectAudioRecordingMime,
} from '../../shared/audio'
import { extForMime, sniffMime } from '../../shared/mime'

describe('audio recording helpers', () => {
  it('prefers Opus in WebM when the browser supports it', () => {
    expect(selectAudioRecordingMime(mime => mime === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus')
  })

  it('falls back to a supported MP4 recording format', () => {
    expect(selectAudioRecordingMime(mime => mime === 'audio/mp4')).toBe('audio/mp4')
  })

  it('formats elapsed recording time', () => {
    expect(formatAudioDuration(0)).toBe('0:00')
    expect(formatAudioDuration(65_999)).toBe('1:05')
  })

  it.each([
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/mp4', 'm4a'],
    ['audio/ogg', 'ogg'],
    ['audio/wav', 'wav'],
  ])('uses the expected extension for %s', (mime, extension) => {
    expect(audioFileExtension(mime)).toBe(extension)
  })
})

describe('audio attachment MIME detection', () => {
  it.each([
    [Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), 'clip.webm', 'audio/webm'],
    [Uint8Array.from([0x4f, 0x67, 0x67, 0x53]), 'clip.ogg', 'audio/ogg'],
    [Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]), 'clip.wav', 'audio/wav'],
    [Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]), 'clip.m4a', 'audio/mp4'],
  ])('detects %s as %s', (bytes, filename, expected) => {
    expect(sniffMime(bytes, filename)).toBe(expected)
  })

  it.each([
    ['audio/webm', 'webm'],
    ['audio/mp4', 'm4a'],
    ['audio/ogg', 'ogg'],
    ['audio/wav', 'wav'],
  ])('maps %s to %s', (mime, extension) => {
    expect(extForMime(mime)).toBe(extension)
  })
})
