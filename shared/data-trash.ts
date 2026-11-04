export const DataTrashTypes = ['database', 'item', 'field', 'view'] as const
export type DataTrashType = typeof DataTrashTypes[number]
export type DataTrashEntry = { type: DataTrashType; id: string; title: string; resourceId: string; deletedAt: string }
