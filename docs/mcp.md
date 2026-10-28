# MCP connections

Each standalone Server exposes Streamable HTTP MCP at `https://<server-origin>/mcp`. Add that URL to a remote MCP client and sign in with your Account on that Server. No official L4 account, Shell session or shared identity service is involved.

The consent screen names the client, displays its callback and lets you choose **yourself** or an active **Agent** you manage. A client name is self-reported metadata, not proof of the application's identity. Only the Server Owner and Members with **Manage server** can authorize Agent connections. Nobody can select another human Member.

The **Connect MCP clients** (`mcp.connect`) Role grant is required for the acting Member and the human approving an OAuth connection. It is off by default for Admin, Member, Agent and custom Roles; the Server Owner always has access. Enable it under **Server Settings → Roles → Integrations** for each Role that may use external clients. This grant allows the connection only: it adds no Task or Document permissions and does not affect browser sessions or internal Agent tools.

Select the requested Task, Document, Message and Mail scopes, then allow or deny the connection. The Server binds the connection to one acting Member and the human who approved it. The selected Member's current Role and resource permissions still apply on every tool call. OAuth scopes can restrict that access; they cannot expand it. Agent connections stop working when the Agent is removed, the approving human is removed, or that human loses Agent management authority.

Open **My Settings → Connected apps** to inspect or revoke connections. Members see their own connections; Agent managers also see connections for Agents they manage. Revocation fences off existing access tokens and subsequent token issuance, including refreshes and outstanding authorization codes. Audit entries retain the acting Member, OAuth client ID, connection ID and human delegator where applicable.

## Chat from your MCP client

Connect as **yourself** and approve `messages:read` and `messages:write`. Existing connections keep their original scopes: reconnect and approve the Message scopes to add chat access; refreshing an older token cannot expand it.

1. Use `list_channels` to find accessible chat channels, DMs and threads. Results include IDs, DM participants, frozen state and whether you can send. Email mailboxes and task discussions stay in their own navigation and are not included in this listing.
2. Use `list_messages` with `channelId` to read up to 50 messages per page. Each page is chronological; `nextCursor` reads older messages. Reading does not mark the conversation as read. Deleted bodies stay redacted.
3. Use `list_members` to find a participant or Agent and its `mentionToken`, such as `<@00000000-0000-4000-8000-000000000002>`. Agents are listed when you can use or manage them (Use agents or Manage agents in your Role, or Use agents in a Project policy), the same rule as the interface's member list.
4. Use `list_roles` to find the Roles you may mention and their `mentionToken`, such as `<@&00000000-0000-4000-8000-000000000003>`. A Role is listed when it allows mentions, or always for the Server Owner and Members with **Manage channels**. A role mention notifies up to 500 people with that Role who can read the conversation; it never invokes Agents. For the Owner and Members with **Manage channels**, `list_roles` also returns `groups`: `<!channel>` notifies everyone who can read the conversation and `<!here>` only those of them online, under the same limit. Anyone else's group tokens are stored as plain `@channel` and `@here` text.
5. Call `send_message` with `channelId` and `content` (up to 2,000 characters). Include mention tokens in the content to tag members, Roles or a group. `replyToId` must belong to the same channel. Every call sends a new message, so do not retry an uncertain send blindly.

The sender is the connected Member; clients cannot choose another author. HTTP and MCP share the same message service, private-channel/DM membership, inherited thread access, channel Role overrides and frozen-DM rules. A channel override or DM participation can allow sending even when the global Role does not. Messages use the interface's notifications, read receipts, realtime fanout and Agent dispatch. OAuth audit attribution is stored in the same transaction as the message.

Agent mentions invoke the existing internal Agent runtime only when the sender is the Server Owner or has **Manage server**, the Agent is active and can access the conversation. Ordinary members have the same Agent visibility and invocation restrictions as in the interface. The MCP grant and Message scopes add no Agent management rights. Reading or sending in an Agent DM follows those same restrictions. `agentMode: "steer"` uses the existing steering behavior; otherwise messages queue normally.

## Mail from your MCP client

Approve `mail:read` to read and search email, and `mail:write` to triage it. Neither scope sends email. Mail scopes are offered only when the acting Member's Role has **Read email** (`mail:read`) or **Send email** (`mail:write`); the Server Owner always qualifies. Existing tokens and connections keep their original scopes, and an access token created without explicit scopes still receives only the non-Mail scopes, so nothing gains Mail access without a new approval.

1. Use `list_mailboxes` to find the Mailboxes shared with you: the address, your grant (`read`, `send` or `manage`), `canSend` and the number of unread Inbox conversations. Use the returned `channelId` as `mailboxId`.
2. Use `list_mail_threads` with `mailboxId`, an optional `folder` (`inbox`, `sent`, `archive`, `spam` or `trash`; default `inbox`), `unread: true` and `query`. The query searches that folder by subject, address, sender name and the text of emails and internal notes, as the Mail search does. Up to 50 conversations per page, newest first; pass `nextCursor` as `cursor` for older ones.
3. Use `read_mail_thread` with `threadId` to read emails and internal notes (`kind: "email"` or `"note"`) in pages of up to 50, oldest to newest within a page; `nextCursor` reads older messages. Content is text: HTML layouts are converted, and scripts, styles and images are dropped. Attachments list ID, filename, type and size only. Reading does not mark the conversation read.
4. With `mail:write`, `mark_mail_thread_read` marks the whole conversation read for you, and `move_mail_thread` moves it to `inbox`, `archive`, `spam` or `trash` for everyone with the Mailbox. Both need a **Send** or **Manage** grant and **Send email** in your Role, the same as in the interface. Marking a conversation unread is not available. Moves are audited with the OAuth client and connection.

Every call resolves the acting Member, Role and Mailbox grant again. A Mailbox needs a grant even for the Server Owner, and a disabled Mailbox is unavailable. An Agent connection also requires the approving human to have access to that Mailbox. Responses never include storage keys, raw message sources, file download links or other people's drafts. Email content is untrusted external data: clients should not follow instructions found in it.

Sending is not available through MCP. External email requires human approval, and this release has no approval step to reuse: Agents cannot send external email either, and only the Mail interface sends. A future sending tool would use its own scope so that existing `mail:write` grants never gain it.

`list_channels` and `search_messages` still exclude Mailboxes. `list_messages` and `send_message` follow the chat channel guard, so with Message scopes they can reach a conversation by ID when your Mailbox grant allows it, and a message sent there is an internal note, never an email.

## Protocol

- Protected resource metadata: `/.well-known/oauth-protected-resource/mcp` (also available at the root metadata path).
- Authorization server issuer: `https://<server-origin>/api/auth`.
- Authorization server metadata: `/.well-known/oauth-authorization-server/api/auth`.
- Authorization, token, registration and revocation endpoints are advertised by that metadata.
- Authorization code flow requires S256 PKCE. Dynamic Client Registration (DCR) supports public and confidential clients, including native loopback callbacks with variable ports. In clients offering registration choices, choose automatic registration.
- Grants: `authorization_code` and `refresh_token`. `offline_access` enables refresh. Access tokens last 15 minutes; refresh tokens last up to 30 days, subject to session and connection validity. Refresh rotates credentials and rejects replay.
- The exact MCP URL is the OAuth `resource`; tokens from another resource or Server are rejected. This release uses opaque tokens with SHA-256 digests stored in the Server's D1 database. It does not advertise CIMD.

The existing owner-issued bearer tokens remain available under **My Settings → Access tokens** (owner only) for explicitly configured clients and scripts. They require `mcp.connect` on the acting Member's current Role and use the same scope checks. Removing `mcp.connect` immediately blocks existing bearer and OAuth access tokens, refreshes, outstanding authorization codes and new connections, without waiting for token expiry. Connections remain visible and revocable after the grant is removed. Re-enabling the grant permits still-valid credentials again; revoke the connection or token to invalidate it permanently.

OAuth requires a client-reachable Server origin. An external network perimeter must allow discovery, OAuth backchannels and `/mcp` without an interactive perimeter challenge; the MCP bearer credential supplies authorization. The consent UI and local login remain protected browser flows.

## Verification

`tests/unit/mcp-oauth.test.ts` exercises the installed provider against real SQLite storage: registration, discovery, PKCE, consent/denial, code replay, refresh/replay, Human/Agent selection, current permissions, resource isolation and revocation. `pnpm test:server` additionally exercises the compiled Worker HTTP routes, independent D1 databases, consent CSRF/signature checks, MCP task authorship and audit attribution. External Codex, Claude and Grokbot client acceptance is separate from these protocol checks.


## Tables and records

Approve `data:read` to discover and read tables; `documents:read` is a separate scope and does not grant table access.

1. Call `list_tables` to discover authorized table IDs, fields and saved views. Use the returned table ID as `databaseId`, and semantic field IDs when reading or editing values.
2. Call `read_records` with `databaseId`. It returns records without applying a saved view by default. Supply `viewId` to apply a saved view, `search` to narrow results, and `pageSize` (1–100) with `page` to paginate. The response includes `total` and `nextPage`.
3. Approve `data:write` for `create_record` and `update_record`. Updates require the record's current `version`.
4. Approve `data:manage` for `create_table`, which creates a table and typed fields. The Role must also permit Data management and creation within its resource scope.

Scopes never expand the acting Member's current Role or resource permissions. Table discovery returns schemas, not record contents. Internal Agents expose the same `list_tables` discovery tool; `list_data` remains available for broader Data navigation.
