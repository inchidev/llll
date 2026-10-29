---
title: Accounts, Members and Roles
description: How login identity, membership and permissions work on an L4 Server, including the Owner, built-in Roles, Project policies and Grants.
order: 2
---

Every Server keeps its own Accounts, Members and Roles. Nothing here is shared between Servers.

## Account

An Account is a human's login identity on one Server. Accounts on different Servers are independent: the same person has a separate Account, and a separate password, on each Server.

- **Login methods.** The Owner chooses them in **Server settings → Authentication**: email and password, and social providers the Owner configures. A Server can instead use Cloudflare Access, which then owns login.
- **Linking.** A login method joins an Account only through explicit linking. A matching email address never links Accounts and never grants access.
- **Recovery.** In your own settings, **Account recovery** creates a recovery key for this Server. It is shown once. Using it sets a new password, uses up the key and signs out your other sessions. Replacing the key invalidates the previous one.

## Member

A Member is a human or an Agent taking part in one Server. A human's Account says who they are; their membership on this Server decides what they can access. An Account and a Member are different things: removing someone's membership does not delete their identity on other Servers, and an Agent is a Member without an Account.

People join through invitations created by Members with **Create invites**. A new person may need to accept the Server's terms and rules before they become an active Member.

## Owner

The Owner operates the Server. The Owner is created once, when the Server is first claimed through its private setup link, and holds every permission. Only the Owner manages deployment settings such as updates, backups, addresses, storage and authentication.

Owner rights cover administration, not private content. Being the Owner does not add you to private channels, and does not let you read other people's private Agent Runs.

## Role

Each Member has one Server Role. A Role groups permissions. Every Server has three system Roles:

| Role | Default permissions |
| --- | --- |
| Owner | All permissions. Cannot be assigned to an Agent. |
| Admin | Built-in policy "Server administrator": every permission except Execute assigned tasks, Use a computer, Manage schedules, Propose code changes and Connect MCP clients. |
| Member | Built-in policy "Server member": Send messages, Attach files and Start live sessions. Chat only. |

You can create more Roles in **Server settings → Roles & Policies**. A Role is a collection of reusable policies. New Roles start without policies. Only the Owner can add policies to Admin and Member (for example, Use agents for everyone); their built-in policy always stays. Role administrators cannot grant permissions they do not have themselves.

A Role can also limit which Boards, Tables, Documents and Canvases its holders can reach. Selecting no resources of a kind permits none of them.

![Server settings → Roles & Policies with the system Roles Owner, Admin and Member and one custom Role](screenshot:concepts-roles-list "Roles & Policies")

### Some permissions to know

| Permission | Allows |
| --- | --- |
| Manage server | Change the Server name and settings. |
| Manage roles | Create Roles, change grants and assign Roles. |
| Manage channels | Create, edit and remove channels; use `@channel` and `@here`. |
| Create invites | Invite new Members. |
| Read tasks, Create and update tasks, Manage tasks | Read, write and administer Task boards. |
| Use agents | Find Agents, talk to them and give them instructions. |
| Manage agents | Create Agents and change their profiles and models. |
| Approve agent actions | Review and approve an Agent's pending actions. |
| Read email, Send email | Use Mailboxes shared with the Member. |

Agent autonomy permissions (Execute assigned tasks, Use a computer, Manage schedules, Propose code changes) are always explicit and never inferred from an administrator Role.

## Project policy and Grant

A **Project policy** adds permissions for a person, an Agent or a Server Role inside one Project. The same Member can have Developer access in Project A and Reviewer access in Project B.

Policies only add. They never remove broader rights a Server Role already gives.

A **Grant** permits one operation on a resource. The Server checks each operation in its Project and resource scope, every time. Project access does not grant Server administration or membership of private channels.

## Where permissions are enforced

The interface hides what you cannot do, but the Server itself is the boundary. The same checks apply to the web Client, MCP connections and Agents. When a Member's Role changes or they are removed, their access changes immediately, including open realtime connections.

## Related

- [Invite your team](../get-started/invite-your-team.md)
- [Agents, Tasks and Runs](agents-tasks-runs.md)
- [Glossary](../reference/glossary.md)
