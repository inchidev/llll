# Outbound MCP plan

Direction, not release evidence. Custom URLs with read-only tools are built; see [agents.md](agents.md#custom-urls).

## Approved writes

A tool that can write, such as DBHub `execute_sql` without `readonly`, Coolify deployments or Cloudflare `execute`.

- A new table `mcp_outbound_actions` modelled on `factory_approvals` (one row per outward request, settled once, the tool call waiting with `outwardPending`), with a digest of the connection, revision, endpoint, tool, schema hash and exact arguments, and a `payment_json` column for x402. Approved outbound MCP writes from a box's Task are Destinations, deferred by [ADR 0011](adr/0011-agent-on-the-box.md).
- The Owner marks each tool Read or Write, default Write. The mark is part of the tool's hash. Another L4's write tools are always Write.
- The Run waits and the request appears in the Inbox of the person who started it, showing the complete arguments. Approval lasts 15 minutes.
- After approval, every check runs again, then the tool is called once. A timeout or lost connection is `uncertain` and is never repeated.
- One function runs an approved action and can pass `_meta`, so a payment adapter can use it later.

## x402

The client side only: L4 pays another service. Each payment gets its own approval, and L4 shows the price and recipient from the parsed request, not from remote text. A read tool that asks for money stops there. A wallet, spending limits and selling are out of scope. A wallet key should not live under `AUTH_SECRET`, which is shared by every Space and restored with a backup: prefer an external signer with its own hard limit.

## OAuth client

For services without a token. The MCP client SDK provides `authProvider`. Discovery runs only while a signed-in Owner configures the connection, never inside a Run, and refresh uses a database lease as `agent-chatgpt.ts` does.

## Server to Server

Connecting to another L4's `/mcp` already works read-only. The bridge is a separate Agent on the other Server with a narrow Role and its own token, so that Server's Role is the whole policy. A Run started by a message that arrived through an Agent's MCP connection should not request a write through a bridge, which breaks loops between Servers.
