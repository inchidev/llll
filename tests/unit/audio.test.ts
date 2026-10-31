import { describe, expect, it } from 'vitest'
import {
  audioFileExtension,
  formatAudioDuration,
  pcm16Wav,
  selectAudioRecordingMime,
} from '../../shared/audio'
import { extForMime, sniffMime } from '../../shared/mime'

describe('audio recording helpers', () => {
  it('prefers MP4/AAC, which transcription models read, over WebM', () => {
    // Chrome and Safari record both; Chrome's default is WebM.
    expect(selectAudioRecordingMime(() => true)).toBe('audio/mp4;codecs=mp4a.40.2')
    expect(selectAudioRecordingMime(mime => mime === 'audio/mp4')).toBe('audio/mp4')
  })

  it('falls back to Ogg, then WebM', () => {
    expect(selectAudioRecordingMime(mime => mime.startsWith('audio/ogg') || mime.startsWith('audio/webm'))).toBe('audio/ogg;codecs=opus')
    expect(selectAudioRecordingMime(mime => mime === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus')
  })

  it('encodes speech as 16 kHz mono 16-bit WAV that upload sniffing accepts', () => {
    const wav = pcm16Wav(new Float32Array([0, 1, -1, 2]))
    const view = new DataView(wav.buffer)
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE')
    expect([view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)]).toEqual([1, 16000, 16])
    expect(view.getUint32(40, true)).toBe(8)
    // Clipped to the 16-bit range.
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767])
    expect(sniffMime(wav)).toBe('audio/wav')
    // Five minutes of speech stays under the attachment cap.
    expect(44 + 16000 * 2 * 300).toBeLessThan(10 * 1024 * 1024)
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
