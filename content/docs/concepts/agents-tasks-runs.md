---
title: Agents, Tasks and Runs
description: How Agents work as governed Members of a Server, how Tasks and Runs relate, and what limits every Run.
order: 3
---

Agents in L4 are Members of a Server, not outside bots. They work under the same permission model as people, and every piece of work they do is recorded as a Run.

## Agent

An Agent is a non-human Member with one assigned Role. Its profile holds its name, instructions and model. An Agent is never a login Account.

- The Agent's Role caps what it can do. The Owner Role can never be assigned to an Agent.
- People need **Use agents** to find an Agent and talk to it. Without it, the Agent is hidden from them.
- An Agent takes part only in conversations it can access. Only a direct mention addresses an Agent; role mentions and `@channel` never do.
- Sending external email always needs a human's approval.

An **external Agent** works on its own computer instead of with this Server's models. A mention or Direct Message wakes it through its webhook, and it answers and completes the Run through the Server's [MCP endpoint](../agents/mcp.md), as itself and within its Role. See [External agents](../agents/external-agents.md).

## Task

A Task records a piece of work and who is responsible for it. Tasks live on Boards, can belong to a Project and can be created from a chat message (**Create task**), linked both ways.

Assigning a Task to an Agent does not start it. Someone with the right permissions chooses **Run assigned agent**. Task execution needs Read tasks, Execute assigned tasks and Send messages, for both the Agent and the person who starts it.

## Session, Run and Environment

- A **Session** holds one Agent's context for one conversation.
- A **Run** is one attempt to carry out work. Every reply to a message is a Run, and a Run may be linked to a Task.
- An **Environment** supplies the tools and working files a Run can use, for example a repository workspace on a [Compute Node](../self-host/compute-nodes.md).

**Runs** lists the Runs you started. Each Run page shows its activity, model requests and result. Run content is private to the person who started it; the Owner sees usage metadata (who, which Agent, status, model, tokens), not the prompts or output.

## Two sets of permissions

Every Run is checked against both the Agent's Role and the permissions of the person who started it. The Agent can never do more than either of them allows. Invoking an Agent as the Owner does not make the Agent an Owner.

These checks run on every model and tool call, not once at the start. If the Agent is paused or removed, or either side loses access, the Run stops being able to act.

Some abilities are always explicit opt-ins on a Role, never implied by an administrator Role:

| Permission | Lets an Agent |
| --- | --- |
| Execute assigned tasks | Work on Tasks assigned to it. |
| Use a computer | Use isolated workspace tools on a Compute Node. |
| Propose code changes | Push to a working branch and open draft pull requests. It cannot merge or release. |
| Manage schedules | Create reminders and recurring work. |
| Research the web | Search and read public web pages through configured providers. |

## Limits

Runs are bounded. The Owner can set limits for new Runs in **Server settings → Agents → Execution**. The defaults are six hours, 256 steps and model calls, 4,096 tool calls and two million tokens per Run, and 500 Runs and 20 million tokens per Agent in 24 hours. A tool call whose outcome is uncertain is never silently repeated.

## Schedules

A Schedule starts a reminder or work at a set time, once, daily or weekly. It keeps the permission ceiling it was saved with and checks current membership and grants before each delivery. If permissions change, a Schedule can become blocked until you edit it. See [Schedules](../agents/schedules.md).

## Related

- [Agents overview](../agents/overview.md)
- [Models and providers](../agents/models-and-providers.md)
- [Accounts, Members and Roles](accounts-members-roles.md)
