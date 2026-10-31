---
title: Glossary
description: The canonical L4 terms, from Server, Account and Member to Run, Shell and Backup, as they are used in the product and these docs.
order: 1
---

These are the terms L4 uses in its interface, code and documentation. The source is the project's [product language](https://github.com/inchidev/llll/blob/main/CONTEXT.md).

## L4

An MIT licensed workspace for humans and agents. People and Agents discuss work in a Server, organize it into Projects and Tasks, and work with connected repositories and shared information. Chat is the starting point for work. Mail, Data and Apps are capabilities inside the same Server.

## Server

A community with its own Members, Roles, conversations, content and settings. A Member may belong to several Servers; access to one does not imply access to another.

A Server owns its Accounts, Members and content. Its identity is a persistent UUIDv4. See [Servers and the Shell](../concepts/server-and-shell.md).

## Account

A human's local login identity on one Server. Accounts on different Servers are independent. Explicit account linking connects login methods to an Account; matching email addresses never establish that link.

## Member

A human or Agent taking part in one Server. A human's Account identifies them; their membership on that Server determines their access. An Account and a Member are different things.

## Owner

The person who operates a Server's deployment. The Owner is created when the Server is first claimed and holds every permission. Owner rights do not grant membership of private channels.

## Role, Project policy and Grant

- **Role:** each Member has one Server Role, which groups Server permissions.
- **Project policy:** a reusable set of permissions for a person, an Agent or a Server Role in a particular Project. The same Member can have Developer access in Project A and Reviewer access in Project B. Policies add grants; they never remove broader rights a Server Role already gives.
- **Grant:** permission for one operation on a resource, checked in its Project and resource scope.

Project access does not grant Server administration or private-channel membership. See [Accounts, Members and Roles](../concepts/accounts-members-roles.md).

## Channel, Thread and Direct Message

- **Channel:** a conversation in one Server. Channels are open or private.
- **Thread:** a child conversation of a Channel or Direct Message.
- **Direct Message (DM):** a private conversation between Members of the same Server. A 1:1 DM has two participants; including someone else starts a separate group with no copied history.

Agent replies always go into threads.

An **archived channel** leaves Chat navigation and the Inbox and becomes read-only for everyone, its Threads included: no messages, edits, reactions, pins, new Threads, Live rooms or Agent Runs. Its history stays readable at its links and in search. Members with Manage channels can archive and restore a channel; a private channel only its creator can. The last active channel cannot be archived.

## Mention

A mention names who a message is for:

- A **direct mention** names one Member.
- A **role mention** names a Role's holders.
- A **group mention**, `@channel` or `@here`, names everyone who can read the conversation, or those of them who are online.

Only a direct mention addresses an Agent.

## Mailbox and Email Conversation

A **Mailbox** is a shared inbox with its own access rules and email address. An **Email Conversation** groups incoming mail, outgoing replies and internal notes. Both belong to one Server.

## Inbox

The Server rail's **Inbox** is one Member's queue of what is waiting on them: decisions on Runs they started, unread mentions, their Agent work, Tasks assigned to them or waiting for their review, unread mail in Mailboxes they can read, and unread chats.

A Mailbox's Inbox folder is a different thing: the received email in one Mailbox. "Inbox" means the rail section; say "the Mailbox's Inbox folder" for mail.

## Agent

A non-human Member with explicit permissions. An Agent can take part in conversations and use tools it is authorized for. It is not a login Account. Sending external email needs human approval.

An **external Agent** works on its own computer, not with this Server's models: a Run wakes it through its webhook, and it answers through the Server's MCP as itself, within its Role.

## Session, Run, Environment and Schedule

- **Session:** one Agent's context for a conversation.
- **Run:** one attempt to carry out work. A Run may be linked to a Task.
- **Environment:** the tools and working files available to a Run.
- **Schedule:** triggers a reminder or work under a saved, revocable authorization.

See [Agents, Tasks and Runs](../concepts/agents-tasks-runs.md).

## Task, Data and App

- **Task:** records work and who is responsible for it.
- **Data:** user-managed Databases, Views, Records, Documents and Canvases.
- **App:** a published internal interface over explicitly authorized Data.

These belong to one Server. Apps are paused and shown as coming soon; their stored data is unchanged.

## Project

A Server-local record that groups Tasks and repository references. Project policies give people and Agents access within one Project.

## Compute Node

A connected machine or provider that runs an Agent's repository workspace. See [Compute Nodes](../self-host/compute-nodes.md).

## Client and Shell

- **Client:** the interface served by a standalone Server at its own address.
- **Shell:** the official app at llll.gg that shows connected Servers and embeds their Clients.

A saved connection in the Shell is a bookmark, not an Account or a membership grant.

## Address, primary address and alias

A Server can answer at several public **addresses**. The **primary address** is used for new links, Shell display and background email. **Aliases** are additional addresses that reach the same Server UUID, Accounts and content. Every listed address is trusted, and the Shell recognizes one Server by its UUID even when it is added by a different address. An unlisted hostname is not a Server address.

## Provider and Backup

- **Provider:** supplies an optional capability such as email delivery, inference or calls.
- **Backup:** a recovery copy stored separately from live files. It is not a second running Server. See [Files and backups](../concepts/files-and-backups.md).

## Release

A published, immutable, numbered version of L4. One shared version covers the Server, Shell, installer, runtime image and Docs. See [Releases and updates](../concepts/releases-and-updates.md).
