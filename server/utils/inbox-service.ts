import { hasPermission, Permission } from '../../shared/permissions'
import { mailPath } from '../../shared/paths'
import type { InboxDTO, InboxRunDTO } from '../../shared/inbox'
import type { PublicUser } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { requireChannelAccessForMember, type ServerChannelAccess, type ServerMembership } from './channel-access'
import { anyProjectPermission } from '../../shared/project-access'
import { listTasks } from './task-service'
import { readableMentions } from './member-names'

const MENTION_LIMIT = 20
const FINISHED_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/** Where a conversation opens in the Client: agent DMs live in the Agents app, mail notes in Mail. */
function conversationPath(access: ServerChannelAccess): string {
  const channel = access.channel
  const thread = channel.type === 'thread' && channel.parentId ? channel.id : null
  const root = thread ? channel.parentId! : channel.id
  if (access.mailPermission) return mailPath(root, 'inbox', thread ?? undefined)
  const section = access.accessRootType === 'dm' && access.participants.some(member => member.kind === 'agent') ? 'agents' : 'channels'
  return thread ? `/${section}/${root}/threads/${thread}` : `/${section}/${root}`
}

async function unreadMentions(env: L4Env, member: ServerMembership): Promise<InboxDTO['mentions']> {
  // Message IDs are time-ordered, so anything after the read cursor is unread.
  const rows = await env.DB.prepare(`SELECT m.id, m.channel_id AS channelId, m.content, m.created_at AS createdAt,
      u.id AS authorId, u.kind AS authorKind, COALESCE(u.nickname, u.display_name) AS authorName, u.avatar_r2_key AS authorAvatar
    FROM message_mentions mm
    JOIN messages m ON m.id = mm.message_id
    JOIN users u ON u.id = m.author_id
    LEFT JOIN channel_reads r ON r.channel_id = m.channel_id AND r.user_id = mm.user_id
    WHERE mm.user_id = ? AND m.author_id <> mm.user_id AND m.deleted_at IS NULL
      AND (r.last_read_message_id IS NULL OR m.id > r.last_read_message_id)
    ORDER BY m.id DESC LIMIT ?`).bind(member.user.id, MENTION_LIMIT * 2)
    .all<{ id: string; channelId: string; content: string; createdAt: string; authorId: string; authorKind: PublicUser['kind']; authorName: string; authorAvatar: string | null }>()
  const access = new Map<string, ServerChannelAccess | null>()
  const visible = []
  for (const row of rows.results ?? []) {
    if (!access.has(row.channelId)) {
      // A mention never outlives the reader's access to its conversation.
      access.set(row.channelId, await requireChannelAccessForMember(env, member, row.channelId).catch(() => null))
    }
    const channel = access.get(row.channelId)
    // An archived channel leaves the Inbox with its navigation; its history stays readable.
    if (channel && !channel.archivedAt) visible.push({ row, channel })
    if (visible.length === MENTION_LIMIT) break
  }
  const excerpts = await readableMentions(env, visible.map(({ row }) => row.content.slice(0, 400)))
  return visible.map(({ row, channel }, index) => ({
    messageId: row.id,
    path: conversationPath(channel),
    conversation: channel.channel.name,
    author: { id: row.authorId, kind: row.authorKind, displayName: row.authorName, avatarR2Key: row.authorAvatar },
    excerpt: excerpts[index]!.slice(0, 280),
    createdAt: row.createdAt,
  }))
}

async function agentWork(env: L4Env, member: ServerMembership): Promise<Pick<InboxDTO, 'approvals' | 'runs'>> {
  const now = new Date().toISOString()
  const approvals = await env.DB.prepare(`SELECT a.id, a.run_id AS runId, a.request_json AS requestJson, a.created_at AS createdAt,
      COALESCE(u.nickname, u.display_name) AS agentName, t.title AS taskTitle
    FROM factory_actions a
    JOIN agent_runs r ON r.id = a.run_id
    JOIN users u ON u.id = r.agent_id
    LEFT JOIN tasks t ON t.id = r.task_id
    WHERE r.initiated_by = ? AND a.status = 'pending' AND a.expires_at > ?
    ORDER BY a.created_at LIMIT 20`).bind(member.user.id, now)
    .all<{ id: string; runId: string; requestJson: string; createdAt: string; agentName: string; taskTitle: string | null }>()
  const publications = await env.DB.prepare(`SELECT p.id, p.run_id AS runId, p.created_at AS createdAt, COALESCE(u.nickname, u.display_name) AS agentName, t.title AS taskTitle
    FROM agent_run_publications p
    JOIN agent_runs r ON r.id = p.run_id
    JOIN users u ON u.id = r.agent_id
    LEFT JOIN tasks t ON t.id = r.task_id
    WHERE r.initiated_by = ? AND p.status = 'pending' AND p.expires_at > ?
    ORDER BY p.created_at LIMIT 20`).bind(member.user.id, now)
    .all<{ id: string; runId: string; createdAt: string; agentName: string; taskTitle: string | null }>()
  const runs = await env.DB.prepare(`SELECT r.id, r.status, r.created_at AS createdAt, r.updated_at AS updatedAt,
      COALESCE(u.nickname, u.display_name) AS agentName, t.title AS taskTitle, c.name AS conversation, p.pull_number AS pullNumber
    FROM agent_runs r
    JOIN users u ON u.id = r.agent_id
    JOIN channels c ON c.id = r.channel_id
    LEFT JOIN tasks t ON t.id = r.task_id
    LEFT JOIN agent_code_proposals p ON p.run_id = r.id
    WHERE r.initiated_by = ? AND (r.status IN ('queued', 'running') OR r.updated_at > ?)
    ORDER BY r.updated_at DESC LIMIT 30`).bind(member.user.id, new Date(Date.now() - FINISHED_WINDOW_MS).toISOString())
    .all<InboxRunDTO>()
  const operation = (json: string) => {
    try { return String((JSON.parse(json) as { operation?: unknown }).operation ?? 'action') }
    catch { return 'action' }
  }
  return {
    approvals: [
      ...(approvals.results ?? []).map(row => ({ id: row.id, kind: 'workspace' as const, runId: row.runId, agentName: row.agentName, taskTitle: row.taskTitle, operation: operation(row.requestJson), createdAt: row.createdAt })),
      ...(publications.results ?? []).map(row => ({ id: row.id, kind: 'publication' as const, runId: row.runId, agentName: row.agentName, taskTitle: row.taskTitle, operation: 'share', createdAt: row.createdAt })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    runs: runs.results ?? [],
  }
}

async function myTasks(env: L4Env, member: ServerMembership): Promise<Pick<InboxDTO, 'assigned' | 'review'>> {
  if (!hasPermission(member.perms, Permission.readTasks) && !anyProjectPermission(member.authorization, Permission.readTasks)) return { assigned: [], review: [] }
  // listTasks applies Role, Project policy and resource access, so only visible Tasks appear.
  const tasks = (await listTasks(env, member.authorization)).flatMap(board => board.tasks.map(task => ({ ...task, boardName: board.name })))
  const item = (task: typeof tasks[number]) => ({ id: task.id, number: task.number, title: task.title, status: task.status, priority: task.priority, dueAt: task.dueAt, boardName: task.boardName })
  return {
    assigned: tasks.filter(task => task.assigneeId === member.user.id && !['done', 'review'].includes(task.status)).map(item).slice(0, 30),
    review: tasks.filter(task => task.status === 'review' && task.createdBy === member.user.id && task.assigneeId !== member.user.id).map(item).slice(0, 30),
  }
}

/** Everything that is waiting on this member, across agents, chat and Tasks. */
export async function loadInbox(env: L4Env, member: ServerMembership): Promise<InboxDTO> {
  const [mentions, work, tasks] = await Promise.all([unreadMentions(env, member), agentWork(env, member), myTasks(env, member)])
  return { mentions, ...work, ...tasks }
}
