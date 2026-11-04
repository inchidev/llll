---
title: Spaces
description: Keep each department's work to itself on one Server, with limits on what it can use.
order: 6
---

A Space separates one department from the rest of your Server. People in a Space see that Space's channels, direct messages, Projects, Tasks, Mailboxes, Data, Apps, files, Agents and MCP connections, and nothing else. They do not see people from other Spaces in the Member list, in search, in mentions or as online.

Accounts, Roles, the domain, backups, Providers and Compute stay with the Server.

If you never create a second Space, nothing changes. Everything sits in the default Space, and the switcher appears only once there is a second one.

With more than one Space, the switcher sits directly under the Server in the rail. Every section, the Inbox included, shows the Space you chose, and page titles start with its name. A dot on the switcher means another of your Spaces has an unread conversation, an unread mention or a decision waiting on you; open the switcher to see which.

## How access works

Someone needs to be in the Space, and then needs the permission. A Role, a Project policy or a Grant gives nothing outside the person's Spaces, and inside them they work as usual.

- **People** can belong to several Spaces. An invitation joins the Space it was created in, so someone invited to one Space sees only that Space.
- **Agents** belong to exactly one Space and see only that Space. A person can use an Agent only in a Space they share with it.
- **MCP tokens** reach what the Member or Agent behind them reaches.

## Who manages a Space

- A **Space admin** manages that Space: its name, its members, and inside it, channels, Tasks, Data, Apps, Projects, Agents and invitations. They do not manage the Server.
- The **Server Owner** can manage any Space's members, limits and deletion, but reads its contents only after joining it. Joining is recorded in the audit log.

A Space that still holds conversations, Projects, Data, Apps or Agents cannot be deleted, and neither can the default Space.

## Limits

The Owner can set limits on each Space, under **Server settings > Spaces**:

| Limit | What happens at the limit |
| --- | --- |
| File storage | New uploads are refused. |
| People and Agents | Nobody else can join, and no new Agent can be created. |
| Agent Runs per month | New Runs are refused until next month. |
| Emails per month | Sending is refused until next month. Incoming mail still arrives. |

Each Space also has rate limits per person and action, such as sending messages or starting Runs. They stop runaway use and are separate from permissions.

## What a Space is not

Spaces separate departments of one organization. They are not protection between organizations that do not trust each other: every Space shares one database and one set of Server secrets, and the people operating the Server can reach all of it. For separate organizations, run separate Servers.
