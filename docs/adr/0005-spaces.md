# Spaces

Accepted on 2026-11-03.

## Problem

People in one department should see only their own things. Everything on a Server was visible to every Member subject to permissions, and the Role, Project policy and Grant model [only adds access](0004-grants-and-agent-access.md), so it cannot draw a boundary. A Project is too small for one: a department has many Projects, and Channels, Mailboxes, Data, Apps and Agents are not tied to a Project at all. An earlier idea of a Role setting "sees only own Projects" is superseded by this decision.

## Decision

**Server > Space > resources.** Accounts, Roles, domain, backups, Providers and Compute stay at the Server. Each Project, Channel, DM, Mailbox, Database, Document, Canvas, App, external MCP connection, Git execution configuration and Agent belongs to exactly one Space. Children inherit: Threads by database trigger, Tasks through their Board, Runs and Schedules through their channel, records through their Database, files through their channel or Task.

**The Space check runs before all permissions.** Access is Space membership and then the permission. The Owner has no bypass. Grants and Policies are unchanged inside a Space.

**A boundary on the authority, not on each query.** `loadSpaceBoundary` puts `spaces` on the `AuthorizationContext`: the reachable Space IDs, and the IDs of resources elsewhere. For a Run or a delegated token it is what both the Agent and the person reach, so a person from another Space gets nothing through an Agent. `resourceAllowed` and `projectPermissionAllowed` refuse what the boundary excludes before they look at any permission, and `requireChannelAccessForMember` compares the channel's Space. Those existing choke points already serve HTTP, MCP and Agent tools, which is why they are covered together. A Server with one Space loads one extra statement per request and excludes nothing. Every place that builds a context loads a boundary. One without it lists only the default Space and is not refused by the ID lists, so a new loader must load it too.

**Every API route declares itself.** `server/utils/route-policy.ts` has one entry per file under `server/api`, naming its action and how it relates to a Space: `space` (a resource in the URL), `active` (lists or creates in the request's Space), `member`, `server`, `account` or `unscoped`. A test fails on any route without an entry, and on a content path classified outside a Space. `server/middleware/02-spaces.ts` enforces it before the handler: a resource in a foreign Space answers 404, the same as a missing one, and the action's rate limit is counted. Handlers keep their permission checks.

**One Space per request.** The Client sends its active Space in a header on every API call, and so can an MCP client. A `space` route uses the resource's own Space instead, so a link into another of the Member's Spaces still opens. A request with one Space cannot combine resources across Spaces, and someone in several Spaces with none chosen cannot create anything: guessing could publish one department's work to another.

**Limits are three separate mechanisms.** Permissions say who may. Quotas per Space say how much: storage, people, Agents, Runs and emails per month. Monthly counts live in `space_usage` and move atomically, because their records can be deleted; the others are recounted, and only for a Space with a limit. Rate limits per action and Member use the existing limiter, with defaults a Space's Owner can override.

**Membership.** A person can belong to several Spaces. An Agent belongs to one, because what it knows must not cross. A database trigger joins each newly active Member to the default Space unless the same batch places them elsewhere, as an invitation to another Space does, and ends every membership on removal from the Server. Leaving a Space removes the person's private channels and Grants there. A pair has one DM per Space, so leaving a Space does not reopen its history elsewhere.

**Administration.** A Space admin gets a fixed set of permissions (`SpaceAdminPermissions`), only on a request the route policy scoped to their Space. The Owner can manage any Space's members, limits and deletion but reads contents only after joining, and `space.join` goes in the audit log. A Space that holds work cannot be deleted, and neither can the default Space. The Owner's table of Spaces in Server settings shows counts from `space_stats`, a snapshot at most a few minutes old, so that sorting many Spaces reads no Tasks or messages, and never contents. The Owner can suspend a Space other than the default one: through the boundary, the route gate and held sockets its people lose reach by every path, and nothing in it is lost.

## Consequences

- **Small teams see no change.** Everything starts in the default Space, with every active Member in it. The switcher appears only once a viewer has a second Space.
- **Provider and Compute stay Server-level**, with Run counts limited per Space.
- **The Owner's two exceptions.** The Server audit log shows the Owner that something happened in every Space, with its details withheld until they join. A Server backup holds the whole database, so whoever downloads one can read every Space outside the product. It is recorded as `backup.download`, and it is the operator's recovery duty, not a way around joining.
- **Open registration joins the default Space.** On a Server with open registration or Cloudflare Access anyone admitted is in the default Space, even if they arrive through an invitation elsewhere. To keep a contractor out of it, use invite-only registration or remove them from the default Space.
- **Names stay Server-wide.** A display name that is already taken gets refused whichever Space holds it, which reveals no content. Task numbers count per Space.
- **Not a security boundary between hostile tenants.** One database, one `AUTH_SECRET` and one set of operators serve every Space. Spaces separate departments of one organization. Between tenants the boundary is a Server: see [ADR 0009](0008-server-per-tenant.md). Billing and AgentShots are out of scope here.
- **`space_id` columns have no foreign key**, because SQLite cannot add one with a non-null default. The application refuses to delete a Space that holds resources, and a test fails on any insert into a Space-owned table that does not name the Space.
- **Server-wide refresh signals.** `channels.changed`, `tasks.changed` and `members.changed` reach every connected Member. They carry opaque IDs and no content, and the refetch they cause is filtered.
- **Moving existing resources between Spaces is not built yet.** Existing content stays in the default Space until it is. Moving a Project also has to move Boards holding its Tasks, and a Database has to bring its relations and Apps, so it needs its own design.
