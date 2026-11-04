export const DataTrashTypes = ['database', 'record', 'field', 'view', 'document', 'canvas'] as const
export type DataTrashType = typeof DataTrashTypes[number]
export type DataTrashEntry = { type: DataTrashType; id: string; title: string; resourceId: string; deletedAt: string }
