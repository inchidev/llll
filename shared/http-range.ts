export type ByteRange = {
  offset: number
  length: number
  start: number
  end: number
}

export function parseByteRange(value: string, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return null

  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    const length = Math.min(suffix, size)
    const start = size - length
    return { offset: start, length, start, end: size - 1 }
  }

  const start = Number(match[1])
  if (!Number.isSafeInteger(start) || start >= size) return null

  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null

  const end = Math.min(requestedEnd, size - 1)
  return { offset: start, length: end - start + 1, start, end }
}
