import type { AuthorizationContext } from '../../shared/authorization'
import type { DocumentRevision } from '../../shared/documents'
import type { L4Env } from '../../workers/env'
import { getItem, updateItem } from './item-service'
import { sanitizeDocumentHtml } from './document-content'
import { fail } from './cf'

export async function listDocumentRevisions(env: L4Env, auth: AuthorizationContext, id: string) {
  await getItem(env, auth, id)
  return (await env.DB.prepare('SELECT version,title,saved_at as savedAt FROM document_revisions WHERE document_id=? ORDER BY version DESC LIMIT 50').bind(id).all<Omit<DocumentRevision, 'content'>>()).results
}

export async function getDocumentRevision(env: L4Env, auth: AuthorizationContext, id: string, version: number): Promise<DocumentRevision> {
  await getItem(env, auth, id)
  const revision = await env.DB.prepare('SELECT version,title,content,saved_at as savedAt FROM document_revisions WHERE document_id=? AND version=?').bind(id, version).first<DocumentRevision>()
  if (!revision) fail(404, 'not_found', 'Document revision not found')
  return { ...revision, content: sanitizeDocumentHtml(revision.content) }
}

export async function restoreDocumentRevision(env: L4Env, auth: AuthorizationContext, id: string, revision: number, version: number) {
  const previous = await getDocumentRevision(env, auth, id, revision)
  return updateItem(env, auth, id, { title: previous.title, content: previous.content, version })
}
