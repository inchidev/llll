import { z } from 'zod'
import { GadgetBindingOperations, GadgetPresentationKinds, type GadgetSpec } from '../../shared/gadgets'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { databaseFieldsFor, requireDatabase } from './database-data'
import { loadDatabaseViews } from './database-views'
import { authorizeResource, type AuthorizationContext } from '../../shared/authorization'

const identifier = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9:_-]+$/u)
const bindingSchema = z.object({
  id: identifier,
  label: z.string().trim().min(1).max(80),
  source: z.object({
    type: z.literal('database_view'),
    databaseId: z.string().min(1).max(120),
    viewId: z.string().min(1).max(120),
  }),
  fieldIds: z.array(z.string().min(1).max(120)).max(32),
  operations: z.array(z.enum(GadgetBindingOperations)).min(1).max(GadgetBindingOperations.length),
})
const sectionSchema = z.object({
  id: identifier,
  bindingId: identifier,
  title: z.string().trim().min(1).max(100),
  presentation: z.enum(GadgetPresentationKinds),
})
const specSchema = z.object({
  schemaVersion: z.literal(1),
  bindings: z.array(bindingSchema).max(8),
  sections: z.array(sectionSchema).max(12),
})

function unique(values: string[]): boolean {
  return new Set(values).size === values.length
}

export function parseGadgetSpec(value: unknown): GadgetSpec {
  const parsed = specSchema.safeParse(value)
  if (!parsed.success) fail(400, 'invalid_gadget_spec', parsed.error.issues[0]?.message ?? 'Invalid Gadget spec')
  const spec = parsed.data
  if (!unique(spec.bindings.map(binding => binding.id)) || !unique(spec.sections.map(section => section.id))) {
    fail(400, 'invalid_gadget_spec', 'App Binding and Section ids must be unique')
  }
  for (const binding of spec.bindings) {
    if (!unique(binding.fieldIds) || !unique(binding.operations)) fail(400, 'invalid_gadget_spec', 'App Binding fields and operations must be unique')
    if (!binding.operations.includes('read')) fail(400, 'invalid_gadget_spec', 'Every App Binding must allow read access')
  }
  const bindingIds = new Set(spec.bindings.map(binding => binding.id))
  if (spec.sections.some(section => !bindingIds.has(section.bindingId))) {
    fail(400, 'invalid_gadget_spec', 'Every App Section must reference a Binding')
  }
  return spec
}

/** Re-resolve semantic ids before every publish and runtime open. */
export async function validateGadgetSpec(
  env: L4Env,
  value: unknown,
  options: { publish?: boolean; authorization?: AuthorizationContext } = {},
): Promise<GadgetSpec> {
  const spec = parseGadgetSpec(value)
  if (options.publish && (!spec.bindings.length || !spec.sections.length)) {
    fail(400, 'invalid_gadget_spec', 'Add at least one source before publishing this App')
  }
  if (options.publish) {
    const used = new Set(spec.sections.map(section => section.bindingId))
    if (spec.bindings.some(binding => !used.has(binding.id))) {
      fail(400, 'invalid_gadget_spec', 'Published Apps cannot keep unused Bindings')
    }
  }
  for (const binding of spec.bindings) {
    if (options.authorization) authorizeResource(options.authorization, 'databases', binding.source.databaseId)
    const database = await requireDatabase(env, binding.source.databaseId)
    if (database.archivedAt) fail(409, 'gadget_binding_invalid', `${binding.label} uses an archived Database`)
    const fields = await databaseFieldsFor(env, database.id)
    const view = (await loadDatabaseViews(env, database.id, fields)).find(candidate => candidate.id === binding.source.viewId)
    if (!view) fail(409, 'gadget_binding_invalid', `${binding.label} uses a missing Database View`)
    const allowed = new Set(view.config.visibleFieldIds ?? fields.map(field => field.id))
    if (binding.fieldIds.some(fieldId => !allowed.has(fieldId))) {
      fail(409, 'gadget_binding_invalid', `${binding.label} uses a missing or hidden Field`)
    }
  }
  return spec
}
