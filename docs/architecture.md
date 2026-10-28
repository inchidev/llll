# Architecture

See [standalone Servers and Shell](server.md). Accounts, UUID identity and authentication belong to each Server. Shell embeds its Client directly.

## Rules

1. Live path ≠ storage path. A Channel DO serializes writes, persists to D1, then broadcasts.
2. D1 is history source of truth for messages, channel read cursors, users, access control, and owner-managed integration settings. RealtimeKit API tokens saved in Server Settings are AES-GCM encrypted with `AUTH_SECRET`; deployment credentials override them. Recorded audio is an ordinary Message Attachment stored in R2; it does not use RealtimeKit. File reads remain authenticated, and audio seeking uses single byte-range responses.
   User-created Databases, Documents, and Canvases are logical resources in this same D1, not separately provisioned Cloudflare databases. Database Fields allocate from bounded typed columns on `database_items`; APIs expose Field ids and types, never physical slot names. Shared Database Views store validated semantic Field references and the Worker compiles them into bound, paginated D1 queries. Private Data Bookmarks belong to one User. Documents store rich text, while Canvases keep positioned Items and Connections in normalized tables. Versions provide optimistic concurrency. Durable Objects are not the source of truth for Data resources.
3. Server DO owns ephemeral presence and recipient-targeted unread signals. It derives online/idle state from visible WebSocket attachments, honors each client's activity-visibility preference, and fans out only message/read identifiers to authorized user sockets; presence and unread truth remain in D1, never on `users` or DO storage.
4. One Channel DO named `channel:<channelId>` and one Server DO named `server:<server-uuid>`. Typing is scoped to a Channel DO.
5. Every Channel and Direct Message owns exactly one Live room; there are no separate voice Channels. Threads use their parent's room and Mailboxes have none. The Channel DO owns the room: it serializes start and join so a room has at most one RealtimeKit meeting, issues each participant token with the host or participant preset, tracks presence by heartbeat, and closes an empty room after a grace period. Starting a room follows the `startLive` grant in Channels and Direct Messages; joining needs only access to the conversation. Hosts are the person who started the room and, in server Channels, members who can manage it; both people in a 1:1 Call are hosts. When someone loses access to a conversation, or a host removes them, the room removes them from the media session and revokes their token; joining again from another tab or device replaces the person's earlier seat. Ending a room always clears it locally, even when its RealtimeKit meeting is gone; a failed remote end is retried a bounded number of times by the room's alarm, and disconnecting or replacing the RealtimeKit connection ends active rooms first. A client whose media connection drops rejoins the same meeting with bounded retries and never starts a new room. A 1:1 Direct Message presents the room as a ringing Call that times out or can be declined; other conversations announce it once and let people drop in. Scheduling is deferred until L4 has a calendar; `channels.live_meeting_id` stores the active meeting. RealtimeKit is only the audio/video/screen-share media plane: media never transits the Channel DO, and its credentials and participant tokens never reach another L4 server.
6. The root Nuxt/Nitro Worker is one autonomous Server, including its local account authority and Client. `apps/site` serves Landing, Shell, Docs and server entry points. Shell embeds each Server Client directly; saved connections contain routing metadata and never authorize membership.
7. Authentication has one deployment-selected mode. In `access` mode Cloudflare Access owns login and its email allow policy; the Worker verifies the Access JWT and maps it to an internal human identity. In `builtin` mode Better Auth owns identities and linked accounts. `users.status` and Roles remain the server authorization boundary in both modes.
8. A login method is effective only when both its owner-controlled switch and credentials/capability are present. Deployment credentials override encrypted D1 credentials and are never editable through the app.
9. Web Push subscriptions and its delivery outbox live in D1. Message and Live session writes enqueue notification rows in the same D1 batch; `NotificationDO` uses alarms to deliver and retry without another Worker or process.
10. Agents are real Members in the shared author/access model, but never authentication identities. `users.kind` distinguishes humans from agents; only humans map to either verified Access identities or Better Auth identities and sessions.
11. One top-level `L4Agent` coordinator is named `agent:<agentId>`. Each Channel or Thread gets a `L4Think` sub-agent with its own SQLite transcript, so conversation memory cannot leak across facets.
12. The default Member Role is chat-only. Task reads require `readTasks`, writes require `writeTasks`, and destructive/board administration retains `manageTasks`. Data follows `readData`, `writeData`, and `manageDatabases`. Agent discovery and invocation require `useAgents`; configuration requires `manageAgents`; pending actions require `approveAgentActions`. Role resource access limits apply in HTTP, MCP and Agent domain operations. Task managers receive only a redacted Agent assignment list. The UI hides unavailable administrative surfaces, but the Worker API and Durable Objects are the authorization boundary.
13. Chat turns use Think's durable FIFO submission ledger directly, including idempotent admission, cancellation, recovery, and approval continuation. D1 mirrors only server-visible active-turn state; Think remains authoritative for the conversation.
14. Terms, Privacy, and Server rules are one immutable onboarding revision in D1. Access, email, and social admissions record acceptance of the current revision before a pending User can become an active Member; later publications apply only to future admissions.
15. Agents reply in chat and may read or create Tasks through the same authorized domain operations as HTTP and MCP. They have no project, repository, filesystem, shell, Workflow, or Container execution capability. Those connections are deferred until their lifecycle and isolation model is designed separately.
16. Default inference is Workers AI through the `AI` binding. When that binding is absent, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` call Workers AI REST (`aiProvider: workers-ai-rest`). An OpenAI-compatible chat endpoint (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`) is next. A profile stores a model id, not a vendor key. Public-web reading uses the `BROWSER` binding, then Browser Run REST, then Chromium at `BROWSER_CDP_URL`, on a caller-supplied http(s) URL after SSRF checks. That is not a search index. Outbound mail uses an email binding, then Email Sending REST, then an HTTP or SMTP gateway. Calls use RealtimeKit on Cloudflare's network, or RealtimeKit REST with the same token off that network. Inbound email uses Email Routing on Cloudflare. Off that network, `POST /api/email/inbound` checks an HMAC-SHA256 signature and timestamp (`INBOUND_EMAIL_SECRET`), and Postmark, Mailgun, and Amazon SES webhooks check that provider's own signature, then the same mailbox ingest runs. Agents still have no container, computer, or shell. The core architecture has no Hermes, OpenRouter Spawn, Neon, or external machine dependency.
17. A Mailbox is a private text Channel marked by `email_mailboxes`; an Email Conversation is its ordinary child Thread. Email messages extend `messages`, while Internal Notes remain plain Messages. D1 owns the searchable conversation facts and mailbox registry, while R2 owns raw MIME and attachment bytes. Each server may own multiple Email Domains and an Email Sending binding; an Email Domain belongs to exactly one server. The Cloudflare installer configures a zone catch-all route to the Server Worker. Ingest accepts only enabled addresses in the local mailbox registry and rejects unknown recipients. A zone catch-all belongs to one destination; sharing a mail zone across Servers requires operator-managed address routing. Domain connect/disconnect remain operator-managed; the Client displays configured domains without offering unimplemented routing actions. Agent mail tools treat external fields as untrusted data, use the same Mailbox grants as humans, and require durable human approval before external sending.
18. Each Server is independently deployed and updated by its operator. Our own application deployments (the official `llll` Worker, llll.gg and Previews) run only in Workers Builds from Git from immutable release artifacts. Customer Server installation and updates are separate: they may upload only a published, immutable, checksum-verified release artifact through the customer's own OAuth grant, with no Git integration or Workers Builds requirement. A Server runtime holds no account-wide provisioning credential; the installer keeps a temporary encrypted browser-bound OAuth grant only within its bounded session.
19. A fresh Access server becomes ready when the deployment-selected Owner email first arrives with a verified Access identity. A fresh builtin server remains unavailable until that Owner completes the private Owner Setup Claim. Both paths create the Owner and Server atomically, and other identities cannot bootstrap the server.
20. Data is human-managed server state. The `manageDatabases` Grant controls Database discovery, shared Views, schema and Record mutations, Documents, and Canvases; the default Member Role remains chat-only. Bookmark writes derive the User from the authenticated session and can change only that User's private shortcuts. The Data navigation index returns only lightweight resource and View metadata, while an active Database View, Document, or Canvas body loads on demand. Tasks and Mail remain purpose-built models rather than special cases of Data.
21. Apps are declarative, versioned internal applications, not generated code sandboxes. A published App can compose multiple Database Views through explicit Bindings. Each Version snapshots the App's name, description, interface, Bindings, and Role access so draft changes remain manager-only until publication. Creating, changing or publishing a draft requires access to every bound Database; The explicitly assigned Apps model receives only sources within the manager's resource scope. Publishing explicitly grants the selected Roles access through those Bindings, without granting direct Data access. Each Binding freezes semantic Database, View, Field, and operation identifiers; runtime reads and mutations re-authorize the current member against both their App Grant and the published Version's Role access. The assigned model may select from prepared sources and presentation candidates while authoring a draft, but no model runs when a published App opens or invokes an action.
22. The same Nuxt Worker serves stateless Streamable HTTP MCP at `/mcp`. Server-local OAuth provides S256 PKCE, client registration, explicit Human/Agent consent, scoped opaque tokens, refresh and revocation. Each connection binds an acting Member separately from the human who authorized it; only Agent managers can select Agents, and humans can select only themselves. Every request resolves current Role Grants and intersects them with the connection and credential scopes. Browser, MCP, and Agent calls reuse the same authorized Task and Document domain operations. Audit entries retain the acting principal, client, connection and delegator. Existing owner-issued bearer tokens remain available. See [MCP connections](mcp.md).

In RealtimeKit REST mode, the Server Durable Object serializes app and preset provisioning across rooms. Non-secret app metadata is persisted per Cloudflare account in D1 `server_settings`, so joins, leaves and restarts reuse it; the API token stays in deployment bindings. A 404 during meeting or participant creation triggers one coordinated repair. Authentication, rate-limit and transient failures do not trigger provisioning, and existing meetings are never replayed into a replacement app.

## Email flow

```text
Internet email → Cloudflare zone catch-all → Server Worker → enabled mailbox lookup
  → size and attachment limits (25 MiB message, 20 attachments of up to 10 MiB each)
  → raw MIME + attachments in R2, removed again if the D1 write fails
  → Mailbox Channel root Message + Email Conversation Thread in D1
  → mail.changed to Members with access to that Mailbox

Off Cloudflare's network the same limits and ingest run after a signed check:
  Email Routing catch-all → examples/email-bridge → POST /api/email/inbound
  Postmark, Mailgun, or Amazon SES → POST /api/email/inbound/postmark|mailgun|ses

New email/reply → mailbox send permission + rate limit → pending email in D1 → configured transport → sent or failed
Internal note   → ordinary Message in the same Thread → server only
```

An RFC Message-ID is unique within one Mailbox, not across the Server.
A message with no RFC Message-ID is stored once per SHA-256 of its raw bytes.
A replayed signed request inside the replay window returns success and does not
add a second copy. Duplicate detection and reply threading look only inside the
Mailbox that received the email, so one email sent to two Mailboxes lands in
both and a reply never joins another Mailbox's conversation. A reply goes to
Reply-To of the latest received email, falling back to its sender. Reply all is an explicit choice that also includes To and Cc, excluding the Mailbox itself.

Inbox lists conversations in the inbox that contain received email; a
conversation a Member starts appears there once it gets a reply. Sent lists every
conversation with sent email, by when it was last sent, except those in Spam or
Trash. Archive, Spam, and Trash list conversations moved there. New mail brings Archive back to Inbox but preserves Spam and Trash.

Each outbound email is recorded before it is sent and keeps its delivery
attempts, last error, and delivery time. A client request key makes a retried
send return the email already recorded, and a delivery attempt first claims the
email, preventing concurrent delivery during its five-minute lease. A failed email can be retried
from the conversation. An interrupted attempt becomes Delivery unknown after five minutes;
sending another copy requires explicit confirmation because the first may have arrived.
A late result cannot overwrite a newer attempt. A receipt-write failure never marks a
successful transport call as failed. Delivery still runs within the HTTP request;
background queues and automatic retries are not implemented.

Provider identifiers are stored separately from RFC Message-IDs. Cloudflare REST
returns delivery status by recipient, not a Message-ID; this cannot be used to
thread a later reply to an initial outbound message. Known valid In-Reply-To and
References headers are preserved. Cloudflare controls Message-ID and rejects a
caller-supplied override.

Inbound attachments are typed from their bytes, with active document types kept
as downloads. Every file response, including legacy rows, uses a restrictive CSP
sandbox and nosniff; only safe preview types are served inline. New mail, replies
and retries share a limit of ten requests per minute per Member and Mailbox.

Deleting a Mailbox records its raw MIME and attachment keys in a persistent
cleanup queue in the same transaction that removes its channels. Cleanup removes
only those live-file keys. Storage failures retain the queue; repeating deletion
or refreshing Mail or its settings retries a bounded batch. The queue has no
independent background scheduler. Backup destinations are never enumerated or
removed by this process.

## Agent task access

```
Human talks to an Agent in a Channel or Thread
  → Agent intersects its current Role/resource access with the initiating Human delegation
  → list_tasks or get_task reads authorized Task data from D1
  → create_task writes through the shared Task domain service
  → Server DO fans out the Task change to connected clients
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

Replies in that DM Thread keep addressing the same Agent without another mention. Server-channel mentions and group-DM replies remain in their source Channel. An Agent-authored Message does not recursively enter this routing path. Paused Agents are not addressed, and a mentioned Agent cannot cross a private Channel boundary it has not joined.

## Notifications

- Server-channel and thread Messages notify only explicitly mentioned Members who can access the Channel. Direct Messages notify every other active participant.
- A newly started Live session notifies other active Members who can access its parent Channel or Direct Message; a 1:1 Call rings the other participant. Join, leave, and end events do not create push notifications.
- One outbox row targets one browser subscription. The `(event_id, subscription_id)` key makes producer retries idempotent; deterministic browser notification tags limit visible duplicates after at-least-once delivery.
- A `404` or `410` push-service response removes the expired subscription. Transient failures use bounded retry and a D1 lease.
- VAPID keys are deployment configuration and must remain stable. Subscription endpoints are capability URLs and must not appear in logs or APIs.

## Local vs production

- `pnpm dev:stack` — standalone celld/RustFS Server, Caddy, Client HMR and a local Shell, with persistent per-worktree state. See [local development](local-development.md).
- `pnpm dev` — Nuxt development server with locally simulated Cloudflare bindings.
- `pnpm dev:full` — built Worker in local Wrangler, including WebSockets and Durable Object hibernation.
- Browser Run in local Wrangler uses the remote binding.
- `pnpm dev:remote` — local frontend with HTTP requests proxied to a selected deployment and WebSockets connected directly to it. Personal targets live in ignored env files; see [Remote development](remote-development.md).
- `pnpm deploy` — guarded Workers Builds entry point; refuses application deployments from a developer machine.
- Scheduled jobs create private backups. There is no public telemetry collector or public control-plane heartbeat.

## Threads and reads

- A thread is a `channels.type = thread` child with one root message and its own Channel DO, messages, and read cursor.
- A thread inherits access from its parent channel; copied visibility is descriptive, not an authorization boundary.
- A channel is shown unread when either its own cursor or one of its thread cursors trails the latest message.

A server may omit `FILES` in a manually configured deployment. File APIs and full backups then fail with `files_disabled`; the operator must configure storage. Provisioning creates a separate live files bucket and backup destination. Server recovery keys are hashed in its D1; redeeming one changes the local password and revokes local sessions. Initial migration baselines are immutable: dormant inherited tables are not removed by rewriting published SQL.
