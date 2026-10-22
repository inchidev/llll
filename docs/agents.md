# Governed agents

An Agent is a non-human Member with one assigned Role. Its profile contains its name, instructions and model. Assign or change its Role in Settings → Roles → Members; Agents appear in that list alongside people. The Owner role cannot be assigned.

## Role permissions

- Using agents: `useAgents` discovers Agents and permits invocation in accessible conversations. It does not reveal other members' private Direct Messages.
- Administration: `manageAgents` edits profiles; it does not by itself permit private conversations or tool execution.
- Approval: `approveAgentActions` approves pending actions in accessible conversations. External email still requires approval.
- Tasks: `readTasks` reads; `writeTasks` creates/updates; `manageTasks` additionally administers boards and destructive operations.
- Data: `readData` reads; `writeData` edits records and Documents; `manageDatabases` additionally changes structure and deletes resources.
- Autonomy: `executeTasks`, `useComputer`, and `manageSchedules` are separate opt-in permissions, never inferred from an administrator role.

The Role editor selects all or specific Boards, Tables, Documents and Canvases. Selecting no resources permits none of that kind. Grants govern operations; selecting a resource does not grant an operation. Restricted collections cannot create new top-level resources. Role administrators cannot grant permissions or resources they lack.

Internal agent tools check the Agent's own Role plus the initiating person's delegation. Invoking an Agent as Owner never makes the Agent an Owner. MCP independently intersects the current acting Member's role/resource access with connection scopes. Tool access is checked at execution, rather than trusted from model instructions.

## Upgrade behavior

Existing server managers retain Agent use, profile administration and conversational approvals. Existing Task/Data managers retain their previous access. No existing role acquires autonomous execution, computers or schedules through migration. Existing resource access stays unchanged until explicitly restricted.

## Runtime implementation

Profiles choose Think or Pi. Pi uses the same pinned `@earendil-works/pi-coding-agent` 1.3.0 image protocol on Docker and Cloudflare Containers. Existing profiles remain Think; new profiles default to Pi only when an executor is configured. Pi needs Server file storage and a model provider. Provider keys remain at the Server; compute receives a capability for one active Run.

Runs are durable, bounded attempts. Sessions and archived context belong to one Agent and conversation. Every model/tool request reloads current roles and checks the saved ceiling. Removal, pause, reduced role or resource access revokes execution. Defaults are 15 minutes, 20 model steps/calls, 100 Server tool calls and 64,000 tokens per Run; admission also limits each Agent to two concurrent Runs and each Server to four; admission also limits each Agent to 50 admissions and 250,000 tokens per 24 hours. Queued work shares conversation context sequentially. A tool with an uncertain outcome is never silently replayed.

Web research requires `browseWeb` and configured Browser access or `EXA_API_KEY`. Search returns source URLs and excerpts. Table records and Documents use the same scoped operations as HTTP and MCP. Agents with `executeTasks` can create assigned Tasks and execute them through `execute_task`; child work inherits the original ceiling, has a maximum nesting of two, and consumes the same daily Agent budget. Computer tools additionally require `useComputer` for both the Agent and initiator, and a task-backed Run. Agent results go to review rather than asserting work is accepted.

Schedules support one-time, daily and weekly reminders and task execution. They retain their original role/resource ceiling, preserve the chosen wall time across DST, skip missed repetitions, and deduplicate each occurrence. Current membership and grants are checked before delivery. Changing permissions can block an existing schedule; create a new mandate after reviewing the new role. Manage your schedules at `/schedules`.

### Embedded executor (experimental)

An experimental fallback now runs `@earendil-works/pi-durable` 1.4.0 inside the Run Durable Object when neither a Runner nor Cloudflare Containers is configured. It needs the Run DO, file storage and a model provider. This is a text-only executor: Server tools, browser tools, shell and computer tools are not registered. Do not treat it as equivalent to the container executor for Tasks or code work. Cancellation revokes gateway access but currently does not abort the in-flight harness; the coordinator does not yet reopen active submissions after eviction. These are remaining implementation gaps.

Local celld acceptance on 2026-10-23 completed three real OpenRouter model calls, including recall in a subsequent Run and another recall after restarting the celld container. The archive regression test uses the real Pi SDK and checks chronological messages and restoration without duplicates. This is local evidence; it does not certify Cloudflare Preview behavior or recovery of active work after a process failure.

### VPS executor

Build both images from the checked-out release, then select their immutable digests in `LLLL_AGENT_IMAGE` and `LLLL_AGENT_RUNNER_IMAGE`. Add `self-host/compose.agents.yml` to the Server Compose command, and configure a separate 32+ character `LLLL_RUNNER_TOKEN`, persistent `LLLL_SERVER_ID` and Compose project name `LLLL_PROJECT`. The trusted Runner has Docker control. Agent containers have no Docker socket, public internet route or provider/production credentials; they run as a non-root user with a read-only root, limited CPU/memory/PIDs bounded temporary data (512 MiB), bounded logs and no persistent host file mount. The Server joins their private network solely to provide the authorized gateway. Results/context are archived before compute is removed. Losing an active compute process interrupts the attempt; a new attempt restores archived conversation context and never silently replays uncertain external actions.

### Cloudflare executor

Add the optional `AGENT_COMPUTE` binding for `AgentComputeDurableObject`, a new SQLite class migration, and a Container with `scheduling_policy: "durable_object"` and named `images.pi` pointing at `packages/agent-runtime/Dockerfile` with repository-root build context. The adapter uses the direct Container API, denies public egress and intercepts only the Server gateway. These provider-specific settings stay outside the Pi protocol. Run application builds/deployments only through Workers Builds from Git. The isolated Server Preview supports `LLLL_PREVIEW_PI=1`; it never changes production or customer Servers.

The Docker proof uses the real Pi SDK with a deterministic model fixture; it proves execution/isolation/recovery, not real-model quality. A Cloudflare Preview and authenticated product acceptance are separate required evidence. See [implementation plan](agent-plan.md) for remaining work.

## GitHub code work

Settings → Repositories configures a source repository and a separate working fork in the same GitHub network. A task selects that environment; Roles select source repositories by their stable GitHub IDs. Both the initiating Member and Agent require `useComputer`, task access and repository access. The Agent additionally requires `proposeCode` to publish changes. Existing administrator roles do not acquire publication permission.

Configure a **dedicated GitHub App**, separate from login OAuth. Put `GITHUB_AGENT_APP_ID` and its PEM `GITHUB_AGENT_APP_PRIVATE_KEY` in the Server's deployment secrets. Install it only on selected sources and working forks. Grant repository Contents read/write, Pull requests read/write, Checks read and Commit statuses read. The broker mints narrower single-repository tokens per operation: source Contents read; fork Contents write; source Pull requests write; source Checks/statuses read. Tokens and the App key never enter compute. Repository discovery uses metadata-only credentials and revokes them after use.

An admitted Run freezes the environment version, base branch and exact commit/tree. Changing or disabling the environment revokes active Runs and stored schedule mandates. The runtime downloads a bounded source archive through the Server gateway, creates a local Git base, edits files and can run available local checks. Public network access stays disabled: package downloads and network-dependent tests are unavailable in this first runtime. Dependency-heavy projects must rely on their independent CI checks; agent reports are not CI evidence.

`publish_code_changes` gathers local changed text files and creates or updates one Run-owned branch (`l4-agent/<run-id>`) in the working fork, then a draft PR to the source's configured base. Proposals cannot change `.github` or `.git`, force-push, change the base branch, merge, label a release or deploy production. Repeated publication recovers the same branch/PR after an uncertain response. A branch changed outside the Run requires a new reviewed attempt. Required CI names are checked against the exact published commit; missing or failed checks keep it unverified. Preview links must use HTTPS on configured domains; their presence does not prove authenticated product acceptance.

Computer outputs are bounded to 100 changed files and a 2 MB JSON archive, including binary files and deletions; individual files are at most 500 KB. The Run page downloads the archive through current conversation/task/repository authorization. Future attempts restore files only from the same conversation, task, environment version and base commit. Repository archives are limited to 20 MB compressed / 200 MB expanded and 10,000 ordinary files/directories; links and special files are rejected. A fresh base commit starts with fresh files. Results and transcripts remain in private Server storage after ephemeral compute is removed.

MCP `create_table` requires the explicit `data:manage` connection scope plus the current Role's table administration and resource grants. Existing tokens do not gain this scope. HTTP, internal tools and MCP share the same table/record services and current-role checks.

Production publishing stays with the protected GitHub release process: a human reviews and merges a release PR with the release label and shared version increase. That authority and its credentials are outside the agent runtime and GitHub broker.
