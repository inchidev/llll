---
title: Repositories and code work
description: Connect GitHub or Gitea, or create a repository inside L4, and let L4 Agents take a Task from a branch to a merge, with a network, secrets and a Git flow per Project.
order: 5
---

An Agent can work on code: it takes a Task and gets a **box** for it, a container with an ordinary Git checkout of your repository. There it edits files, runs commands, tests and builds, and commits, at the speed of the machine. When it publishes, its commit is pushed to its own branch and a **draft pull request** opens. A person merges it from the Task, unless the Project lets the Agent merge after checks pass. Releasing and deploying stay with your repository's own pipeline.

Code work needs five things. **Server settings → Agents** shows them as a checklist, **Set up agents that work on code**, until each is done:

1. **Connect a model.** See [Models and Providers](models-and-providers.md).
2. **Connect GitHub or Gitea, or create a repository in L4.** A dedicated GitHub App or a Gitea bot account for repositories that live elsewhere; or, on a Cloudflare Server with Compute enabled, a repository inside L4 that needs neither.
3. **Choose a repository for Tasks.** An environment in **Git → Environments**.
4. **Add compute.** A Compute Node where each Task's box runs.
5. **Create an agent** with a Role that has **Use a computer** and **Propose code changes**.

![The Set up agents that work on code checklist in Server settings → Agents with five steps and their buttons](screenshot:agents-code-checklist "The code work checklist")

GitHub and Gitea work today, and Gitea connections also work with Forgejo. A Project on a Server in your own Cloudflare account with Compute enabled can also keep its repository [inside L4](#or-create-a-repository-in-l4), with no account anywhere else. GitLab shows **connections are not available yet**; Projects can record GitLab and Cursor repositories as references only.

## 1. Connect GitHub

L4 creates a private GitHub App for your Server, separate from any GitHub login. Only the Owner can set it up, and the Server needs an HTTPS address.

1. Open **Server settings → Git**. On the **GitHub** tab, select **Connect GitHub**. For an organization, select **Connect a GitHub organization** instead and enter its name.
2. GitHub opens in a new tab. Create the App, then choose which repositories it may access.
3. Return to L4. The connection appears in the list with the repositories it can access. Select the refresh button if it does not appear yet.

![Server settings → Git with the GitHub tab, one connection and the Connect GitHub button](screenshot:agents-git-github "Connect GitHub")

The App asks for code and pull request write access, for working branches, draft pull requests and merges from L4, and read access to issues, checks, Actions and deployments. It does not ask for branch-protection administration. The App's key stays encrypted on your Server and is never given to an Agent.

If GitHub asks you to sign in and then says it did not find an App Manifest, return to L4 and select **Prepare again after GitHub sign-in**. If you already created the App, refresh the connections instead of creating another.

To manage a connection, open it:

- **Change repositories on GitHub** changes which repositories the App can access.
- **Disable in L4** stops L4 from using the connection at once. It does not uninstall the App; uninstall it on GitHub if you also want to remove its access there.

## Or connect Gitea

Gitea has no Apps, so L4 uses one account's access token. Use a separate bot account: Gitea cannot limit a token to chosen repositories, so the account's own access is the limit. Only the Owner can connect Gitea, and Gitea must be served over HTTPS at its own address, not under a path.

1. In Gitea, create an account for L4, for example `l4-bot`.
2. Add it as a collaborator with **Write** access to each repository Agents may work on.
3. Signed in as that account, open **Settings → Applications** and generate a token. Set **Repository and Organization Access** to **All**, so private repositories are included. Give it **Read and Write** for **repository** and **issue**, and **Read** for **user**: Gitea needs it to identify the account and list its repositories. Copy the token; Gitea shows it only once.
4. In L4, open **Server settings → Git**, select the **Gitea** tab, then **Connect Gitea**. Enter your Gitea address, for example `https://git.example.com`, paste the token and select **Connect Gitea**.

L4 checks the token with Gitea before saving it. The connection lists the repositories the account can push to. To change them, change the account's collaborator access in Gitea and refresh.

The token stays encrypted on your Server. Agents never get it, and neither do Compute Nodes: a Node downloads and pushes the repository through your Server, with a permission bound to the Task's box. **Disable in L4** stops L4 from using the token at once; delete the token in Gitea to revoke it there too.

A personal token works too, but then L4 can reach every repository that person can.

Gitea differs from GitHub in a few ways:

- A draft pull request is a pull request whose title starts with `WIP:`. Gitea does not merge it until the prefix is removed.
- **Required CI checks** match commit statuses. Gitea Actions reports each job as one.
- CI job logs stay in Gitea; open the pull request there to read them.

## Or create a repository in L4

A Project can own its repository inside L4. It lives in your Server's own storage, in the same Cloudflare account, and nobody needs a GitHub or Gitea account. This works today on a Server created on Cloudflare with Compute enabled (**Server settings → Compute → Server compute setup**), because Compute provisions the storage that holds repositories. On a VPS it is not available; on L4 Cloud it is coming.

1. On the Project page, under **Repositories**, select **Connect repository**, then **Create a repository in L4**. With more than one computer, choose where its Tasks run.
2. L4 creates the repository, named after the Project, with a `main` branch and a README, and attaches it to the Project. No environment setup is needed: steps 2 and 3 below are done.

A repository in L4 works like a connected one, with these differences:

- **No pull request.** When an Agent publishes, its branch is recorded on the Task as **Published for review**. The diff is on the Run's page, where you approve pushes in review mode too.
- **No CI.** Nothing tests a head before you merge it, and the Task says so. If you want checks, keep the repository on GitHub or Gitea, or build from the L4 repository with your own pipeline.
- **A person merges.** From the Task, as for any repository, with the Project's merge method. The Agent never merges here, whatever the Git flow says, because there are no checks to pass. L4 merges only a branch that includes `main`'s current commit; if `main` moved, ask the Agent to bring it into its branch and publish again.
- **Versions.** Under **Versions** on the Project page, someone who may merge can **Release a version**: a tag `v1.0.0` on `main`'s current commit, listed there. L4 records it; what a version means is up to whatever builds from the repository.
- **Nothing deletes it.** Detaching the repository or archiving the Project keeps the repository and its history in your storage.

To work on the repository from your own computer, ask the Server Owner: the repository is reachable with Git over HTTPS and a token from your Cloudflare account's Artifacts namespace. L4 does not hand out tokens yet.

## 2. Add a repository environment

An environment tells Tasks which repository, branch and compute to use.

1. In **Server settings → Git**, open the **Environments** tab and select **Add environment**.
2. Enter a **Name**, for example `Website fixes`.
3. Choose the **Git connection**, GitHub or Gitea, then the **Source repository**. Select **Refresh repositories** if the list is empty.
4. Choose the **Working repository**: the same repository for ordinary branch-based work, or an optional fork.
5. Choose the **Compute Node** where its Task Runs execute.
6. Enter the **Base branch**.
7. In **Required CI checks**, optionally enter exact check or commit-status names, one per line. A pull request whose required checks are missing or failing cannot be merged from L4. Leave it empty to require every check CI reports.
8. Optionally list **Allowed Preview domains**, one per line, for preview links Agents may report. Preview links must use HTTPS.
9. Select **Save environment**.

Saving changes to an environment stops Runs and Schedules that use its earlier version.

## 3. Add compute

Code runs on a Compute Node, never on the Server itself. In **Server settings → Compute**, select **Add compute** to pair a Docker host on your own VPS or set up Containers in your own Cloudflare account, or use **Server compute setup** for the option that fits where your Server runs. L4 Compute, a box per Task from llll.gg paid by the hour of agent work, is coming. See [Compute Nodes](../self-host/compute-nodes.md).

## 4. Give the Agent and people the right permissions

| Permission | Who needs it |
| --- | --- |
| Use a computer | Both the Agent and the person who starts the work |
| Propose code changes | The Agent, to publish a branch and draft pull request |
| Read tasks, Execute assigned tasks, Send messages | Both, to run a Task |
| Read projects | Both, when the Task belongs to a Project |

No existing Role gets **Use a computer** or **Propose code changes** automatically, not even Admin. The built-in **Developer** Project policy covers working on project Tasks and proposing code; assign it in **Projects → Access**.

## 5. Open the network and add secrets

A box reaches only your Server until its Project opens more. Attach the repository to a Project, then on the Project page, under **Repositories**, whoever may manage the Project sets:

- **Network**: presets for the npm registry, PyPI, crates.io and GitHub (read only, no credentials), and your own hosts, such as an API your code calls. What you open here is open for every Task of the Project.
- **Secrets**: tokens and keys the Agents may use, each bound to the hosts it may go to. You enter a value once; nobody reads it back, Agents included. The Agent sees a placeholder such as `L4_SECRET_TELEGRAM_TOKEN`, and L4 puts the value in only on requests to a bound host.

When a Task needs another host, the Agent asks for a **window**: one host for up to eight hours, with the secrets it needs there. A host outside the Project's network waits for you in your Inbox.

Put a token in a Project secret, never in a conversation: a conversation is history its members can read, and it is sent to the model.

## 6. Choose the Git flow

The Project page also sets each Project's **Git flow**:

- **Who merges**: a person (the default), the Agent once checks pass, or a direct push to the base branch for experiments, with no pull request.
- **Agent branch prefix**: `l4-agent/` by default. Each Task's branch is this prefix and its box's id.
- **Merge method**: squash (the default), merge or rebase.

Your branch protection on GitHub or Gitea always has the last word. A push or merge it refuses comes back with its reason; L4 never works around it. A repository in L4 has no protection of its own: L4 allows a Task's branch to be pushed and nothing else, and only a person merges.

## 7. Run a Task

1. Create a Task, assign it to the Agent and choose the **Repository environment**.
2. Select **Create and run**, or later **Run assigned agent** on the Task.
3. Follow the Run in the conversation, where its answer appears as it is written, or on the **Runs** page.

The Agent works in the box on the base branch's exact commit and commits as usual. **Server settings → Agents → Execution** decides what needs your approval:

| Mode | Pushes | Secrets |
| --- | --- | --- |
| Autonomous (default) | The Agent pushes its branch on its own | Used at their bound hosts |
| Approve a plan | Covered by the plan you approve once | Only those the plan names |
| Review | You approve each push after reading its diff | Only through a window you open |

Approvals wait in your Inbox and on the Run's page.

After a push, the Agent reads the pull request's checks, CI logs and deployments for exactly that commit, and repairs on the same branch if something fails. Your existing CI, branch rules and preview deployments stay authoritative. A report from the Agent is not CI evidence.

## 8. Merge

The Task shows its pull request (or, for a repository in L4, **Published for review in L4**) and a **Merge** button, on the board and on the Run's page. You can merge when you may approve Agent actions in the Project and every check of the pull request's head passed. If the repository reports no checks at all, you can still merge, and L4 says plainly that nothing tested it. For the first two minutes after a push the Task shows **Waiting for checks to register…** instead, because CI may not have reported the new head yet. L4 merges exactly the commit you saw, with the Project's merge method, and marks the Task's code **Merged**. The Task's own status stays yours to change.

Under **the Agent once checks pass**, the Agent can merge too, but only after at least one check passed and none failed or is pending.

## Limits

The Owner sets per-Task limits in **Server settings → Agents → Execution**: branch pushes (50 by default) and box runtime (six hours by default). Box size and how many boxes run at once depend on the Compute Node; see [Compute Nodes](../self-host/compute-nodes.md). Git LFS is not supported yet.

## Related

- [Compute Nodes](../self-host/compute-nodes.md)
- [Projects and Tasks](../guides/projects-and-tasks.md)
- [Agents, Tasks and Runs](../concepts/agents-tasks-runs.md)
