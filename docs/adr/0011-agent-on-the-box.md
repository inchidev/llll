# The Agent works on its box

Proposed on 2026-11-07. Items 1 to 7 are built in this pull request; item 8 in part since (below), and Destinations not. Built differently from the text below, or not yet:

- **Model limits:** the window and answer limit come from what the provider reported, then what the Owner set in Server settings → Models for a model whose provider reported none, then Pi's catalog, then a default, capped at 200,000 and 32,000 tokens. Reasoning and image input for Pi are not built: Pi is still told the model takes text and does not reason.
- **Streaming from a box:** the box pushes HTTP batches of events to the gateway, about every 150 ms while text flows, instead of holding a WebSocket to the Run's Durable Object. The answers carry cancellation and steering.
- **Cloudflare checkpoints** at the end of each turn and before a box stops after 10 minutes without a turn, not on every operation. A VPS box stops after 15 minutes; its disk stays.
- **L4 Compute boxes checkpoint too** (amended 2026-11-10). A microVM is billed for as long as it lives, and keeping one for its disk billed idle hours. After 15 minutes without a turn its daemon saves the Task disk to a private per-box Artifacts repository in the same `l4-state` format as a Cloudflare box, through the Server, which holds every token; once the Server has read the checkpoint back, it releases the machine at llll.gg and keeps the checkpoint. The next turn's new machine restores it instead of the pinned source. The checkpoint goes when the Task is Done. A Server without Artifacts keeps the machine until the Task is Done, as before.
- **No Git server on the VPS Node.** The daemon copies the approved commit out of the box with hardened Git in a throwaway container without network, and pushes from that copy with a short token. Git LFS is not built.
- **The Agent's branch** is `<prefix><box id>`, `l4-agent/` by default, not `l4-agent/<task>`. The target is always the repository's base branch.
- **TLS termination on a VPS** happens only for hosts with a bound Project secret; every other open host stays a plain CONNECT tunnel, so pinned certificates keep working there.
- **Item 8, in part (amended 2026-11-10): a screen, a browser, and a person watching.** Every box on a Docker Node or L4 Compute has Xvfb on `DISPLAY=:99`, Chromium and `playwright-core`, so the Agent plays the game it builds. On L4 Compute a person who may read the Task watches the box's screen live: voxl in a viewer container beside the box with no network, behind the daemon's preview gate on the port llll.gg exposes, opened by a 30-minute ticket the Server signs with a key derived from the box's lease. This is a stream of the screen, not the "preview of a box port through the Server's address" the item names: a dev server's own port is still not reachable, and nothing goes through the Server's address, since the provider's HTTPS address carries the stream directly and the Server stays out of its path. A VPS Node and Cloudflare have no viewer. voxl links x264 (GPL), so it ships as a separate program with its source in the image. See [Software Factory](../software-factory.md#watching-a-box).
- **A person may merge a head with no reported checks** (no check, status or Actions job, and no required check in the repository environment) two minutes after its push, and L4 says so. The Agent's merge always needs a passing check and none failed or pending.

Destinations stay deferred, as decided below. The acceptance runs below are not recorded yet. See [Software Factory](../software-factory.md) for what works today.

It is one plan for a fast Software Factory, built in one pull request with this decision and released together. It builds on [Compute is the business](0009-compute-as-the-business.md): Factory is what spends Compute, so a slow Factory is a small business.

## Problem

An Agent doing code work today is a brain in a Worker and hands on a remote machine, joined by a queue in D1. Every command, even `ls`, is a job:

1. The Agent calls `factory_workspace`; the Server writes a `factory_actions` row.
2. The Node polls for work every second (`packages/compute-node/src/daemon.mjs`), claims the job, then begins it with a second request.
3. The Node starts a fresh container for the command, and for network access also an internal network and a proxy container. On Cloudflare each operation also starts the container, restores a checkpoint from Artifacts and saves it again.
4. The Agent polls the result every 250 ms (embedded Pi) or 2 s (container Pi).

Seconds per command where a coding agent on its own machine takes milliseconds. On top of that:

- **One operation per Node.** A Node claims nothing while another of its actions is claimed or executing (`server/utils/compute-nodes.ts`). Ten Agents on one VPS run one command at a time, against the whole point of ADR 0009.
- **Commits rebuilt through the API.** Publication recreates each commit through GitHub's Git Data API from the Worker, with file contents inline in JSON, from a snapshot kept as one string in D1 (`factory_workspaces.snapshot_json`). Hence 100 text files per snapshot, 80 KB per file, 85 KB per commit, 350 KB per snapshot, twenty commits and no binary files. A `package-lock.json` alone fails it; a game's sprites or a Worker's assets cannot be proposed at all.
- **A crippled model.** Embedded Pi is told the model has a 24,000-token window, 4,096 output tokens, no reasoning and text-only input (`workers/agent-pi-durable.ts`); container Pi gets 64,000 (`packages/agent-runtime/src/pi.mjs`). Pi compacts at about 20,000 tokens with a model that holds 200,000 or more, so the Agent keeps forgetting, and cannot write a large file in one answer.
- **No streaming.** A conversation sees "Working" or "Using a tool" and then one final message. Text deltas are written to D1 as Run events (`workers/agent-run-do.ts`) and never shown.
- **No way out.** No secrets for a Project, no approved writes to other services, no merge from L4. Two real flows stop here: a Telegram game deployed to the operator's Cloudflare from one conversation, and games for AfterPrompt with generated art and a playtest ([#43](https://github.com/inchidev/llll/issues/43)).

The per-command design existed so that every command could be reviewed and no credential reaches the Agent. The default execution mode is already `role`, autonomous within the Agent's permissions, so most Servers pay for per-command review they do not use. exe.dev shows the other way: the agent lives on a real machine with real Git, and credentials are added at the network edge, so the machine never holds them.

## Decision

**The Agent lives on its box.** A Task that needs code work gets one box for the life of the Task, not a container per command. The Pi loop runs inside it with Pi's own shell, file and edit tools, which container Pi has today and keeps disabled. Commands, tests, builds and Git run locally at local speed. The box calls models through the Server's gateway with a credential scoped to the Run; provider keys, budgets and the audit stay on the Server, as they do for container Pi now. Embedded Pi in the Run's Durable Object stays for Runs without code work.

**Where the box runs**, all speaking one Node protocol:

- **Own VPS.** The published daemon keeps a container per Task running while the Task is active and stops it when idle; its disk persists until the Task is Done, as today.
- **Own Cloudflare.** A container per Task that sleeps when idle. Its disk is temporary, so a checkpoint goes to Artifacts when the box goes idle or a turn ends, not after every operation. The checkpoint code in `workers/factory-compute.ts` stays.
- **L4 Compute.** A microVM per Task from `llll-cloud`, running the same daemon (ADR 0009).

A Node announces its capacity (CPU, memory, boxes) and the Server places Tasks within it. One active box per Task stays; the lock of one operation per Node goes.

**Real Git, with the content in Git.** The box has an ordinary repository. Its remote is the Project's repository: on GitHub or Gitea, or, since [ADR 0013](0013-artifacts-git-provider.md), a repository the Server holds itself in Artifacts. On Cloudflare the box's working disk is also checkpointed between turns into a private per-box repository in the Server's Artifacts namespace, which is a checkpoint, not the Project's history; on a VPS Node a Git server run by the trusted daemon (on its own internal network, never a writable mount) plays the same role. Binary files, lockfiles and large changes are ordinary commits. Large generated assets use Git LFS against the Server's file storage. D1 keeps only SHAs, statuses, receipts and digests. Anything large (diffs for review, logs, receipts' output) is in Git or R2, never in a D1 row. Review approves a commit SHA; Git's hashes already guarantee the content.

**Credentials are added on the way out.** The box holds no token. Each request leaving it passes the trusted egress layer, which adds the credential for that destination:

- On Cloudflare, the outbound Worker does this already for Artifacts and the source fetch (`workers/factory-outbound.ts`).
- On a VPS, the daemon's proxy, which passes connections through unopened today, becomes a TLS-terminating proxy with a per-box certificate authority installed in the box.

**The network is closed, with windows.**

- **Presets:** npm, PyPI, crates.io and GitHub read access, chosen per Project.
- **Project hosts:** set by an Owner or Space admin, such as an API the Project's code talks to.
- **A Task window:** the Agent asks for a host, a person opens it for a stated time.

**Secrets belong to a Project.** An Owner or admin enters a value once; nobody, Agents included, reads it back. Each secret is bound to the hosts it may go to. The Agent sees a placeholder such as `L4_SECRET_TELEGRAM_TOKEN`, and the egress layer replaces it in headers, URL or body only on a request to a bound host. A window without a secret gives the Agent the network and nothing else. A token pasted into a conversation is history readable by its members and sent to the model; this is the place for it instead.

**Publication is a push, and the human gate moves to what leaves the box.** The Agent pushes to `l4-agent/<task>` in the original repository through the egress layer. On Cloudflare the outbound Worker reads the ref commands at the start of the `git-receive-pack` request and refuses any ref but that one. On a VPS the trusted daemon pushes from its Git server with a short single-repository token. Afterwards the Server checks that the remote head equals the SHA it allowed. The modes keep their meaning, applied to outward actions instead of commands:

- `role`: the Agent pushes, opens windows within presets and uses bound secrets on its own.
- `plan`: one approved plan covers the hosts and secrets it names.
- `review`: every push, new window and use of a secret waits for the person, with the diff read from Git.

**Each Project has its Git flow.** Its target branch, its branch prefix for Agents, who merges (only a person, which is the default, or the Agent after the required checks pass, or a direct push to the target branch for experiments) and the merge method. GitHub's branch protection is always the ceiling: L4 narrows it, never widens it. A person merges from the Task in L4; the GitHub App's Pull requests write is enough.

**Factory ends at the merge; deployment is the repository's own business.** Whatever builds from the target branch, whether Workers Builds, Coolify, Fly or Vercel, stays authoritative and is configured by the team, not by L4. `factory_feedback` shows its checks and deployments as it does today. Setting up deployment targets from L4 (Destinations: a Cloudflare connection for Projects separate from the Server's own grant, the AfterPrompt publish API, approved outbound MCP writes) is deliberately out of this plan and gets its own decision later.

**The model is told the truth.** Context window, output limit, reasoning and image input come from the model's own description: Pi's model catalog first, if it has one, then a table in L4, then Server settings for a custom model or OpenRouter. Compaction keeps a share of the real window instead of 6,000 tokens. Reasoning is on where the model supports it, with an effort setting.

**Replies stream natively, for every Agent Run, with or without a box.** When a reply starts, the conversation's ChannelDO shows a message in a writing state. Deltas go over the conversation's existing WebSocket as transient events, buffered in the ChannelDO's memory, so a reconnecting client gets the text so far. The finished message is written to D1 once, and push notifications fire on it only. Tool steps and review waits show in the message as collapsible steps. Run events in D1 keep steps, not text deltas.

- **Embedded Pi:** the Durable Object forwards deltas as they come.
- **Box:** the Pi loop holds one outbound WebSocket to the Run's Durable Object, replacing the poll for events.
- **The unused `agent_turns.draft_message_id`** goes with the old progress-only path: streaming is not a draft message edited in D1.

**The per-command protocol is removed entirely, without compatibility or a transition period.** Nothing of it has users. The following go:

- `factory_workspace` with its `exec`, `read`, `write`, `snapshot` and `publish` operations;
- per-command `factory_actions`;
- `snapshot_json`;
- the proposal limits in `packages/compute-node/src/operate.mjs`;
- the per-operation container start.

The Agent keeps Pi's tools and gets a few L4 tools: `factory_status`, `factory_publish`, `factory_feedback`, `request_network_window` and `factory_merge` where the Git flow allows it. The schema change is one migration in one release, as the release rules require.

## Work, in order

All items land in one pull request with this decision, one commit or more per item; the release ships when items 1 to 7 are in it and the acceptance runs pass. No baseline is measured first: the current path is slow by construction.

1. **Model limits from the model.** Window, output, reasoning, images, compaction share; Server settings for custom models.
2. **Native streaming** in conversations, embedded Pi first, then boxes. This is not optional and not deferred: it ships in the same release.
3. **Node capacity** instead of one operation per Node; the daemon reports slots.
4. **The box.** The daemon runs a long-lived Task box with container Pi and its native tools, the model gateway credential per Run, and the Cloudflare container that sleeps and checkpoints on idle.
5. **Git in the box.** Artifacts or the Node's Git server as remote, LFS on the Server's storage, push to `l4-agent/*` through the egress layer, SHA approval, review diffs read from Git. Removal of `snapshot_json`, the proposal limits and the per-command protocol.
6. **Windows and secrets.** Presets, Project hosts, Task windows; Project secrets with bound hosts; the TLS-terminating proxy on VPS Nodes.
7. **Git flow and merge.** Project Git flow settings, merge from the Task, the Agent merge after checks where allowed.
8. **After the release.** Image generation through the gateway with a receipt and the Run's budget, written into the box; a preview of a box port through the Server's address so a person can try a build; Chromium and Playwright in the box image for playtests; creating a repository from a Project (needs Administration on the GitHub App, and its behaviour on a personal account must be checked). Destinations are a separate, later decision.

## Acceptance

- **Local speed.** A command in the box makes no request to the Server: `git status` in a box takes what it takes on the host.
- **Parallel work.** Four Tasks on one 4-vCPU VPS Node run at the same time, none waiting on another's command.
- **Streaming.** The first words of a reply appear in the conversation within a second of the model sending them, on web and phone.
- **The Telegram experiment.** In a conversation, from a phone, after connecting GitHub once:
  - a change with images and a lockfile;
  - a bot token as a Project secret, used by the Agent against `api.telegram.org` through a window;
  - a pull request merged from L4.

  The repository's own build deploys it. Nobody opens GitHub or a browser on a computer for the code.
- **A game.** A Task produces a web game with binary sprites committed in Git, and its Agent loads it in the box and reports a screenshot and console errors (with item 8).
- **Nothing in the box.** No provider key, Git write token or secret value is readable in the box's filesystem, environment or process list; the tests check it.

## Unknowns

- **Artifacts.** Repository size limits, LFS support and pricing at many Tasks a day.
- **Containers.** Whether `interceptOutboundHttps` can read the start of a request body to check `git-receive-pack` ref commands, and how long a sleeping Container keeps its disk.
- **Pi.** Whether its packages expose a model catalog with limits, and what its compaction trigger is exactly.
- **VPS egress.** The cost and failure modes of a TLS-terminating proxy for package managers that pin certificates.
- **celld.** It has no containers and no Artifacts, so Factory there always needs a Node, with the Node's Git server as the remote. Check that this is the whole story.
- **Isolation.** The Docker path stays for the operator's own trusted code. Commands from untrusted authors need microVMs, as ADR 0009 says.

## Consequences

- Factory becomes as fast as the box it runs on, and its Compute hours are spent working instead of waiting on queues.
- Per-command review goes away for everyone; review moves to pushes, merges, windows and secrets. An operator who wants every command reviewed has no such mode any more.
- The security boundary is the box plus its egress layer, as on exe.dev and for Claude Code on a developer's machine. The tests for "nothing in the box" become the most important tests of Factory.
- `docs/software-factory.md` and `docs/agents.md` describe the box; nothing of the per-command Factory is documented any more.
- Codex CLI and Claude Code do not run in the box: the L4 Agent is Pi. A ChatGPT plan keeps working through the gateway; using a Claude subscription inside the product stays out under Anthropic's terms. An external Agent can still work through the Server's MCP.
- The game flow from #43 is covered by items 5, 6 and 8 except publishing to AfterPrompt, which waits for Destinations; that issue is closed in favour of this plan.
- L4 does not learn how a team deploys. A team on Coolify, Fly, Vercel or Cloudflare keeps its own pipeline and sees its result in the Task.
