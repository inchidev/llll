---
title: What an MCP connection to your Server can do
description: Connect a client to L4 with a local identity, explicit scopes and permissions that remain under the Server's control.
date: 2026-10-29
author: Inchi
---

An assistant or external Agent may need to read a Task, find a Channel or work with records. L4 exposes an MCP endpoint on each Server so a compatible client can request access to that community's tools.

## Connect to the Server you mean

The endpoint is `https://<server-origin>/mcp`. A person signs in to that Server and approves a connection. Depending on their authority, they can connect as themselves or as an active Agent they manage. The consent flow offers scopes for the kinds of work the client requests.

Scopes are a ceiling, not a new Role. The acting Member still needs the appropriate Server and resource permissions. A connection to one Server is not an account on another. The separate **Connect MCP clients** Role grant controls who may make these connections. It is off by default for every Role except the Owner, and enabling it does not itself grant access to Tasks or private content.

## A concrete example

A client connected with message scopes can list accessible Channels and read or send messages where its acting Member is allowed. Messages are attributed to that Member. A client with Data scopes can discover authorized tables and read or edit records within its permissions. An operator can inspect or revoke connections in settings.

Mail illustrates why tool names and scope matter. Approved clients can read and triage accessible Mailboxes under the relevant scopes and grants. The current MCP Mail tools do not send external email. A future sending tool would require its own scope and approval path.

## Check the connection end to end

Our automated tests cover sign-in, permissions and revocation on the Server side, but every MCP client behaves a little differently. Before adopting a client for team work, test the intended identity, allowed resource, denied resource and revocation against your Server. Avoid treating content read through a tool as instructions that can grant it more authority.
