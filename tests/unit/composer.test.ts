import { describe, expect, it } from 'vitest'
import { claimComposerSubmission, type ComposerSubmission } from '../../shared/composer'

describe('composer submission', () => {
  it('claims a draft synchronously so repeated submit cannot send it twice', () => {
    let state: ComposerSubmission<string> = {
      draft: '',
      files: ['design.png'],
      replyToId: 'message-1',
    }
    const source = {
      read: () => state,
      clear: () => {
        state = { draft: '', files: [], replyToId: null }
      },
    }

    expect(claimComposerSubmission(source)).toEqual({
      draft: '',
      files: ['design.png'],
      replyToId: 'message-1',
    })
    expect(claimComposerSubmission(source)).toBeNull()
  })
})
