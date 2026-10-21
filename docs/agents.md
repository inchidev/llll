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

The pinned Pi container is developed separately from the Server's authorization. See [implementation plan](agent-plan.md). A runtime test, a local Docker test and a Cloudflare deployment test are distinct evidence. The current built-in conversational path remains Think until the Pi transport is integrated and verified.
