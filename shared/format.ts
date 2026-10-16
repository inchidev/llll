import BigNumber from 'bignumber.js'
import dayjs from 'dayjs'

export function formatBytes(bytes: number): string {
  const n = new BigNumber(bytes)
  if (n.gte(1024 * 1024)) return `${n.dividedBy(1024 * 1024).decimalPlaces(1).toString()} MB`
  if (n.gte(1024)) return `${n.dividedBy(1024).decimalPlaces(0).toString()} KB`
  return `${n.toString()} B`
}

export function formatTime(iso: string): string {
  return dayjs(iso).format('HH:mm')
}

export function formatDateTime(iso: string): string {
  return dayjs(iso).format('YYYY-MM-DD HH:mm')
}

export function formatMessageTime(iso: string): string {
  const d = dayjs(iso)
  const now = dayjs()
  if (d.isSame(now, 'day')) return `Today at ${d.format('HH:mm')}`
  if (d.isSame(now.subtract(1, 'day'), 'day')) return `Yesterday at ${d.format('HH:mm')}`
  return d.format('D MMMM YYYY HH:mm')
}

export function formatDayLabel(iso: string): string {
  const d = dayjs(iso)
  const now = dayjs()
  if (d.isSame(now, 'day')) return 'Today'
  if (d.isSame(now.subtract(1, 'day'), 'day')) return 'Yesterday'
  return d.format('D MMMM YYYY')
}

export function sameDay(a: string, b: string): boolean {
  return dayjs(a).isSame(dayjs(b), 'day')
}

export function formatFullDateTime(iso: string): string {
  return dayjs(iso).format('dddd, D MMMM YYYY HH:mm')
}
