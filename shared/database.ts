export const DatabaseFieldTypes = ['text', 'number', 'boolean', 'date', 'select'] as const

export type DatabaseFieldType = (typeof DatabaseFieldTypes)[number]
export type DatabaseValue = string | number | boolean | null

export const DatabaseViewLayouts = ['table', 'board', 'calendar', 'list'] as const
export type DatabaseViewLayout = (typeof DatabaseViewLayouts)[number]

export const DatabaseViewFilterOperators = [
  'equals',
  'not_equals',
  'contains',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
  'before',
  'after',
] as const
export type DatabaseViewFilterOperator = (typeof DatabaseViewFilterOperators)[number]
export type DatabaseViewSortDirection = 'asc' | 'desc'

export type DatabaseViewFilter = {
  fieldId: string
  operator: DatabaseViewFilterOperator
  value?: DatabaseValue
}

export type DatabaseViewSort = {
  fieldId: string
  direction: DatabaseViewSortDirection
}

export type DatabaseViewConfig = {
  /** null follows all current and future fields; an empty array intentionally hides every custom field. */
  visibleFieldIds: string[] | null
  filters: DatabaseViewFilter[]
  sorts: DatabaseViewSort[]
  groupFieldId: string | null
  dateFieldId: string | null
  /** Table column widths in pixels, keyed by field id or `title`; missing columns use the default width. */
  columnWidths: Record<string, number>
}

/** Bounds for a table column width set by dragging its border. */
export const DatabaseColumnWidth = { min: 80, max: 640, title: 256, field: 192 } as const

export function defaultDatabaseViewConfig(): DatabaseViewConfig {
  return {
    visibleFieldIds: null,
    filters: [],
    sorts: [{ fieldId: 'title', direction: 'asc' }],
    groupFieldId: null,
    dateFieldId: null,
    columnWidths: {},
  }
}

export const DatabaseSlotCounts: Record<DatabaseFieldType, number> = {
  text: 16,
  number: 8,
  boolean: 8,
  date: 8,
  select: 8,
}

const SLOT_PREFIX: Record<DatabaseFieldType, string> = {
  text: 'text',
  number: 'number',
  boolean: 'boolean',
  date: 'date',
  select: 'select',
}

/** Physical columns are allocated only from this server-known list. */
export function databaseSlots(type: DatabaseFieldType): string[] {
  return Array.from({ length: DatabaseSlotCounts[type] }, (_, index) => `${SLOT_PREFIX[type]}_${index + 1}`)
}

export function isDatabaseSlot(type: DatabaseFieldType, slot: string): boolean {
  return databaseSlots(type).includes(slot)
}

export function normalizeDatabaseOptions(options: Iterable<string>): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of options) {
    const option = raw.trim()
    const key = option.toLocaleLowerCase()
    if (!option || seen.has(key)) continue
    seen.add(key)
    normalized.push(option)
  }
  return normalized
}
