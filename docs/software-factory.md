# Compute nodes and Task workspaces

A human assigns a repository-backed Task to a Pi Agent. The Agent requests workspace operations, the initiating human reviews their exact arguments, and a connected Docker Node executes approved work on persistent Task disk. The Agent makes normal local Git commits, submits a committed snapshot, and requests separate approval to publish those exact commits to one dedicated branch and draft PR in the original GitHub repository. Existing CI and deployment integrations remain authoritative. A repair uses the same workspace and PR, with a new committed snapshot and publication approval.

The reviewed MVP shipped in 0.2.13. Version 0.2.14 repairs the agent-facing discovery/lifecycle findings and adds optional recommended execution setup. Real-provider fresh-install acceptance remains separate from local fixtures; see [the reproducible procedure](software-factory-acceptance.md).

## Recommended setup

**Cloudflare:** install ordinary L4 on Workers Free with Basic KV and no R2 if desired. In Settings → Git choose Enable Factory, connect the owning Cloudflare account, review the optional Containers/Artifacts charges and choose compute size, timeout and process limits. Workers Paid and provider availability are required; the installer never upgrades a plan. The Cloudflare consent includes Artifacts Read and Artifacts Write (`artifacts.read`, `artifacts.write`). Provisioning stops with a reconnect message when that grant is missing. It uploads only checksum-verified released image layers, records the released image on the Server's container, and keeps the same immutable installed Server module, preserving original secrets, UUID, D1, files and Git connections. Return to Settings and activate after the provider probe succeeds. A failed activation stays on the card. R2 is independent.

Each Cloud Task uses an isolated code repository in the Server's Artifacts namespace. Every operation starts the fixed released image, restores the last acknowledged checkpoint, executes as UID/GID 1000, terminates Task processes, and stores full Git history plus staged, unstaged and untracked source before acknowledging its receipt. Private checkpoint commits stay off the upstream commit chain. Dependencies, node_modules, default build/cache directories and process memory are disposable. A container is stopped after the checkpoint, including during subsequent approval waits. There is no assumed uninterrupted container lifetime or nested Docker capability. Default L4 policy is one operation, 0.5 CPU/4 GiB RAM/8 GB temporary disk, 128 processes, 120 seconds per command and a 500 MB retained-object budget; supported activation choices set other size/time/process limits. These are L4 policies, not platform maxima.

Cloud source and Task-repo tokens stay in the outbound Worker. Every request rechecks the exact action lease/current authority and the single repo/service or reviewed HTTPS destination. No original write token, App key or Cloudflare account credential enters the Task. Completed code/checkpoint evidence and receipts persist outside compute. A lost command/checkpoint is uncertain and never replayed automatically. The private Run exposes acknowledged checkpoint/recovery state and an explicit five-minute read capability for exporting just that Task's private code. Pause stops new work/compute and retains source; separately reviewed workspace release deletes source. Image/policy changes require explicit provider replacement and new Tasks after exporting retained work.

**VPS:** the published installer can opt in with `LLLL_FACTORY=true LLLL_SHARED_KERNEL_TRUSTED=1`; existing installations use `sudo llll factory enable --trust-shared-kernel`. Verified release assets include the Node executable, Compute Node service and workspace image. No Git clone, source build or registry is needed. Preflight requires supported Linux amd64, local Docker, at least 17 GiB free disk/2 GiB available RAM and actual loop/mount support. The service path also requires systemd as process 1 (`/run/systemd/system`) and checks that before it writes executor files. A host without systemd — a container, or a machine whose process 1 is not systemd — uses `sudo llll factory enable --trust-shared-kernel --no-systemd`. That downloads the same verified release, loads the workspace image and writes `factory/factory.env`. Start it yourself, from `factory/releases/<version>/`:

```sh
set -a; . /opt/llll/factory/factory.env; set +a
/opt/llll/factory/releases/VERSION/node /opt/llll/factory/releases/VERSION/src/pair-local.mjs /opt/llll/.env
/opt/llll/factory/releases/VERSION/node /opt/llll/factory/releases/VERSION/src/daemon.mjs
```

The environment file has four variables: `LLLL_SERVER_ORIGIN`, `LLLL_NODE_STATE`, `LLLL_WORKSPACE_IMAGE` and `LLLL_SHARED_KERNEL_TRUSTED`. `llll factory status` and `logs` fail with that explanation when systemd is not running. The trusted root service, when systemd is present, pairs automatically after Owner claim using a narrowly scoped host signature, then stores only its private Node connection. Original account secrets are never forwarded to the daemon or Task. Select the recommended connected executor for the repository environment.

The workspace image pin accepts the loaded image id when it equals the published image id, the image config digest, or the OCI index digest. Classic Docker's image store and containerd report different ids for one release; both are checked. The executor records the id that the local daemon actually loaded.

Use `llll factory status|logs|restart|disable|backup` on the VPS. Disable and `remove --keep-source` retain disks and receipts. Factory backups are separate from the Server database/files backup and include backing disk images; copy them encrypted off-host. Changing the image fails before stopping the existing pinned executor: export source and explicitly revoke/pair a replacement for new Tasks. Existing remote Nodes remain available under Advanced setup. A fresh Server install keeps going when only this optional Factory step fails, and says how to retry. Running the installer again with `LLLL_FACTORY=true` on a Server that has no executor prints the same enable command.

The following manual pairing/image instructions are the advanced remote-provider path.

## Set up the Server

1. Apply append-only migration `0023_software_factory.sql` through the normal installation/update or Git Preview build. Do not edit earlier migrations.
2. As the Server Owner, open Settings → Git and create a dedicated GitHub App connection. For first acceptance, select only `inchidev/afterprompt` in GitHub. Existing Apps need **Actions read** and **Deployments read**, in addition to the existing Contents/Pull requests/Issues/Checks/Statuses permissions. These read scopes observe existing automation; they do not configure or deploy it. No administration or protection-bypass permission is requested.
3. Under Compute Nodes, create a one-use pairing code. It expires after ten minutes. Install the Node below on your Linux Docker host. The same outbound protocol works for a Cloudflare Server and a VPS/celld Server; the Server does not need Docker or an inbound route to the Node.
4. Create a repository environment using the original repository for both Source and Working repository, its base branch, exact additional CI check names and allowed preview status domains. Select the connected Compute Node. Assign this environment to a Project repository reference and Task using the existing interfaces.
5. Give the Agent an explicit Role with Read projects, Read tasks, Execute assigned tasks, Use a computer, Send messages and Propose code changes. Scope Projects, boards and repositories to the intended resources. The initiating human must hold the corresponding grants plus Approve Agent actions. Owner invocation never upgrades the Agent Role. Changing Project, repository environment, Task assignment or current grants revokes pending work.

No connected provider means no coding execution. Optional Cloudflare activation and the VPS installer prepare recommended providers; advanced remote Nodes remain supported. Base installation has no Containers dependency, paid fallback or credential fallback. Executable factory publication supports GitHub and Gitea/Forgejo. Gitea publication fetches source through the Server broker and must reproduce each approved commit SHA exactly; new executable files and signed commits cannot be published there. GitLab/Cursor references remain available as metadata.

## Install a trusted Linux Compute Node

The Node is trusted infrastructure with Docker control. Run it under a dedicated operator account on a host used for compute, with Node 24, Docker, `fallocate`, `mkfs.ext4`, `mount`, `umount`, `findmnt` and `losetup`. Run this trusted service as root with loop-device/mount access; it already controls Docker. These privileges are never given to a workspace. Its state directory and private connection file must never be mounted into an Agent container. The workspace image includes Node, Git, Python and ripgrep. Extend and review that image if your repository needs another toolchain.

Build the image from the candidate checkout, push it to your own registry and record its immutable registry digest. The daemon requires `repository@sha256:…` and refuses mutable tags. Build/publish commands below concern your compute image, not an official L4 deployment or production promotion.

```sh
docker build -f packages/compute-node/Dockerfile.workspace -t YOUR_REGISTRY/l4-workspace:REVIEWED_CANDIDATE .
docker push YOUR_REGISTRY/l4-workspace:REVIEWED_CANDIDATE
docker image inspect YOUR_REGISTRY/l4-workspace:REVIEWED_CANDIDATE --format '{{json .RepoDigests}}'
```

Configure a private environment file or service manager. To enter the initial pairing code in Bash without putting it in command history:

```sh
export LLLL_SERVER_ORIGIN=https://YOUR_SERVER
export LLLL_NODE_STATE=/PRIVATE/COMPUTE_STATE
export LLLL_WORKSPACE_IMAGE=YOUR_REGISTRY/l4-workspace@sha256:THE_REVIEWED_REGISTRY_DIGEST
export LLLL_SHARED_KERNEL_TRUSTED=1
read -r -s -p 'One-use pairing code: ' LLLL_PAIRING_TOKEN
export LLLL_PAIRING_TOKEN
sudo --preserve-env=LLLL_SERVER_ORIGIN,LLLL_NODE_STATE,LLLL_WORKSPACE_IMAGE,LLLL_SHARED_KERNEL_TRUSTED,LLLL_PAIRING_TOKEN node packages/compute-node/src/daemon.mjs
```

`LLLL_SHARED_KERNEL_TRUSTED=1` explicitly selects the trusted-code Docker threat model below. HTTPS is required for a remote Server; HTTP is accepted only for local loopback development. Keep `LLLL_SERVER_ORIGIN` configured on every start: restored credentials must match that exact operator-selected origin. The Node stores its validated revocable credential and recovery receipts in `node-state.sqlite` with mode 0600 in a 0700 state directory. Node.js 24's built-in SQLite provides full-synchronous transactions; no additional Node dependency is required. Subsequent starts reuse that connection and do not need the pairing code. No public Node port or public Docker socket is opened. Disable and revoke the old Node in the Server before pairing a replacement; update the repository environment and start a new Task after an image/provider change.

Idle Nodes poll for approved work. Every job is claimed once, then started once under a short lease. Heartbeats recheck current authority. A disconnect, revoke, Run stop, deadline or expired lease aborts the operation. Restart removes only containers labelled with this paired Node and Server, resubmits retained receipts, and never restarts uncertain commands. A validated receipt commits before its callback; acknowledgement removes only the exact action and lease. The private journal holds at most 128 receipts and 64 MiB, and the daemon stops accepting work if it cannot retain a receipt. Retained receipts are private operator evidence; a receipt rejection means inspect the outcome rather than rerun the operation. The host process launcher exposes only fixed Git/Docker/Linux disk tools with separate argument arrays and a trusted PATH. Only the separate container entrypoint interprets an approved shell script, through stdin with fixed shell arguments.

## Source credentials and Git history

The App private key and every upstream Git **write** credential stay in the L4 Server broker. Bootstrap issues a short-lived, single-repository **read** capability to the trusted source-fetch component of the Node. This component runs stock Git in a separate, trusted non-root fetch container with a read-only root, fixed 512 MiB source filesystem, CPU/memory/process/time limits and no Agent execution. It fetches the pinned SHA and its history into a temporary bare repository, exports a Git bundle, attempts immediate token revocation, and deletes temporary source data. It does not implement a Git HTTP proxy.

Only the bundle enters the workspace, through a read-only mount. The read capability is never passed to an Agent, container environment, Git configuration, named volume or receipt. There is no upstream remote in the Agent checkout. Normal local `git log/status/diff/add/commit/rebase` works against the pinned history. Repository or branch changes need a renewed Task; upstream base divergence blocks publication. The source fetch has a time and capacity limit; an oversized history fails explicitly.

Treat this trusted source-fetch component as part of the provider credential broker. Operators who require every Git read credential to remain physically on the Server machine need a separately operated bundle source; that topology is not implemented by the first Docker Node.

## Run, review and repair

Start the Agent on the Task and open its private Run. `factory_workspace` is an object-schema tool compatible with embedded and container Pi. Native Pi shell/filesystem tools remain disabled. Each factory operation records a SHA-256 digest over its exact arguments, Run/Agent/initiator, Task/channel/workspace, frozen repository/base/connection, current authority, pinned image, workspace revision and expiry.

The Run and Task indicate review is required. The private Software Factory panel displays destination repository/ref, identities, Node, image, exact command or file content, timeout, selected network hosts and the committed diff/test receipts. Select the explicit acknowledgement and approve or reject. Approval is for that action only; it does not approve later commands, changed arguments, merge or release. An approved publication must retain exact local Git commit and tree SHAs; a provider mismatch stops before branch publication.

Pi waits using the same durable call identity. Gateway polls only observe that one action; they do not create new commands. Rejected, expired, cancelled, changed or uncertain actions never execute through retries. A completed receipt is idempotent. One active action per workspace and one claimed/executing action per Node prevent concurrent workspace mutations.

Typical Agent sequence:

1. `factory_status` to select bootstrap or resume. For a new workspace request `bootstrap`, then `read` or `exec` to inspect the checkout/history.
2. `write` or `exec` for the bounded edit; `exec` tests and a normal local commit. Every operation receives its own human review.
3. `snapshot` after the worktree is clean. The result includes an immutable snapshot digest, exact linear commits, final text changes and independently stored command receipt digests.
4. `publish` with that snapshot digest, title and description. After approval, the Server reconstructs and verifies each exact Git object, updates only `l4-agent/<workspace-id>`, and creates/reconciles one draft PR in the original repository. It never moves main, force-pushes, merges, releases or deploys.
5. `factory_feedback` observes exact-head checks, commit statuses, Actions jobs/logs and existing deployments. Old green results cannot satisfy a new SHA. Missing/skipped/running/failing evidence stays distinct. Draft PRs may have no preview; no URL is invented. The human can also refresh feedback from the private Run after inference ends.
6. On failure, inspect an allowed job's logs, edit/test/commit in the same workspace, snapshot and approve publication again. The same canonical PR branch advances by fast-forward. Treat repository and CI content as untrusted; it never authorizes egress or writes.

GitHub's native merge state and protections remain authoritative. Configured check names are additional local requirements, not a replacement for classic branch protection or rulesets. An unavailable native protection assessment is unknown, not permission to merge. Feedback pagination/capacity limits are reported as incomplete and prevent a readiness claim. Provider reviews/merge remain on GitHub.

## Limits, persistence and isolation

New VPS workspaces use a preallocated 10 GiB ext4 image mounted by the trusted Node and exposed through a Task-labelled Docker named volume. Existing 1 GiB Nodes retain their original disks and remain supported; replacing a Node is explicit. The filesystem itself enforces capacity, including dependency caches, and is remounted from its persistent image after host restart. The Node permits at most four workspace disks and one temporary source disk; each disk is allocated when needed, and allocation or mount failure never falls back to unbounded host storage. Reserve at least 17 GiB free for the image, one new workspace and Server headroom, and more for concurrent retained Tasks.

Each workspace is bound to one Task, Agent, initiating human, original conversation and exact repository environment. Another human, Task, Server, Node lease or changed conversation cannot inherit it. The named volume retains the checkout and dependency cache while fresh per-operation containers are removed, including after suspend. `release` explicitly deletes that Task disk only after review. Back up Node volumes separately; a Server database backup preserves authorization/audit records, not Docker volume contents.

Commands have 1 CPU, 1 GiB memory, 128 PIDs, a read-only root, non-root UID 1000, dropped capabilities, no privilege escalation and bounded temporary files/output. A Task is limited to 50 operations, 3600 execution seconds and ten publications; a snapshot has at most twenty linear commits and 100 bounded ordinary text files. Workflow paths, binary/symlink changes and large proposals are rejected. Cleanup remains possible after a Task budget is exhausted. Existing Run model/token/daily budgets still apply, and review expires within the Run deadline.

Default command networking is disabled. Explicitly reviewed HTTPS hosts use a separate allowlisted CONNECT proxy; private/rebinding/numeric destinations are denied, DNS cannot bypass the proxy, and no host port is published. Hosts can receive data under an approved command, so review network requests together with that command's contents and repository trust. No background process survives into the next operation.

Docker shares the host kernel. This provider is for trusted operators/code and is not a hard boundary for hostile public tenants. Use a VM/microVM provider and a separate policy before admitting untrusted multi-tenant code. New workspace disk capacity is a hard 10 GiB block-filesystem ceiling; temporary source fetches have a separate hard 512 MiB filesystem. The Linux Node requires loop/mount support and fails closed when unavailable. Fixed filesystems limit disk consumption but do not make Docker or Git object parsing a safe boundary for hostile public tenants. Do not declare hostile-code or stronger-isolation acceptance based on this Docker path.

Windows/macOS hosts, local browser/desktop capabilities, workspace HTTP port previews, shared caches across Tasks, live relocation and provider-neutral VM implementations are outside this Linux MVP. Canonical repository previews are observed through the existing CI provider instead.

## Verification and Grok handoff

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec nuxt prepare apps/site
corepack pnpm test
corepack pnpm --filter @llll/agent-runtime test
corepack pnpm --filter @llll/compute-node test
docker build -t l4-workspace:test -f packages/compute-node/Dockerfile.workspace .
node scripts/test-factory-workspace.mjs
corepack pnpm typecheck
corepack pnpm typecheck:site
corepack pnpm lint
corepack pnpm db:migrations:check --base 77d551f9765d28c0d3b6f819625e317e38bc34de
corepack pnpm model:check
corepack pnpm build:deployment
corepack pnpm test:server
```

The GitHub fixture independently computes Git object SHAs, exercises a failing CI result followed by repair on one PR, rejects old-head logs, unapproved egress, revocation, changed arguments/base, cross-Node leases and uncertain publication replay. The Docker smoke uses real persistent volumes and containers for history, edits, failing commands, commits, snapshot/resume, cross-Task separation, non-root/no-socket/no-credential checks and egress denial. These tests do not authorize a real GitHub installation.

Grok must validate the candidate SHA on a test Server with an explicitly selected `inchidev/afterprompt` installation, actual Pi/model interactions, one deliberately failing CI test and repair, existing preview integration or explicit absence, desktop/mobile review UI, restart/revoke/cancellation and both Cloudflare Server → VPS Node and VPS Server → local Docker topologies. Verify candidate CI and native Server/web Previews without a production release. Keep #307/#310/#309/#336 open until their acceptance criteria are demonstrated; real Linux loop-backed quota/reboot verification and the stronger-isolation policy must remain explicit in the acceptance record.
