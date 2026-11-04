import sanitizeHtml from 'sanitize-html'
import { marked } from 'marked'
import TurndownService from 'turndown'
import { DOCUMENT_CONTENT_MAX } from '../../shared/documents'
import { fail } from './cf'

/** Only formatting understood by the document editor crosses the storage boundary. */
export function sanitizeDocumentHtml(content: string): string {
  const html = sanitizeHtml(content, {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'],
    allowedAttributes: { a: ['href', 'title', 'rel'], ol: ['start'] },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'template', 'iframe', 'svg', 'math'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
  })
  if (html.length > DOCUMENT_CONTENT_MAX) fail(400, 'document_too_large', 'Document content exceeds the supported size')
  return html
}

export function documentInputHtml(content: string, format: 'html' | 'markdown' = 'html'): string {
  return sanitizeDocumentHtml(format === 'markdown' ? marked.parse(content, { async: false }) : content)
}

export function documentMarkdown(content: string): string {
  return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(sanitizeDocumentHtml(content))
}
