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

Runs are durable, bounded attempts. Sessions and archived context belong to one Agent and conversation. Every model/tool request reloads current roles and checks the saved ceiling. Removal, pause, reduced role or resource access revokes execution. Defaults are 15 minutes, 20 model steps/calls, 100 Server tool calls and 64,000 tokens per Run; admission also limits each Agent to two concurrent Runs, 50 admissions and 250,000 tokens per 24 hours. Queued work shares conversation context sequentially. A tool with an uncertain outcome is never silently replayed.

Web research requires `browseWeb` and configured Browser access or `EXA_API_KEY`. Search returns source URLs and excerpts. Table records and Documents use the same scoped operations as HTTP and MCP. Agents with `executeTasks` can create assigned Tasks and execute them through `execute_task`; child work inherits the original ceiling, has a maximum nesting of two, and consumes the same daily Agent budget. Computer tools additionally require `useComputer` for both the Agent and initiator, and a task-backed Run. Agent results go to review rather than asserting work is accepted.

Schedules support one-time, daily and weekly reminders and task execution. They retain their original role/resource ceiling, preserve the chosen wall time across DST, skip missed repetitions, and deduplicate each occurrence. Current membership and grants are checked before delivery. Changing permissions can block an existing schedule; create a new mandate after reviewing the new role. Manage your schedules at `/schedules`.

### VPS executor

Build both images from the checked-out release, then select their immutable digests in `LLLL_AGENT_IMAGE` and `LLLL_AGENT_RUNNER_IMAGE`. Add `self-host/compose.agents.yml` to the Server Compose command, and configure a separate 32+ character `LLLL_RUNNER_TOKEN`, persistent `LLLL_SERVER_ID` and Compose project name `LLLL_PROJECT`. The trusted Runner has Docker control. Agent containers have no Docker socket, public internet route or provider/production credentials; they run as a non-root user with a read-only root, limited CPU/memory/PIDs and a per-Run volume. The Server joins their private network solely to provide the authorized gateway. Results/context are archived before compute and its volume are removed.

### Cloudflare executor

Add the optional `AGENT_COMPUTE` binding for `AgentComputeDurableObject`, a new SQLite class migration, and a Container with `scheduling_policy: "durable_object"` and named `images.pi` pointing at `packages/agent-runtime/Dockerfile` with repository-root build context. The adapter uses the direct Container API, denies public egress and intercepts only the Server gateway. These provider-specific settings stay outside the Pi protocol. Run application builds/deployments only through Workers Builds from Git. The isolated Server Preview supports `LLLL_PREVIEW_PI=1`; it never changes production or customer Servers.

The Docker proof uses the real Pi SDK with a deterministic model fixture; it proves execution/isolation/recovery, not real-model quality. A Cloudflare Preview and authenticated product acceptance are separate required evidence. See [implementation plan](agent-plan.md) for remaining work.
