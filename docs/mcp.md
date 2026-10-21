# MCP connections

Each standalone Server exposes Streamable HTTP MCP at `https://<server-origin>/mcp`. Add that URL to a remote MCP client and sign in with your Account on that Server. No official L4 account, Shell session or shared identity service is involved.

The consent screen names the client, displays its callback and lets you choose **yourself** or an active **Agent** you manage. A client name is self-reported metadata, not proof of the application's identity. Only the Server Owner and Members with **Manage server** can authorize Agent connections. Nobody can select another human Member.

The **Connect MCP clients** (`mcp.connect`) Role grant is required for the acting Member and the human approving an OAuth connection. It is off by default for Admin, Member, Agent and custom Roles; the Server Owner always has access. Enable it under **Server Settings → Roles → Integrations** for each Role that may use external clients. This grant allows the connection only: it adds no Task or Document permissions and does not affect browser sessions or internal Agent tools.

Select the requested Task, Document and Message scopes, then allow or deny the connection. The Server binds the connection to one acting Member and the human who approved it. The selected Member's current Role and resource permissions still apply on every tool call. OAuth scopes can restrict that access; they cannot expand it. Agent connections stop working when the Agent is removed, the approving human is removed, or that human loses Agent management authority.

Open **My Settings → Connected apps** to inspect or revoke connections. Members see their own connections; Agent managers also see connections for Agents they manage. Revocation fences off existing access tokens and subsequent token issuance, including refreshes and outstanding authorization codes. Audit entries retain the acting Member, OAuth client ID, connection ID and human delegator where applicable.

## Chat from your MCP client

Connect as **yourself** and approve `messages:read` and `messages:write`. Existing connections keep their original scopes: reconnect and approve the Message scopes to add chat access; refreshing an older token cannot expand it.

1. Use `list_channels` to find accessible chat channels, DMs and threads. Results include IDs, DM participants, frozen state and whether you can send. Email mailboxes and task discussions stay in their own navigation and are not included in this listing.
2. Use `list_messages` with `channelId` to read up to 50 messages per page. Each page is chronological; `nextCursor` reads older messages. Reading does not mark the conversation as read. Deleted bodies stay redacted.
3. Use `list_members` to find a participant or Agent and its `mentionToken`, such as `<@00000000-0000-4000-8000-000000000002>`.
4. Call `send_message` with `channelId` and `content` (up to 2,000 characters). Include mention tokens in the content to tag members. `replyToId` must belong to the same channel. Every call sends a new message, so do not retry an uncertain send blindly.

The sender is the connected Member; clients cannot choose another author. HTTP and MCP share the same message service, private-channel/DM membership, inherited thread access, channel Role overrides and frozen-DM rules. A channel override or DM participation can allow sending even when the global Role does not. Messages use the interface's notifications, read receipts, realtime fanout and Agent dispatch. OAuth audit attribution is stored in the same transaction as the message.

Agent mentions invoke the existing internal Agent runtime only when the sender is the Server Owner or has **Manage server**, the Agent is active and can access the conversation. Ordinary members have the same Agent visibility and invocation restrictions as in the interface. The MCP grant and Message scopes add no Agent management rights. Reading or sending in an Agent DM follows those same restrictions. `agentMode: "steer"` uses the existing steering behavior; otherwise messages queue normally.

## Protocol

- Protected resource metadata: `/.well-known/oauth-protected-resource/mcp` (also available at the root metadata path).
- Authorization server issuer: `https://<server-origin>/api/auth`.
- Authorization server metadata: `/.well-known/oauth-authorization-server/api/auth`.
- Authorization, token, registration and revocation endpoints are advertised by that metadata.
- Authorization code flow requires S256 PKCE. Dynamic Client Registration (DCR) supports public and confidential clients, including native loopback callbacks with variable ports. In clients offering registration choices, choose automatic registration.
- Grants: `authorization_code` and `refresh_token`. `offline_access` enables refresh. Access tokens last 15 minutes; refresh tokens last up to 30 days, subject to session and connection validity. Refresh rotates credentials and rejects replay.
- The exact MCP URL is the OAuth `resource`; tokens from another resource or Server are rejected. This release uses opaque tokens with SHA-256 digests stored in the Server's D1 database. It does not advertise CIMD.

The existing owner-issued bearer tokens remain available under **Server Settings → MCP** for explicitly configured clients and scripts. They require `mcp.connect` on the acting Member's current Role and use the same scope checks. Removing `mcp.connect` immediately blocks existing bearer and OAuth access tokens, refreshes, outstanding authorization codes and new connections, without waiting for token expiry. Connections remain visible and revocable after the grant is removed. Re-enabling the grant permits still-valid credentials again; revoke the connection or token to invalidate it permanently.

OAuth requires a client-reachable Server origin. An external network perimeter must allow discovery, OAuth backchannels and `/mcp` without an interactive perimeter challenge; the MCP bearer credential supplies authorization. The consent UI and local login remain protected browser flows.

## Verification

`tests/unit/mcp-oauth.test.ts` exercises the installed provider against real SQLite storage: registration, discovery, PKCE, consent/denial, code replay, refresh/replay, Human/Agent selection, current permissions, resource isolation and revocation. `pnpm test:server` additionally exercises the compiled Worker HTTP routes, independent D1 databases, consent CSRF/signature checks, MCP task authorship and audit attribution. External Codex, Claude and Grokbot client acceptance is separate from these protocol checks.
