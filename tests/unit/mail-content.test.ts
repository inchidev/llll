import { describe, expect, it } from 'vitest'
import { plainMailBody, readableMailContent } from '../../shared/mail-content'
import { mailThreadDto } from '../../server/utils/mail-data'

describe('mail text bodies', () => {
  it('keeps genuine plain text, angle brackets, and code examples intact', () => {
    const text = 'Contact <person@example.com>\n2 < 3 & 5 > 4\nUse <strong>text</strong>.'
    expect(plainMailBody(text, '<p>Other version</p>')).toBe(text)
    expect(readableMailContent(text)).toBe(text)
  })

  it('converts an HTML-only fallback with paragraphs, entities, and useful link URLs', () => {
    expect(plainMailBody('   ', '<h2>Welcome</h2><p>Grow &amp; sell &#x1f680;.</p><p><a href="https://example.com/start">Start here</a></p>'))
      .toBe('Welcome\n\nGrow & sell 🚀.\n\nStart here [https://example.com/start]')
  })

  it('omits scripts, styles, and image tracking URLs and returns escaped text for the view', () => {
    const html = '<!doctype html><html><head><style>body { color:red }</style></head><body><script>alert(1)</script><p>&lt;script&gt;example&lt;/script&gt;</p><img src="https://example.com/track"></body></html>'
    expect(readableMailContent(html)).toBe('<script>example</script>')
  })

  it('keeps the body limit and truncation notice for text and HTML', () => {
    for (const text of ['x'.repeat(200_001), `<table><tr><td>${'x'.repeat(200_001)}</td></tr></table>`]) {
      const body = plainMailBody(text, undefined)
      expect(body).toContain('[Message truncated by L4]')
      expect(body.length).toBeLessThanOrEqual(200_000 + '\n\n[Message truncated by L4]'.length)
    }
  })

  it('preserves markup written in outbound mail and internal note previews', () => {
    const preview = '<div>Example HTML</div>'
    const row = { channelId: 'thread', mailboxChannelId: 'mailbox', subject: 'Example', status: 'inbox' as const, participantsJson: '[]', lastMessageAt: '2026-10-14T00:00:00Z', preview }
    expect(mailThreadDto(row).preview).toBe(preview)
    expect(mailThreadDto({ ...row, previewInbound: true }).preview).toBe('Example HTML')
  })
})
