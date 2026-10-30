# Grants and Agent access

Accepted on 2026-10-30.

## Problem

Humans and Agents work together on one Server. An Agent's Role can be much broader than the Role of the person who asks it for something. Until now every Run used the intersection of both: the Agent worked no higher than the person who invoked it. That is safe, but a person could not use a capable Agent for work they are not allowed to do themselves, even when someone with that authority wanted them to. The opposite rule — the Agent always works with its full Role — would let anyone who can write to an Agent use every permission it has.

Scoped access was also spread over separate mechanisms: Role permission masks and resource lists, Project policy assignments, Mailbox access, channel overrides and Gadget access. Each had its own shape, so a cross-cutting rule had to be built into every one of them.

## Decision

**A Grant gives one subject a Policy on a scope.** It is one row in `grants`: a Member or a Role, a Policy, a Project or the whole Server, who created it and when. Project policy assignments are Grants without an Agent. They moved into this table unchanged (migration `0004_grants`), keeping their IDs so saved Run ceilings still match.

**Agent access is a Grant with an Agent.** It reads: "this person or role may use this Agent with this Policy, here". It may carry a daily Run limit and an expiry. A Server-wide Grant exists only as Agent access; direct Server-wide permissions remain a Role.

The authority of a Run is:

> Agent's Role ∩ (initiating person's own authority ∪ their Agent access for this Agent)

- **Default is unchanged.** Without Agent access the Agent works no higher than the person who asks.
- **The Agent's Role is the ceiling.** Agent access never lifts the Agent above its own Role, and the Owner cannot either.
- **No laundering.** Only someone who holds every permission of the Policy in that scope can grant it: Manage roles for the whole Server, Manage projects for one Project, plus Manage agents and the Agent's role hierarchy. No one can grant access to themselves.
- **Per Project.** Project Agent access is kept with its Project, like project assignments. Its permissions never apply in another Project.
- **Revocable.** Every Run rechecks its saved ceiling against current Grants at each step. Removing, expiring or narrowing access, archiving the Project or lowering the Agent's Role stops Runs that relied on it.
- **Delegation only narrows.** A subtask started by a coordinating Agent runs under the parent Run's ceiling. The human's Agent access for the receiving Agent does not widen it.

**Who an Agent answers.** Each Agent is either *open* — anyone with Use agents may invoke it, limited as above — or *granted* — only the Owner and holders of Agent access may invoke it. A mention from anyone else does not wake a granted Agent; it does not reply. Restricting an Agent needs Manage agents; opening it needs Manage roles as well.

Example: Mike's Role can merge. Petya holds Developer access to Mike in Project A, Vanya holds Reviewer access, Kolya and Katya hold none. With Mike set to *granted*, Petya gets Developer work in Project A, Vanya gets review, and Mike ignores Kolya and Katya.

## Consequences

- One evaluation path covers every Run a person starts — mentions, DMs, Tasks, Schedules and retries: `loadAuthorizationContext` adds the initiator's Agent access to the delegation, and `runAuthorization` revalidates it on every step.
- **Existing Servers** apply `0004_grants` on their next update. Project assignments keep their IDs and every Agent starts *open*, so nothing changes until someone gives access or restricts an Agent. An update applies migrations before uploading the new code; during that window a read-only `project_policy_assignments` view keeps the previous release's authorization working, while its project-access edits fail. A later migration drops the view.
- Mailbox access, channel overrides and Gadget access still use their own tables. They move into `grants` in later migrations, one resource kind at a time, with a scope column per kind so foreign keys keep removing Grants with their resource.
- External MCP tokens that an Agent holds are unchanged: they act as the Agent within its creator's authority. Agent access applies to Runs a person starts.
- Merge and release remain outside Agent permissions until they exist as Policy permissions; when they do, Agent access is how a person gets an Agent to merge for them.
