# Software Factory implementation evidence

The initial audit on 2026-10-26 used main `77d551f9765d28c0d3b6f819625e317e38bc34de` (v0.2.12). At the operator's request, PR #337 contains the complete implementation flow together, rather than separate batch PRs. External acceptance is assigned to Grok bot; this document does not claim a production release or a real authorized GitHub installation.

| Area | Implementation | Evidence boundary |
| --- | --- | --- |
| Existing foundations | Projects, GitHub App setup, Pi Durable, discovery, outbound MCP and private result review retained | Earlier merged tests remain applicable; no integrations migrated |
| Native-tool containment | Server sends no native computer authority; stale native Runs interrupted; runtime rejects it | Real Pi SDK forged-tool and coordinator tests |
| Exact action approval | `factory-authority.ts`, `factory-actions.ts`, immutable digest/policy/image/workspace revision, private review, expiry, durable decision/result/uncertain states | Role, human, Task, repository, channel, Node and call-identity denial tests |
| Portable compute | `compute-nodes.ts`, paired outbound daemon, one-use Node leases, heartbeat/revoke/cancel, receipt recovery | Server fixture tests; Linux daemon topology requires operator acceptance |
| Persistent disk and Git | Task-labelled named volume bound to a preallocated ext4 filesystem; separate bounded source broker; pinned full-history Git bundle; fresh non-root containers | Real Docker Git/edit/test/commit/snapshot/suspend/resume and cross-Task isolation; loop-device root-host reboot/quota tests assigned to Grok |
| Exact canonical publication | `factory-github.ts`; exact local tree/commit SHA verification, one dedicated original-repository branch/draft PR, fast-forward repair, no main/merge/release | Independent Git object hashes and GitHub fixture; real afterprompt writes need explicit installation |
| CI/Preview repair | Exact-head checks/statuses, native merge state, existing deployments/previews, allowed Actions logs, private Run review and coarse Task state | Failing CI → new approved snapshot → same PR → green fixture; absent/skipped/incomplete evidence explicit |
| Product/setup | Compute Nodes and repository provider selection, private Run action/diff/evidence review, Task status, operator instructions | Types/build/component checks; desktop/mobile external product acceptance assigned to Grok |

See the [operator guide](software-factory.md) for limits, credential placement, setup, reproduction and the full external handoff. No App private key or Git write credential enters compute. The trusted source-fetch broker on the Node temporarily receives a single-repository read credential; no credential enters an Agent workspace.

The Server database backs up authorization and audit records, not Node disk images. Linux root/loop-device access is required for the hard disk provider. Docker's shared-kernel implementation is limited to trusted operators/code; VM/microVM isolation for hostile public tenants, macOS/Windows Nodes and local workspace port previews are not implemented. Original repository CI/Preview integrations remain authoritative, including the possibility that drafts have no preview.

Do not close #307/#310/#309/#336 or claim release acceptance until Grok records the required real-provider and both Server-placement results at the candidate SHA. No version bump, release, merge or production configuration change is part of this PR.
