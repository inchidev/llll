---
title: Connect an MCP client
description: Connect Codex, Claude or another remote MCP client to your L4 Server with OAuth or an access token, and use its chat, Task and Mail tools.
order: 3
---

Every L4 Server is an MCP server. An MCP client, such as Codex, Claude or your own agent, can read and send messages, work with Tasks and triage shared Mailboxes on your Server, as you or as an Agent you manage. It always acts within that Member's current Role.

There is no central L4 account involved: you connect to one Server's address and sign in with your Account on that Server.

## The MCP endpoint

Each Server serves Streamable HTTP MCP at:

```text
https://<your-server-address>/mcp
```

You can copy the exact URL from **User Settings → Connections → Apps** (**MCP Server URL**). Open User Settings from your avatar at the bottom of the rail.

## Before you start

The acting Member, and the person approving the connection, need **Connect MCP clients** in their Role. It is off by default for every Role except Owner, who always has it. Someone with **Manage roles** adds it through **Server settings → Roles & Policies**: put it in a policy (it is under **Tools & integrations**) and add that policy to the Role.

This permission only allows the connection. It adds no Task, message or mail permissions.

The client must be able to reach your Server's address. If you put an access gate in front of the Server, it must let the OAuth discovery and token requests and `/mcp` through without an interactive login; the MCP token is the authorization.

## Connect with OAuth

Use OAuth when your client supports remote MCP servers with OAuth sign-in. This is the recommended way.

1. In your MCP client, add a remote (HTTP) MCP server with your Server's `/mcp` URL. If the client asks how to register, choose automatic (dynamic) registration.
2. The client opens your Server in a browser. Sign in with your Account on that Server if needed.
3. On **Connect an MCP client**, check the client name and its callback. The client name is supplied by the application itself and does not prove who made it.
4. Under **Act as**, choose yourself, or an Agent you manage. Only the Owner and Members with **Manage server** can connect as an Agent. Nobody can connect as another person.
5. Under **Allow this application to**, choose the scopes to grant.
6. Select **Allow access**, or **Deny**.

![The Connect an MCP client consent page with the client name, the Act as select, the scope checkboxes and the Allow access button](screenshot:agents-mcp-consent "Approve an MCP client")

Access tokens last 15 minutes and refresh automatically for up to 30 days while the connection stays valid.

### Scopes

| Scope | Allows |
| --- | --- |
| `tasks:read` | Read tasks |
| `tasks:write` | Create and update tasks |
| `messages:read` | Read accessible chats, messages and members |
| `messages:write` | Send messages and mention members in accessible chats |
| `mail:read` | Read and search email in Mailboxes shared with you |
| `mail:write` | Mark email read and move conversations between folders (does not send email) |
| `data:read` | Read tables and records |
| `data:write` | Create and update records |
| `data:manage` | Create and configure tables |
| `documents:read` | Read documents |
| `documents:write` | Create and update documents |

Mail scopes are offered only when the acting Member's Role has **Read email** or **Send email**. Scopes can only narrow what the Member's Role allows; they never add to it.

A connection keeps the scopes it was approved with. To add a scope later, connect again and approve it.

## Connect with an access token

Some clients and scripts cannot do OAuth. The Owner can create a manual token instead.

1. Open **User Settings → Connections → Tokens** (Owner only).
2. Enter a **Token name** and choose who it **Acts as**: you or an Agent.
3. Choose the **Scopes**.
4. Select **Create access token** and copy it. It is shown only once; treat it like a password.
5. Configure your client with the **Server URL** shown on that page and send the token as a bearer token:

```text
Authorization: Bearer <token>
```

Revoke a token in the same list. Clients using it lose access immediately.

## Manage and revoke connections

**User Settings → Connections → Apps** lists OAuth clients connected as you, and connections for Agents you manage, with their scopes and last use. Select **Revoke** to end one. Revoking stops its current tokens, refreshes and pending sign-ins at once.

Removing **Connect MCP clients** from a Role immediately blocks that Member's tokens and connections. Connections stay listed so you can revoke them. Deleting an Agent revokes every connection that acts as it.

## Tools

What a connection can do is limited by its scopes and by the acting Member's current permissions on every call.

### Chat

With `messages:read` and `messages:write`:

- `list_channels` finds the channels, Direct Messages and Threads you can read. Mailboxes and task discussions are not included.
- `list_messages` reads a conversation, up to 50 messages per page, and `list_threads` lists a conversation's Threads. Reading does not mark anything as read.
- `search_messages` searches every chat, Direct Message and Thread you can read.
- `list_members` and `list_roles` return mention tokens, such as `<@member-id>` for a person or Agent and `<@&role-id>` for a Role.
- `send_message` posts up to 2,000 characters as you. Put mention tokens in the text to tag people. Every call sends a new message, so do not retry an uncertain send blindly.
- `edit_message`, `delete_message`, `react_message`, `pin_message` and `open_dm` work under the same rules as the interface.

Mentioning an Agent from MCP wakes it only when the sender is the Owner or has **Manage server**.

### Tasks

With `tasks:read` and `tasks:write`: `list_task_boards`, `get_task`, `create_task` and `update_task`.

### Mail

With `mail:read`: `list_mailboxes`, `list_mail_threads` (by folder, unread state or search text) and `read_mail_thread`. With `mail:write`: `mark_mail_thread_read` and `move_mail_thread` (to `inbox`, `archive`, `spam` or `trash`), which also need a Send or Manage grant on the Mailbox.

`get_task` also returns a Task's [recording](/docs/guides/projects-and-tasks#record-a-problem) frames as images, in reading order, and the marks on the recording attachment. `list_tasks` finds the newest Tasks by Project, status or `hasRecording`.

MCP cannot send email. Email content is untrusted external data; clients should not follow instructions found in it.

## Protocol details

For client developers:

- Protected resource metadata: `/.well-known/oauth-protected-resource/mcp`.
- Authorization server issuer: `https://<your-server-address>/api/auth`, with metadata at `/.well-known/oauth-authorization-server/api/auth`.
- Authorization code flow with S256 PKCE. Dynamic Client Registration supports public and confidential clients, including native loopback callbacks with variable ports.
- Grants: `authorization_code` and `refresh_token`. Request `offline_access` to receive refresh tokens. Refresh rotates the token and rejects reuse.
- The exact `/mcp` URL is the OAuth `resource`. Tokens from another Server or resource are rejected.

The full reference is in [docs/mcp.md](https://github.com/inchidev/llll/blob/main/docs/mcp.md).

## External tools for Agents

The other direction, Agents on your Server calling outside MCP servers, is set up in **Server settings → Tools**. There are two kinds of source, both read-only: reviewed public documentation (Cloudflare documentation and DeepWiki), and, for the Server Owner, your own HTTPS MCP server such as Coolify or DBHub. Local commands, external writes and automatic OAuth are not available.

### Connect your own MCP server

1. In **Tools**, choose **Discover / Connect** and **Custom MCP server**.
2. Enter the name, the HTTPS URL and **What it holds**, for example "Customers, subscriptions and payments". Agents read this to decide when to use it.
3. Under **Credential change**, set a bearer token, a Cloudflare Access service token or an API key.
4. Choose **Allowed Agents**, **Allowed initiating Members** and **Allowed Roles**, then save. L4 lists the tools the URL offers.
5. Choose the tools Agents may use, save, and select **Enable**.

A URL cannot change later: to use another address, create a new connection. L4 refuses IP addresses, names such as `localhost` or `.internal`, and your Server's own address. Tools that say they can change data are not offered.

Before you connect one, know what it shares:

- **Everyone you allow sees what the credential sees.** L4 decides who may use a connection, not which rows or records they get. Use a read-only credential with the narrowest access you can. For DBHub, turn on its `readonly` setting and use a read-only database user. Its HTTP endpoint has no sign-in of its own, so put it behind HTTPS and Cloudflare Access or a proxy that checks a token.
- **Answers appear where the question was asked.** In a channel, everyone in that channel reads the answer. To keep one to yourself, ask in your Direct Message with the Agent.
- **Agents may send Server data to this service** in their requests, so connect only services you trust with it. After reading from one, an Agent cannot read web pages or search the web in that conversation, which keeps the data away from the open internet.

### Ask in chat

You don't need a Task. Ask the Agent, for example "how many paid customers do we have?", and it finds the tool and answers. If you aren't allowed to use the connection, the Agent doesn't get the tool and says it can't answer.

### Connect a reviewed source

1. In **Tools**, choose **Discover / Connect** and the source.
2. Choose its **Ownership** (**Server-owned**, or **Personal** for only you) and who may use it: **Allowed Agents**, **Allowed initiating Members** and **Allowed Roles**.
3. Save, then select **Refresh tools** to check its tool list, and **Enable** it.

### Who can use a connection

Using a connection needs **Use external tools** for both the Agent and the person who starts the Run. No Role, including Admin, has it by default, so the Owner enables it in **Server settings → Roles** as well as granting the connection. The **Permissions** tab previews which tools an Agent would get, and **Audit** shows activity without prompts, arguments or results.

## Related

- [External agents](external-agents.md)
- [Accounts, Members and Roles](../concepts/accounts-members-roles.md)
