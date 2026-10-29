---
title: Building one workspace for humans and agents
description: What L4 is today, what we are working on next and how we will talk about progress.
date: 2026-10-30
author: Inchi
---

L4 is one workspace for humans and agents. It is open source, and it runs on your own Cloudflare account or on a server you host yourself. We want it to be a workspace a community can run for itself, where people and their Agents work in the same context. That idea is bigger than any one screen. It depends on a Server its owner can install, understand, update and recover.

## What is there today

A Server brings together conversations, Tasks, Data, Mail and Agents under its own Accounts and permissions. The official Shell makes it easier to move between Servers; it does not own their Members or content.

There are several ways to run one:

- **On Cloudflare**, from the installer on llll.gg. A Server that keeps Cloudflare access updates itself from its own settings, without going back to llll.gg ([Updates](/docs/cloudflare/updates)).
- **On a VPS**, with one install command on Debian or Ubuntu and a domain pointed at the machine ([Install on a VPS](/docs/get-started/install-on-a-vps)).
- **With Docker Compose**, when you want to manage Docker yourself ([Docker](/docs/self-host/docker)).

Agents need a model. The Owner can connect a provider with an API key, and a Member can sign in with their own ChatGPT plan and choose to share it with the Server ([Models and Providers](/docs/agents/models-and-providers)). With a connected repository and compute, an Agent can take a Task to a draft pull request. Merging and releasing stay with people.

## What we are working on

The first job is making the basic community journey dependable on every way to run a Server: install, claim the owner Account, invite someone, exchange messages and files, reload and reconnect. We also want to check removing a Member, signing out sessions and restoring from a backup on real Servers. Two independent Servers and two people find problems that automated tests on one machine miss.

Agents don't pick up work on their own today. A person mentions them, starts a Run or sets up a Schedule. We want Agents to take on more useful work, with explicit permissions, visible results and people making the decisions that matter.

Projects, Tasks and Data can also make it easier to carry context from a conversation into a lasting result. We are interested in bringing those together without changing who owns them or who can see them. A more spatial Canvas is a direction we want to explore, not something that ships today.

## How we will talk about progress

We will write about decisions, practical setup and what we learn from testing. We will say when a feature needs an outside provider, when something passes automated tests but hasn't been tried on a real Server yet, and when an idea is still only an idea. The goal is a workspace that earns trust through clear behavior and reliable recovery, one community at a time.
