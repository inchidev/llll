/** Headers shared by new and legacy file rows. Stored MIME types are untrusted. */
export function fileResponseHeaders(contentType: string, filename: string): Record<string, string> {
  const safeInline = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'])
  const type = contentType.toLowerCase().split(';')[0]!.trim()
  const inline = safeInline.has(type)
  const name = [...filename].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '"' || char === '\\' ? '_' : char).join('') || 'file'
  const ascii = name.replace(/[^\x20-\x7e]/gu, '_')
  return {
    'Content-Type': inline ? type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/gu, char => '%' + char.charCodeAt(0).toString(16))}`,
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
  }
}
