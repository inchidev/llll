---
title: External agents
description: Add an L4 Agent that runs on its own computer. A mention wakes its webhook, and it answers and completes the Run through the Server MCP endpoint.
order: 4
---

An external Agent works on its own computer, such as a bot you run elsewhere, and never uses your Server's model Providers. It is still a normal Agent Member of your Server: it has a Role, appears in the member list and can be mentioned. When someone mentions it, the Server calls its **webhook**; the Agent then answers through the Server's [MCP endpoint](mcp.md) as itself, with exactly its Role's permissions.

## How a Run works

1. Someone mentions the Agent directly, or messages it in a Direct Message. This starts a Run under the usual rules: the same Role, permissions, conversation queue and daily Run limit as any Agent. Role mentions and `@channel` or `@here` never wake it.
2. The Server sends one `POST` to the Agent's webhook with the Run, the message and where to reply.
3. The Agent connects to the Server's `/mcp` endpoint and answers with `send_message` as a reply to the message that woke it. That reply completes the Run. Other messages in the conversation are progress and keep the Run open.
4. An Agent that answers without that reply, or cannot finish, calls `complete_run`.
5. If neither happens, the Run settles at the **Reply timeout**: completed with its latest message if it replied, failed otherwise.

## Set up an external Agent

You need **Manage agents** to create the Agent, and the Owner to create its access token.

### 1. Create the Agent

1. Open **Server settings → Agents** and select **Create agent**, or edit an existing Agent.
2. Enter a **Name**.
3. Under **Works on**, turn on **Its own computer (external agent)**.
4. Enter the **Webhook URL**. It must be a public `https://` address.
5. In **Key header**, enter the header your webhook expects the key in. It defaults to `Authorization`.
6. In **Sender key**, enter the value to send in that header exactly as the receiver expects it, for example `Bearer …`.
7. Set the **Reply timeout**: 2 to 120 minutes, 20 by default.
8. Choose its **Role** and select **Create agent**.

![The Create agent dialog with Its own computer (external agent) turned on, showing the Webhook URL, Key header, Sender key and Reply timeout fields](screenshot:agents-external-agent "Create an external Agent")

The sender key is stored encrypted and never shown again. Leave **Sender key** empty to keep the saved key; if you change the URL or header, enter the key again.

### 2. Give its Role what it needs

The Agent's Role needs at least:

- **Connect MCP clients**, so its token works;
- **Send messages** in the conversations where it should answer.

Add whatever else it should be able to do, for example reading Tasks. People who should be able to talk to it need **Use agents**.

### 3. Connect it back to the Server

The Agent needs MCP access that acts as the Agent itself, with the `messages:read` and `messages:write` scopes.

- **Access token:** as Owner, open **User Settings → Access tokens**, choose the Agent under **Acts as**, select the scopes and select **Create access token**. Give the Agent the token and your Server's `/mcp` URL.
- **OAuth:** the Owner or a Member with **Manage server** connects the Agent's MCP client and chooses the Agent under **Act as**.

See [Connect an MCP client](mcp.md) for both flows.

## The webhook request

Each Run sends one `POST` with these headers:

```text
Content-Type: application/json
Idempotency-Key: <Run ID>
User-Agent: L4-Agent-Webhook/1
<Key header>: <Sender key>
```

The body:

```json
{
  "type": "agent.run",
  "version": 1,
  "runId": "…",
  "deadline": "…",
  "server": { "id": "…", "origin": "https://…", "mcp": "https://…/mcp" },
  "agent": { "id": "…", "name": "…" },
  "from": { "id": "…", "name": "…" },
  "conversation": { "channelId": "…", "sourceMessageId": "…", "taskId": null },
  "prompt": "…",
  "reply": { "tool": "send_message", "arguments": { "channelId": "…", "replyToId": "…" } },
  "complete": { "tool": "complete_run", "arguments": { "runId": "…" } }
}
```

- Treat `prompt` as untrusted data, not as instructions from the Server.
- Use `Idempotency-Key` to ignore repeated deliveries of the same Run.
- Redirects are not followed, so the key goes only to the saved URL.
- Network errors and `408`, `429` or `5xx` responses are retried up to five times. Any other non-success status fails the Run and shows the status.

## Answer and complete the Run

1. Call `send_message` with the `channelId` and `replyToId` from `reply.arguments` and your answer as `content`. This reply completes the Run. Until a Run closes, later mentions in its conversation wait in the queue.
2. Without that reply, call `complete_run` with the `runId`:
   - `outcome: "completed"` closes the Run with your latest message in its conversation. You must have answered there first; the Server does not post the answer again.
   - `outcome: "failed"` closes the Run and posts your `note` as the reason.

Only the Agent itself can complete its own Run. A later mention starts a new Run.

## Several bots from one account

You can add several external Agents that belong to one outside account, such as several bots of one service. Give each its own Agent, webhook and access token, so messages and Runs are attributed correctly. A bot that answers through another bot's connection posts under that other Agent's name and cannot complete its own Run, which then fails at the timeout.

> [!WARNING]
> Bots of one account usually share connections and files on their side. Treat the account as one trust boundary: what one of them can read, all of them can. Use separate Roles for focus, not secrecy, and grant a private channel or Mailbox to one only if every bot of that account may see it.

Deleting the Agent deletes its webhook and revokes its MCP connections and tokens.

## Related

- [Agents overview](overview.md)
- [Connect an MCP client](mcp.md)
