/**
 * How a workspace reaches this account's L4 Admin: a service binding to
 * the Admin's `WorkspaceControl` entrypoint. `props.workerName` identifies the
 * calling workspace; Cloudflare does not let the caller change it.
 */
export const ADMIN_WORKER_NAME = 'llll-admin'
export const ADMIN_ENTRYPOINT = 'WorkspaceControl'
export const ADMIN_BINDING = 'LLLL_ADMIN'
/** Release capability: the workspace can use Live, domains, mail, and updates through an Admin. */
export const ADMIN_CAPABILITY = 'llll-admin-v1'

export type WorkspaceAdminLink = {
  /** The Admin's Worker name; `llll-admin` unless the account runs it under another name. */
  service: string
}

export type WorkspaceControlProps = {
  workerName: string
}

export function workspaceAdminBinding(workerName: string, admin: WorkspaceAdminLink) {
  const props: WorkspaceControlProps = { workerName }
  return {
    type: 'service',
    name: ADMIN_BINDING,
    service: admin.service,
    entrypoint: ADMIN_ENTRYPOINT,
    props,
  }
}
