# L4 product language

This is the product glossary. See [product scope](docs/product.md), [runtime architecture](docs/architecture.md), and the [stabilization roadmap](docs/roadmap.md) for behavior, implementation and planned work.

## L4

An MIT licensed workspace for humans and agents. People and Agents discuss work in a Server, organize it into Projects and Tasks, and work with connected repositories and shared information. Chat is a starting point for work. Mail, Data and Apps are capabilities within the same Server.

## Server

A community with its own Members, Roles, conversations, content and settings. A Member may belong to several Servers; access to one does not imply access to another.

A Server owns its Accounts, Members and content. Its identity is a persistent UUIDv4. The same term is used throughout the product.

## Account

A human's local login identity on one Server. Accounts on different Servers are independent. Explicit account linking connects login methods to an Account; matching email addresses do not establish that link.

## Member

A human or Agent participating in one Server. A human's Account identifies them; their server-local membership determines their access. An Account and a Member are different concepts.

## Role, Project policy and Grant

A Member has one Server Role, which groups Server permissions. A reusable Project policy adds permissions for a person, an Agent or a Server Role in a particular Project. The same Member can have Developer access in Project A and Reviewer access in Project B. Policies add grants; they do not remove broader rights already supplied by a Server Role.

A Grant permits an operation on a resource. Evaluate the operation in its Project and resource scope. The Server Owner operates its deployment; Project access does not grant Server administration or private-channel membership.

## Channel, Thread and Direct Message

A Channel is a conversation in one Server. A Thread is a child conversation. A Direct Message is a private conversation between Members of the same Server.

A mention names who a message is for: a direct mention names one Member, a role mention a Role's holders, and a group mention (`@channel` or `@here`) everyone who can read the conversation or those of them online. Only a direct mention addresses an Agent.

## Mailbox and Email Conversation

A Mailbox is a shared inbox with its own access rules and email address. An Email Conversation groups incoming mail, outgoing replies and internal notes. Both belong to one Server.

## Inbox

The Server rail's Inbox is one Member's queue of what is waiting on them: decisions on Runs they started (review-mode workspace actions and sharing reviews), unread mentions, their Agent work, Tasks assigned to them or waiting for their review, unread mail in Mailboxes they can read, and unread chats. A Mailbox's Inbox folder is a different thing: received email in one Mailbox. Say "Inbox" for the rail section and "the Mailbox's Inbox folder" for mail.

## Agent

A non-human Member with explicit permissions. An Agent can participate in authorized conversations and use authorized tools. It is not a login Account. External email sending requires human approval.

## Session, Run, Environment and Schedule

A Session holds one Agent's context for a conversation. A Run is one attempt to carry out work and may be linked to a Task. An Environment supplies the tools and working files available to a Run. A Schedule triggers a reminder or work under a saved, revocable authorization.

## Task, Data and App

A Task records work and its responsibility. Data comprises user-managed Databases, Views, Records, Documents and Canvases. An App is a published internal interface over explicitly authorized Data. These resources belong to one Server.

## Client and Shell

The Client is the interface served by a standalone Server. The official Shell displays connected Servers and embeds their Clients. A saved connection is a bookmark, not an Account or a membership grant.

A Server can answer at several public **addresses**. The **primary address** is used for new links, Shell display and background email. **Aliases** are additional addresses that reach the same Server UUID, Accounts and content. Every listed address is trusted; the Shell recognizes one Server by UUID even when it is added by a different address. An unlisted hostname is not a Server address.

## Provider and Backup

A Provider supplies an optional capability such as email delivery, inference or calls. A Backup is a recovery copy stored separately from live files; it is not a second running Server.

## Conversations

A DM has two participants inside one Server. Larger conversations use channels, which are open or private. Changing a private channel's members preserves its ID, threads and history. Only its creator can add or remove members; existing groups without recorded creators receive no guessed administrator. The Server Owner can explicitly assign a current human participant as creator of such a channel; assignment is audited and grants no membership. Adding a member grants the whole history, with the previous messages treated as read. New messages after the grant remain unread. Agent replies use threads in every conversation. An archived channel leaves Chat navigation and the Inbox and is read-only for everyone, its Threads included: no messages, edits, reactions, pins, new Threads, Live rooms or Agent Runs. Its history stays readable at its links and in search. Members with Manage channels archive and restore it; a private channel, like its visibility, only by its creator. The last active channel cannot be archived.
