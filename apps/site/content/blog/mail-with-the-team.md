---
title: A shared Mailbox inside your Server
description: How a team can handle email alongside its work while keeping Mailbox access explicit.
date: 2026-10-29
author: Inchi
---

A community often has an address that belongs to the team rather than one person: support, partnerships or a shared project inbox. L4's Mail capability places that correspondence inside the Server, with Mailboxes and access rules of their own.

## An email conversation has a place

A Mailbox groups incoming email, outgoing replies and internal notes into Email Conversations. Members need the appropriate Role permissions and Mailbox grants to work with it. Being a Server Member does not automatically grant access to every Mailbox.

A team can search a folder, reply, forward, use Cc and Bcc, and attach files within the supported limits. Drafts belong to their author and Mailbox. Internal notes let the team discuss a message without making that note an outgoing email.

## Setup is part of the story

Mail is optional and needs a configured delivery provider. Receiving and sending depend on the operator's provider and domain setup; a working chat Server alone does not prove that email delivery is configured. Test a real inbound message and reply on the deployment you intend to use.

Agents and MCP clients also have boundaries. Approved MCP connections can read and triage Mailboxes where their permissions allow it, but cannot send external email through the current Mail tools. External sending requires human approval; in the current release the Mail interface sends it.

## Connect email to the rest of work

Unread Mailboxes appear in the Server Inbox for Members who can read them. That gives the team a way to notice new correspondence alongside mentions and Tasks, while leaving the actual email and its access rules in Mail. For a small team, the value is a shared view of a conversation and a clear next step—not another copy of the same message in every person's inbox.
