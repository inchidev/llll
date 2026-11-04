import type { DatabaseFieldDTO } from './types'
import type { DatabaseValue } from './database'

export const CSV_MAX_ROWS = 1000
export const CSV_MAX_BYTES = 2_000_000

/** RFC 4180 fields, including quoted commas, line breaks and doubled quotes. */
export function parseDataCsv(input: string): string[][] {
  if (new TextEncoder().encode(input).length > CSV_MAX_BYTES) throw new Error('CSV files may be at most 2 MB')
  const text = input.replace(/^\uFEFF/u, '')
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let closed = false
  const finishCell = () => { row.push(cell); cell = ''; closed = false; if (row.length > 65) throw new Error('CSV has too many columns') }
  const finishRow = () => { finishCell(); rows.push(row); row = []; if (rows.length > CSV_MAX_ROWS + 1) throw new Error(`Import at most ${CSV_MAX_ROWS} records at a time`) }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index++ }
      else if (char === '"') { quoted = false; closed = true }
      else cell += char
    }
    else if (char === ',') finishCell()
    else if (char === '\r' || char === '\n') { if (char === '\r' && text[index + 1] === '\n') index++; finishRow() }
    else if (char === '"' && !cell && !closed) quoted = true
    else { if (closed || char === '"') throw new Error('Invalid CSV quoting'); cell += char }
    if (cell.length > 20_000) throw new Error('A CSV cell is too long')
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field')
  if (cell || row.length || closed) finishRow()
  if (!rows.length || rows[0]!.every(cell => !cell.trim())) throw new Error('CSV needs a header row')
  if (rows.some(row => row.length !== rows[0]!.length)) throw new Error('Every CSV row must have the same number of columns')
  return rows
}

export function csvCell(value: DatabaseValue, spreadsheetSafe = true): string {
  let text = Array.isArray(value) ? JSON.stringify(value) : value === null ? '' : String(value)
  if (spreadsheetSafe && typeof value === 'string' && /^[\s]*[=+\-@\t\r]/u.test(text)) text = `'${text}`
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csvFieldValue(field: DatabaseFieldDTO, input: string): DatabaseValue {
  if (!input) return null
  if (field.type === 'number') {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(input.trim()) || !Number.isFinite(Number(input))) throw new Error(`${field.name}: expected a number`)
    return Number(input)
  }
  if (field.type === 'boolean') {
    if (/^(true|1)$/iu.test(input.trim())) return true
    if (/^(false|0)$/iu.test(input.trim())) return false
    throw new Error(`${field.name}: use true or false`)
  }
  if (['multi_select', 'person', 'relation'].includes(field.type)) {
    try { const value: unknown = JSON.parse(input); if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value }
    catch { /* Explained below. */ }
    throw new Error(`${field.name}: expected a JSON list of ${field.type === 'multi_select' ? 'options' : 'IDs'}`)
  }
  return input
}
