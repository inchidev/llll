import { dataNameWrite } from './data-conflicts'
import { createDocumentSchema, updateDocumentSchema } from '../../shared/documents'
import { documentInputHtml } from './document-content'
import type { DataResourcesDTO, DocumentDTO } from '../../shared/types'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { loadDataResources, requireDocument } from './data-resources'
import { writeAudit } from './messages'
import { authorize, authorizeResource, resourceAllowed, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { creationSpaceId, spaceSql } from '../../shared/spaces'

export type CreateDocumentInput = {
  title?: string
  content?: string
  format?: 'html' | 'markdown'
}

export type UpdateDocumentInput = {
  title?: string
  content?: string
  version: number
  format?: 'html' | 'markdown'
}

export async function listAuthorizedDataResources(
  env: L4Env,
  authorization: AuthorizationContext,
): Promise<DataResourcesDTO> {
  authorize(authorization, ServerAction.readDocuments)
  const data = await loadDataResources(env, authorization.credential.kind === 'session' ? authorization.principal.id : undefined, spaceSql(authorization))
  return { ...data,
    databases: data.databases.filter(row => resourceAllowed(authorization, 'databases', row.id)),
    documents: data.documents.filter(row => resourceAllowed(authorization, 'documents', row.id)),
    canvases: data.canvases.filter(row => resourceAllowed(authorization, 'canvases', row.id)),
    bookmarks: data.bookmarks.filter(row => row.targetType === 'database_view'
      ? data.databases.some(database => resourceAllowed(authorization, 'databases', database.id) && database.views.some(view => view.id === row.targetId))
      : resourceAllowed(authorization, row.targetType === 'document' ? 'documents' : 'canvases', row.targetId)),
  }
}

export async function getDocument(
  env: L4Env,
  authorization: AuthorizationContext,
  id: string,
): Promise<DocumentDTO> {
  authorize(authorization, ServerAction.readDocuments)
  // Decided without the boundary: the lookup makes a document in another Space answer as missing.
  authorizeResource(authorization, 'documents', id)
  return requireDocument(env, id, authorization)
}

export async function createDocument(
  env: L4Env,
  authorization: AuthorizationContext,
  input: CreateDocumentInput,
): Promise<DocumentDTO> {
  authorize(authorization, ServerAction.writeDocuments)
  const spaceId = creationSpaceId(authorization)
  if (!spaceId) fail(403, 'forbidden', 'Choose a Space first')
  authorizeResource(authorization, 'documents', '*')
  const serverId = authorization.serverId
  const actorId = authorization.principal.id
  const position = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) + 1024 as value FROM documents WHERE space_id = ?').bind(spaceId).first<{ value: number }>()
  const id = newId()
  const now = nowIso()
  input = createDocumentSchema.parse(input)
  const content = documentInputHtml(input.content ?? '', input.format)
  let title = input.title ?? 'Untitled'
  let inserted = false
  for (let attempt = 0; attempt < 8; attempt++) {
    if (input.title === undefined) {
      const names = (await env.DB.prepare('SELECT lower(title) AS title FROM documents WHERE space_id = ?').bind(spaceId).all<{ title: string }>()).results
      const used = new Set(names.map(row => row.title))
      let suffix = 1
      while (used.has((suffix === 1 ? 'Untitled' : `Untitled ${suffix}`).toLowerCase())) suffix++
      title = suffix === 1 ? 'Untitled' : `Untitled ${suffix}`
    }
    const saved = await env.DB.prepare(
    `INSERT INTO documents (id, space_id, title, content, position, version, created_by, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM documents WHERE space_id=? AND lower(title)=lower(?)) RETURNING id`,
    ).bind(id, spaceId, title, content, position?.value ?? 1024, actorId, now, now, spaceId, title).first()
    if (saved) { inserted = true; break }
    if (input.title !== undefined) fail(409, 'duplicate_name', 'A document with this title already exists')
  }
  if (!inserted) fail(409, 'conflict', 'Document titles changed concurrently; retry creating the document')
  await writeAudit(env, {
    serverId,
    actorId,
    action: 'document.create',
    targetType: 'document',
    targetId: id,
    meta: { title },
    authorization,
  })
  return { id, title, content, position: position?.value ?? 1024, version: 1, createdBy: actorId, createdAt: now, updatedAt: now }
}

export async function updateDocument(
  env: L4Env,
  authorization: AuthorizationContext,
  id: string,
  input: UpdateDocumentInput,
): Promise<DocumentDTO> {
  authorize(authorization, ServerAction.writeDocuments)
  authorizeResource(authorization, 'documents', id)
  const serverId = authorization.serverId
  const actorId = authorization.principal.id
  input = updateDocumentSchema.parse(input)
  const document = await requireDocument(env, id, authorization)
  if (document.version !== input.version) fail(409, 'stale_document', 'This document changed elsewhere. Reload and try again.')
  if (input.title !== undefined && await env.DB.prepare('SELECT id FROM documents WHERE id <> ? AND lower(title) = lower(?) AND space_id = (SELECT space_id FROM documents WHERE id = ?) LIMIT 1').bind(id, input.title, id).first()) {
    fail(409, 'duplicate_name', 'A document with this title already exists')
  }
  const assignments = ['updated_at = ?', 'version = version + 1']
  const values: Array<string | number> = [nowIso()]
  if (input.title !== undefined) { assignments.push('title = ?'); values.push(input.title) }
  if (input.content !== undefined) { assignments.push('content = ?'); values.push(documentInputHtml(input.content, input.format)) }
  const updated = await dataNameWrite(() => env.DB.prepare(
    `UPDATE documents SET ${assignments.join(', ')} WHERE deleted_at IS NULL AND id = ? AND version = ?
     RETURNING id, title, content, position, version, created_by as createdBy,
     created_at as createdAt, updated_at as updatedAt`,
  ).bind(...values, id, input.version).first<DocumentDTO>())
  if (!updated) fail(409, 'stale_document', 'This document changed elsewhere. Reload and try again.')
  await writeAudit(env, {
    serverId,
    actorId,
    action: 'document.update',
    targetType: 'document',
    targetId: id,
    meta: { fields: Object.keys(input).filter(key => key !== 'version') },
    authorization,
  })
  return updated
}
