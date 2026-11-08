# Three doors to a Server on L4 Cloud

Decided on 2026-11-08. It extends [One Server per tenant on our Cloud](0008-server-per-tenant.md), where sign-up on llll.gg creates a Server from a published release, and it is the first slice of what [Artifacts as a Git provider](0013-artifacts-git-provider.md) and [Compute is the business](0009-compute-as-the-business.md) assume: a Server that exists before anyone has set anything up.

Built in two pull requests against this text, one per repository: the Server side here (released, since hosted Servers run only published code), the control plane in `inchidev/llll-cloud`. Where the two meet, this file is the contract, as `docs/compute.md` is for Compute.

## Problem

Today a Server on L4 Cloud is made by a person with a verified email, from the account page, by a browser that calls each step. Two kinds of creator cannot do that.

An **agent** is told "go set up an L4 and organize the work on X there". It has no email and no browser. Today it can only ask its person to go and click. The person should be asked for exactly one thing: to open a link and become the Owner.

A **partner** has its own accounts and makes a Server for each of them: AfterPrompt gives every game creator a Server with an Agent on it (its `docs/CREATOR_STUDIO.md`). Its people never visit llll.gg, their Server's Owner is the partner's account, and they open the Server from the partner's app.

Both bring the same risks as sign-up without a browser: one caller making many Servers, and all callers together making more than the account, the API rate and our money can carry. Each Server is a script, a database, two buckets and a KV namespace.

## Decision

**One creation, three doors.** `createHostedServer` in the control plane takes the same request from three places and marks each row with its `origin`: `account`, `agent` or `partner`. The steps, the storage, the release and the name rule are the same for all three. Only who may call, what they get back and who becomes the Owner differ.

**The Owner is always a person.** A Server made by an agent belongs to the person who claims it. A Server made by a partner belongs to the partner's account holder. An agent never owns a Server; it gets an Account on it, under the Owner.

**A Server nobody owns is provisional.** It answers, it has a name, and it is reaped after 24 hours if no Owner has claimed it. The reaper deletes everything but the backup bucket, as every deletion on Cloud does.

**Quotas are the control plane's, not the Server's.** They are counted in llll-cloud across all doors, by IP, by account, by partner and system-wide, with one switch that closes creation entirely. A refusal is a plain sentence and a 429; it is never "the Server failed".

**The control plane drives the steps itself.** A row in `creating` is advanced by whoever asks about it (the account page, the agent's status call, the partner's `servers/get`) under the existing lease, and by the hourly cron for rows nobody asks about. No browser is needed for a Server to finish.

**Payments are not part of creation.** A Server is free to make. Compute credit arrives later, through the account page or the partner (`credit/add`). A 402 on creation is a different product and is not built.

## The doors

### Account

As today: a signed-in account with a verified email, three Servers at most, the claim link shown on the account page. Unchanged except that it counts against the same IP and system quotas as the other doors.

### Agent

An agent calls llll.gg without an account, over MCP at `https://llll.gg/mcp` or over HTTP, with the tool `create_server { name, agent: { name } }`. The answer is:

```json
{
  "serverId": "<uuid>",
  "name": "paper-planes",
  "origin": "https://paper-planes.llll.gg",
  "state": "creating",
  "claimUrl": "https://llll.gg/claim/<code>",
  "agentToken": "dfmcp_<64 hex>",
  "expiresAt": "<ISO, 24 h from now>",
  "mcp": "https://paper-planes.llll.gg/mcp"
}
```

- `claimUrl` is for the person. It opens on llll.gg, asks them to sign in or sign up with a verified email, attaches the Server to that account (`hosted_servers.user_id`), and sends them on to the Server's own `/setup#claim=…` where they choose their username and password and become the Owner. The code works once and dies with the Server after 24 hours.
- `agentToken` is for the agent, for two things only: `server_status { serverId }` on llll.gg until the Server is `ready` and claimed, and then as its bearer token at the Server's `/mcp`. The control plane keeps the token's SHA-256 and hands the hash to the Server in the seed (below); the secret itself is never stored.
- The Server's seed carries the agent: when the Owner claims, the Server creates an Agent named as asked, under the Role **Cloud agent**, and an MCP access token whose hash is the seed's, created by the Owner and acting as the Agent. The seed says `admin`; the system Role `admin` cannot connect over MCP, on purpose, so the Server gives such an Agent **Cloud agent** (key `cloud-agent`): admin's permissions plus what an Agent needs to connect and work (Connect MCP clients, Execute assigned tasks, Use a computer, Manage schedules, Propose code changes), made once on first use and the Owner's to change like any Role. From that moment the agent works on the Server as an external Agent does (`content/docs/agents/external-agents.md`), within that Role and whatever Spaces and Projects the Owner gives it. Until the claim, `/mcp` answers 401, because no Account exists yet.
- `name` is a hint. The control plane applies `lib/cloud.mjs` (3 to 32 of `[a-z0-9-]`, reserved names refused) and, when the name is taken, appends `-2`, `-3` and so on, up to 9, then refuses.
- Discovery: `https://llll.gg/.well-known/llll` answers `{ "service": "l4-cloud", "mcp": "https://llll.gg/mcp", "docs": "https://llll.gg/docs", "create": "https://llll.gg/create" }`, and `https://llll.gg/llms.txt` says in a few lines what L4 is, that an agent can make a Server with `create_server` at that MCP endpoint, and that a person must claim it within 24 hours.

The agent door needs no Web Bot Auth. When it is cheap to verify a signature, a verified agent may get a higher IP quota; that is a later change to the numbers, not to the door.

### Partner

A partner is a backend with a shared secret. The first is AfterPrompt; its calls are `POST https://llll.gg/api/partners/afterprompt/v1/<operation>`, signed as its contract says (HMAC-SHA-256 over method, path, contract name, origin, time and body; 60 seconds of skew; 401 on a bad signature). The control plane keeps one secret per partner (`PARTNER_AFTERPROMPT_SECRET`) and one `partner_servers` row per `(partner, accountId)`.

Operations built now, with AfterPrompt's shapes:

| Operation | Does |
| --- | --- |
| `servers/create` | One Server per partner account, idempotent: a second call answers the same Server and reapplies `agent`, `secrets` and `env`. `owner` is `{ name, email \| null }`; the Owner is created on the Server as the partner's Member (below), never from a claim link. |
| `servers/get` | The Server with `state`, `reason` and `compute` (the Server's entitlements, `serverStanding`). Advances one step while `creating`. |
| `servers/sleep`, `servers/wake` | Sleep releases the Server's boxes, deletes its Worker script and keeps D1, buckets and KV; the dispatcher answers "This Server is asleep" for its hostname; weekly backups pause. Wake re-runs the `worker` and `verify` steps. A sleeping Server costs us no script. |
| `servers/delete` | As the account page's delete: everything but the backup bucket. |
| `servers/secrets`, `agents/update`, `models/set` | Passed to the Server through the relay (below). |
| `members/add`, `members/remove`, `sessions/create` | Passed to the Server through the relay. A session link is a one-time URL on the Server, good for ten minutes, that signs that Member in. "Open in L4" is a page load: the Server's CSP is `frame-ancestors 'self'`. |
| `credit/add` | One `credit_ledger` row: source `afterprompt`, source id the partner's top-up id, subject the Server. Writing it twice changes nothing. Answers the Server's credit. |

Not built now, and said so in the contract: `projects/*` and `tasks/*`. They need a repository inside L4 on a hosted Server (ADR 0013 names that as later) and Task-level relay actions. The partner's Member and Agent exist from day one, so a creator can already open the Server and talk to the Agent there.

A partner Server's Owner is the partner's account holder, signed in only through `sessions/create`. On the Server they are an ordinary Owner: they can set a password, add people, change anything. The partner's Agent is an ordinary Agent under **Cloud agent** (above). Nothing is linked by email: the link is the identity row the seed writes.

## Quotas

Counted in llll-cloud, in the existing `rate_limits` table, before any step runs:

| Scope | Limit | Window |
| --- | --- | --- |
| One IP, any door | 3 new Servers | a day |
| One account | 3 Servers | at once (as today) |
| One partner | 50 new Servers | a day |
| Everyone | 100 new Servers | a day |
| Switch | `CLOUD_CREATION=off` answers 503 "Creating Servers is paused" at every door | |

A refused creation is 429 with one sentence. The numbers are the control plane's `lib/cloud.mjs` and are expected to change; the shape is not. `CF-Connecting-IP` is the IP; a partner's calls count against the partner, not its IP.

## Provisional Servers and the reaper

An `agent` Server has no `user_id` until claimed. The hourly cron deletes `agent` rows with no `claimed_at` older than 24 hours, through the same `deleteHostedL4` as a delete, keeping the backup bucket, and records the deletion by id in the log. A row in `failed` from any door is reaped on the same clock. A `partner` Server is never provisional: its Owner exists from the seed.

## What the Server side adds (release 0.0.12)

One migration, `0007_cloud_seed.sql`:

- `server_setup.seed_json TEXT`: what the control plane asks the first claim to create, besides the Owner. Written by `seedNewServer` (`packages/deployment-core/src/deploy.ts`) when the hosted install request carries a `seed`:

```json
{
  "owner": { "identity": { "provider": "afterprompt", "subject": "<accountId>" }, "name": "Ivan", "username": "ivan" },
  "agent": { "name": "Claude", "role": "admin", "token": { "hash": "<sha256 hex>", "prefix": "dfmcp_", "scopes": ["…"] }, "instructions": "…", "version": 1 },
  "secrets": { "AFTERPROMPT_TOKEN": { "value": "apk_…", "hosts": ["afterprompt.games"] } },
  "env": { "AFTERPROMPT_URL": "https://afterprompt.games" }
}
```

On the agent door `agent.token` is the agent's own token, a Server access token `dfmcp_<64 hex>` minted by the control plane and hashed whole, so the Server's `/mcp` reads it exactly like one it issued. On the partner door the Agent has no `token` and `owner.identity` is set. Secret names are environment-variable names (`[A-Z][A-Z0-9_]*`); values are 8 192 characters at most, env values 4 096, instructions 200 000.

- `member_identities (provider TEXT, subject TEXT, user_id TEXT REFERENCES users ON DELETE CASCADE, created_at TEXT, PRIMARY KEY (provider, subject))`, with a unique index on `user_id`: the explicit link between a Member and an outside identity. It is how a partner names a Member. Email is never a key.

The relay `/.llll/cloud/*` (bearer `CLOUD_SECRET`, POST, JSON, 404 for everything else; `server/utils/cloud-relay.ts`) gains these actions. Each is idempotent and answers `{ ok: true, … }` or `{ error }` with a 4xx:

| Action | Body | Does |
| --- | --- | --- |
| `claim-owner` | `{}` | Only on a Server whose `seed_json.owner.identity` is set and whose Owner does not exist: runs the same bootstrap as `/api/setup/owner` with a random password nobody is told, records the identity, deletes `server_setup`. Then creates the seed's Agent, secrets and env as a claim does. Answers `{ ok, ownerId }`, and the same Owner again on a second call; a Server a person claims at `/setup` (no identity in the seed) answers 409. |
| `members/upsert` | `{ identity, name, role: "member" }` | A Member for that identity, `active`, in the Server's default Space; an existing one keeps its Account and takes the new name, and one removed earlier is admitted again. Answers `{ ok, userId, created }`. |
| `members/remove` | `{ identity }` | Removes the Member as the Owner would (`status = 'removed'`, sessions and tokens revoked). The Owner's identity is refused with 409; an identity that names nobody answers `{ ok, userId: null, removed: false }`. |
| `session-link` | `{ identity }` | A one-time sign-in URL for that Member, `<origin>/signin/link#<token>`, valid ten minutes, single use, creating an ordinary session. The Server keeps only the token's SHA-256, in Better Auth's verification table, and no new table. Answers `{ ok, url, expiresAt }`; 404 when no active Member has the identity. |
| `agents/upsert` | `{ name, role, instructions, version, token? }` | The seed's Agent by name: created if missing (with the token when given; `admin` means **Cloud agent**), instructions replaced when `version` grows. The Server remembers which Agent each seeded name became, so an Agent the Owner renamed is still found. Answers `{ ok, agentId, created }`. |
| `secrets/set` | `{ secrets, env }` | Kept encrypted in `server_settings` under `cloud.partner`; applied as Project secrets and network windows to every Project the partner later creates. Nothing is applied to Projects that exist, and no value is ever answered. Names are environment-variable names (`[A-Z][A-Z0-9_]*`). |
| `models/set` | `{ provider: "openrouter", key }` | `saveAgentProvider` as the Owner would from **Server settings → Models**, enabled, with the provider's current model list (tool-capable models first, two hundred at most), and the default model set when none is. Answers `{ ok, configured: true }`. |
| `sleep` | `{}` | Releases the Server's boxes (L4 Compute, through the Server's own client). The script deletion is the control plane's. Answers `{ ok, released }`. |

On the account and agent doors the first claim is a person at `/setup#claim=…`: `/api/setup/owner` reads `seed_json` after creating the Owner and creates the Agent (name, Role **Cloud agent** for `admin`, the pre-hashed token, created by the Owner), then any `secrets` and `env` for later Projects. The claim page says that an Agent will be on the Server and under what name.

`GET /.well-known/llll` on a Server already answers its id, name and version; it adds `"owner": true | false` so that an agent polling the Server itself can see the claim land.

## What the control plane adds

- `hosted_servers`: `user_id` nullable, `origin TEXT NOT NULL DEFAULT 'account'`, `agent_token_hash`, `claim_code_hash`, `sleeping_at`; `partner_servers (partner, account_id, server_id, created_at, PRIMARY KEY (partner, account_id))`; `partner_members (partner, account_id, server_id, added_at)` so that `members/remove` and `servers/delete` know whom they affect.
- `/mcp` on llll.gg: an MCP server with `create_server` and `server_status`, no OAuth, the `agentToken` as bearer for the second; the same two over HTTP at `POST /api/cloud/agent/servers` and `GET /api/cloud/agent/servers/<id>`.
- `/claim/<code>`: the page and the attach.
- `/.well-known/llll` and `/llms.txt`.
- `worker/partners/afterprompt.ts`: the signature check, the operations above, the relay calls.
- The quotas, the switch, the reaper, sleep and wake in `scheduled()` and in the install steps.
- `docs/cloud.md`: the three doors, the quotas, what sleep keeps, the partner contract's location.

## Consequences

- **Two releases of trust.** A Server made through the agent door answers at once but is useless until a person claims it: that is the point. An agent that wants to work immediately is told so in the `create_server` answer and in `llms.txt`.
- **A partner's Member has no password** until they set one. Losing the partner means losing sign-in until the Owner resets it from the Server; that is the same as losing any identity provider, and the Server's own password reset remains.
- **Secrets travel through llll-cloud** on their way to the Server, once, in the create and `secrets/set` calls, and are stored encrypted only on the Server. The control plane does not keep them.
- **Hosted Servers do not update yet**, so every new relay action reaches only Servers created from 0.0.12 or later. Batch updates (ADR 0008) are the next piece of the control plane.
- **Costs.** A provisional Server costs a script and a database for a day at most; the reaper and the quotas bound it at 100 a day. Sleep is what keeps a partner's long tail off the script count.
- **ADR 0008** is amended by this file: sign-up is one of three doors, and "Owner claim" happens on llll.gg before the Server for the agent door and on the Server at creation for the partner door.
