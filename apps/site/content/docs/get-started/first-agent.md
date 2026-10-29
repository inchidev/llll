---
title: Create your first Agent
description: Connect a model, create an Agent with a Role, let people use it and send it its first message in your L4 Server.
order: 7
---

An Agent is a non-human Member of your Server. It has a name, instructions, a model and one Role, and it can do only what that Role and the person asking allow. Each reply or piece of work is a **Run**.

An Agent can chat with only a model. Working on code, from a Task to a draft pull request, also needs GitHub, a repository and compute; see [Repositories](../agents/repositories.md).

## 1. Connect a model

The Owner connects model Providers.

1. Open **Server settings → Models**.
2. Select **Add provider** and choose one, for example OpenRouter, an Anthropic API key or ChatGPT. Keys are stored encrypted on your Server.
3. Save the provider and pick its models.

On a Cloudflare Server, Workers AI is listed with the other providers. The Owner can turn it off or choose which of its models Agents see.

Members with **Use agents** can also connect their own ChatGPT plan in **Server settings → Models** and share it with the Server. See [Models and Providers](../agents/models-and-providers.md).

## 2. Create the Agent

You need **Manage agents**. The Owner has it.

1. Open **Server settings → Agents**, or the **Agents** page, and select **Create agent**.
2. Enter a **Name**. No other Member can use the same name.
3. Choose a **Model**, or leave it empty to use the Server default when one is set.
4. Choose its **Role**. The Role caps what the Agent can do. The Owner Role cannot be assigned to an Agent.
5. Write **Profile instructions**, or use **Fill instructions from an example**.
6. Select **Create agent**.

![The Create agent dialog with Avatar, Name, Works on, Model, Role and Profile instructions fields and the Create agent button](screenshot:get-started-create-agent "Create an Agent")

To create an Agent that runs on its own computer instead of the Server's models, turn on **Its own computer (external agent)** under **Works on**. See [External agents](../agents/external-agents.md).

## 3. Let people use it

People can find and talk to an Agent only if their Role, or a Project policy, grants **Use agents**. The built-in Member Role does not include it by default.

1. Open **Server settings → Roles & Policies**.
2. Open the Role whose Members should use Agents, then its **Policies** tab.
3. Check a policy that grants **Use agents**, or create one first, and select **Save policies**.

## 4. Send it a message

- Open a Direct Message with the Agent from the **Agents** page, or
- mention it directly in a conversation it can access, for example `@Helper summarize this thread`.

Only a direct mention addresses an Agent. Role mentions and `@channel` or `@here` never wake one. Agent replies go into a Thread.

## 5. Follow its work

The **Runs** page lists the Runs you started. Each Run shows its activity, model requests and result. Your Inbox shows your Agent work while it is queued or running, and approvals waiting on you.

> [!NOTE]
> Sending external email from an Agent always needs human approval.

## Next steps

- [Agents overview](../agents/overview.md)
- [Agents, Tasks and Runs](../concepts/agents-tasks-runs.md)
- [MCP](../agents/mcp.md)
