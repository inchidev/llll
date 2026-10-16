import { describe, expect, it, vi } from 'vitest'
import { createCanvasNodeEditor, type CanvasNodePatch } from '../../app/utils/canvas-node-editor'
import type { CanvasNodeDTO } from '../../shared/types'

function node(): CanvasNodeDTO {
  return { id: 'node', canvasId: 'canvas', kind: 'note', content: 'Initial', x: 0, y: 0, width: 240, height: 144, color: 'orange', version: 1, createdBy: 'owner', createdAt: '', updatedAt: '' }
}

describe('canvas item editing', () => {
  it('serializes overlapping edits and preserves typing made while a save is pending', async () => {
    let finish!: (node: CanvasNodeDTO) => void
    const write = vi.fn<(patch: CanvasNodePatch, version: number) => Promise<CanvasNodeDTO>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockImplementationOnce(async patch => ({ ...node(), ...patch, version: 3 }))
    const editor = createCanvasNodeEditor(node(), write)
    editor.state.node.content = 'First'
    const saving = editor.save()
    editor.state.node.content = 'Second'
    editor.state.node.x = 20
    const following = editor.save()
    expect(write).toHaveBeenCalledTimes(1)
    finish({ ...node(), content: 'First', version: 2 })
    await Promise.all([saving, following])
    expect(write.mock.calls[1]).toEqual([{ content: 'Second', x: 20 }, 2])
    expect(editor.state.node.content).toBe('Second')
    expect(editor.state.node.version).toBe(3)
  })

  it('keeps failed drafts, stops automatic retries, and uses refreshed version for explicit retry', async () => {
    const write = vi.fn<(patch: CanvasNodePatch, version: number) => Promise<CanvasNodeDTO>>()
      .mockRejectedValueOnce(new Error('Changed elsewhere'))
      .mockImplementationOnce(async patch => ({ ...node(), ...patch, version: 3 }))
    const editor = createCanvasNodeEditor(node(), write)
    editor.state.node.content = 'My changes'
    await editor.save()
    editor.receive({ ...node(), content: 'Remote changes', version: 2 })
    expect(editor.state.node.content).toBe('My changes')
    expect(editor.state.error).not.toBe('')
    await editor.save()
    expect(write).toHaveBeenCalledTimes(1)
    await editor.save(true)
    expect(write.mock.calls[1]).toEqual([{ content: 'My changes' }, 2])
    expect(editor.state.error).toBe('')
  })

  it('refreshes unchanged fields while retaining a local draft and ignores older snapshots', () => {
    const editor = createCanvasNodeEditor(node(), vi.fn())
    editor.state.node.content = 'Draft'
    editor.receive({ ...node(), x: 100, version: 2 })
    expect(editor.state.node).toMatchObject({ content: 'Draft', x: 100, version: 2 })
    expect(editor.state.error).toBe('')
    editor.receive(node())
    expect(editor.state.node).toMatchObject({ content: 'Draft', x: 100, version: 2 })
  })

  it('keeps pending writes bound to their original item', async () => {
    let finish!: (node: CanvasNodeDTO) => void
    const first = createCanvasNodeEditor(node(), () => new Promise(resolve => { finish = resolve }))
    first.state.node.content = 'Save A'
    const saving = first.save()
    const second = createCanvasNodeEditor({ ...node(), id: 'other', canvasId: 'other-canvas' }, vi.fn())
    finish({ ...node(), content: 'Save A', version: 2 })
    await saving
    expect(second.state.node).toMatchObject({ id: 'other', content: 'Initial', version: 1 })
  })

  it('can explicitly discard a failed draft in favor of the latest saved item', async () => {
    const editor = createCanvasNodeEditor(node(), vi.fn().mockRejectedValue(new Error('Offline')))
    editor.state.node.content = 'Unsaved'
    await editor.save()
    editor.discard({ ...node(), content: 'Current server content', version: 2 })
    expect(editor.state.node.content).toBe('Current server content')
    expect(editor.state.error).toBe('')
    expect(editor.isDirty()).toBe(false)
  })
})
