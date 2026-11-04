---
title: Servers
description: How an L4 Server owns its people and data, how you move between Servers, and how Server addresses and identity work.
order: 1
---

A **Server** is where your community and its data live. You use one by opening its address.

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

The Client is the interface a Server serves at its own address. You use a Server directly in the browser, and a Server does not depend on llll.gg. The address also works as a PWA. The Client is never embedded in another site.

[llll.gg](https://llll.gg) hosts these docs and the [installer](https://llll.gg/create).

## Several Servers

The Server menu's **Add a Server** adds another Server by its address. Your browser keeps this list on that Server's address, on this device.

- That Server's own page can read the list. No other Server can.
- An entry is not an Account and grants no membership. You sign in to each Server separately, and your password and session stay with that Server.
- Lists are not synced. Each holds only what was added there or accepted there.
- Removing an entry does not delete the Server or your Account.

Once a list has an entry, a rail of Servers shows at the far left. Going to another Server is an ordinary page load of another site. See [Connect to a Server](../get-started/connect-a-server.md).

## Addresses

A Server can answer at several public **addresses**:

- The **primary address** is used for new links and background email.
- **Aliases** are additional addresses that reach the same Server UUID, Accounts and content.

Every listed address is trusted for login, sessions, uploads and realtime. A hostname that is not listed is not a Server address, even if it reaches the Server. On Cloudflare, addresses are managed in **Server settings → Deployment → Domain**; on a VPS, with `llll domain` ([VPS reference](../self-host/vps.md#server-addresses)).

## Related

- [Accounts, Members and Roles](accounts-members-roles.md)
- [Connect to a Server](../get-started/connect-a-server.md)
- [Custom domain on Cloudflare](../cloudflare/custom-domain.md)
