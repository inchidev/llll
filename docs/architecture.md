# Runtime architecture

The root Nuxt/Nitro Worker is **one server**. `apps/instance` is a separate Worker with its own control D1. `apps/site` serves the independently deployed landing, iframe shell and OAuth installer; `apps/client` redirects the previous entry point to that shell. These are artifacts of one repository, not forks.

An installation introduces identities to a server with a 30-second HS256 assertion scoped to issuer and server ID, using a distinct pairing key per server. The server verifies that assertion and retains its own roles, onboarding and removals. It never accepts an installation's credential directly as a local administrator login. The gateway rechecks installation sessions and membership for every HTTP request. Files use short-lived, read-only grants with the same session/membership recheck.

WebSocket tickets are server-local and consumed at authentication. Installation-issued tickets additionally recheck their originating session with the installation before authentication. Already authenticated sockets follow the server's existing lifecycle; logout does not promise immediate remote closure of every existing socket. Do not log tickets, signed Telegram launches or bearer tokens.

The installation’s own client connects to `/s/:serverId/api/...` and `/s/:serverId/ws/...` on its own origin. The official shell embeds that client; it never calls these content APIs. The gateway uses a service binding where configured, or a pinned server origin. Embedding parents are an explicit CSP allowlist; bridge messages verify both origin and source window. Content authentication remains local to the installation. HTTP origins are only allowed for local development or operator-pinned private celld services.

The SPA stores connection metadata in local storage and connection credentials in session storage or installation cookies. Private draft and navigation state is scoped by installation, server and account. The service worker caches the static app shell and immutable assets; API, authentication and server routes are excluded. Updates wait for an explicit reload.

Each server owns D1, FILES R2, TICKETS KV and all its DO namespaces. Cloudflare provisioning uses unique resource names. celld Compose uses a separate fleet bucket and process per server, plus a separate installation fleet. Its filesystem/S3 operator must protect configuration and fleet credentials.

## Inherited server runtime details

The following invariants apply within each server. References to “workspace” in this implementation mean the single server described above.

## Rules

1. Live path ≠ storage path. A Channel DO serializes writes, persists to D1, then broadcasts.
2. D1 is history source of truth for messages, channel read cursors, users, access control, and owner-managed integration settings. RealtimeKit API tokens saved in Workspace Settings are AES-GCM encrypted with `AUTH_SECRET`; deployment credentials override them. Recorded audio is an ordinary Message Attachment stored in R2; it does not use RealtimeKit. File reads remain authenticated, and audio seeking uses single byte-range responses.
   User-created Databases, Documents, and Canvases are logical resources in this same D1, not separately provisioned Cloudflare databases. Database Fields allocate from bounded typed columns on `database_items`; APIs expose Field ids and types, never physical slot names. Shared Database Views store validated semantic Field references and the Worker compiles them into bound, paginated D1 queries. Private Data Bookmarks belong to one User. Documents store rich text, while Canvases keep positioned Items and Connections in normalized tables. Versions provide optimistic concurrency. Durable Objects are not the source of truth for Data resources.
3. Workspace DO owns ephemeral presence and recipient-targeted unread signals. It derives online/idle state from visible WebSocket attachments, honors each client's activity-visibility preference, and fans out only message/read identifiers to authorized user sockets; presence and unread truth remain in D1, never on `users` or DO storage.
4. One Channel DO named `channel:<channelId>` and one Workspace DO named `workspace:main`. Typing is scoped to a Channel DO.
5. Every Channel and Direct Message owns exactly one Live room; there are no separate voice Channels. Threads use their parent's room and Mailboxes have none. The Channel DO owns the room: it serializes start and join so a room has at most one RealtimeKit meeting, issues each participant token with the host or participant preset, tracks presence by heartbeat, and closes an empty room after a grace period. Starting a room follows the `startLive` grant in Channels and Direct Messages; joining needs only access to the conversation. Hosts are the person who started the room and, in workspace Channels, members who can manage it; both people in a 1:1 Call are hosts. When someone loses access to a conversation, the room removes them from the media session and revokes their token. A 1:1 Direct Message presents the room as a ringing Call that times out or can be declined; other conversations announce it once and let people drop in. Scheduling is deferred until L4 has a calendar; `channels.live_meeting_id` stores the active meeting. RealtimeKit is only the audio/video/screen-share media plane: media never transits the Channel DO, and its credentials and participant tokens never reach another L4 installation.
6. The root Nuxt/Nitro Worker is one server. `apps/instance` is the account and directory authority with its own D1. The official client and landing are independent artifacts in this repository. No separate account-wide Admin or public control plane participates in the runtime.
7. Authentication has one deployment-selected mode. In `access` mode Cloudflare Access owns login and its email allow policy; the Worker verifies the Access JWT and maps it to an internal human identity. In `builtin` mode Better Auth owns identities and linked accounts. `users.status` and Roles remain the workspace authorization boundary in both modes.
8. A login method is effective only when both its owner-controlled switch and credentials/capability are present. Deployment credentials override encrypted D1 credentials and are never editable through the app.
9. Web Push subscriptions and its delivery outbox live in D1. Message and Live session writes enqueue notification rows in the same D1 batch; `NotificationDO` uses alarms to deliver and retry without another Worker or process.
10. Agents are real Members in the shared author/access model, but never authentication identities. `users.kind` distinguishes humans from agents; only humans map to either verified Access identities or Better Auth identities and sessions.
11. One top-level `L4Agent` coordinator is named `agent:<agentId>`. Each Channel or Thread gets a `L4Think` sub-agent with its own SQLite transcript, so conversation memory cannot leak across facets.
12. The default Member Role is chat-only. Task reads and writes require `manageTasks`; Agent discovery, chat invocation, control, and configuration require `manageWorkspace`. Task managers receive only a redacted Agent assignment list. The UI hides unavailable administrative surfaces, but the Worker API and Durable Objects are the authorization boundary.
13. Chat turns use Think's durable FIFO submission ledger directly, including idempotent admission, cancellation, recovery, and approval continuation. D1 mirrors only workspace-visible active-turn state; Think remains authoritative for the conversation.
14. Terms, Privacy, and Workspace rules are one immutable onboarding revision in D1. Access, email, and social admissions record acceptance of the current revision before a pending User can become an active Member; later publications apply only to future admissions.
15. Agents reply in chat and may read or create Tasks through the same authorized domain operations as HTTP and MCP. They have no project, repository, filesystem, shell, Workflow, or Container execution capability. Those connections are deferred until their lifecycle and isolation model is designed separately.
16. Default inference is Workers AI through the `AI` binding. When that binding is absent, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` call Workers AI REST (`aiProvider: workers-ai-rest`). An OpenAI-compatible chat endpoint (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`) is next. A profile stores a model id, not a vendor key. Public-web reading uses the `BROWSER` binding, then Browser Run REST, then Chromium at `BROWSER_CDP_URL`, on a caller-supplied http(s) URL after SSRF checks. That is not a search index. Outbound mail uses an email binding, then Email Sending REST, then an HTTP or SMTP gateway. Calls use RealtimeKit on Cloudflare's network, or RealtimeKit REST with the same token off that network. Inbound email uses Email Routing on Cloudflare. Off that network, `POST /api/email/inbound` checks an HMAC-SHA256 signature and timestamp (`INBOUND_EMAIL_SECRET`), and Postmark, Mailgun, and Amazon SES webhooks check that provider's own signature, then the same mailbox ingest runs. Agents still have no container, computer, or shell. The core architecture has no Hermes, OpenRouter Spawn, Neon, or external machine dependency.
17. A Mailbox is a private text Channel marked by `email_mailboxes`; an Email Conversation is its ordinary child Thread. Email messages extend `messages`, while Internal Notes remain plain Messages. D1 owns the searchable conversation facts and mailbox registry, while R2 owns raw MIME and attachment bytes. Each server may own multiple Email Domains and an Email Sending binding; an Email Domain belongs to exactly one server. Every Mailbox has one exact Cloudflare literal-address routing rule to that workspace Worker, so multiple servers can share a zone without sharing mail and unknown addresses never reach the application. Agent mail tools treat external fields as untrusted data, use the same Mailbox grants as humans, and require durable human approval before external sending.
18. The installation owner controls server provisioning and updates. The installation stores an optional Cloudflare API token encrypted in its control D1 or obtains it from deployment secrets. It signs server-scoped identities with a different pairing key per server. Server roles and removals stay local. Domain routing, VPS resources and server deletion remain operator-managed; the website holds a temporary encrypted browser-bound OAuth grant only until handoff or expiry. Provisioning credentials then belong to the installation, which serializes refresh rotation with a lease.
19. A fresh Access installation becomes ready when the deployment-selected Owner email first arrives with a verified Access identity. A fresh builtin installation remains unavailable until that Owner completes the private Owner Setup Claim. Both paths create the Owner and Workspace atomically, and other identities cannot bootstrap the installation.
20. Data is human-managed workspace state. The `manageDatabases` Grant controls Database discovery, shared Views, schema and Record mutations, Documents, and Canvases; the default Member Role remains chat-only. Bookmark writes derive the User from the authenticated session and can change only that User's private shortcuts. The Data navigation index returns only lightweight resource and View metadata, while an active Database View, Document, or Canvas body loads on demand. Tasks and Mail remain purpose-built models rather than special cases of Data.
21. Apps are declarative, versioned internal applications, not generated code sandboxes. A published App can compose multiple Database Views through explicit Bindings. Each Version snapshots the App's name, description, interface, Bindings, and Role access so draft changes remain manager-only until publication. Each Binding freezes semantic Database, View, Field, and operation identifiers; runtime reads and mutations re-authorize the current member against both their App Grant and the published Version's Role access. Jev may select from prepared sources and presentation candidates while authoring a draft, but no model runs when a published App opens or invokes an action.
22. The same Nuxt Worker serves stateless Streamable HTTP MCP at `/mcp`. MCP Access Tokens are owner-issued, revocable credentials whose raw value is shown once and whose SHA-256 digest is stored in D1. A token names an active Human or Agent principal separately from the Human who created it. Every request resolves that principal's current Role Grants and intersects them with the credential's scopes. Browser, MCP, and Agent calls reuse the same authorized Task and Document domain operations. Audit entries name the acting principal and retain credential and delegator attribution; no raw SQL or general browser-session bypass is exposed.

## Email flow

```text
Internet email → exact Cloudflare literal-address rule → owning workspace Worker → local email handler
  → size and attachment limits (25 MiB message, 20 attachments of up to 10 MiB each)
  → raw MIME + attachments in R2, removed again if the D1 write fails
  → Mailbox Channel root Message + Email Conversation Thread in D1
  → mail.changed to Members with access to that Mailbox

Off Cloudflare's network the same limits and ingest run after a signed check:
  Email Routing catch-all → examples/email-bridge → POST /api/email/inbound
  Postmark, Mailgun, or Amazon SES → POST /api/email/inbound/postmark|mailgun|ses

New email/reply → mailbox send permission → pending email in D1 → Email Sending → sent or failed
Internal note   → ordinary Message in the same Thread → workspace only
```

An RFC Message-ID is unique within one Mailbox, not across the Installation.
A message with no RFC Message-ID is stored once per SHA-256 of its raw bytes.
A replayed signed request inside the replay window returns success and does not
add a second copy. Duplicate detection and reply threading look only inside the
Mailbox that received the email, so one email sent to two Mailboxes lands in
both and a reply never joins another Mailbox's conversation. A reply goes to
the sender, To, and Cc of the latest email received in the conversation.

Inbox lists conversations in the inbox that contain received email; a
conversation a Member starts appears there once it gets a reply. Sent lists every
conversation with sent email, by when it was last sent, except those in Spam or
Trash. Archive, Spam, and Trash list conversations moved there.

Each outbound email is recorded before it is sent and keeps its delivery
attempts, last error, and delivery time. A client request key makes a retried
send return the email already recorded, and a delivery attempt first claims the
email, so it is never sent twice concurrently. A failed email can be retried
from the conversation.

## Agent task access

```
Human talks to an Agent in a Channel or Thread
  → Agent resolves its current Role and the initiating Human delegation
  → list_tasks or get_task reads authorized Task data from D1
  → create_task writes through the shared Task domain service
  → Workspace DO fans out the Task change to connected clients
```

Task assignment is organizational metadata; it does not start autonomous execution. D1 remains the Task source of truth and the Agent Durable Object retains only conversation state.

## Agent chat flow

```text
Human mentions Agent, or sends a DM containing an Agent
  → Worker validates the Message and Channel membership in D1
  → Worker signals the agent:<id> coordinator
  → Coordinator routes to the Channel/Thread's isolated Think facet
  → Think durably queues one idempotent submission for that Message
  → Lifecycle hooks expose tool progress and stream one editable Agent Message
  → Public http(s) URLs may be read through Browser Run Quick Actions after SSRF checks
  → External mail actions park durably until an authorized Member approves or rejects them
  → In a 1:1 DM, the facet creates/reuses a Thread rooted at that Message
```

Image attachments are loaded from R2 only for the active turn and passed as inline model input when the selected Workers AI model supports vision. Binary image data is not persisted in the Think transcript. A text-only model is told that the visual input was unavailable and must not claim that it inspected the image. Browser screenshots are stored in R2 the same way: the Think transcript keeps the object key and byte size, not the image bytes.

Replies in that DM Thread keep addressing the same Agent without another mention. Workspace-channel mentions and group-DM replies remain in their source Channel. An Agent-authored Message does not recursively enter this routing path. Paused Agents are not addressed, and a mentioned Agent cannot cross a private Channel boundary it has not joined.

## Notifications

- Workspace-channel and thread Messages notify only explicitly mentioned Members who can access the Channel. Direct Messages notify every other active participant.
- A newly started Live session notifies other active Members who can access its parent Channel or Direct Message; a 1:1 Call rings the other participant. Join, leave, and end events do not create push notifications.
- One outbox row targets one browser subscription. The `(event_id, subscription_id)` key makes producer retries idempotent; deterministic browser notification tags limit visible duplicates after at-least-once delivery.
- A `404` or `410` push-service response removes the expired subscription. Transient failures use bounded retry and a D1 lease.
- VAPID keys are deployment configuration and must remain stable. Subscription endpoints are capability URLs and must not appear in logs or APIs.

## Local vs production

- `pnpm dev` — Nuxt development server with locally simulated Cloudflare bindings.
- `pnpm dev:full` — built Worker in local Wrangler, including WebSockets and Durable Object hibernation.
- Browser Run in local Wrangler uses the remote binding.
- `pnpm dev:remote` — local frontend with HTTP requests proxied to a selected deployment and WebSockets connected directly to it. Personal targets live in ignored env files; see [Remote development](remote-development.md).
- `pnpm deploy` — build, apply D1 migrations by binding name, then deploy.
- Scheduled jobs create private backups. There is no public telemetry collector or public control-plane heartbeat.

## Threads and reads

- A thread is a `channels.type = thread` child with one root message and its own Channel DO, messages, and read cursor.
- A thread inherits access from its parent channel; copied visibility is descriptive, not an authorization boundary.
- A channel is shown unread when either its own cursor or one of its thread cursors trails the latest message.

A server may omit `FILES` in a manually configured deployment. File APIs and full backups then fail with `files_disabled`; the operator must configure storage. Normal installation provisioning creates a separate files bucket for every server. Installation recovery keys are hashed in control D1; redeeming one changes the local password and revokes installation sessions. Initial migration baselines are immutable: dormant inherited tables are not removed by rewriting published SQL.
