# Software Factory foundation audit

Audited on 2026-10-26 against main `77d551f9765d28c0d3b6f819625e317e38bc34de` (v0.2.12), for [#336](https://github.com/inchidev/llll/issues/336). This is Batch 0 evidence and a containment fix, not Software Factory acceptance. Full external verification is assigned to Grok bot by the operator. No real GitHub App installation, afterprompt write, preview deployment or production configuration was performed in this audit.

## What exists

| Foundation | Implementation and evidence | Remaining boundary |
| --- | --- | --- |
| #305 discovery | `shared/tool-discovery.ts`, `server/utils/agent-tools.ts`; filtered discovery and lazy schemas in embedded/container Pi; deterministic selection tests | Discovery never grants invocation authority. |
| #306 outbound MCP | `server/utils/outbound-mcp.ts`; explicit connection grants, encrypted credentials, frozen revisions, transport/output limits, revocation and audit | Sensitive outbound arguments remain blocked by #289 containment pending exact review. Earlier real MCP acceptance does not prove current GitHub coding acceptance. |
| #308 Tools settings | `app/components/settings/ToolsSettings.vue`; installed/discovery/permissions/audit UI | Pending-action queue and executable approvals remain unavailable. |
| #289 containment | `server/utils/agent-tool-security.ts`; monotonic Session taint, private result review, forged-tool and exfiltration tests | Container-native tools previously bypassed this gateway; see the fix below. |
| #333 Projects | `server/utils/project-service.ts`, `shared/projects.ts`; project/board/repository/delegation intersection and snapshot revocation | Provider references do not supply credentials or action/branch grants. |
| #334 GitHub App setup | `server/utils/git-connections.ts`; Owner/origin/state-bound setup, encrypted App key, explicit connection selection and disable | Unit and HTTP tests replace GitHub with a fixture, including fixture repository `inchidev/afterprompt`. They do not create a real App. |
| Pi Durable | `workers/agent-pi-durable.ts`; SQLite recovery, stable tool-call ledger, steering, budgets, private archive continuation | Embedded execution has no persistent source checkout or shell. Process-recovery tests use deterministic model/tool fixtures. |
| GitHub broker | `server/utils/github-agent-client.ts`, `server/utils/agent-code-service.ts`; repository-scoped token minting, pinned reads, dedicated branch/draft PR reconciliation and exact-head checks | Model-selected publication is blocked. Direct broker unit tests do not demonstrate an approved production write. |

## Containment correction

The container adapter previously translated `mandate.computer` directly into native Pi `read/write/edit/bash/grep/find/ls`. These tools execute inside Pi rather than `executeRunTool`, so the Server could not check each command's arguments, approval, current grants or ledger. Container isolation limits host exposure but cannot replace that authorization boundary.

The Server now always submits `computer: false`. Runtime admission rejects `computer: true`, and direct Pi session creation rejects it before opening credentials or session files. Native tools are never registered. Deterministic model tests forge every native tool name and verify no native execution; a coordinator regression retains an admitted computer mandate while proving that compute receives no native authority. Repository metadata remains behind the existing Server broker. Commands must eventually return through a Server-authorized WorkspaceProvider; re-enabling native tools based only on a Role or container configuration would reopen this gap.

Rebuild and pin the container runtime image together with the Server change. The rejection at new runtime admission protects against stale Server submissions; on its next alarm the coordinator fails a previously submitted computer Run without the new policy marker and requests cancellation and cleanup. The operator must also stop unreachable old executors; a Server update cannot halt an offline process by itself. No automatic replay is performed.

## Required next implementation

1. **#307 exact actions:** immutable tool/connection/action/arguments, identities, Task/project/repository/ref/base/content digest, expiry and cost limits; current-grant checks on decision and execution; durable claim/result/uncertain states; private review UI and redacted audit. Preserve existing denials until each action has this path. Result-sharing approval is not code or command approval.
2. **#310 WorkspaceProvider:** the existing Docker Runner uses a 512 MiB temporary filesystem and deletes its container after archival. It is not a persistent Compute Node. Implement persistent Task-bound disk, pinned Git history (the current tarball has no `.git` history), bounded brokered commands, leases/cancellation, isolation, capacity and outbound pairing. Docker shares the host kernel; untrusted public tenants require stronger isolation.
3. **#309 exact publication:** reuse the canonical GitHub broker after validating an approved immutable change. Keep original repository history, branch rules, CI and preview integrations authoritative. A Run-owned publication helper is not a complete human-reviewed Task workflow.
4. **#309 CI repair:** existing checks compare the PR head SHA but use configured check names and successful status URLs. They do not yet establish provider-authoritative required checks, complete pagination, deployments, explicit absent/skipped preview reasons or a bounded same-PR repair loop. Empty configured checks must not be treated as Software Factory acceptance.

## Reproduce local verification

Use Node 24 and the pinned package manager. Root postinstall prepares only the Server; generate the Shell's types before the complete unit suite:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec nuxt prepare apps/site
corepack pnpm test
corepack pnpm --filter @llll/agent-runtime test
corepack pnpm typecheck
corepack pnpm typecheck:site
corepack pnpm lint
corepack pnpm db:migrations:check --base 77d551f9765d28c0d3b6f819625e317e38bc34de
corepack pnpm model:check
corepack pnpm build
corepack pnpm exec wrangler deploy --dry-run --minify --config wrangler.installer.jsonc --outdir .installer/bundle
corepack pnpm test:server
```

The Server integration suite uses real workerd, local databases/storage and two isolated Servers. Its GitHub endpoint, installation credentials and afterprompt identity are synthetic. `scripts/test-github-agent.mjs` uses real workerd WebCrypto/fetch with a synthetic GitHub service. Neither suite demonstrates upstream GitHub authorization. `scripts/test-pi-runtime.mjs` additionally requires a Docker daemon and newly built pinned images; do not confuse its deterministic model fixture with a real coding Task.

## Grok external verification handoff

Use an explicit test Server and a dedicated GitHub App installation limited to `inchidev/afterprompt`. Record connection/installation/repository IDs and the exact candidate SHA, without copying keys into logs, chat, Agent files or CI. Owner setup is documented in [Agents](agents.md#github-connection-setup). Verify that discovering the repository does not itself permit Agent publication, and disabling the selected App denies subsequent calls without fallback.

On the candidate, check both embedded and container execution. A Task with computer permission must not expose or execute native Pi shell/filesystem tools; forged calls and restored context must not enable them. Exercise private result review separately. Check existing CI and native Server/web PR Previews at the candidate SHA. Further compute, exact-code publication and repair-loop acceptance must wait for their implementation PRs and tests above. Keep #307/#310/#309/#336 open until their own acceptance criteria are demonstrated.
