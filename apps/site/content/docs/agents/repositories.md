---
title: Repositories and code work
description: Connect GitHub, add a repository environment and let L4 Agents take a Task to a draft pull request on a working branch.
order: 5
---

An Agent can work on code: it takes a Task, edits a copy of your repository in an isolated workspace, runs checks and opens a **draft pull request**. Merging and releasing stay with people. Agents never get merge or release tools.

Code work needs five things. **Server settings → Agents** shows them as a checklist, **Set up agents that work on code**, until each is done:

1. **Connect a model.** See [Models and Providers](models-and-providers.md).
2. **Connect GitHub.** A dedicated GitHub App for the repositories Agents may work on.
3. **Choose a repository for Tasks.** An environment in **Git → Environments**.
4. **Add compute.** A Compute Node where the workspace runs.
5. **Create an agent** with a Role that has **Use a computer** and **Propose code changes**.

![The Set up agents that work on code checklist in Server settings → Agents with five steps and their buttons](screenshot:agents-code-checklist "The code work checklist")

GitHub is the only Git provider that works today. GitLab and Gitea show **connections are not available yet**; Projects can record GitLab, Gitea and Cursor repositories as references only.

## 1. Connect GitHub

L4 creates a private GitHub App for your Server, separate from any GitHub login. Only the Owner can set it up, and the Server needs an HTTPS address.

1. Open **Server settings → Git**. On the **GitHub** tab, select **Connect GitHub**. For an organization, select **Connect a GitHub organization** instead and enter its name.
2. GitHub opens in a new tab. Create the App, then choose which repositories it may access.
3. Return to L4. The connection appears in the list with the repositories it can access. Select the refresh button if it does not appear yet.

![Server settings → Git with the GitHub tab, one connection and the Connect GitHub button](screenshot:agents-git-github "Connect GitHub")

The App asks for code and pull request write access, for working branches and draft pull requests, and read access to issues and checks. It does not ask for branch-protection administration. The App's key stays encrypted on your Server and is never given to an Agent.

If GitHub asks you to sign in and then says it did not find an App Manifest, return to L4 and select **Prepare again after GitHub sign-in**. If you already created the App, refresh the connections instead of creating another.

To manage a connection, open it:

- **Change repositories on GitHub** changes which repositories the App can access.
- **Disable in L4** stops L4 from using the connection at once. It does not uninstall the App; uninstall it on GitHub if you also want to remove its access there.

## 2. Add a repository environment

An environment tells Tasks which repository, branch and compute to use.

1. In **Server settings → Git**, open the **Environments** tab and select **Add environment**.
2. Enter a **Name**, for example `Website fixes`.
3. Choose the **Git connection**, then the **Source repository**. Select **Refresh repositories** if the list is empty.
4. Choose the **Working repository**: the same repository for ordinary branch-based work, or an optional fork.
5. Choose the **Compute Node** where its Task Runs execute.
6. Enter the **Base branch**.
7. In **Required CI checks**, enter at least one exact check or commit-status name, one per line. A pull request whose required checks are missing or failing stays unverified.
8. Optionally list **Allowed Preview domains**, one per line, for preview links Agents may report. Preview links must use HTTPS.
9. Select **Save environment**.

Saving changes to an environment stops Runs and Schedules that use its earlier version.

## 3. Add compute

Code runs on a Compute Node, never on the Server itself. In **Server settings → Compute**, select **Add compute** to pair a Docker host or connect Lizard, or use **Server compute setup** for the option that fits where your Server runs. See [Compute Nodes](../self-host/compute-nodes.md).

## 4. Give the Agent and people the right permissions

| Permission | Who needs it |
| --- | --- |
| Use a computer | Both the Agent and the person who starts the work |
| Propose code changes | The Agent, to publish a branch and draft pull request |
| Read tasks, Execute assigned tasks, Send messages | Both, to run a Task |
| Read projects | Both, when the Task belongs to a Project |

No existing Role gets **Use a computer** or **Propose code changes** automatically, not even Admin. The built-in **Developer** Project policy covers working on project Tasks and proposing code; assign it in **Projects → Access**.

## 5. Run a Task

1. Create a Task, assign it to the Agent and choose the **Repository environment**.
2. Select **Create and run**, or later **Run assigned agent** on the Task.
3. Follow the Run from your Inbox or the **Runs** page.

The Agent downloads the repository at the base branch's exact commit, works in an isolated workspace and can run the checks available there. When it publishes, it pushes a branch named `l4-agent/<run-id>` to the working repository and opens a draft pull request against the base branch. The Task moves to **Review**.

Your existing CI, branch rules and preview deployments stay authoritative. A report from the Agent is not CI evidence.

Agents cannot change `.github` or `.git`, force-push, change the base branch, merge, label a release or deploy.

Internet access from workspace commands is limited, so package downloads and network-dependent tests may not work there. Rely on your repository's own CI. Per-Task workspace limits, such as actions, command runtime and draft PR updates, are set by the Owner in **Server settings → Agents → Execution**.

## Related

- [Compute Nodes](../self-host/compute-nodes.md)
- [Projects and Tasks](../guides/projects-and-tasks.md)
- [Agents, Tasks and Runs](../concepts/agents-tasks-runs.md)
