import type { DatabaseFieldDTO, DatabaseItemDTO } from './types'

export const GadgetPresentationKinds = ['table', 'list', 'metric'] as const
export type GadgetPresentationKind = (typeof GadgetPresentationKinds)[number]

export const GadgetBindingOperations = ['read', 'create', 'update'] as const
export type GadgetBindingOperation = (typeof GadgetBindingOperations)[number]

export type GadgetDatabaseViewSource = {
  type: 'database_view'
  databaseId: string
  viewId: string
}

/** A bounded capability from a Gadget to one workspace resource. */
export type GadgetBinding = {
  id: string
  label: string
  source: GadgetDatabaseViewSource
  fieldIds: string[]
  operations: GadgetBindingOperation[]
}

export type GadgetSection = {
  id: string
  bindingId: string
  title: string
  presentation: GadgetPresentationKind
}

export type GadgetSpec = {
  schemaVersion: 1
  bindings: GadgetBinding[]
  sections: GadgetSection[]
}

export function emptyGadgetSpec(): GadgetSpec {
  return { schemaVersion: 1, bindings: [], sections: [] }
}

export type GadgetSummaryDTO = {
  id: string
  name: string
  description: string
  position: number
  draftRevision: number
  publishedVersion: number | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type GadgetDetailDTO = GadgetSummaryDTO & {
  draftSpec: GadgetSpec
  roleIds: string[]
}

export type GadgetListDTO = {
  gadgets: GadgetSummaryDTO[]
  canManage: boolean
}

export type GadgetRuntimeDatasetDTO = {
  binding: GadgetBinding
  database: { id: string; name: string }
  view: { id: string; name: string }
  fields: DatabaseFieldDTO[]
  items: DatabaseItemDTO[]
  total: number
}

export type GadgetRuntimeDTO = {
  gadget: Pick<GadgetSummaryDTO, 'id' | 'name' | 'description'> & { version: number }
  spec: GadgetSpec
  datasets: GadgetRuntimeDatasetDTO[]
}
