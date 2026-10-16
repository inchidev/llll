const MAX_THREAD_TITLE_LENGTH = 80

export function threadTitle(content: string, filenames: string[] = []): string {
  const normalized = content.trim().replace(/\s+/g, ' ')
  if (normalized) {
    return normalized.length > MAX_THREAD_TITLE_LENGTH
      ? `${normalized.slice(0, MAX_THREAD_TITLE_LENGTH - 1).trimEnd()}…`
      : normalized
  }
  if (filenames.length === 1) {
    const filename = filenames[0]!.trim()
    if (!filename) return 'Thread'
    return filename.length > MAX_THREAD_TITLE_LENGTH
      ? `${filename.slice(0, MAX_THREAD_TITLE_LENGTH - 1).trimEnd()}…`
      : filename
  }
  if (filenames.length > 1) return `${filenames.length} attachments`
  return 'Thread'
}
