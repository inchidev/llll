# Governed agents

An Agent is a non-human Member with one assigned Role. Its profile contains its name, instructions and model. Creators with Manage roles can choose its Role in the creation dialog. Assign or change its Role in Settings → Roles → Members; Agents appear in that list alongside people. The Owner role cannot be assigned.

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

All profiles use Pi. The default embedded executor uses `@earendil-works/pi-durable` 1.4.0; Docker and Cloudflare Containers use the pinned `@earendil-works/pi-coding-agent` 1.3.0 protocol. Runtime names are internal and there is no runtime selector. The former Think engine is retired; old profile metadata is normalized to Pi, and no Think context is imported. Pi needs Server file storage (KV or R2) and a model provider. Provider keys remain at the Server; compute receives a capability for one active Run.

Runs are durable, bounded attempts. Sessions and archived context belong to one Agent and conversation. Every model/tool request reloads current roles and checks the saved ceiling. Removal, pause, reduced role or resource access revokes execution. Defaults are 15 minutes, 20 model steps/calls, 100 Server tool calls and 64,000 tokens per Run; admission also limits each Agent to two concurrent Runs and each Server to four; admission also limits each Agent to 50 admissions and 250,000 tokens per 24 hours. Queued work shares conversation context sequentially. A tool with an uncertain outcome is never silently replayed.

Web research requires `browseWeb` in both the Agent’s Role and the initiating member’s authority. Search uses `EXA_API_KEY`, or the OpenRouter web-search option in Server settings. Public page reading additionally uses configured Browser access. Search returns source URLs and excerpts. Table records and Documents use the same scoped operations as HTTP and MCP. Agents with `writeTasks` can create Tasks; `executeTasks` permits executing assigned Tasks through `execute_task`; child work inherits the original ceiling, has a maximum nesting of two, and consumes the same daily Agent budget. Computer tools additionally require `useComputer` for both the Agent and initiator, and a task-backed Run. Agent results go to review rather than asserting work is accepted.

Schedules support one-time, daily and weekly reminders and task execution. They retain their original role/resource ceiling, preserve the chosen wall time across DST, skip missed repetitions, and deduplicate each occurrence. Current membership and grants are checked before delivery. Changing permissions can block an existing schedule; create a new mandate after reviewing the new role. Manage your schedules at `/schedules`.

### Embedded executor (experimental)

The embedded executor runs `@earendil-works/pi-durable` 1.4.0 inside the Run SQLite Durable Object when neither a Runner nor Cloudflare Containers is configured. It needs the Run DO, file storage and a model provider. Its registered L4 tools use the same Server gateway, current role checks, delegation ceiling, call IDs and result ledger as container execution. Tasks, Data, schedules, web search and configured Browser reads are available only when authorized. There is no local shell or filesystem; do not treat it as a container for arbitrary code execution.

A durable input snapshot and stable submission ID let polling reopen active SQLite work after eviction. Recorded tool results can be read again; uncertain external writes are refused. Stop aborts the harness and in-flight inference, as well as revoking further gateway access. Model output and tool activity stream into bounded Run events and conversation progress. Archives are chunked atomically into bounded SQLite rows; automatic context compaction uses the same inference gateway and budget.

Local celld acceptance on 2026-10-23 used a real OpenRouter model, called `list_tasks` and `search_web`, returned a direct documentation URL, and cancelled an active model call without publishing a result. An independent process test kills execution with SIGKILL after a tool’s external write and resumes from SQLite: the user input and write each occur once. Other tests cover archive ordering, steering at a tool boundary, duplicated steering delivery, permission revocation, inference budgets and multi-megabyte Unicode archive storage. These are local and fixture results; Cloudflare Preview acceptance remains a separate release check.

### Model providers and conversation controls

Server settings → Agents → Model providers stores API keys encrypted with the Server’s `AUTH_SECRET`. Only the Owner can replace credentials, enable a provider, enable OpenRouter web search or choose the Server default. Members with `useAgents` can see available model IDs, never credentials. A blank key preserves the saved key. OpenRouter, Claude and ChatGPT are available through Pi; no alternate agent engine is offered. Legacy bare model IDs retain their deployment endpoint or resolve to one unambiguous enabled connection. Disabled and ambiguous selections fail with an actionable error, never silently falling back to another model. Disabling a saved provider fails closed; importing OpenRouter suppresses the corresponding legacy deployment option. The import action never sends the deployment key to the browser. Existing deployment bindings remain a compatibility fallback until imported.

- OpenRouter: Chat Completions with an API key. Its optional web search plugin is a separately billed, role-gated tool, with at most three sources per search and the Run’s model/token budget.
- Claude: Anthropic API key. Claude Pro/Max subscription authentication is not implemented in embedded Pi. Do not collect Claude.ai credentials or reuse subscription OAuth tokens as shared Server API credentials; see [Claude authentication boundaries](https://code.claude.com/docs/en/legal-and-compliance).

In a one-to-one Agent conversation, the toolbar above the composer selects the provider/model for future Runs, switches Queue/Steer and stops outstanding work. Threads inherit the parent conversation’s model selection. An admitted Run snapshots its model; changing the picker does not switch an in-flight generation. Every root invocation opens a thread in a DM or channel; replies inside that thread keep using it. Queue runs admitted into the same thread share context sequentially. Failed runs post an error with a link to details. Only the initiating Member can retry a stopped Run, under their current permissions. On embedded Pi, Steer adds the initiating member’s new instructions at the next tool boundary of their active Run, using a stable message ID. It cannot inject instructions under another member’s delegation. The interaction follows the [T3 Code composer](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md); container adapters currently queue when steering is unavailable. Agent conversations appear in the dedicated Agents app, separately from human Chat.

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

## Model connections

The Server owner manages connections in Server settings → Agents → Providers. Agents and Providers have separate searchable, paginated lists. Model defaults appears before the provider list. The owner-only Audit tab separates Run status and usage from agent-related configuration changes and actions; both views support search and pagination, and Run rows omit prompts and transcripts. A row opens Run details with its prompt, events, selected model, individual model requests, safe provider errors, archived transcript download and retry. Access is rechecked against the conversation and any Task/code environment. Multiple connections of the same provider type can have distinct names. API-key connections show only a masked key fragment to the owner. Model catalogs come from the provider; choose models by name instead of entering IDs. The conversation picker combines the connection name and model, and searches a bounded model page on the Server.

ChatGPT / Codex uses **Continue with ChatGPT** with the [official open-source OAuth flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). Pi remains the runtime. The owner authorizes ChatGPT plan usage; that connection can pay only for Runs initiated by that same member. It does not sign anyone into L4, link local Accounts, or grant membership. Tokens and refresh credentials are encrypted on the Server and never passed to Pi. Model selection and inference use the public OpenAI API and the account's model catalog. Live ChatGPT authentication/inference has not been accepted yet; OAuth, renewal, identity validation and stream termination have fixture coverage.

For a local HTTP Server, the browser returns to `127.0.0.1` on the Server port. A remote Server offers a downloadable Node 24 sign-in helper: run the displayed command on the computer hosting the browser. The helper listens only on `127.0.0.1:1455`, opens OpenAI sign-in, and relays the one-time callback to the chosen HTTPS Server. It writes no credential file. Removing a ChatGPT connection stops local use and attempts to revoke the renewable session; if remote revocation fails, disconnect L4 in ChatGPT settings.

In an agent DM, a message starts a reply thread. Direct Run admission into the DM root is rejected. New messages queue in send order across that DM's threads; **Steer** on an already queued message submits it to the sender's running embedded Pi attempt at its next tool boundary. If steering is unavailable, the message stays queued. If delivery is uncertain, it is not executed a second time. **Stop** appears while the agent is working and cancels pending work before the active attempt. Separate conversations can run concurrently within the existing limits.

## Model selection and task completion

Connecting a provider adds choices; it never selects the first model as a Server default. Choose the default explicitly in Providers, or select an Agent/conversation model. A disabled default does not fall back to another model. Explicit operator model configuration remains supported; an AI binding by itself does not enable a default. Workers AI appears as a deployment connection whose account access, quota and compatibility are verified on use. Known OpenRouter models without tool support are excluded from Agent choices; missing capability metadata is not proof of incompatibility.

Task execution requires Read tasks and Execute assigned tasks, plus access and Send messages in the report conversation, for both the Agent and initiator. Admission checks these before inference. Completion can record only that Run’s result on its assigned, unchanged Task; it does not grant general task editing. Results move to Review. Human changes, reassignment and archival are preserved.

Assignment alone does not start execution: Ready means available for an explicit start. Choose **Create and run** when creating an Agent-assigned Task with a report channel, or **Run assigned agent** on a saved Task. Both actions use the same authorization and admission checks. Conversation reports identify the Task number, title and current status, link back to its board and detail, and include the result below.

Computation, Task-result recording and report delivery have independent states on the Run page. Delivery failures retain the computed result. Pending delivery retries are bounded; only the original initiator can explicitly retry blocked delivery, under current permissions and the saved mandate. Retrying delivery does not call the model. Successful delivery is not posted twice.

Every model request includes the current UTC time and Server timezone (UTC by default). The `get_current_time` tool refreshes this reference during longer work. Ambiguous scheduling timezones still require clarification.
