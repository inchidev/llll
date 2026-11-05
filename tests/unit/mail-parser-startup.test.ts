import { beforeEach, expect, it, vi } from 'vitest'
import { compile } from 'html-to-text'

vi.mock('html-to-text', async (original) => {
  const actual = await original<typeof import('html-to-text')>()
  return { ...actual, compile: vi.fn(actual.compile) }
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

it('only compiles the inbound HTML parser when a body needs conversion, then reuses it', async () => {
  const { plainMailBody, readableMailContent } = await import('../../shared/mail-content')
  expect(readableMailContent('Plain text')).toBe('Plain text')
  expect(plainMailBody('Plain text', '<p>unused</p>')).toBe('Plain text')
  expect(compile).not.toHaveBeenCalled()
  expect(plainMailBody('', '<p>First</p>')).toBe('First')
  expect(readableMailContent('<div>Second</div>')).toBe('Second')
  expect(compile).toHaveBeenCalledTimes(1)
})

it('does not compile the outbound text parser for HTML-only rendering', async () => {
  const { mailMarkdownHtml, mailHtmlText } = await import('../../shared/mail-html')
  expect(mailMarkdownHtml('**Hello**')).toContain('<strong>Hello</strong>')
  expect(compile).not.toHaveBeenCalled()
  expect(mailHtmlText('<p>First</p>')).toBe('First')
  expect(mailHtmlText('<p>Second</p>')).toBe('Second')
  expect(compile).toHaveBeenCalledTimes(1)
})
