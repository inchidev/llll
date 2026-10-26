# Governed agents with Pi

Approved direction, 2026-10-21. Implementation is incremental; this document is not release evidence.

1. Validate a pinned Pi runtime in Docker and Cloudflare Containers: tools, events, cancellation and session restore.
2. Separate agent use, administration and approval; split task/data reading and writing; intersect agent and delegation authority; add resource grants.
3. Add durable Runs, Sessions, execution limits, cancellation, recovery and auditable results. Runtime adapters share a container image and protocol, not provider lifecycle assumptions.
4. Complete research to authorized Data and Tasks, including bounded autonomous execution and source evidence.
5. Add GitHub-only coding to PR and Preview; reminders and recurring mandates. Production publishing is a separate controlled capability.
6. Align existing OAuth MCP connections and tools with the same current role/resource authorization and revocation behavior.

Agent is a persistent non-human Member. Session is conversation-local context. Task records desired work. Run is an execution attempt, optionally linked to a Task. Environment supplies execution tools and files. Schedule triggers work using a stored revocable mandate. Chat does not implicitly create Tasks.

No shared private memory across conversations. No host Docker socket or production credentials in agent containers. No privilege increase through owner invocation or generated subtasks. Protected release policy stays outside agent-editable code. Persist results and audit facts outside ephemeral compute. Restore must not replay completed external writes.

Validation: denied paths as well as allowed paths; removal and role revocation; cross-conversation and cross-resource denial; interrupted runs; duplicate delivery; spend/concurrency limits; actual Docker and Cloudflare Preview acceptance. All application deployments use Workers Builds from Git. Feature PRs do not publish production.

## Implementation evidence

- Role/action/resource foundation merged in PR #41. Ordinary merge, no production promotion.
- Pi 1.3.0 SDK and isolated Docker proofs pass: explicit tools, transcript restore, gateway callbacks, repeated admission, restart, public-egress denial, Runner cancellation and resource cleanup. The model fixture is deterministic and does not certify real-model behavior.
- Durable Runs/Sessions, scoped research/Data/Tasks tools, inherited subtask execution, role revocation and occurrence-based schedules are implemented for review. Local Server integration validates the schema and exports. Isolated PR #42 Cloudflare Containers completed a real Workers AI reply, restored the previous conversation in fresh compute, and called the role-scoped list_tasks tool before returning the real board name. A literal reminder was delivered once without inference. Mobile navigation was checked and corrected before merge.
- Server-local Projects contain provider-qualified repository references and L4 Tasks. GitHub is the first executable adapter, with a dedicated-App capability broker, optional-fork draft proposals, exact-commit CI/Preview reporting, bounded computer files and `data:manage` MCP table creation. Owner-driven App setup now has a Server interface; real GitHub acceptance requires creating and authorizing that App for a test repository (inchidev/afterprompt); mocked GitHub protocol tests do not certify a live installation. Production publishing remains under the existing human-controlled protected release process. No production credential enters compute.

- Embedded Pi 1.4.0 now registers governed L4 tools, resumes stable SQLite submissions, aborts active inference, and exposes streamed Run progress. Local celld verified real OpenRouter search and tool use. A separate process test verifies SIGKILL recovery mid-tool without repeating its external write. Server-owned encrypted provider configuration and the 1:1 composer toolbar are implemented; The Claude API adapter has protocol fixtures, not live-account acceptance. Cloudflare Preview and personal subscription flows remain separate evidence/work.

## Software Factory implementation for review

PR #337 implements the Task-scoped factory workflow in one PR: immutable action approvals, outbound paired Linux Docker Nodes, fixed-capacity persistent ext4 workspaces and bounded source Git bundle fetches, normal local commits, exact-SHA original-repository draft PR publication, existing CI/Preview observation and same-PR repair. See [setup and limits](software-factory.md) and [evidence](software-factory-audit.md). Real provider/topology/product acceptance remains assigned to the operator's Grok bot; this entry is not release evidence.
