# L4 product language

This is the product glossary. See [product scope](docs/product.md), [runtime architecture](docs/architecture.md), and the [stabilization roadmap](docs/roadmap.md) for behavior, implementation and planned work.

## L4

Free MIT licensed software for independent communities. A community gathers in a Server. Chat is the starting point; Tasks, Mail, Data, Apps and Agents are capabilities within that Server.

## Server

A community with its own Members, Roles, conversations, content and settings. A Member may belong to several Servers; access to one does not imply access to another.

A Server owns its Accounts, Members and content. Its identity is a persistent UUIDv4. The same term is used throughout the product.

## Account

A human's local login identity on one Server. Accounts on different Servers are independent. Explicit account linking connects login methods to an Account; matching email addresses do not establish that link.

## Member

A human or Agent participating in one Server. A human's Account identifies them; their server-local membership determines their access. An Account and a Member are different concepts.

## Role and Grant

A Role groups permissions for Members in a Server. A Grant permits an operation on a resource. The Server Owner operates its deployment; Roles grant local community permissions.

## Channel, Thread and Direct Message

A Channel is a conversation in one Server. A Thread is a child conversation. A Direct Message is a private conversation between Members of the same Server.

## Mailbox and Email Conversation

A Mailbox is a shared inbox with its own access rules and email address. An Email Conversation groups incoming mail, outgoing replies and internal notes. Both belong to one Server.

## Agent

A non-human Member with explicit permissions. An Agent can participate in authorized conversations and use authorized tools. It is not a login Account. External email sending requires human approval.

## Session, Run, Environment and Schedule

A Session holds one Agent's context for a conversation. A Run is one attempt to carry out work and may be linked to a Task. An Environment supplies the tools and working files available to a Run. A Schedule triggers a reminder or work under a saved, revocable authorization.

## Task, Data and App

A Task records work and its responsibility. Data comprises user-managed Databases, Views, Records, Documents and Canvases. An App is a published internal interface over explicitly authorized Data. These resources belong to one Server.

## Client and Shell

The Client is the interface served by a standalone Server. The official Shell displays connected Servers and embeds their Clients. A saved connection is a bookmark, not an Account or a membership grant.

## Provider and Backup

A Provider supplies an optional capability such as email delivery, inference or calls. A Backup is a recovery copy stored separately from live files; it is not a second running Server.
