import { reactive } from 'vue'
import type { CanvasNodeDTO } from '../../shared/types'

const editableKeys = ['content', 'x', 'y', 'width', 'height', 'color'] as const
export type CanvasNodePatch = Partial<Pick<CanvasNodeDTO, typeof editableKeys[number]>>

/** Keep one draft and one serialized writer for each item, even across canvas navigation. */
export function createCanvasNodeEditor(initial: CanvasNodeDTO, write: (patch: CanvasNodePatch, version: number) => Promise<CanvasNodeDTO>) {
  const state = reactive({ node: { ...initial }, saving: false, error: '' })
  let saved = { ...initial }
  let pending: Promise<void> | undefined

  function changes(): CanvasNodePatch {
    return Object.fromEntries(editableKeys.filter(key => state.node[key] !== saved[key]).map(key => [key, state.node[key]]))
  }

  function receive(incoming: CanvasNodeDTO) {
    if (state.saving || incoming.version < saved.version) return
    const dirty = changes()
    const conflicted = editableKeys.some(key => key in dirty && incoming[key] !== saved[key] && incoming[key] !== state.node[key])
    Object.assign(state.node, incoming, dirty)
    saved = { ...incoming }
    if (conflicted) state.error = 'This item changed elsewhere. Your edits are kept here.'
  }

  function save(retry = false): Promise<void> {
    if (pending) return pending
    if (state.error && !retry) return Promise.resolve()
    state.error = ''
    state.saving = true
    pending = (async () => {
      try {
        while (Object.keys(changes()).length) {
          const sent = { ...state.node }
          const result = await write(changes(), saved.version)
          // An older response must never erase typing or movement made while it was pending.
          const newer = Object.fromEntries(editableKeys.filter(key => state.node[key] !== sent[key]).map(key => [key, state.node[key]]))
          Object.assign(state.node, result, newer)
          saved = { ...result }
        }
      }
      catch (error) {
        state.error = error instanceof Error ? error.message : 'Could not save this item.'
      }
      finally {
        state.saving = false
      }
    })().finally(() => { pending = undefined })
    return pending
  }

  function discard(incoming: CanvasNodeDTO) {
    Object.assign(state.node, incoming)
    saved = { ...incoming }
    state.error = ''
  }

  return { state, receive, save, discard, isDirty: () => Object.keys(changes()).length > 0 }
}
