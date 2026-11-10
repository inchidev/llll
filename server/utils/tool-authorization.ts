import { actionRule, authorize, authorizeMcpCredential, AuthorizationError, ServerAction, SpaceBoundaryError, type AuthorizationContext } from '../../shared/authorization'
import type { McpScope } from '../../shared/mcp'
import { anyProjectPermission } from '../../shared/project-access'
import { spaceResourceDenied, type SpaceDeniedKind } from '../../shared/spaces'
import type { UserKind } from '../../shared/types'

/**
 * What a Server tool needs of the principal it acts for. One rule per tool, whichever way the
 * call arrives: a Run's built-in tools, the inbound MCP endpoint or an external Agent's Run credential.
 *
 * - `actions`: every listed action must pass `authorize`, which checks the Agent's Role, the person
 *   it acts for, the credential's scopes and any delegated action list.
 * - `anyOf`: one of the actions must pass; the service then checks the exact kind of the resource named.
 * - `projectwide`: a Project policy that grants the permission anywhere counts, as it does for the
 *   interface; the Task itself is still checked against its own Project.
 * - `scope`: an MCP credential must carry this scope. Channel and Mailbox permissions are per resource,
 *   so the message and mail services check them with the channel in hand.
 * - `principal`: only this kind of Member may call the tool.
 *
 * A tool without a rule is refused. Remote descriptions, tool names and model instructions grant nothing.
 */
export type ToolRule = { actions?: ServerAction[]; anyOf?: ServerAction[]; projectwide?: boolean; scope?: McpScope; principal?: UserKind }

const A = ServerAction
const tasksRead: ToolRule = { actions: [A.readTasks], projectwide: true }
const tasksWrite: ToolRule = { actions: [A.writeTasks], projectwide: true }
const itemsRead: ToolRule = { anyOf: [A.readDocuments, A.readRecords] }
const itemsWrite: ToolRule = { anyOf: [A.writeDocuments, A.writeRecords, A.manageData] }
const computer: ToolRule = { actions: [A.useComputer] }

export const TOOL_RULES: Readonly<Record<string, ToolRule>> = {
  // Control: no Server data.
  get_current_time: {}, search_tools: {}, get_tool_details: {},
  // Tasks and Projects.
  list_tasks: tasksRead, list_task_boards: tasksRead, get_task: tasksRead, list_project_agents: tasksRead,
  create_task: tasksWrite, update_task: tasksWrite,
  delegate_task: { actions: [A.delegateTasks] }, get_delegated_run: { actions: [A.delegateTasks] },
  execute_task: { actions: [A.executeTasks] }, start_build: { actions: [A.executeTasks] },
  // Data: tables and records.
  list_tables: { actions: [A.readRecords] }, read_records: { actions: [A.readRecords] },
  create_record: { actions: [A.writeRecords] }, update_record: { actions: [A.writeRecords] }, bulk_create_records: { actions: [A.writeRecords] },
  create_table: { actions: [A.manageData] },
  // Data: pages, canvases and the records they may be.
  list_data: { actions: [A.readDocuments] }, list_items: itemsRead, get_item: itemsRead, list_item_revisions: itemsRead,
  create_item: itemsWrite, update_item: itemsWrite, restore_item_revision: itemsWrite,
  move_item: { actions: [A.manageData] },
  search_data: { anyOf: [A.readRecords, A.readDocuments, A.readTasks] },
  list_data_trash: { actions: [A.manageData] }, trash_data: { actions: [A.manageData] }, restore_data: { actions: [A.manageData] },
  // Apps.
  list_app_drafts: { actions: [A.manageGadgets] }, get_app_draft: { actions: [A.manageGadgets] },
  create_app_draft: { actions: [A.manageGadgets] }, update_app_draft: { actions: [A.manageGadgets] },
  // The web.
  read_url: { actions: [A.browseWeb] }, search_web: { actions: [A.browseWeb] },
  // Schedules.
  create_reminder: { actions: [A.manageSchedules] }, update_reminder: { actions: [A.manageSchedules] },
  list_schedules: { actions: [A.manageSchedules] }, cancel_schedule: { actions: [A.manageSchedules] },
  // Repositories admitted to a chat Run: the service checks Read projects and Use a computer in the Project.
  list_public_project_repositories: {}, inspect_public_project_repository: {},
  list_private_project_repositories: {}, inspect_private_project_repository: {}, read_private_project_file: {},
  // A Task's box and source repository.
  factory_status: computer, generate_image: computer, factory_plan: computer, request_network_window: computer, factory_feedback: computer,
  factory_publish: { actions: [A.proposeCode] }, factory_merge: { actions: [A.proposeCode] },
  read_github_repository: computer, read_github_issue: computer, read_github_pull_request: computer,
  read_code_tree: computer, read_code_file: computer, check_code_proposal: computer,
  publish_code_changes: { actions: [A.proposeCode] },
  // Chat over MCP. The conversation decides the rest, with the channel in hand.
  list_channels: { scope: 'messages:read' }, list_members: { scope: 'messages:read' }, list_roles: { scope: 'messages:read' },
  list_messages: { scope: 'messages:read' }, search_messages: { scope: 'messages:read' }, list_threads: { scope: 'messages:read' },
  send_message: { scope: 'messages:write' }, edit_message: { scope: 'messages:write' }, delete_message: { scope: 'messages:write' },
  react_message: { scope: 'messages:write' }, pin_message: { scope: 'messages:write' }, open_dm: { scope: 'messages:write' },
  complete_run: { scope: 'messages:write', principal: 'agent' },
  // Mail over MCP. The Mailbox grant is checked with the Mailbox in hand.
  list_mailboxes: { scope: 'mail:read' }, list_mail_threads: { scope: 'mail:read' }, read_mail_thread: { scope: 'mail:read' },
  mark_mail_thread_read: { scope: 'mail:write' }, move_mail_thread: { scope: 'mail:write' },
}

/** The rule for a tool: external MCP tools are named by their connection and all need Use external tools. */
export function toolRule(name: string): ToolRule | null {
  if (name.startsWith('mcp_')) return { actions: [A.useExternalTools] }
  return Object.hasOwn(TOOL_RULES, name) ? TOOL_RULES[name]! : null
}

/** The actions a tool may be registered with, so a definition cannot drift from the table. */
export function toolActions(name: string): ServerAction[] {
  const rule = toolRule(name)
  return rule ? [...rule.actions ?? [], ...rule.anyOf ?? []] : []
}

function authorizeAction(auth: AuthorizationContext, action: ServerAction, projectwide: boolean | undefined) {
  try {
    authorize(auth, action)
  } catch (error) {
    const rule = actionRule(action)
    if (!projectwide || !anyProjectPermission(auth, rule.permission)) throw error
    // Granted in some Project: the credential and any delegated action list still apply.
    authorizeMcpCredential(auth, rule.scope)
    if (auth.delegation?.actions && !auth.delegation.actions.includes(action)) throw error
  }
}

function reason(error: unknown): string {
  if (error instanceof AuthorizationError) return error.message
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: { error?: { message?: string } } }).data
    if (data?.error?.message) return data.error.message
  }
  return error instanceof Error ? error.message : 'not permitted'
}

/**
 * The one check every tool call passes, for the principal it acts for: the Agent's own Role, the
 * person it acts for (the delegation a Run or an MCP credential carries), the credential's scopes
 * and the Space boundary of a resource the call names. It refuses with a message the Agent can relay.
 */
export function authorizeToolCall(auth: AuthorizationContext, name: string, resource?: { kind: SpaceDeniedKind; id: string }): void {
  const rule = toolRule(name)
  if (!rule) throw new AuthorizationError(`${name} is not a Server tool, so it cannot be used`)
  try {
    if (rule.principal && auth.principal.kind !== rule.principal) throw new AuthorizationError(`Only an ${rule.principal === 'agent' ? 'Agent' : 'Account'} can call it`)
    if (rule.scope) authorizeMcpCredential(auth, rule.scope)
    for (const action of rule.actions ?? []) authorizeAction(auth, action, rule.projectwide)
    if (rule.anyOf) {
      let refused: unknown = null
      for (const action of rule.anyOf) {
        try { authorize(auth, action); refused = null; break } catch (error) { refused = error }
      }
      if (refused) throw refused
    }
  } catch (error) {
    throw new AuthorizationError(`${name} is not available: ${reason(error)}`)
  }
  // Outside the Space boundary a resource does not exist, rather than being forbidden.
  if (resource && spaceResourceDenied(auth, resource.kind, resource.id)) throw new SpaceBoundaryError()
}
