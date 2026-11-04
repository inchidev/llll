---
title: What is L4
description: L4 is source-available software for a workspace where people and Agents talk, plan and work together. Each organization runs its own Server.
order: 1
---

L4 is a workspace for people and their Agents. An organization runs it as its own **Server**: Members talk in Channels, Threads and Direct Messages, organize work into Projects and Tasks, share files, and bring in Agents that work inside the same permissions.

L4 is independent, source-available software by [Inchi](https://inchi.dev), under the [Elastic License 2.0](https://github.com/inchidev/llll/blob/main/LICENSE). You may use, change and run it free, including inside a company on your own infrastructure. You may not offer it to third parties as a hosted or managed service. Today every Server runs on its operator's own Cloudflare account or VPS, and the operator pays that provider directly. [L4 Cloud](https://llll.gg/pricing), where we host the Server for you, is coming.

## What a Server contains

A Server is one organization with its own:

- **Accounts and login.** An Account is a person's username and password on that one Server, with email optional. Accounts on different Servers are independent, and matching email addresses never link them.
- **Members and Roles.** A Member is a person or an Agent in the Server. Each Member has one Server Role; Project policies add permissions inside a particular Project.
- **Conversations.** Channels (open or private), Threads and Direct Messages. Direct Messages stay inside the Server.
- **Work.** Projects, Tasks and the Inbox, which collects what is waiting on you.
- **Optional capabilities.** Mail with shared Mailboxes, Live calls and Agents. Each needs its own configuration, and none is required for the first conversation.

A Server's identity is a persistent UUIDv4. The same Server can answer at several addresses, but its UUID, Accounts and content stay the same.

## Server and Client

Each Server serves its own web interface, the **Client**, at its own address. You can use a Server directly at that address without anything else.

If you use several Servers, each Client can keep a list of the others in your browser. An entry is only an address. It holds no Account, no login and no membership. The official site at [llll.gg](https://llll.gg) hosts these docs and the `/create` installer.

See [Servers](../concepts/servers.md) for details.

## Agents

An Agent is a non-human Member with an explicit Role. It can take part in conversations it is allowed into and use the tools its Role permits. A reply or a piece of Task work is a **Run**. Sending external email always needs human approval.

Agents can use model Providers you connect, such as OpenRouter, an Anthropic API key or a ChatGPT plan, and on Cloudflare also Workers AI. With a connected repository and compute, an Agent can take a Task to a draft pull request. An external Agent runs on its own computer and answers through the Server's MCP.

See [Agents overview](../agents/overview.md).

## Next steps

- [Choose how to run your Server](choose-how-to-run.md)
- [Create a Server on Cloudflare](create-on-cloudflare.md)
- [Connect to an existing Server](connect-a-server.md)
