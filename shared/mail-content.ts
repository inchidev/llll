import { compile } from 'html-to-text'

const MAX_BODY_LENGTH = 200_000
const TRUNCATED = '\n\n[Message truncated by L4]'
const htmlToText = compile({
  wordwrap: false,
  limits: { maxInputLength: MAX_BODY_LENGTH, maxDepth: 100, maxChildNodes: 10_000 },
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: 'style', format: 'skip' },
    { selector: 'script', format: 'skip' },
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(selector => ({ selector, options: { uppercase: false } })),
  ],
})

/** Some senders put an entire HTML layout in their text/plain MIME part. */
function isHtmlLayout(content: string): boolean {
  return /^\s*(?:<!doctype\s+html\b[^>]*>\s*)?<(?:html|head|body|table|div)\b/iu.test(content)
    && /<\/(?:html|body|table|div)>/iu.test(content)
}

function convertHtml(content: string): string {
  const text = htmlToText(content.slice(0, MAX_BODY_LENGTH)).trim()
  return text.slice(0, MAX_BODY_LENGTH) + (content.length > MAX_BODY_LENGTH || text.length > MAX_BODY_LENGTH ? TRUNCATED : '')
}

/** Returns text only: callers must continue rendering it as escaped text. */
export function readableMailContent(content: string): string {
  return isHtmlLayout(content) ? convertHtml(content) : content
}

export function plainMailBody(text: string | undefined, html: string | undefined): string {
  const body = (text?.trim() ? readableMailContent(text) : html ? convertHtml(html) : '').replace(/\r\n/gu, '\n').trim()
  return body.length <= MAX_BODY_LENGTH ? body : body.slice(0, MAX_BODY_LENGTH) + TRUNCATED
}
