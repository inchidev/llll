---
title: Projects and Tasks
description: Organize work in L4 with Boards and Tasks, group it into Projects with their own access, and hand Tasks to Agents.
order: 2
---

A **Task** records a piece of work and who is responsible for it. Tasks live on **Boards**. A **Project** groups Tasks and repository references and gives people and Agents access for that Project only.

## Boards

Open **Tasks** in the rail. A Board collects the Tasks of one team or project in columns: **Backlog**, **Ready**, **Review**, **Done** and **Failed**.

Members with **Manage tasks** create Boards with **Create board** next to **Boards**, and rename, archive or delete them. Archived Boards are listed under **Archived**.

You need **Read tasks** to see Boards and **Create and update tasks** to add and edit Tasks. A Role can also be limited to specific Boards; see [Accounts, Members and Roles](../concepts/accounts-members-roles.md).

## Create a Task

1. On a Board, select **Task** (the **New task** button).
2. Enter a **Title** and optionally a **Description**.
3. Choose an **Assignee**: a person or an Agent.
4. Optionally choose a **Project**, a **Priority** (Low, Normal, High, Urgent), a **Due** date, **Labels** and **Dependencies** on other Tasks of the Board.
5. Select **Create task**.

![The Create task dialog with Title, Description, Assignee, Project, Report channel, Priority and Due fields and the Create and run and Create task buttons](screenshot:guides-create-task "Create a Task")

Open a Task to edit it, change its **Status** or **Board**, attach files, add **Checklist** items and set what it **Depends on**. **Archive task** hides it without deleting it.

### Create a Task from a message

In any channel, Direct Message or Thread, open a message's menu and choose **Create task**. The form opens prefilled from the message, and the saved Task links back to it. People who can read the Task see the link on the message; people who cannot read the source conversation see only that the Task came from a message. Deleting the message keeps the Task.

### Discuss a Task

Each Task has a **Discussion**, created when someone who can edit the Task starts it. It follows the Board's access: people who can read the Board's Tasks can read it. Agents working on the Task report in its Discussion unless a separate **Report channel** is set.

## Hand a Task to an Agent

Assigning a Task to an Agent does not start any work; a Task assigned to an Agent waits in **Ready** until someone starts it.

- When creating it, select **Create and run** instead of **Create task**.
- On a saved Task, select **Run assigned agent** at the top.

Starting work needs **Read tasks**, **Execute assigned tasks** and **Send messages** in the report conversation, for both the Agent and you. If something is missing, or the Agent is paused or the Task archived, the button explains why. Save pending edits before starting.

For code work, also choose a **Repository environment**; see [Repositories and code work](../agents/repositories.md).

When the Agent finishes, it records its result on the Task, moves it to **Review** and posts a report with the Task number, title, status and a link. You review the result and move the Task on. Follow progress in your Inbox under **Agent work** or on the **Runs** page.

To repeat Task work on a timetable, see [Schedules](../agents/schedules.md).

## Projects

Open **Projects** in the rail. You need **Read projects** to see Projects and **Manage projects** to create and configure them. No existing Role gets **Manage projects** automatically; the Owner always has it.

### Create a Project

1. Select **Create project**.
2. Enter a **Project name** and optionally a **Description**.
3. Save it, then assign access and attach repositories.

Tasks keep their Board; choose the Project in the Task form.

### Project access

A Project's access settings give people, Agents or a whole Server Role a reusable **Project policy** for that Project only. The same person or Agent can be a Developer in one Project and a Reviewer in another, while their Server Role stays the same.

1. Open the Project and find **Project access**.
2. Select **Assign access**.
3. Under **Assign to**, choose a person or Agent, or a Server Role, and choose the **Policy**.
4. Select **Save access**.

Built-in policies include **Developer**, **Reviewer**, **Coordinator** and **Task coordinator**. You can create more in **Server settings → Roles & Policies → Policies**. Policies only add permissions; a read-only policy does not take away broader rights someone already has from their Server Role.

### Repositories in a Project

Use **Attach repository** to record a repository by its **Git provider**, **Provider origin** (for example `https://github.com`) and **Repository path** (`organization/repository`). A reference alone connects no credentials and enables no work. To let Agents work on a GitHub repository, set it up in **Server settings → Git** and link the matching **Coding environment**; see [Repositories and code work](../agents/repositories.md).

Project access never grants Git credentials, merging or releases. Archiving a Project stops Agent work in it.

## Tasks from MCP clients

MCP clients approved for the Task scopes can list Boards and create and update Tasks on your behalf. See [Connect an MCP client](../agents/mcp.md).

## Related

- [Agents, Tasks and Runs](../concepts/agents-tasks-runs.md)
- [Chat](chat.md)
