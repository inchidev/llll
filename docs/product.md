# Product scope

Accepted direction: L4 is software for independent communities organized into Servers. Mail and Agents are capabilities inside a Server. They do not change L4 into an inbox-first product or an embedding service.

This defines the intended product boundary. It does not certify implementation or deployment readiness. Track that work in the [roadmap](roadmap.md).

## The first experience

An operator deploys a Server, claims its owner Account and shares an invitation. A participant accepts the invitation, joins that Server and starts a conversation. The direct Server address works without the official Shell.

Participants use Servers, Channels, Threads, Direct Messages and files. Owners additionally manage Server deployment settings. The canonical terms in code and UI are defined in [the glossary](../CONTEXT.md).

Each Server is an autonomous deployment. A community should not have to understand resource IDs, pairing keys, Workers or database bindings to join. Registration of an existing server remains an advanced operator operation.

## Capabilities

| Layer | Scope | Acceptance before advertising readiness |
| --- | --- | --- |
| Community core | Invitations, membership, Roles, Channels, Threads, Direct Messages, messages, files, search and notifications | Fresh owner and participant journeys; denial/removal; file access; realtime between two clients; reload and reconnect |
| Work within a Server | Tasks, Data, Documents, Canvases and internal Apps | A non-owner completes the intended workflow; private resources and published Apps obey their access rules |
| Optional Providers | Mail, Agent inference, public-page reading, calls and Live | A named Provider works on the named runtime; missing configuration is explained; permission loss and failure are handled |
| Delivery | Direct web Client, official Shell, PWA and Telegram | Direct and embedded login, navigation and updates; real-device results identified separately |
| Operations | Install, update, Backup and restore | Fresh install and update preserve identity, content and authorization; recovery restores Server data |

Preserve existing implementations while stabilizing the community core and operations. Optional capabilities must explain their configuration state instead of presenting a broken primary action. These are acceptance gates, not a new feature-switch implementation.

Agents have the Server's local permission boundary. Their current scope is conversation and authorized tools, not a computer, shell or repository worker. External email sending requires human approval. Mail delivery needs its own Provider configuration. Neither Mail nor Agents is required for the first community conversation.

## Inbox

Inbox is the first rail section and the one place to catch up. It lists only what needs the signed-in Member, each with one next step:

- **Approvals:** pending review-mode workspace actions and sharing reviews from Runs they started.
- **Mentions:** unread messages that mention them, in conversations they can still open.
- **Agent work:** their Runs while queued or running and for three days after, with the draft pull request when one was opened.
- **My tasks:** Tasks assigned to them, and Tasks they created that wait for review.
- **Mail:** Mailboxes they can read with unread mail.
- **Unread chats:** unread Channels, Direct Messages and Agent chats. A row opens the unread thread when only thread replies are new, and can be marked read without opening it.

The rail badge counts approvals and mentions only, so standing work does not keep it lit. Unread mail is listed per Mailbox; individual Email Conversations stay in Mail.

Mail sends a push notification for each new email that lands in a Mailbox's Inbox to every human who holds a grant on that Mailbox and Read or Send email (or is the Owner); the grant is checked again at delivery. Mail filed as Spam or Trash stays quiet. Each Mail folder can be searched by subject, address, sender name and the text of emails and internal notes. New emails and replies support Cc and Bcc (Bcc stays out of the conversation's participants), and Forward opens a new email quoting the original. Forwarding does not copy attachments; outbound attachments, HTML composition, drafts and signatures are not supported yet.

Messages in Channels, Direct Messages and Threads offer **Create task**. It opens the Task form prefilled from the message, and the saved Task links back to it. The message then shows the Task to anyone who can read that Task; people who cannot read the source conversation see only that the Task came from a message. Deleting the message keeps the Task and shows the source as deleted.

## Deployment boundary

The normal topology is an independent Server with an optional Shell. Site, Shell and installer deploy independently; they are not mandatory infrastructure for customer content or identity. The root Nuxt runtime is one Server; the Server owns local identity and routing. See [the architecture decision](adr/0003-server-schema-lineage.md).

The two deployment targets are Cloudflare and VPS using Docker Compose/celld. Stabilization verifies Cloudflare first. The multi-server VPS path needs separate transport and browser acceptance before it can be described as equally ready. Verify both the direct Client and Shell.

The public guide should lead with one complete path per target, from a pinned release to the first invitation. Manual provisioning, existing-server registration and Coolify details remain operator references. Verify the public image archive checksum, embedded version and architecture before promising a build-free install.

## Fixed boundaries

- Accounts and sessions belong to the Server. Server membership, Roles and removals remain authoritative locally. Email matching never grants access.
- Private channel membership can be managed by channel participants with Manage channels. Adding an active Member grants existing channel history, files and inherited Threads; removing one revokes API access, closes held channel/Thread sockets and revalidates Live seats. Membership changes are audited and sent only to current or removed participants. Managers cannot remove their own access through this dialog. DM, Mailbox and task-discussion access use their own rules.
- Direct Messages remain inside a Server. Shell bookmarks and public routing IDs grant no membership.
- A 1:1 Direct Message stays between its two participants. Including someone else starts a separate group with no copied history. Groups keep their identity when people leave; opening a 1:1 never reuses a former group.
- Group creators can remove other participants, and any participant can leave. Historical groups without a recorded creator allow self-leave only; when a creator leaves, the group becomes unowned. Adding an Agent requires Use agents. People added to a group can read its existing group history.
- Backups remain separate from live files. Recovery includes the Server identity, accounts, secrets and content; server deletion never deletes Backup buckets.
- Append migrations within the current schema lineage; merged SQL and published assets are immutable.
- L4 remains MIT software. Each Server is autonomous. This stabilization adds no managed-hosting marketplace, billing or OEM business.

## Deferred work

OpenRivers/AfterPrompt embedding, an external embed SDK, Gitrew, cross-server Direct Messages and executable Agent computers remain later work. iOS/macOS packaging remains frozen. New inbox automation and commercial hosting need separate scope after deployment and community journeys pass acceptance.

This repository starts a new source and release history at `0.1.0-alpha.1`. The prototype is archived separately. Fresh databases use one `0000` baseline per runtime; this release does not upgrade prototype databases. Subsequent merged migrations and published assets are immutable.
