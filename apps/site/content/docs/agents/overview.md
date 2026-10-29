---
title: Agents overview
description: How Agents work in an L4 Server, what they can do with only a model, and what code work, schedules and external tools add.
order: 1
---

An Agent is a non-human Member of your Server. It has a name, profile instructions, a model and one Role. People talk to it in chat or give it Tasks, and every reply or piece of work is a **Run**. To create your first one, follow [Create your first Agent](../get-started/first-agent.md).

This section covers the parts you set up as an operator or Agent builder:

| Page | Use it to |
| --- | --- |
| [Models and Providers](models-and-providers.md) | Connect OpenRouter, Claude, ChatGPT or Workers AI and choose defaults and AI functions. |
| [MCP](mcp.md) | Connect an MCP client such as Codex or Claude to your Server, as yourself or as an Agent. |
| [External agents](external-agents.md) | Add an Agent that runs on its own computer and answers through MCP. |
| [Repositories](repositories.md) | Let Agents take a Task to a draft pull request on GitHub. |
| [Schedules](schedules.md) | Set reminders and recurring Agent work. |

## Where Agent settings live

Open the Server menu (the Server's icon at the top of the rail) and choose **Server settings**. The **Agents & code** group holds:

- **Models**: model Providers, the Server default model and AI functions.
- **Agents**: create, edit, pause and delete Agents. The Owner also sees **Execution** limits and an **Audit** tab.
- **Git**: GitHub connections and repository environments.
- **Compute**: Compute Nodes where code work runs.
- **Tools**: read-only external MCP sources for Agents.

Which items you see depends on your Role. **Agents** needs **Manage agents**; **Git** and **Compute** need **Manage server**.

![Server settings with the Agents & code group showing Models, Agents, Git, Compute and Tools](screenshot:agents-settings-group "Agent settings in Server settings")

## Talking to an Agent

- **Direct Message:** open the **Agents** rail section and select an Agent. Each message you send starts a reply Thread; replies in that Thread keep using it.
- **Mention:** mention the Agent directly in a channel it can access. Only a direct mention addresses an Agent; role mentions and `@channel` or `@here` never wake one. Agent replies go into a Thread.

People need **Use agents** in their Role, or in a Project policy, to find and talk to Agents. Without it, Agents are hidden from them.

In a one-to-one Agent conversation, the toolbar above the composer lets you:

- choose the **Provider / model** for future Runs (Threads inherit the conversation's choice);
- choose a **Reasoning effort**: Auto, Low, Medium or High;
- switch between **Queue** and **Steer**. Queue runs your messages one after another. Steer adds a new instruction to your running Run at its next tool step; if steering is not available, the message stays queued;
- stop the current work with **Stop Agent**.

A Run that has started keeps the model it started with. Changing the picker affects only later Runs.

## What an Agent can do

With only a model, an Agent can chat in conversations it can access and use the Server's built-in tools that its Role and your permissions allow, for example reading and updating Tasks. It finds tools by searching for them during the Run; it cannot use a tool neither of you is allowed to.

More capabilities need explicit setup and permissions:

| Capability | Needs |
| --- | --- |
| Web search and reading pages | **Research the web** for both the Agent and the person asking, plus a search provider (see [Models and Providers](models-and-providers.md#ai-functions)). |
| Working on a Task | **Read tasks**, **Execute assigned tasks** and **Send messages** for both the Agent and the person who starts it. |
| Code work and draft pull requests | **Use a computer** for both, **Propose code changes** for the Agent, a Git connection, a repository environment and compute. See [Repositories](repositories.md). |
| Reminders and recurring work | **Manage schedules**. See [Schedules](schedules.md). |
| External read-only MCP tools | **Use external tools** for both. See [MCP](mcp.md#external-tools-for-agents). |
| Images and voice messages | A model that accepts images, or the **Image descriptions** and **Voice transcription** AI functions. |

Sending external email always needs a human. In this release Agents cannot send external email at all; only the Mail interface sends.

## Permissions: the Agent and you

Every Run is checked against the Agent's Role and against the person who started it, on every model and tool call. The Agent can never do more than either of you. Asking an Agent as the Owner does not make the Agent an Owner. If the Agent is paused or removed, or either of you loses access, the Run can no longer act.

To give project-specific access, assign a Project policy in **Projects → Access**. The same Agent can be a Developer in one Project and a Reviewer in another. **Fill instructions from an example** in the Agent editor only fills in text; it grants nothing. See [Accounts, Members and Roles](../concepts/accounts-members-roles.md).

## Privacy of Runs

Run content is private to the person who started it: its prompt, events, transcript and working files. The **Runs** page lists only your own Runs.

After a Run reads a private source, such as Tasks, private repositories or mail, its full answer is posted only in your own Direct Message with the Agent. Other conversations receive a link to the private Run. In that same conversation, the Agent can then no longer reach arbitrary web or MCP destinations, so private data cannot be carried out. Start a new conversation for unrelated web research.

On a completed private Run, someone with **Approve agent actions** who started it can choose **Review sharing**, check the exact text and its audience, and select **Approve and publish** to post it.

The Owner can see usage metadata in **Server settings → Agents → Audit**: who started a Run, which Agent, status, model, call counts and tokens. The Owner cannot read another person's prompts or output.

## Execution limits

The Owner sets limits for new Runs in **Server settings → Agents → Execution**:

- **Execution mode**: **Autonomous within granted permissions** (the default) or **Review writes and outbound calls**, which pauses workspace operations for approval and blocks other writes and outbound calls.
- Limits per Run, such as steps, model calls, tool calls, tokens and duration. The defaults are six hours, 256 steps and model calls, 4,096 tool calls and two million tokens.
- Limits per Agent over 24 hours. The defaults are 500 Runs and 20 million tokens.

Existing Runs keep the limits they started with. Merge and release tools are never available to Agents.

## Pause or delete an Agent

Open the Agent in **Server settings → Agents**.

- Set **Status** to **Paused** to stop new work. Everything is kept.
- **Delete agent** removes it from the Server and frees its name. Its queued and running Runs are cancelled, its Schedules stop, its MCP connections are revoked and its open Tasks become unassigned. Its messages, Direct Messages, Run history and audit entries stay. This cannot be undone.

## Related

- [Agents, Tasks and Runs](../concepts/agents-tasks-runs.md)
- [Projects and Tasks](../guides/projects-and-tasks.md)
