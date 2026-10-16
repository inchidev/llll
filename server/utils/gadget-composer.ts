import type { GadgetPresentationKind, GadgetSpec } from '../../shared/gadgets'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { databaseFieldsFor } from './database-data'
import { loadDatabaseViews } from './database-views'
import { loadDataResources } from './data-resources'

type JevAnswer = { type?: string; noul?: number; choice?: string; score?: number }
type JevResponse = { answers?: Record<string, JevAnswer> }
type JevRunner = {
  run: (model: 'typesafe/jev', input: Record<string, unknown>) => Promise<JevResponse>
}

/** Jev selects only prepared sources and layouts; it never writes a spec or receives Record values. */
export async function composeGadgetSpec(env: L4Env, prompt: string): Promise<GadgetSpec> {
  const resources = await loadDataResources(env)
  const sourceRefs = resources.databases
    .filter(database => !database.archivedAt)
    .flatMap(database => database.views.map(view => ({ database, view })))
    .slice(0, 12)
  const candidates = (await Promise.all(sourceRefs.map(async ({ database, view }) => {
      const fields = await databaseFieldsFor(env, database.id)
      const resolved = (await loadDatabaseViews(env, database.id, fields)).find(item => item.id === view.id)
      if (!resolved) return null
      const visible = new Set(resolved.config.visibleFieldIds ?? fields.map(field => field.id))
      return {
        database,
        view: resolved,
        fields: fields.filter(field => visible.has(field.id)),
      }
    })))
    .filter(candidate => candidate !== null)

  if (!candidates.length) fail(409, 'no_gadget_sources', 'Create a Database View before generating an App')
  if (!env.AI) fail(503, 'jev_unavailable', 'Jev is unavailable in this environment')

  const questions: Record<string, unknown> = {}
  for (const [index, candidate] of candidates.entries()) {
    const name = `${candidate.database.name} / ${candidate.view.name}`
    questions[`include_${index}`] = {
      type: 'noul',
      instructions: `Should the internal tool include the prepared source "${name}"?`,
      criteria: { true: 'The requested tool needs this source', false: 'This source is not relevant' },
    }
    questions[`presentation_${index}`] = {
      type: 'choice',
      instructions: `Choose the most useful presentation for "${name}" if it is included.`,
      criteria: {
        table: 'Several records with comparable fields',
        list: 'A compact scan of record titles and details',
        metric: 'A single count of matching records',
      },
    }
    questions[`priority_${index}`] = {
      type: 'score',
      instructions: `How prominently should "${name}" appear if it is included?`,
      criteria: ['Supporting section', 'Important section', 'Primary section'],
    }
  }

  let response: JevResponse
  try {
    response = await (env.AI as unknown as JevRunner).run('typesafe/jev', {
      state: {
        request: prompt,
        availableSources: candidates.map(candidate => ({
          database: candidate.database.name,
          view: candidate.view.name,
          fields: candidate.fields.map(field => `${field.name} (${field.type})`),
        })),
      },
      questions,
    })
  }
  catch {
    fail(503, 'jev_unavailable', 'Jev could not compose this App')
  }

  const selected: Array<{
    candidate: (typeof candidates)[number]
    catalogIndex: number
    presentation: GadgetPresentationKind
    priority: number
  }> = []
  for (const [index, candidate] of candidates.entries()) {
    if ((response.answers?.[`include_${index}`]?.noul ?? 0) < 0.5) continue
    const rawPresentation = response.answers?.[`presentation_${index}`]?.choice
    const presentation: GadgetPresentationKind = rawPresentation === 'list' || rawPresentation === 'metric' ? rawPresentation : 'table'
    selected.push({ candidate, catalogIndex: index, presentation, priority: response.answers?.[`priority_${index}`]?.score ?? 0 })
  }
  selected.sort((a, b) => b.priority - a.priority || a.catalogIndex - b.catalogIndex)
  const bindings = [] as GadgetSpec['bindings']
  const sections = [] as GadgetSpec['sections']
  for (const [index, selection] of selected.entries()) {
    const { candidate, presentation } = selection
    const bindingId = `source_${index + 1}`
    bindings.push({
      id: bindingId,
      label: `${candidate.database.name} / ${candidate.view.name}`,
      source: { type: 'database_view', databaseId: candidate.database.id, viewId: candidate.view.id },
      fieldIds: candidate.fields.map(field => field.id),
      operations: ['read'],
    })
    sections.push({ id: `section_${index + 1}`, bindingId, title: candidate.view.name, presentation })
  }
  if (!bindings.length) fail(422, 'composition_unavailable', 'Jev did not find a matching source. Try naming the Databases or Views you need.')
  return { schemaVersion: 1, bindings, sections }
}
