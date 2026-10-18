# Stabilization roadmap

Direction: [Servers for independent communities](product.md). This is an ordered plan, not a shipped-feature or deployment report. Finish each milestone's acceptance before expanding its scope.

## 0. Fresh bootstrap

This history begins with the current product source, the Instance/Server vocabulary, one baseline each for Server, Instance and installer databases, and an initial `0.1.0-alpha.1` release. Historical upgrade fixtures and prototype release notes are excluded. The prototype and operator-owned local files are preserved outside this repository.

The first release is a developer alpha. Cloudflare is the first target for acceptance. VPS/celld remains experimental until the proxy WebSocket, reload/selection and SPA deep-link issues described in [self-host findings](self-host-findings.md) pass independent reproduction and acceptance. These reports are not independently confirmed root causes.

No automatic production deployment is enabled by the bootstrap. Use isolated resources for runtime checks; installation/Server updates and production rollout remain explicit operations. Do not point the new baseline migrations at a prototype database.

### Initial evidence inventory

The following source and verification entry points exist at the audited baseline. See [bootstrap validation](bootstrap-validation.md) for executed checks. This source map alone proves neither test results nor runtime readiness; Provider and real-device acceptance remain unverified unless the validation record explicitly says otherwise.

| Capability | Source / automated verification entry point | Remaining runtime acceptance |
| --- | --- | --- |
| Instance identity and server isolation | [Controller](../apps/instance/src/index.ts), [identity tests](../tests/unit/installation-identity.test.ts), [integration fixture](../scripts/test-instance.mjs) | Fresh owner/member, two Servers, removal, direct/Shell sessions |
| Chat, realtime and search | [Channels](../app/pages/channels.vue), [socket tests](../tests/unit/channel-socket.test.ts), [search tests](../tests/unit/message-search.test.ts) | Two browser clients, proxy WebSocket handshake, reload/reconnect, denied content |
| Tasks | [Tasks](../app/pages/tasks.vue), [assignee tests](../tests/unit/task-assignee.test.ts) | Task workflow with a non-owner and denied operations |
| Data | [Databases](../app/pages/databases.vue), [View tests](../tests/unit/database-views.test.ts) | Resource permissions and concurrent editing across Views/Documents/Canvases |
| Mail | [Mailbox UI](../app/pages/mail/index.vue), [ingest tests](../tests/unit/inbound-email.test.ts), [delivery tests](../tests/unit/mail-delivery.test.ts) | Named Provider, actual receive/reply, attachments, rejection and retry |
| Agents | [Turn tests](../tests/unit/agent-turns.test.ts), [ingress tests](../tests/unit/agent-ingress.test.ts) | Configured inference, local grants, approval continuation and failure recovery |
| Notifications and calls | [Notification tests](../tests/unit/notifications.test.ts), [Live tests](../tests/unit/live-room.test.ts) | Real-device push and configured media Provider, including access revocation |
| Install and recovery | [Compose checks](../scripts/test-self-host-installation.mjs), [Backup tests](../tests/unit/backup-format.test.ts), [release workflow](../.github/workflows/publish-installer-release.yml), [image workflow](../.github/workflows/publish-image.yml) | Fresh pinned release/image, update, browser transport and restore of both layers |

This is an initial map of evidence, not an exhaustive test inventory. Apps, files, invitations, PWA and Telegram are included in milestone acceptance even where no individual test file is listed above.

## 1. One vocabulary and one community journey

Apply [the glossary](../CONTEXT.md) to visible labels, errors, empty states, accessibility labels, setup and invitations. Members see Server; operators additionally see Instance. Keep internal API/schema names. The current vocabulary pass is a starting point, not proof that every string is covered.

Verify: deploy Instance → claim owner → create Server → invite → accept as another Account → open Channel → exchange messages/files → reload → reconnect. Repeat direct and through the official Shell. Repeat join/denial/removal with a non-owner. Existing-server registration belongs in advanced operator settings.

Reproduce selection loss before changing the router. The literal `native: true` in `useClientServers` and the web boot/discovery flow are inspection leads, not a proven cause. Test persisted selection, expired sessions, unavailable Servers and two Instances so a fix cannot merge identity or content across origins.

Acceptance: the first conversation survives reload/reconnect, invitations require no manual resource IDs, and removal still denies content access.

## 2. Repeatable deployment and recovery

Exercise one normal path per target. Keep site/Shell deployment separate from customer Instance/Server deployment.

| Target | Work | Acceptance |
| --- | --- | --- |
| Cloudflare, first | Verify release assets and installer handoff, then create a fresh isolated Instance and Server | Owner claim, invitation, direct/Shell login, two-client realtime, files, reload and deep links |
| VPS, second | Reproduce outbound WebSocket upgrade and SPA asset routing failures on celld; isolate runtime issues before choosing a fix; verify pinned image availability | The same journeys over real HTTP/WebSocket through generated Compose, including deep-link reloads |
| Both | Update with existing resources/secrets, then restore a Backup into isolated resources | Identity and authorization remain correct; both Instance and Server data survive update and recover |

The in-process Worker fixture checks domain behavior and isolation. It does not certify a serialized WebSocket handshake, HTTP redirect or asset lookup. Existing Compose checks create/read messages and test isolation; extend acceptance to the browser and realtime path instead of treating health 200 as completion.

Cloudflare account operations use the connected API tool. Verification resources are isolated from live installations. Published tags/assets and merged migrations are never replaced to repair a release.

Acceptance: record commit, immutable release/image, runtime, journey and result. Local verification, isolated deployment, publication and production rollout are separate. Do not advertise VPS parity while transport acceptance is unresolved.

## 3. Coherent interface for existing features

Inspect real layouts before redesigning: first visit, empty Server/Channel, navigation, composer, search, files, invitations and settings at phone and desktop widths. Fix observed defects in small PRs. Use realistic community content in screenshots.

Check Tasks, Data and Apps with a non-owner Role. Check Mail, Agents and calls with missing and configured Providers. Preserve existing features; make permissions and setup requirements legible. Do not add a mail-first home screen or new product modules during this pass.

The hero preview is implemented. Review screenshots and what its live-demo button opens. A sign-in form is not a browsable product demo. Public demo access needs explicit read-only authorization, restrictions on writes/Direct Messages/provider usage and a reset/cost policy before exposure; hiding controls is insufficient.

Acceptance: honest screenshots show the community experience; visitors understand what to deploy and which capabilities need Providers. Advertised demo behavior matches its actual access.

## 4. Publish the stabilized baseline

Use the [existing release process](releases.md). Publish from validated `main`, verify immutable public assets and the advertised image, and record which deployments were actually updated. Keep release evidence in release notes rather than the glossary.

Acceptance: a new operator can follow the public guide to a working community; an existing operator can update and recover it. Then schedule new mail automation, embedding or commercial hosting as separately scoped milestones.
