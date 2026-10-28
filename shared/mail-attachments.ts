import { sniffMime } from './mime'

/**
 * Bounds on outbound attachments. Cloudflare Email Sending accepts 5 MiB per
 * message including base64 encoding, so 3 MiB of files leaves room for the body.
 */
export const MAIL_OUTBOUND_LIMITS = {
  attachments: 10,
  attachmentBytes: 3 * 1024 * 1024,
} as const

export const MAIL_FILES_UNAVAILABLE = 'Email attachments need file storage. Ask the Server operator to configure storage.'

/** Inbound mail stores attachments under the same condition. */
export function mailFilesAvailable(env: { FILES?: unknown; TICKETS?: unknown }): boolean {
  return Boolean(env.FILES || env.TICKETS)
}

export function mailAttachmentFilename(value: string | null | undefined, index = 0): string {
  const normalized = (value || `attachment-${index + 1}`).replace(/[\p{Cc}\\/]/gu, '-').trim()
  return normalized.slice(0, 160) || `attachment-${index + 1}`
}

const ACTIVE_CONTENT = /\.(?:html?|svg|xml|xhtml)$/iu
const ACTIVE_TYPES = /^(?:text\/html|image\/svg\+xml|application\/(?:xml|xhtml\+xml))$/iu
const PACKAGES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
}
/** Receiving providers block these; Gmail and Outlook reject the whole message. */
const EXECUTABLE = /\.(?:exe|com|bat|cmd|scr|pif|msi|msp|cpl|dll|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|lnk|hta|reg|app|apk|dmg|iso|sh)$/iu

/**
 * The stored type comes from the bytes and the name, never from a declared MIME
 * type: active content (HTML, SVG, XML) is kept as an opaque download.
 */
export function mailAttachmentType(bytes: Uint8Array, filename: string, declared?: string | null): string {
  if (ACTIVE_CONTENT.test(filename) || ACTIVE_TYPES.test(declared || '')) return 'application/octet-stream'
  const sniffed = sniffMime(bytes, filename)
  const extension = filename.toLowerCase().split('.').pop() || ''
  if (sniffed === 'application/zip' && PACKAGES[extension]) return PACKAGES[extension]!
  if (sniffed === 'text/plain' && extension === 'csv') return 'text/csv'
  return sniffed || 'application/octet-stream'
}

/** Executables are refused for outbound mail by name and by their file signature. */
export function blockedMailAttachment(bytes: Uint8Array, filename: string): boolean {
  if (EXECUTABLE.test(filename.trim())) return true
  const peOffset = bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0x3c, true) : -1
  const pe = peOffset >= 0 && peOffset + 4 <= bytes.length && bytes[peOffset] === 0x50 && bytes[peOffset + 1] === 0x45 && bytes[peOffset + 2] === 0 && bytes[peOffset + 3] === 0
  const elf = bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
  const machO = bytes.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0)
  return pe || elf || machO
}

/** Count and total size for a set of attachments; null when they fit. */
export function mailAttachmentLimitError(files: Array<{ sizeBytes: number }>): string | null {
  if (files.length > MAIL_OUTBOUND_LIMITS.attachments) return `An email can have at most ${MAIL_OUTBOUND_LIMITS.attachments} attachments`
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  if (total > MAIL_OUTBOUND_LIMITS.attachmentBytes) return `Attachments can total at most ${MAIL_OUTBOUND_LIMITS.attachmentBytes / 1024 / 1024} MB per email`
  return null
}
