import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { version as packageVersion } from '../../package.json'
import type { L4Env } from '../../workers/env'
import { createDocument, getDocument, listAuthorizedDataResources, updateDocument } from './document-service'
import type { McpPrincipal } from './mcp-principal'
import { createTask, getTask, listTasks, updateTask } from './task-service'
import { listMessageChannels, listMessageMembers, readChannelMessages, requireMessageMember, sendChannelMessage } from './message-service'
import { createRecord, createRecordSchema, readRecords, updateRecord, updateRecordSchema } from './record-service'
import { createTable, createTableSchema } from './table-service'

type McpServerContext = {
  env: L4Env
  principal: McpPrincipal
  schedule: (promise: Promise<unknown>) => void
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

const dueAtSchema = z.string().refine(value => !Number.isNaN(Date.parse(value)), 'Invalid due date').nullable()
const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent'])
const statusSchema = z.enum(['backlog', 'ready', 'review', 'done', 'failed'])
const taskReferenceSchema = z.union([z.string().trim().min(1), z.number().int().positive()])

export function createL4McpServer({ env, principal, schedule }: McpServerContext): McpServer {
  const server = new McpServer({ name: 'L4', version: packageVersion })
  server.registerTool('create_table', {
    description: 'Create a table and typed fields. Requires the data:manage scope, role permission and unrestricted table creation.',
    inputSchema: createTableSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async input => result({ database: await createTable(env, principal.authorization, input) }))

  server.registerTool('read_records', {
    description: 'Read fields and a page of records from an authorized table.',
    inputSchema: { databaseId: z.string().min(1), page: z.number().int().positive().default(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ databaseId, page }) => result(await readRecords(env, principal.authorization, databaseId, page)))
  server.registerTool('create_record', {
    description: 'Create a record in an authorized table. Requires data:write scope and role permission.',
    inputSchema: { databaseId: z.string().min(1), ...createRecordSchema.shape },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ databaseId, ...input }) => result({ item: await createRecord(env, principal.authorization, databaseId, input) }))
  server.registerTool('update_record', {
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

  server.registerTool('list_documents', {
    description: 'List L4 document summaries. Use get_document to read a document body.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const resources = await listAuthorizedDataResources(env, principal.authorization)
    return result({ documents: resources.documents })
  })

  server.registerTool('get_document', {
    description: 'Read one L4 document. The content field contains HTML used by the rich-text editor.',
    inputSchema: { documentId: z.string().min(8) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ documentId }) => {
    return result({ document: await getDocument(env, principal.authorization, documentId) })
  })

  server.registerTool('create_document', {
    description: 'Create a L4 document. Supply the rich-text body as HTML.',
    inputSchema: {
      title: z.string().trim().min(1).max(160),
      content: z.string().max(1_000_000).default(''),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    return result({ document: await createDocument(env, principal.authorization, input) })
  })

  server.registerTool('update_document', {
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
    description: 'List accessible chat channels, DMs and threads with IDs, participants and canSend. Email mailboxes and task discussions use their own navigation and are excluded. Page with nextCursor.',
    inputSchema: { ...pageSchema, name: z.string().trim().min(1).max(100).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => result(await listMessageChannels(env, await requireMessageMember(env, principal.authorization, 'messages:read'), input)))

  server.registerTool('list_members', {
    description: 'List active members visible to you, including Agents when you can manage them. Paste a returned mentionToken into send_message content to tag that member; plain @names are not mention tokens. Page with nextCursor.',
    inputSchema: { ...pageSchema, name: z.string().trim().min(1).max(80).optional(), kind: z.enum(['human', 'agent']).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => result(await listMessageMembers(env, await requireMessageMember(env, principal.authorization, 'messages:read'), input)))

  server.registerTool('list_messages', {
    description: 'Read one accessible chat or thread, oldest to newest within each page. Use nextCursor to read older pages. Reading does not mark messages as read. Deleted message bodies are omitted.',
    inputSchema: { ...pageSchema, channelId: z.string().min(8) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ channelId, ...input }) => result(await readChannelMessages(env, await requireMessageMember(env, principal.authorization, 'messages:read'), channelId, input)))

  server.registerTool('send_message', {
    description: 'Send as the connected member in an accessible chat or thread using the same permissions as the interface. Put <@member-id> tokens from list_members into content to tag members. Agent invocation requires the same management rights and Agent chat access as the interface. Replies must target a message in this channel. This sends a new message on every call; do not retry blindly.',
    inputSchema: { channelId: z.string().min(8), content: z.string().min(1).max(2000),
      replyToId: z.string().min(8).optional(), agentMode: z.enum(['queue', 'steer']).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ channelId, ...input }) => result(await sendChannelMessage(env, await requireMessageMember(env, principal.authorization, 'messages:write'), channelId, input, schedule)))

  return server
}
