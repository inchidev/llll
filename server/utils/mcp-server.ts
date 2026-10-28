import { listAuthorizedTables } from './table-catalog'
import { toolPaused } from '../../shared/features'
import { McpServer, createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { version as packageVersion } from '../../package.json'
import type { L4Env } from '../../workers/env'
import { createDocument, getDocument, listAuthorizedDataResources, updateDocument } from './document-service'
import type { McpPrincipal } from './mcp-principal'
import { createTask, getTask, listTasks, updateTask } from './task-service'
import {
  deleteChannelMessage, editChannelMessage, listChannelThreads, listMentionRoles, listMessageChannels, listMessageMembers, openDirectMessage,
  readChannelMessages, requireMessageMember, searchChannelMessages, sendChannelMessage, setMessagePin, setMessageReaction,
} from './message-service'
import { isStoredAvatarKey } from '../../shared/avatar'
import { retryDeletedFiles } from '../../shared/file-cleanup'
import { createRecord, createRecordSchema, readRecordsSchema, readRecords, updateRecord, updateRecordSchema } from './record-service'
import { createTable, createTableSchema } from './table-service'

type McpServerContext = {
  env: L4Env
  principal: McpPrincipal
  schedule: (promise: Promise<unknown>) => void
  /** Public origin for absolute links such as avatars. */
  origin?: string
}

/**
 * MCP output never carries storage object keys. A member's picture becomes a
 * Server avatar URL (or null), other `*R2Key` fields are dropped.
 */
export function mcpOutput(value: unknown, origin = ''): unknown {
  if (Array.isArray(value)) return value.map(item => mcpOutput(item, origin))
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === 'avatarR2Key') {
      if (typeof record.id === 'string') {
        output.avatarUrl = isStoredAvatarKey(item as string | null) ? `${origin}/api/users/${encodeURIComponent(record.id)}/avatar` : null
      }
    }
    else if (!key.endsWith('R2Key')) output[key] = mcpOutput(item, origin)
  }
  return output
}

const dueAtSchema = z.string().refine(value => !Number.isNaN(Date.parse(value)), 'Invalid due date').nullable()
const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent'])
const statusSchema = z.enum(['backlog', 'ready', 'review', 'done', 'failed'])
const taskReferenceSchema = z.union([z.string().trim().min(1), z.number().int().positive()])

/**
 * Serves one stateless MCP HTTP request. Only this Server's own hostname may appear in
 * Host and Origin, which keeps DNS-rebound and cross-site pages off the endpoint.
 */
export function serveMcpRequest(request: Request, context: McpServerContext): Promise<Response> {
  const hostname = new URL(request.url).hostname
  const rejected = hostHeaderValidationResponse(request, [hostname]) ?? originValidationResponse(request, [hostname])
  if (rejected) return Promise.resolve(rejected)
  return createMcpHandler(() => createL4McpServer(context)).fetch(request)
}

export function createL4McpServer({ env, principal, schedule, origin = '' }: McpServerContext): McpServer {
  const server = new McpServer({ name: 'L4', version: packageVersion })
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(mcpOutput(value, origin), null, 2) }] })
  if (!toolPaused('list_tables')) server.registerTool('list_tables', {
    description: 'Discover authorized table IDs, names, fields and views before reading records. Requires data:read.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => result({ tables: await listAuthorizedTables(env, principal.authorization) }))

  if (!toolPaused('create_table')) server.registerTool('create_table', {
    description: 'Create a table and typed fields. Requires the data:manage scope, role permission and unrestricted table creation.',
    inputSchema: createTableSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async input => result({ database: await createTable(env, principal.authorization, input) }))

  if (!toolPaused('read_records')) server.registerTool('read_records', {
    description: 'Read fields and records without saved view filters by default. Supply viewId to apply a saved view; search/pageSize and nextPage support paging.',
    inputSchema: readRecordsSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ databaseId, page, ...options }) => result(await readRecords(env, principal.authorization, databaseId, page, options)))
  if (!toolPaused('create_record')) server.registerTool('create_record', {
    description: 'Create a record in an authorized table. Requires data:write scope and role permission.',
    inputSchema: { databaseId: z.string().min(1), ...createRecordSchema.shape },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ databaseId, ...input }) => result({ item: await createRecord(env, principal.authorization, databaseId, input) }))
  if (!toolPaused('update_record')) server.registerTool('update_record', {
    description: 'Update an authorized record using its current version.',
    inputSchema: { recordId: z.string().min(1), ...updateRecordSchema.shape },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ recordId, ...input }) => result({ item: await updateRecord(env, principal.authorization, recordId, input) }))

  server.registerTool('list_task_boards', {
    description: 'List task boards with their tasks, labels, dependencies, and checklist counts.',
    inputSchema: { includeArchived: z.boolean().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ includeArchived }) => {
    return result({ boards: await listTasks(env, principal.authorization, includeArchived) })
  })

  server.registerTool('get_task', {
    description: 'Get one task by UUID or human-readable number, with its labels, dependencies, checklist, and attachments.',
    inputSchema: { taskId: taskReferenceSchema.describe('Task UUID or human-readable number') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ taskId }) => {
    const task = await getTask(env, principal.authorization, taskId)
    if (!task) throw new Error('Task not found')
    return result({ task })
  })

  server.registerTool('create_task', {
    description: 'Create a task on a L4 task board. Unassigned tasks start in backlog; assigned tasks start ready.',
    inputSchema: {
      boardId: z.string().min(8),
      title: z.string().trim().min(1).max(160),
      description: z.string().trim().max(12_000).default(''),
      priority: prioritySchema.default('normal'),
      dueAt: dueAtSchema.default(null),
      assigneeId: z.string().min(8).nullable().default(null),
      environmentId: z.string().min(8).nullable().optional(),
      channelId: z.string().min(8).nullable().default(null),
      labelIds: z.array(z.string().min(8)).max(20).default([]),
      dependencyIds: z.array(z.string().min(8)).max(100).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ boardId, ...input }) => {
    return result({ task: await createTask(env, principal.authorization, boardId, input, schedule) })
  })

  server.registerTool('update_task', {
    description: 'Update, move, archive, or restore a task by UUID or human-readable number.',
    inputSchema: {
      taskId: taskReferenceSchema.describe('Task UUID or human-readable number'),
      title: z.string().trim().min(1).max(160).optional(),
      description: z.string().trim().max(12_000).optional(),
      status: statusSchema.optional(),
      priority: prioritySchema.optional(),
      dueAt: dueAtSchema.optional(),
      position: z.number().int().min(0).optional(),
      boardId: z.string().min(8).optional(),
      assigneeId: z.string().min(8).nullable().optional(),
      environmentId: z.string().min(8).nullable().optional(),
      channelId: z.string().min(8).nullable().optional(),
      archived: z.boolean().optional(),
      labelIds: z.array(z.string().min(8)).max(20).optional(),
      dependencyIds: z.array(z.string().min(8)).max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ taskId, ...input }) => {
    if (!Object.keys(input).length) throw new Error('No changes supplied')
    return result({ task: await updateTask(env, principal.authorization, taskId, input, schedule) })
  })

  if (!toolPaused('list_documents')) server.registerTool('list_documents', {
    description: 'List L4 document summaries. Use get_document to read a document body.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const resources = await listAuthorizedDataResources(env, principal.authorization)
    return result({ documents: resources.documents })
  })

  if (!toolPaused('get_document')) server.registerTool('get_document', {
    description: 'Read one L4 document. The content field contains HTML used by the rich-text editor.',
    inputSchema: { documentId: z.string().min(8) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ documentId }) => {
    return result({ document: await getDocument(env, principal.authorization, documentId) })
  })

  if (!toolPaused('create_document')) server.registerTool('create_document', {
    description: 'Create a L4 document. Supply the rich-text body as HTML.',
    inputSchema: {
      title: z.string().trim().min(1).max(160),
      content: z.string().max(1_000_000).default(''),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    return result({ document: await createDocument(env, principal.authorization, input) })
  })

  if (!toolPaused('update_document')) server.registerTool('update_document', {
    description: 'Update a L4 document using its current version. Supply rich-text content as HTML.',
    inputSchema: {
      documentId: z.string().min(8),
      title: z.string().trim().min(1).max(160).optional(),
      content: z.string().max(1_000_000).optional(),
      version: z.number().int().positive(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ documentId, ...input }) => {
    if (input.title === undefined && input.content === undefined) throw new Error('No changes supplied')
    return result({ document: await updateDocument(env, principal.authorization, documentId, input) })
  })

  const pageSchema = {
    limit: z.number().int().min(1).max(50).default(25),
    cursor: z.string().min(1).max(100).optional(),
  }
  server.registerTool('list_channels', {
    description: 'List accessible chat channels, DMs and threads with IDs, participants, canSend, unread state (unread, unreadCount, lastMessageAt) for the acting member. Use it to answer what needs catching up. Email mailboxes and task discussions use their own navigation and are excluded; archived channels and their threads leave navigation and are omitted, though list_messages still reads them by ID. Page with nextCursor.',
    inputSchema: { ...pageSchema, name: z.string().trim().min(1).max(100).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => result(await listMessageChannels(env, await requireMessageMember(env, principal.authorization, 'messages:read'), input)))

  server.registerTool('list_members', {
    description: 'List active members visible to you, including Agents when you can use or manage them. Paste a returned mentionToken into send_message content to tag that member; plain @names are not mention tokens. Page with nextCursor.',
    inputSchema: { ...pageSchema, name: z.string().trim().min(1).max(80).optional(), kind: z.enum(['human', 'agent']).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => result(await listMessageMembers(env, await requireMessageMember(env, principal.authorization, 'messages:read'), input)))

  server.registerTool('list_roles', {
    description: 'List the Roles you may mention: mentionable Roles, or every Role for the Server Owner and members with Manage channels. Paste a returned mentionToken (<@&role-id>) into send_message content to notify the people with that Role who can read the conversation, up to 500. The Owner and members with Manage channels also get groups: <!channel> notifies everyone who can read the conversation and <!here> only those of them online, up to 500; from anyone else these tokens are stored as plain @channel and @here text. Role and group mentions never invoke Agents.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => result(await listMentionRoles(env, await requireMessageMember(env, principal.authorization, 'messages:read'))))

  server.registerTool('list_messages', {
    description: 'Read one accessible chat or thread, oldest to newest within each page. Use nextCursor to read older pages. Reading does not mark messages as read. Deleted message bodies are omitted.',
    inputSchema: { ...pageSchema, channelId: z.string().min(8) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ channelId, ...input }) => result(await readChannelMessages(env, await requireMessageMember(env, principal.authorization, 'messages:read'), channelId, input)))

  server.registerTool('send_message', {
    description: 'Send as the connected member in an accessible chat or thread using the same permissions as the interface. Put <@member-id> tokens from list_members into content to tag members, <@&role-id> tokens from list_roles to notify a Role, or the <!channel> and <!here> group tokens list_roles offers you. Agent invocation requires the same management rights and Agent chat access as the interface. Replies must target a message in this channel. Archived channels and their threads are read-only and answer channel_archived. This sends a new message on every call; do not retry blindly. Sends share the member\'s chat rate limit (30 per 10 seconds) and fail with rate_limited when it is exhausted.',
    inputSchema: { channelId: z.string().min(8), content: z.string().min(1).max(2000),
      replyToId: z.string().min(8).optional(), agentMode: z.enum(['queue', 'steer']).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ channelId, ...input }) => result(await sendChannelMessage(env, await requireMessageMember(env, principal.authorization, 'messages:write'), channelId, input, schedule)))

  const reader = () => requireMessageMember(env, principal.authorization, 'messages:read')
  const writer = () => requireMessageMember(env, principal.authorization, 'messages:write')
  const writeAnnotations = (destructiveHint: boolean, idempotentHint: boolean) => ({ readOnlyHint: false, destructiveHint, idempotentHint, openWorldHint: false })

  server.registerTool('search_messages', {
    description: 'Full-text search, newest first, across every chat, DM and thread you can read in the interface (mailboxes and task discussions excluded). Words match as prefixes; all must match. Narrow with channelId (a conversation and its threads, or one thread) and authorId. Each hit has its channel and the path that opens it; hits in archived channels stay searchable and carry channel.archived=true. Page with nextCursor.',
    inputSchema: { query: z.string().trim().min(1).max(120), channelId: z.string().min(8).optional(), authorId: z.string().min(8).optional(),
      limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(2048).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, ...input }) => result(await searchChannelMessages(env, await reader(), { q: query, ...input })))

  server.registerTool('list_threads', {
    description: 'List threads of one accessible chat or DM, newest first, with their original message and reply count. Read a thread with list_messages using its id; reply with send_message. Page with nextCursor.',
    inputSchema: { ...pageSchema, channelId: z.string().min(8) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ channelId, ...input }) => result(await listChannelThreads(env, await reader(), channelId, input)))

  server.registerTool('edit_message', {
    description: 'Replace the content of a message you sent. Same rules as the interface: only your own messages, with send permission in that conversation. Mention tokens work as in send_message; only people a new mention reaches are notified.',
    inputSchema: { messageId: z.string().min(8), content: z.string().min(1).max(2000) },
    annotations: writeAnnotations(false, true),
  }, async ({ messageId, content }) => result(await editChannelMessage(env, await writer(), messageId, { content }, schedule)))

  server.registerTool('delete_message', {
    description: 'Delete a message with its attachments and pin, for everyone in the conversation. Same rules as the interface: your own messages, or any message in a server channel when you can manage channels. This cannot be undone.',
    inputSchema: { messageId: z.string().min(8) },
    annotations: writeAnnotations(true, true),
  }, async ({ messageId }) => {
    const deleted = await deleteChannelMessage(env, await writer(), messageId)
    schedule(retryDeletedFiles(env))
    return result(deleted)
  })

  server.registerTool('react_message', {
    description: 'Add your emoji reaction to a message in an accessible conversation, or remove it with remove=true. Repeating the same call changes nothing.',
    inputSchema: { messageId: z.string().min(8), emoji: z.string().min(1).max(16), remove: z.boolean().default(false) },
    annotations: writeAnnotations(false, true),
  }, async ({ messageId, ...input }) => result(await setMessageReaction(env, await writer(), messageId, input)))

  server.registerTool('pin_message', {
    description: 'Pin a message, or unpin it with pinned=false. Channels require the manage channels permission; DM participants can pin while the DM is active.',
    inputSchema: { messageId: z.string().min(8), pinned: z.boolean().default(true) },
    annotations: writeAnnotations(false, true),
  }, async ({ messageId, pinned }) => result(await setMessagePin(env, await writer(), messageId, { pinned })))

  server.registerTool('open_dm', {
    description: 'Open your 1:1 direct message with a member from list_members, creating it if needed, and return its channel ID for send_message. Opening a DM with an Agent requires the use agents permission.',
    inputSchema: { userId: z.string().min(8) },
    annotations: writeAnnotations(false, true),
  }, async ({ userId }) => result(await openDirectMessage(env, await writer(), userId)))

  return server
}
