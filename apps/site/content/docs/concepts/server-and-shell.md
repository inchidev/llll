---
title: Servers and the Shell
description: How an L4 Server owns its community and data, what the official Shell at llll.gg does, and how Server addresses and identity work.
order: 1
---

L4 has two parts you deal with as a user: the **Server**, where your community and its data live, and the **Shell**, an optional app that keeps a list of the Servers you use.

## The Server

A Server is one community with its own Members, Roles, conversations, content and settings. Each Server is a separate deployment that its operator runs, either on their own Cloudflare account or on their own VPS. There is no hosted L4 service.

A Server owns:

- Accounts, login and sessions.
- Members, Roles and invitations.
- Channels, Direct Messages, Tasks, Mail and files.
- Its realtime connections and its settings.

On Cloudflare, one Server is one Worker with its own D1 database, its own files bucket and its own Durable Objects. On a VPS it is one celld service with its own private storage. Backup storage is always separate from live files.

Servers are independent. A Member can belong to several Servers, but access to one Server never implies access to another. Direct Messages stay inside one Server.

### Server identity

Every Server has one persistent UUIDv4. It is the Server's only ID. It names the Server's resources, appears in public discovery and is preserved by updates, backups and restores. It is never reused for another Server.

Each Server publishes a small public description at `/.well-known/llll`: its UUID, origin, name, version and icon. Names and icons are public branding. Accounts, Members and conversations stay private.

## The Client

The Client is the interface a Server serves at its own address. You can always use a Server directly in the browser, without llll.gg. The direct address also works as a PWA.

## The Shell

The official Shell at [llll.gg](https://llll.gg) is a web, PWA and Telegram app that shows the Servers you have connected and embeds each Server's own Client.

- Saved Servers are **bookmarks on this device**. A bookmark is not an Account and grants no membership. Bookmarks are not synced between devices.
- You sign in to each Server separately. Login happens with that Server, in the embedded Client or a popup on the Server's own address. Your password and session never pass through the Shell.
- The Shell receives only bounded metadata from the Client: name, icon, unread state, navigation and call events. It never receives message text, passwords, session tokens or provider credentials.
- Removing a bookmark does not delete the Server or your Account.

The Shell's plus button opens the [Create page](https://llll.gg/create), with three tabs: **Connect** (add a Server by address or invitation), **Cloudflare** (install a new Server on your Cloudflare account) and **VPS** (get the install command for a VPS). **My servers** lists the Servers saved on this device.

![The llll.gg Shell with two Servers in the rail and one Server's Client open](screenshot:concepts-shell-rail "The Shell embeds each Server's own Client")

The Shell recognizes a Server by its UUID. If a bookmarked address starts answering with a different UUID, you must reconnect explicitly.

## Addresses

A Server can answer at several public **addresses**:

- The **primary address** is used for new links, Shell display and background email.
- **Aliases** are additional addresses that reach the same Server UUID, Accounts and content.

Every listed address is trusted for login, sessions, embedding, uploads and realtime. A hostname that is not listed is not a Server address, even if it reaches the Server. On Cloudflare, addresses are managed in **Server settings → Deployment → Domain**; on a VPS, with `llll domain` ([VPS reference](../self-host/vps.md#server-addresses)).

## Related

- [Accounts, Members and Roles](accounts-members-roles.md)
- [Connect a Server](../get-started/connect-a-server.md)
- [Custom domain on Cloudflare](../cloudflare/custom-domain.md)
