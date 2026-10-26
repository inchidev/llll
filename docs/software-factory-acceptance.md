# Software Factory 0.2.14 acceptance

Run this procedure against the published immutable 0.2.14 release and record its full tag/commit. Local/provider fixtures are separate evidence. The operator assigns the following real-provider checks to Grok after publication; this document does not claim they have run.

## Fresh installations

1. Install a fresh Cloudflare Server through `/create` on Workers Free with Basic KV and no R2. Claim Owner; save UUID, a Role, Project, Task, file and Git connection. Confirm no Factory container application was allocated.
2. On that same Server choose Settings → Repositories → Enable Factory. Exercise Free/permission/unavailable states without upgrading plans. After the operator explicitly chooses Workers Paid, review compute/storage/network costs, choose limits and authorize provisioning. Activate only after provider readiness. Confirm the original UUID, accounts, content, secrets, repositories and files remain. R2 stays optional.
3. On a fresh supported amd64 VPS use the published installer with `LLLL_FACTORY=true LLLL_SHARED_KERNEL_TRUSTED=1`, or enable after claiming Owner with `sudo llll factory enable --trust-shared-kernel`. Check `llll factory status` and Settings readiness. No registry, source clone, manual image build or second machine should be required. Confirm actual hard quota and reserved Server capacity.

## Real Agent flow on both recommended backends

Use a dedicated restricted GitHub App installation and `inchidev/afterprompt` (or the explicitly authorized test fork). Preserve the original CI and Preview integrations.

1. Connect the repository, create its environment and Project, and choose the Factory agent Role. Limit Project/board/repository scopes and ensure the initiating human has Approve Agent actions. Use the default Task discussion.
2. Assign a Task and Run with GPT-4.1 Mini, then a second supported model. Test exact-name `factory_status`/`factory_workspace` discovery and repository/Compute Node queries. Include irrelevant advertised optional fields in bootstrap and omit required `exec.command` once: expect normalization or a corrective 400 naming the field, with private audit.
3. Review exact bootstrap, read, edit and test actions. Reject one and confirm no effect. Keep another pending: the Run must stay waiting. Finish a local commit and snapshot, approve publication, and verify the exact commit/tree SHAs and one draft PR in the original repository.
4. Deliberately fail CI, read feedback for that exact head, approve a repair, and advance the same PR. Record actual CI and Preview URLs, or explicit absence. Old green evidence must not satisfy a new head. No merge, release or deployment authority is granted to the Agent.
5. Start a new attempt and verify prior receipts/checkpoint context prevent needless repeated edits/tests. A Run that only reads metadata must not mark coding work complete. After inference finishes, inspect private requests, decisions, errors and receipts. The Task must link the latest private Run.

## Durability, limits and authority

- Cloud: stop/replace the container between acknowledged operations; restore full pinned history, local commits, staged/unstaged/untracked source and receipts. Dependency caches/build output may rebuild. Interrupt a command and a checkpoint separately: uncertain effects remain held and never rerun. Check the pinned image and explicitly changed-image handling.
- VPS: restart the daemon and host, verify actual loop-backed disk capacity and remount, exact receipt replay without command replay, and a second Task's disk isolation. Confirm missing mount/loop support fails closed.
- Exercise configured timeout, memory pressure/OOM, process/disk/code-storage quotas, no-network denial and exact reviewed HTTPS hosts. Inspect capacity failures before declaring recovery; do not discard source or change providers.
- Revoke the Node, change Agent Role/assignment/Project/base/image and cancel a Run while work is pending/executing. No stale approval or token may execute. Verify cross-Server/Task restore and private Run denial, and absence of App keys, account tokens, Server secrets or upstream write credentials in the Task container.
- Pause/disable Factory, export retained source, re-enable and repeat activation/approval without duplicate resources. Explicit release alone deletes Task source. Backups and unrelated Servers/resources remain intact.
- Inspect desktop and narrow/mobile setup, role scopes, progress/error feedback, exact approval UI and current PR/CI/Preview links. Record slow/503 paths with provider request IDs and latency, without credentials or private source.

Attach reproducible results, release SHA, runtime/provider versions and safe screenshots/links to the combined implementation PR. Report failures with their exact step and retain uncertain receipts/source. Do not close foundation acceptance trackers #289/#307/#309/#310/#336 merely because fixtures pass.
