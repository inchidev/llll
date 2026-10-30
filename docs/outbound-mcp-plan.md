# Custom outbound MCP connections

Proposed direction, first drafted 2026-10-29 and revised 2026-10-30 after Grants and Agent access ([ADR 0004](adr/0004-grants-and-agent-access.md)), Factory and plan mode. Not implemented; this document is not release evidence.

Today a Server brokers read-only Streamable HTTP MCP calls to a fixed, reviewed catalog (`shared/outbound-mcp.ts`: Cloudflare documentation and DeepWiki). This plan lets the Server Owner connect an MCP server by URL, such as their own Coolify, a DBHub in front of their database or the Cloudflare API MCP. Agents use tools the Owner classified as reads within the existing mandate. Every tool the Owner classified as a write waits for exact human approval of its arguments.

Inbound MCP (external clients and external Agents calling a Server's own `/mcp`, [mcp.md](mcp.md)) is a separate feature and is not changed here.

## Targets

| Target | Endpoint | Auth | Tools |
| --- | --- | --- | --- |
| Coolify | `https://<coolify-domain>/mcp`, Streamable HTTP; enable instance MCP in Settings → Advanced | Team-scoped Coolify API token as Bearer; read permission suffices today | All read |
| DBHub | `dbhub --transport http` on the operator's host. DBHub's HTTP endpoint has no auth of its own, so it must sit behind HTTPS and an auth layer (Cloudflare Tunnel + Access service token, or a reverse proxy with a Bearer check) | Header pair (`CF-Access-Client-Id`/`CF-Access-Client-Secret`) or Bearer | `search_objects` read; `execute_sql` write, unless the DSN uses a read-only database user |
| Cloudflare API | `https://mcp.cloudflare.com/mcp` (Code Mode: `search` + `execute` over the whole API) | Narrow Cloudflare API token as Bearer now; OAuth in phase 3 | `search` read; `execute` write: it runs arbitrary code against the API, so each call needs approval of the exact code |
| Another L4 Server | `https://<other-server>/mcp` | Access token of a dedicated bridge Agent on that Server (§5a) | Fixed by L4 recognition |

The Cloudflare connection never reuses the Server's own Cloudflare access for self-updates (`cloudflare-account-access.ts`). Agents get a separate token with separate scope and revocation.

## Non-goals

Local stdio servers, sampling, elicitation, MCP resources and prompts, private-network or IP-literal destinations, automatic trust of remote annotations, and custom URLs owned by Members (v1: custom URLs are Server connections, configured by the Owner).

## Who may use a connection

A Run may call a connection's tools only when **both** hold, checked when the Run is admitted, before every call and again before its result is returned (as `visibleConnections` does today):

1. the Agent is granted the connection, and
2. the initiating person is granted the connection themselves, or owns it.

This stays separate from the Run's permission ceiling in ADR 0004:

- **Agent access does not widen connection use.** It lifts the permissions an Agent may use for a person (`Agent's Role ∩ (initiator ∪ Agent access)`), but a connection is a credential, not a permission. A person without their own grant on a connection cannot reach it through Agent access, even when the Policy of that access contains **Use external tools**. Otherwise anyone with Agent access could read the Owner's database through a broad Agent. Agent access for a connection can be added later as its own Grant kind; it is out of scope here.
- **Delegation only narrows.** A coordinator's subtask keeps the parent Run's connection ceiling (`RunMandate.toolConnections`); a delegated Agent needs its own grant as well.
- **A *granted* Agent** (ADR 0004) is only woken by the Owner and holders of its access, so its connections are only reachable by those people, and only if they hold the connection grant too.
- **Revocation:** removing a connection grant, disabling or changing the connection (revision bump) stops later calls of Runs that relied on it, as today.

### Connection grants storage

Connection grants stay in `mcp_outbound_connections.grants_json` (Agent, Member and Role lists) for these phases. They move into `grants` together with Mailbox access, channel overrides and Gadget access, one resource kind per migration (ADR 0004). That move needs `grants.policy_id` to become optional and a `connection_id` scope column, which in SQLite is a table rebuild; it should be done once for the next resource kind, not as part of this plan. Until then the evaluation rule above is the contract, so the move does not change behaviour.

## Design

### 1. Connection identity

- Add `providerId: 'custom'` next to the reviewed catalog. A custom connection stores its own `endpoint`; the catalog entries keep their fixed endpoints.
- Endpoint rules, checked at save and again before every request: `https:` only, no userinfo, no fragment, hostname must be a DNS name (no IP literals, no `localhost`, `.local`, `.internal`, `.localhost`, `.test`), not the Server's own origin or one of its aliases, at most 2,048 characters. Query strings are allowed (Cloudflare's `?codemode=false`) and are part of the exact pinned URL.
- Endpoint and provider are identity: changing them requires a new connection, like `providerId` and ownership today.
- `mcpBoundedFetch` takes the connection's pinned endpoint instead of looking it up in the catalog. Redirects stay disabled; GET streams stay refused; `Cookie` and `Authorization` stay overwritten.
- Egress: Workers keep `global_fetch_strictly_public` (already in `wrangler.jsonc`). The Docker/VPS runtime must enforce the same rule (resolve, then refuse private, loopback, link-local, CGNAT and metadata addresses, as `packages/compute-node` already tests). Verify this before phase 1 ships; if it can't be enforced there, custom connections stay unavailable on that runtime.

### 2. Credentials

`authKind`: `none` | `bearer` | `headers` | `oauth`.

- `bearer`: today's encrypted credential.
- `headers`: up to two header name/value pairs. Names come from an allowlist (`CF-Access-Client-Id`, `CF-Access-Client-Secret`, `X-API-Key`) and never `Cookie`, `Host` or `Authorization`. Values are encrypted together as one secret under the existing `outbound-mcp:<server>:<connection>` scope.
- `oauth` (phase 3): see §5.
- DTOs still expose only presence, kind and expiry. `mcpSecretForms` redaction covers every stored value.

### 3. Tool classification

- Refresh lists remote tools (still ≤ 40, no pagination, unique names). The Owner selects up to 10 and marks each **Read** or **Write**. Default is Write. `readOnlyHint` and `destructiveHint` only pre-fill the form and show warnings; they never decide.
- The effect is stored in the tool snapshot and included in its hash, so reclassifying a tool bumps the revision and requires new Runs.
- Classifying a tool as Read is the Owner's statement. The real boundary is the credential: the Settings form says so, and the recipes above use the narrowest tokens.
- `agent-tool-security.ts`: MCP read tools keep `effect: 'external'` and their current mode behaviour: they run where outbound calls are permitted (autonomous, and plan mode outside repository work), and review mode keeps blocking them. MCP write tools get a new classification that never executes on its own in any mode; each call creates an approval request (§4).

### 3a. Connection results are private by default

Today `privateContext` counts only built-in private reads (`privateSourceTools`). An MCP read does not mark the Session, so a Run could read rows from DBHub or messages from another Server and then send them out through `read_url`, `search_web` or another MCP tool. Its answer would also be posted to the shared conversation. Fix this before phase 1:

- Each connection has `sensitivity: 'private' | 'public'`. Custom connections default to private; Cloudflare documentation and DeepWiki are public.
- A completed or attempted read from a private connection is recorded with the other private reads, so `privateContext` returns true for the Session. The taint is written before the call starts, like `markUntrustedContext`.
- The existing consequences then follow: open egress is blocked, and the full answer goes only to the initiator's Direct Message with the Agent.
- Marking a connection public is the Owner's statement, shown with a warning, and bumps the revision.

### 4. Write approval

New table `mcp_outbound_actions`, modeled on `factory_actions`:

```
id, run_id, call_id, connection_id, connection_revision, tool, schema_hash,
args_json, digest, status (pending|approved|executing|completed|rejected|expired|uncertain|failed),
expires_at, created_at, decided_by, decided_at, lease_token, lease_until, result_json, completed_at,
UNIQUE(run_id, call_id)
```

- `digest` = SHA-256 of canonical JSON of {connection id, revision, endpoint, remote tool, schema hash, arguments}.
- The Run turn goes to `waiting_approval`; the request appears in the Inbox approvals list with a new `kind: 'mcp'`, next to workspace operations and plans.
- Approver: only the initiating Member, who also needs **Approve agent actions** in the Run's scope (their Role, or a Project policy in the Run's Project) and still holds the connection grant. No Owner bypass into another Member's Run, same as publication review. Approving does not use Agent access: it is the person's own decision about their own Run.
- **Plan mode does not cover MCP writes.** An approved plan (`factory_workspace` `operation: plan`) counts workspace operations and egress hosts only. Like publication, every MCP write waits for its own decision even inside an approved plan. A later version may let a plan name exact connection tools; not in this plan.
- The review page shows the connection name, the endpoint origin, the remote tool, a destructive warning when hinted, and the complete arguments (≤ 16 KB, never truncated). For Cloudflare `execute`, that is the exact code. Expiry: 15 minutes.
- Execution after approval: claim with a lease. Re-authorize the Agent and the initiator through `runAuthorization` (current Grants, Agent access, Project archive state, Agent's Role), the connection revision and the connection grants. List tools again and compare the hash. Recompute the digest. Then call the tool exactly once. Timeout or a lost connection becomes `uncertain` and is never replayed. Rejection, expiry or failure returns a plain tool result to the Run.
- Private context: MCP reads stay blocked after a Run reads private data. Approved writes stay allowed, because a human sees the exact outgoing payload. This is a deliberate exception; see Open questions.
- Audit: `tool.connection.action.{request,approve,reject,execute}` with ids, digest and status, never arguments or results. Arguments and results live in the action row, private to the initiator, and cascade with the Run.

### 5. OAuth client (phase 3)

Follows the MCP authorization spec: protected-resource metadata from the endpoint, then authorization-server metadata, then Dynamic Client Registration, then a PKCE S256 authorization code in the Owner's browser. The callback is at `/api/servers/:id/tool-connections/:connectionId/oauth/callback`, and `resource` is the exact endpoint.

- Discovery runs only during configuration by a signed-in human, never inside a Run. Metadata and token URLs must pass the endpoint rules; the issuer is pinned into the connection revision.
- Tokens are encrypted like other credentials. Refresh uses the database-lease pattern from `agent-chatgpt.ts` (`chatGPTAccessToken`). A failed refresh disables the connection with `credentials_rejected`.

### 5a. Connecting to another L4 Server

One Server (A) can connect to another Server's (B) `/mcp`. This is a bridge between two independent communities, not shared identity: every call on B acts as a B Member and passes B's checks, and A's grants and approvals apply on A.

- **Bridge identity.** B's Owner creates a dedicated Agent on B with a narrow Role, the **Connect MCP clients** grant and only the needed resources. They then issue an access token whose subject is that Agent, with minimal scopes. In phase 3, a person from A signs in on B through OAuth and selects the bridge Agent on B's consent screen. Never use B's Owner as the subject.
- **B's Agent access does not apply.** An MCP token held by an Agent acts as that Agent within its creator's authority (ADR 0004); B's Agent access only covers Runs a B Member starts. B controls the bridge only through the bridge Agent's Role and resources.
- **Recognition.** A identifies L4 by `serverInfo.name === 'L4'` at refresh. For a recognized L4 endpoint, the effects of its known tools are fixed by A and cannot be overridden: `list_*`, `get_*`, `read_*` and `search_*` are reads; `send_message`, `edit_message`, `delete_message`, `react_message`, `pin_message`, `open_dm`, `create_*`, `update_*`, `mark_mail_thread_read`, `move_mail_thread` and `complete_run` are writes. Unknown tools from an L4 server default to write. The connection is always private (§3a).
- **Loops.** A message sent through the bridge can mention an Agent on B, and B's Agent may have a bridge back to A. Each write needs human approval, which breaks automatic loops. In addition, each Server marks messages that arrive through its inbound `/mcp` from an Agent connection (the audit already stores the OAuth client and connection). A Run started by such a message cannot request writes through any L4 bridge. Both Servers' Run budgets still apply. If B's bridge Agent is *granted*, mentions of B's other granted Agents from the bridge do not wake them unless the bridge Agent holds their access.
- **Audience.** Everyone granted the connection on A can read what the bridge Agent can read on B, even if they are not Members of B. Settings shows this next to the grants. B controls exposure through the bridge Agent's Role and can revoke the token or connection at any time.
- **No self-connection.** The endpoint rules already refuse A's own origin, so a Server cannot route around its own authorization through its own `/mcp`.
- **Untrusted content.** Messages, documents and mail from B are external data written by B's Members. Results keep the untrusted-data marking and never grant authority on A.

### 6. Storage

Append the next free Server migration (`0005_outbound_mcp_custom.sql` at the time of writing; `0004_grants` is the latest) in the `server-v2` lineage. It adds `endpoint`, `auth_kind`, `sensitivity`, `server_kind` (`generic` | `l4`) and `oauth_json` (issuer, client id; tokens stay in `credential_json`) to `mcp_outbound_connections`. The `mcp_outbound_actions` table belongs to phase 2 and is added by that phase's own migration, so phase 1 ships no unused table. Existing rows keep `provider_id`, resolve their endpoint from the catalog and get `sensitivity = 'public'`.

**Existing Servers** apply the migration on their next update. Only columns with defaults are added, so the previous release keeps working on the new schema during the update window and nothing changes for existing connections. Custom connections become available once the new code runs.

### 7. Settings UI

Tools → Discover / Connect gains **Custom MCP server**: name, URL, auth kind and secret, then Refresh tools, a Read/Write choice per tool, sensitivity, grants and Enable. The grants section states that Agent access does not extend to the connection. Recipes for Coolify, DBHub and Cloudflare are linked from the form. The capability row "External writes and approvals" becomes available in phase 2.

## Phases

1. **Custom URL, read only.** Custom provider, endpoint rules, `none`/`bearer`/`headers`, Read classification only, private-by-default results (§3a), L4 recognition, migration. Unlocks Coolify, read-only DBHub, Cloudflare `search` and read-only bridges to other L4 Servers.
2. **Approved writes.** Write classification, `mcp_outbound_actions`, Inbox and review page, exactly-once execution. Unlocks `execute_sql` and Cloudflare `execute`.
3. **OAuth client.** Discovery, DCR, PKCE, refresh. Unlocks per-user Cloudflare OAuth and other OAuth-only servers.

Each phase is one focused PR to `main`, verified on its Worker Preview against a fixture MCP server in `tests/helpers/outbound-mcp.ts`, never against live customer infrastructure.

## Validation

Endpoint rules (IP literals, userinfo, own origin and aliases, special-use names, redirects to private addresses); header allowlist; a private-connection read blocks later `read_url`/`search_web`/MCP egress and routes the answer to the initiator's DM; L4 tool effects cannot be reclassified; a Run started by an inbound Agent-connection message cannot request bridge writes; two Server fixtures connected both ways; credential echo in metadata and results; hash drift after reclassification.

Grants: a person with Agent access to a connected Agent but no connection grant cannot reach the connection, including when the Policy contains **Use external tools**; a *granted* Agent's connection stays unreachable for people without its access; a coordinator subtask cannot reach a connection outside the parent mandate; removing the connection grant, Agent access, the Agent's Role permission or archiving the Run's Project between approval and execution stops the write.

Writes: plan mode with an approved plan still asks for each write; digest mismatch; expiry; duplicate approval; approval by anyone but the initiator; process death during `executing` → `uncertain` with no replay; private-context rules for reads and writes; Docker runtime egress refusal.

## Open questions

- Docker/VPS runtime: does the self-hosted runtime enforce strictly-public fetch, or does phase 1 need its own resolver check?
- Should approved writes really be allowed after a Run reads private data, or should private context block all MCP calls?
- Write calls (Cloudflare `execute`, long SQL) may need more than the 10-second RPC timeout. Allow a per-connection timeout up to 60 seconds?
- Member-owned custom connections: allow later with the same endpoint rules, or keep custom URLs Owner-only?
- Should a connection grant later become Agent access ("Petya may use Mike with the DBHub connection"), a Grant kind with `connection_id`, instead of the person's own grant? That would let someone use a connection only through one Agent.
