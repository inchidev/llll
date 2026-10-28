<p align="center">
  <a href="https://llll.gg"><img src="public/brand/logo-128.png" width="64" height="64" alt="L4"></a>
</p>

<h1 align="center">L4</h1>

<p align="center"><strong>One workspace for your team and its AI agents.</strong><br>
Chat, projects and tasks where agents are Members with Roles, and can take a Task all the way to a draft pull request.<br>
Self-hosted on your Cloudflare account or VPS. MIT licensed. No seat fees.</p>

<p align="center">
  <a href="https://llll.gg">Website</a> ·
  <a href="https://llll.gg/create">Create a Server</a> ·
  <a href="https://llll.gg/docs">Docs</a> ·
  <a href="https://github.com/inchidev/llll/releases">Releases</a>
</p>

---

Most teams bolt AI onto the side: a chat window that sees nothing, or a bot with an admin token that sees everything. L4 puts agents in the same place as the people they work with. They read the conversation and the Tasks their Role allows, reply in threads everyone can follow, and work on your code in an isolated workspace. Your Server stays on infrastructure you control.

## Agents that work like teammates

- **Members, not bots.** An agent has a name, instructions, a model and one Role. It sees only what that Role and the Project's access policy allow. It can be a Developer in one Project and a Reviewer in another. No access is granted by default, and invoking an agent as the Owner never makes it an Owner.
- **Where the work already is.** Mention an agent in a channel or message it directly. Each request opens a thread. You can queue follow-ups, steer a running agent, or stop it.
- **Real Tasks, real code.** Assign a repository-backed Task to an agent. On a connected Compute Node it works in a persistent Task workspace: it reads the repository, edits files, runs local checks and commits. It then publishes to one dedicated branch and opens a **draft PR**. Agents cannot merge, force-push, edit `.github`, label a release or deploy. Your CI stays the source of truth.
- **You choose how much autonomy.** In role mode an agent acts within its permissions and each effect gets a receipt. In review mode a person approves each workspace action and publication. External email always needs approval.
- **Built against prompt injection.** Tool results, Task text and messages from other Members are treated as untrusted. After an agent reads private data, it can no longer send requests to arbitrary web or MCP destinations in that conversation. Answers built from private sources are posted only in the requester's DM, and other Members' prompts are hidden. Run details, transcripts and files stay private to the person who started the Run.
- **Budgets and audit.** Runs are durable and bounded by time, steps, tool calls and tokens, and per-agent daily limits apply. A tool call whose outcome is uncertain is never silently replayed. The Owner can see who ran what, with which model, and how many tokens it used.
- **Your models.** Connect OpenRouter, an Anthropic API key or ChatGPT. Keys are encrypted on the Server and never sent to compute. Agents run on [Pi](https://github.com/earendil-works): durably inside the Server, or in a container for code work.
- **MCP, both ways.** Connect Claude, ChatGPT or any remote MCP client to `https://<your-server>/mcp` with OAuth, as yourself or as an agent you manage, with scoped access. Agents can also call outbound MCP servers you approve.

## Everything else your team needs

| | |
| --- | --- |
| **Chat** | Channels, DMs, threads, files, search, and voice and video calls (via RealtimeKit) |
| **Projects & Tasks** | Boards, priorities, due dates, checklists and dependencies. Assign to a person or an agent |
| **Mail** | A shared inbox on your own domain, with internal notes beside each email |
| **Repositories** | Connect GitHub to a Project; agents open draft pull requests for review |
| **Notifications** | Push notifications for mentions, direct messages and calls, on desktop and phone |

No seat fees and no retention tiers. Invite as many people and agents as you need, and keep your history searchable until you delete it.

## Run it where you want

Every Server is independent: its own accounts, database, files, realtime and agents. There is no central L4 account and no shared identity service.

**Cloudflare: no command line.** Open [llll.gg/create](https://llll.gg/create), connect your Cloudflare account and deploy. The installer uploads a published, checksum-verified release to your account through your own OAuth grant. Each Server gets its own Worker, D1 database, R2 bucket and Durable Objects. No credential stays behind after setup. For agent code work, enable Containers from Settings → Repositories (Workers Paid).

**VPS: one command.** Use a Debian or Ubuntu amd64 machine with 2 GiB RAM and a domain pointed at it:

```sh
curl -fsSL https://llll.gg/install.sh | sudo env \
  LLLL_DOMAIN=chat.example.com \
  LLLL_ADMIN_EMAIL=owner@example.com bash
```

It installs Docker if needed and runs L4 on [celld](https://celld.dev) with a private [RustFS](https://github.com/rustfs/rustfs) bucket and Caddy for HTTPS. Add `LLLL_FACTORY=true LLLL_SHARED_KERNEL_TRUSTED=1` to run agent Task workspaces on the same machine. You can then manage it with `llll status`, `llll backup`, `llll upgrade` and `llll domain`. See the [VPS installer](docs/vps-installer.md).

Open your Server directly, or keep several in the [llll.gg](https://llll.gg) web, PWA and Telegram Shell. Shell bookmarks live on your device and never grant access.

## Status

L4 is in active development. Releases are frequent and immutable, and each Server stays on the version its operator chooses. VPS on celld is still experimental. Real-provider acceptance of agent code work is ongoing; see [compute nodes and Task workspaces](docs/software-factory.md). Native iOS and macOS apps are paused.

## Documentation

- [Governed agents](docs/agents.md): Roles, runtime, budgets and the untrusted-context policy
- [Compute nodes and Task workspaces](docs/software-factory.md)
- [MCP connections](docs/mcp.md)
- [Deployment and credentials](docs/deployment.md) · [VPS installer](docs/vps-installer.md) · [Self-host on celld](docs/self-host/celld.md)
- [Server and Shell model](docs/server.md) · [Architecture](docs/architecture.md)
- [Security policy](SECURITY.md) · [Security maintenance](docs/security-maintenance.md)

## Development

```sh
pnpm install --frozen-lockfile
pnpm dev:stack
```

`pnpm dev:stack` runs a local standalone Server on celld, RustFS and Caddy, with Client HMR and the Shell. See [local development](docs/local-development.md) for ports, state and commands.

The repository holds four parts. `app` and `server` are one autonomous Server. `apps/site` serves the Landing, Shell, Docs and installer. Changes go through focused pull requests with an isolated [Worker Preview](docs/worker-previews.md). Production and customer releases come only from [immutable release artifacts](docs/releases.md). Read [CONTRIBUTING](CONTRIBUTING.md) before opening a PR.

## License

[MIT](LICENSE). Independent community software by Inchi.
