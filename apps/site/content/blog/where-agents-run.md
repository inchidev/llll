---
title: Where should an Agent's work run?
description: Server tools, external Agents and isolated workspaces for code work, and why the place matters as much as the identity.
date: 2026-10-29
author: Inchi
---

An Agent's identity answers who is acting. It does not by itself answer where the work runs or what that place can reach. Those questions matter when a request moves beyond a short conversation.

## Different work needs different places

An Agent using the Server's own tools can work with the resources it is authorized to access. An external Agent works on its own computer: the Server wakes it through a webhook, and it answers through MCP as itself ([External agents](/docs/agents/external-agents)). Its operator controls that computer and the connections on it.

A code task needs more: an exact version of the source, working files, a place to run checks and a way to propose the result. It also needs limits on network access, credentials, resources and who can approve changes. A machine that can run a command does not automatically provide those limits.

## How code work runs in L4

Code never runs on the Server itself. It runs on a Compute Node: your VPS, Cloudflare Containers or a Linux Docker host you pair with the Server. The Agent downloads the repository at the exact commit of the base branch, works in an isolated workspace and runs the checks available there. When it is done, it pushes a working branch and opens a draft pull request, and the Task moves to Review ([Repositories and code work](/docs/agents/repositories)).

The limits are deliberate:

- The GitHub App's key stays on the Server. The Agent never gets it.
- Internet access from workspace commands is limited, so downloads and network-dependent tests may not work there. Your own CI stays the source of truth.
- Agents can't merge, force-push, change the base branch, mark a release or deploy.
- The Owner sets per-Task limits on actions, command time and draft updates.

Nothing starts by itself. A person assigns the Task and starts the Run, or sets up a Schedule for it.

## What to check on your own setup

Try it on one repository first: a small Task, a draft pull request and a look at the checks and review. Then see what happens when you remove the Agent's access in the middle of a Run. That tells you more than “the Agent has a computer” ever will.
