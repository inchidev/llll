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
