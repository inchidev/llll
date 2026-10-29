/** `2026-10-29` → `October 29, 2026`, independent of the reader's time zone. */
export function formatContentDate(date: string): string {
  if (!date) return ''
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}
