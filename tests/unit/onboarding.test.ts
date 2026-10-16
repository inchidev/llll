import { describe, expect, it } from 'vitest'
import { emptyRichTextDocument, parseRichTextDocument, richTextHasContent } from '../../server/utils/onboarding'

describe('onboarding rich text', () => {
  it('treats a blank Tiptap document as unpublished content', () => {
    expect(richTextHasContent(emptyRichTextDocument())).toBe(false)
    expect(richTextHasContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }] })).toBe(false)
  })

  it('detects authored document content', () => {
    expect(richTextHasContent({
      type: 'doc',
      content: [{ type: 'heading', content: [{ type: 'text', text: 'Workspace terms' }] }],
    })).toBe(true)
  })

  it('falls back to an empty document for corrupt stored JSON', () => {
    expect(parseRichTextDocument('{broken')).toEqual(emptyRichTextDocument())
  })
})
