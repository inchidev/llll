# Workspace development plan

L4 is a workspace for humans and agents. This document records the agreed direction and the work remaining after 0.2.16. It is a development plan, not a list of shipped capabilities.

## Product model

- A Server owns its local Accounts, Members, Roles, conversations, Projects, Tasks, connections and data.
- Humans and Agents participate in the same channels, threads and Direct Messages. An explicit mention addresses an Agent; an Agent DM needs no mention. Participation in a thread should support natural follow-up without repeatedly mentioning the Agent. Continuous channel monitoring is a separate opt-in behavior.
- Authorized conversation context is available on demand. Reading a thread does not grant access to unrelated conversations or private sources. Results return to the permitted conversation; moving information from a private source to a broader audience needs publication authority.
- A Project gathers a goal, Tasks, repository references, materials and related conversations. Projects and Tasks do not require code repositories.
- A Task records the request, acceptance criteria, responsible human or Agent, discussion, source-message links and results. Assignment and execution are distinct; explicit start, create-and-run and configured automatic admission should be supported.
- A Task can outlive individual Runs. Waiting for CI, review or another Agent is a durable state, not failed execution. Workspaces preserve work across execution attempts.

## Roles and Agent templates

Keep one authorization system for humans and Agents. Each Member keeps one Server Role. Reusable Project policies supply Developer access in Project A and Reviewer access in Project B. Assign a policy directly to a Member or to a Server Role inside a Project; do not create a separate Role or policy definition for every Project.

Project policies add rights. Existing Server Role grants still apply, so assigning Reviewer cannot remove broader Developer rights granted by a Server Role. Resolve each permission together with its target Project and resource; never flatten permission bits and allowed Project IDs independently. Server administration remains Server-scoped, and private-channel membership remains a separate access check.

The local implementation includes policy definitions and scoped assignments, searchable lists with create/edit modals, per-Project Task and repository checks, and saved Run authority. Assignment removal, replacement or policy-version changes revoke affected Runs; adding a grant never expands an existing Run. Existing installations receive policy definitions without automatic assignments. This has local unit, HTTP and browser verification, not isolated Preview or real-model provider acceptance.

The initial Reviewer policy permits reading Tasks and running review/check commands in an authorized repository workspace. It does not permit editing Tasks or proposing code. Publishing a GitHub review needs its own capability and remains pending. Starting a read-only Reviewer Task currently also needs an existing Task discussion or report channel; removing that setup dependency belongs to the execution/autonomy work.

Agent templates propose instructions and a suitable Role. They do not independently grant permissions. Initial templates can cover Coordinator, Researcher, Developer, Reviewer, Maintainer and Release manager. Changes to a template do not silently change existing Agents.

Add distinct capabilities for code review, merge, release, deployment and delegation. Managing an Agent profile does not grant those capabilities. Project/repository policies may require exact-head CI, independent review or human confirmation for specified sensitive actions. Ordinary permitted work proceeds autonomously.

A Coordinator can delegate selected work to selected Agents in a Project under authority explicitly granted by an authorized human. It need not receive its Developer's shell rights. The receiving Agent retains its own limits; preserve the initiator and delegation chain, and prevent privilege laundering or automatic Agent ping-pong.

## Execution and connectivity

- Replace blanket model-tool write/outbound prohibitions with per-action authorization. Remove per-operation human review for work already authorized by Role, scope and task mandate. Preserve revocation, private-source boundaries, isolation and uncertain-outcome handling.
- Internet access is a normal permission for research and development: documentation, package installation and authorized services. Separate public internet, credentialed connections and private-network access. Keep service credentials in the broker and protect host/cloud administrative endpoints.
- Use large configurable task budgets, including delegated work and retries. Proposed starting points are hundreds of model calls, thousands of tool calls and hours of active work. Final model/time/spend defaults remain to be chosen. Waiting does not consume active execution time. Detect repeated failures and lack of progress rather than relying only on tiny call limits.
- New VPS Task workspaces have 10 GiB of disk. Preserve existing 1 GiB Nodes and their retained work; never resize or replace them implicitly.
- Enable a recommended compute node by default on supported VPS and Cloudflare installations where feasible. Detect prerequisites and provider availability, respect the operator's installation choice and paid usage authorization, and keep the base Server usable if compute cannot start. Installer implementation and live acceptance remain pending.
- Local workspace HTTP previews are deferred. Existing repository CI and previews remain useful evidence.

## Interface and release work

Use Projects, Tasks, Repositories, Agents, Task workspace and Compute node in product copy. Remove the former Factory feature branding. Internal identifiers and immutable released assets are compatibility details, not product names.

Settings show searchable lists. Creation and editing open a modal or a dedicated detail view. Apply this consistently to Git connections, compute nodes, repository configuration and project setup.

Landing promises must match accepted user workflows and clearly explain required connections and compute. Do not advertise autonomous task creation, research or code execution until their paths actually work.

Work locally from remote main in focused changes. Prepare a future release through the existing PR, Preview and release process; do not modify published tags or deploy official Workers from this checkout.

## Acceptance path

Humans discuss an idea in a channel. A Coordinator reads the permitted context and creates linked Tasks. A Developer executes a Task and opens a PR. A Reviewer performs independent review. An authorized Maintainer merges after policy checks. A Release manager prepares and publishes only when its separate release/deployment authority permits it. Progress and results remain visible in the right conversations throughout.

This path needs separate local, isolated Preview and real-provider verification. A connected compute node or a deterministic workspace smoke does not establish real-model GitHub end-to-end acceptance.
