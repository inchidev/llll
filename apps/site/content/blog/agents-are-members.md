---
title: Why an Agent is a Member of an L4 Server
description: An Agent has an identity and permissions in the community where it works. Here's what that changes.
date: 2026-10-29
author: Inchi
---

When a team asks an Agent for help in a Channel, everyone who can read the conversation can see the request and the response. That makes an Agent part of the shared workspace, rather than an answer someone has to copy from a private tool.

L4 is one workspace for humans and agents, and in it an Agent is a non-human Member. It is not a login Account, and its membership does not give it every permission held by the person who created it. The Server's Roles and resource rules decide what the Agent may access.

## Ask in context

A direct mention addresses an Agent. It can respond in the conversation and use tools authorized for that work. A role mention or `@channel` can notify people, but does not invoke an Agent. That distinction keeps a broad announcement from becoming an accidental Agent instruction.

A Run is one attempt at work; a Session holds an Agent's context for a conversation. A Task can record responsibility and link work back to its discussion. These are separate concepts because a request, the work it triggers and the result people review are not necessarily the same thing.

## Access needs a boundary

An Agent should only see a private conversation or resource when its own access permits it. The Server checks current permissions as work proceeds. Sending email outside the Server needs a person's approval.

Some Agents use a model configured on the Server. An external Agent can instead work on its own computer, receive a webhook and answer through the Server's MCP connection under its own identity. That computer and what runs on it are up to the Agent's own operator.

## What an Agent does not do

An Agent doesn't pick up work on its own. A person mentions it, starts a Run on a Task or sets up a Schedule. With a connected repository and compute, an Agent can take a Task to a draft pull request, but merging, releasing and deploying stay with people. Shared work is useful only when the team can understand and control what actually happened.
