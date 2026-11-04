import { describe, expect, it } from 'vitest'
import { parseByteRange } from '../../shared/http-range'

describe('parseByteRange', () => {
  it.each([
    ['bytes=0-99', 1000, { offset: 0, length: 100, start: 0, end: 99 }],
    ['bytes=900-', 1000, { offset: 900, length: 100, start: 900, end: 999 }],
    ['bytes=-100', 1000, { offset: 900, length: 100, start: 900, end: 999 }],
    ['bytes=950-2000', 1000, { offset: 950, length: 50, start: 950, end: 999 }],
    ['bytes=-2000', 1000, { offset: 0, length: 1000, start: 0, end: 999 }],
  ])('parses %s', (value, size, expected) => {
    expect(parseByteRange(value, size)).toEqual(expected)
  })

  it.each([
    ['items=0-10', 1000],
    ['bytes=10-5', 1000],
    ['bytes=1000-', 1000],
    ['bytes=0-1,4-5', 1000],
    ['bytes=-0', 1000],
    ['bytes=-', 1000],
    ['bytes=0-1', 0],
  ])('rejects %s', (value, size) => {
    expect(parseByteRange(value, size)).toBeNull()
  })
})
