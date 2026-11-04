---
title: Projects and Tasks
description: Organize work in L4 under Projects, with their Boards, Tasks and access, and hand Tasks to Agents.
order: 2
---

A **Task** records a piece of work and who is responsible for it. Tasks live on **Boards**, and each Board belongs to a **Project**, which can also hold repository references and give people and Agents access for that Project only.

Open **Projects** in the rail. Its list starts with **My tasks**, the Tasks assigned to you in this Space and yours waiting for review. Below come **Runs**, each Project with its Boards, and **Archived**.

## Boards

Open a Project in the **Projects** list to see its Boards, and select one. A Board collects Tasks in columns: **Backlog**, **Ready**, **Review**, **Done** and **Failed**.

Members with **Manage tasks** create a Board with the **+** beside its Project, and rename, reorder, archive or delete it from the Board's menu. Archived Boards are listed under **Archived**.

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

Select a Project in the **Projects** list to open its page, with its Boards, your Runs on its Tasks, its access and its repositories. Selecting **Projects** in the rail lists them all, with a search and the archived ones. You need **Read projects** to see Projects and **Manage projects** to create and configure them. No existing Role gets **Manage projects** automatically; the Owner always has it.

### Create a Project

1. Select the **+** beside **Projects** in the list, or **Create project** on the page listing them.
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

## Record a problem

A Task can carry a screen recording or screenshot with your marks on it. Your coding agent gets frames with your box and words on them, not a video it can't watch. Frames are cut in your browser, so the Server only stores files and text.

1. Share it from your iPhone with the Shortcut (below), or open a Task and press **Add recording**, which opens your library on a phone.
2. Mark it. On a video, scrub to the moment and press **In** and **Out**. Draw a box with the box button, or right away on a screenshot. Type what's wrong or press the microphone and say it, and add more marks with **+**. If you talked while recording, the waveform button turns what you said into clips.
3. Press **Send** (**Save** when it came from the Shortcut).

With **Add recording**, nothing reaches the Server until Send. From the Shortcut, the file is already there. The Task takes its title from your first comment, its text from your marks and what you said, and its cover from a close-up of your box. Choose another image attachment as the cover with **Use as cover**.

The recording follows the Task: the same access, the same Space and that Space's file storage. It stays until you delete it or the Task; there is no automatic expiry, so delete a recording that shows something it shouldn't. Voice is transcribed and dropped; only the text is kept. Other files on a Task stop at 10 MB; a recording stops at the limit the Owner sets in Server settings → Storage, 100 MB unless changed. A request through Cloudflare stops at 100 MB on most plans, and Basic storage stops at 20 MB.

### From your iPhone

Share a recording straight from Photos. The file goes to your Server first, so it is a Task at once, on your **Shots** board. A page then opens where you mark it the same way and press **Save**.

1. Open your avatar → **Connections** → **Shortcut** and press **Make my link**. A link can only send recordings, to the Space you made it in, and it can't read anything. It is shown once, so copy it. **Your links** lists them, so you can turn one off. Keep it to yourself: anyone who has it can send you recordings.
2. On the iPhone in Safari, press **Get the Shortcut**, download it and open it. Tap **Set Up Shortcut** and paste your link. If it won't import, the same page has the steps to build it by hand.
3. The marking page opens in your phone's default browser. Sign in to your Server there once, or it asks you the first time, and then continues to the page.
4. In Photos, open a recording → **Share** → **L4**. The first time, iOS asks to send it to your Server: tap **Always Allow**.

The Shots board is an ordinary board in the Space, made the first time you need it. Choose another board while marking, and that device's recordings go there from then on. If you press **Later**, the Task stays with a **Mark** button. A file over the limit, a mistyped link or a full Space opens a page saying so, and leaves nothing behind. A Server behind Cloudflare Access can't take the Shortcut; add the recording from the Task instead.

To hand it to your own agent, open your avatar → **Your agent**, connect once, and write `shots` in your repository for the newest recorded Task, `shots 4` for the last four, or `shots #12` for one. The agent looks for the Project named like the folder or with that repository connected. To let an Agent work on it here, assign it and start a Run as with any Task; the Run gets up to 8 frames.

**Invite someone** on a Project page makes a link for that Project. Whoever opens it joins the Project's Space with the Coordinator policy there: they see its Tasks and can add their own. The link works 5 times, for 7 days.

## Boards belong to a Space

A board belongs to a Space and holds Tasks. A Task can name a Project for agent work, whichever board it sits on, and moving it to another board keeps its Project. With no Project, a Task follows Server Roles.
