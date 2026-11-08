# Artifacts as a Git provider

Decided on 2026-11-08. Built in one pull request with this decision, for Servers in the operator's own Cloudflare account with Compute enabled; hosted Servers come later.

It builds on [The Agent works on its box](0011-agent-on-the-box.md), where a Task's box publishes to a branch of the Project's repository on GitHub or Gitea, and on [Compute is the business](0009-compute-as-the-business.md): a Project that can hold its own code inside L4 needs no account anywhere else before an Agent can work.

## Problem

Code work in L4 needs a repository on GitHub or Gitea. That is right for a team that has one. It is wrong for the people L4 Cloud is built for first: a game creator on AfterPrompt gets a Server and an Agent, and the first thing L4 asks of them is a GitHub account, an App, a repository and a connection, before a single Task can run. The Agent's work has to live somewhere, and nothing in the product can hold it.

The Server already has Git storage. On a Cloudflare-based Server with Compute enabled, the installer provisions an Artifacts namespace and binds it as `FACTORY_CODE` (`packages/deployment-core/src/factory.ts`), and the box runtime uses it to checkpoint each box's working disk between turns (`workers/factory-compute.ts`). Artifacts is Git-compatible storage: repositories are created from the binding, tokens are minted per repository, and `git` talks to it over HTTPS. It has no pull requests, no branch protection and no releases object, and its tokens are repository-wide: a write token writes any ref.

## Decision

**Artifacts is the third Git provider**, `artifacts` beside `github` and `gitea` in `shared/git-connections.ts`. There is no connection object and no row in `git_connections`: the Server's own `FACTORY_CODE` binding is the connection. Wherever code switches on the provider, `artifacts` has its half (`server/utils/factory-artifacts.ts`, mirroring `factory-github.ts` and `factory-gitea.ts`).

**One namespace per Server, one repository per Project, one branch per Task, versions as tags on `main`.**

- The namespace is the Server's existing one, the one `FACTORY_CODE` is bound to. It already holds the boxes' checkpoint repositories; Project repositories share it, named after the Project (`projectRepositoryName` in `shared/software-factory.ts`), and never take a checkpoint repository's name.
- A Project manager creates the Project's repository from the Project page, with the same permission as connecting a repository. The Server creates it with default branch `main`, pushes a first commit (a README) with the creation token, revokes that token, and attaches the repository to the Project through a repository environment like a connected one. One game is one repository.
- A Task publishes to `<prefix><box id>` of the Project's repository, as it does on GitHub or Gitea. The Project's Git flow decides the prefix and the merge method, as before.
- A version is an annotated tag `v<semver>` on the base branch, made from the Project by someone who may merge there, and recorded in `project_releases`, because Artifacts lists no refs. L4 records the tag; what a version means is the business of whatever builds from the repository, as ADR 0011 decided for deployment.

**Review stays inside L4.** There is no pull request to open. A publication's receipt points at the Run, where the diff a trusted helper made from Git is read, as for every provider on Cloudflare today. `factory_feedback` reports no checks: nothing tests a head in an L4 repository, and the Task says so plainly before a person merges. Under the `agent_after_checks` Git flow the Agent never merges in an L4 repository, since there are no checks to pass; a person merges.

**L4 enforces the branch rule, because the tokens cannot.** An Artifacts token writes any ref of its repository. The box never holds one: a short write token is minted by the Server for one push and revoked right after, and it lives only in the egress layer. On Cloudflare the box's outbound Worker reads the `git-receive-pack` commands and allows exactly `<old> <approved sha> refs/heads/<prefix><box id>`, as it does for GitHub; on a VPS Node the daemon pushes through the Server's transport (`/api/compute-agent/publish/<approval>.git`), where the Server reads the commands the same way and adds a token minted for that request. Members do not push to `main` unless the Project's Git flow is `direct_push`, which goes through the same path as a fast-forward from the head the Server read.

**The Server does the merge, with no box involved.** Artifacts has no API that writes a commit, a ref or a tag: only `git push` writes. So the Server builds Git objects itself (`server/utils/git-pack.ts`): a squash commit with the approved head's tree and the base branch's head as parent, a merge commit with both parents, or a fast-forward for `rebase`, packed and pushed over smart HTTP with a token minted for the merge and revoked after it. The push names the head it replaces, so a base branch that moved meanwhile refuses the update. L4 does not resolve a three-way merge: the approved head must include the base branch's current commit, and otherwise the person is told to have the Agent bring `main` into the branch and publish again. Release tags are made the same way.

**Where it exists.** Only where `FACTORY_CODE` is bound: a Server in the operator's own Cloudflare account with Compute enabled. A celld Server says a repository in L4 needs a Cloudflare-based Server; a hosted Server (`LLLL_RUNTIME=cloud`) says it is coming. Hosted Servers get it later through the control plane, which holds the namespace for them (ADR 0008). The Node can be the Cloudflare Node or a VPS Node: both reach the repository only through a Server-held token.

**Per-box checkpoint repositories stay.** A box of an Artifacts-backed Project still checkpoints its working disk into its own private repository (`l4-state`), and restores from it, exactly as for a GitHub-backed Project. Pushing the working state to a service branch of the Project repository would put uncommitted, half-finished state next to the Project's history and would need the branch rule to allow a second ref; it buys nothing this pull request needs. ADR 0011 called this per-box repository "the Task's repository", which was the right name when there was no Project repository in Artifacts; it is a checkpoint, and this decision renames it in that document.

## Consequences

- A Project can own its code inside L4, with no GitHub or Gitea account. Connecting a repository stays the way to work on code that lives elsewhere.
- The security boundary does not move: the box holds no token, the egress layer allows one ref update per push, and the only path that writes `main` is the Server's own, after a person's decision.
- An L4 repository has no CI and no previews. The Task says that nothing tested a head before a person merges it; a team that wants checks keeps its repository on GitHub or Gitea, or builds from the L4 repository elsewhere.
- Detaching the repository from its Project, or archiving the Project, keeps the repository and its history: nothing deletes a Project's repository without a person doing so themselves. The Project page says so.
- The Server now contains a small Git implementation: object hashing, trees, commits, annotated tags, packs of whole objects and a receive-pack client. Its tests check every object against `git` itself.
- Annotated tags and the Server's own push were written against Artifacts' Git compatibility, not against the live service in this pull request; the first release from a real Server verifies them.
- Git LFS, forks from one Project to another and repository import stay out, as do the Destinations of ADR 0011.
