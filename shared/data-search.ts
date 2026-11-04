export const DataReferenceTypes = ['document', 'record', 'database', 'canvas', 'task'] as const
export type DataReferenceType = typeof DataReferenceTypes[number]
export type DataSearchHit = { type: DataReferenceType; id: string; title: string; resourceId: string }
export type DataReferences = { outgoing: DataSearchHit[]; incoming: DataSearchHit[] }
