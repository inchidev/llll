---
title: Custom domain
description: Give your Cloudflare L4 Server its own domain, choose the primary address, and add or remove aliases without breaking existing links.
order: 4
---

A new Cloudflare Server starts on its `workers.dev` address. You can add your own domains at any time. A Server can answer at several addresses:

- The **primary address** is used for new links, the Shell's display and background email.
- **Aliases** are additional addresses. They reach the same Server, with the same UUID, Accounts and content.

Every listed address works for login, sessions, Shell embedding, links, uploads, MCP and realtime. Adding an address never disables the others, and the `workers.dev` address always stays enabled.

## Before you start

- The hostname must be in an **active zone in the same Cloudflare account** as the Server. Add the domain to Cloudflare first if it is not there yet.
- The hostname must not already be attached to another Worker.
- You must be the Owner.

## Add an address

1. In your Server, open **Server settings → Deployment → Domain**. The page is titled **Server address**.
2. Select **Add address**.
3. In **Domain**, enter the hostname, for example `chat.example.com`.
4. Optional: check **Make this the primary address**. The current primary stays available as an alias.
5. Confirm:
   - If the Server keeps Cloudflare access, select **Add address**. The Server attaches the domain itself.
   - Otherwise, select **Continue to Cloudflare**. The official installer opens on llll.gg; select **Connect Cloudflare**, sign in to the account that owns the Server, then select **Apply the change**. Keep the window open until it finishes, then select **Return to Server settings**.

![The Server address settings with the Addresses list showing a workers.dev address marked Always available, a custom domain marked Primary, and the Add address form with the Domain field](screenshot:cloudflare-server-address "Server settings → Deployment → Domain")

The installer attaches the hostname as a Worker custom domain in your zone. Cloudflare creates the DNS record and certificate for it.

The **Requests** list on the same page shows each change and whether it completed or failed, with the reason.

## Change the primary address

On an alias, select **Make primary**. The old primary stays as an alias, so existing links keep working.

New links, Shell bookmarks and background email then use the new primary. People who saved the Server in their Shell under an older address keep reaching it; the Shell recognizes the Server by its UUID.

## Remove an alias

On an alias, select **Remove**. This detaches the custom domain from the Worker.

You cannot remove the primary address. Make another address primary first. The `workers.dev` address is marked **Always available** and cannot be removed here.

> [!WARNING]
> Links, bookmarks and MCP clients that use a removed address stop working. Make sure people use the primary address before you remove an old one.

## Without kept Cloudflare access

If the Server does not keep Cloudflare access, every add, promote or remove goes through the official installer. The Server creates a single-use request; the installer applies it with your one-time Cloudflare authorization. The Server never receives an account-wide credential this way. See [Cloudflare access](access.md).

## Things to check

- **Only listed addresses are trusted.** A hostname that merely reaches the Worker, without being listed, is rejected for sessions and changes. It is never added automatically.
- **External sign-in providers.** If you use GitHub, Google or another login provider in **Server settings → Authentication**, allow its callback URL on each address you enable there.
- **Zone features that rewrite scripts.** Features that inject or rewrite inline scripts, such as Rocket Loader, are incompatible with the Server's Content-Security-Policy. Keep them off for the Server's hostnames.

## Related

- [Mail](mail.md)
- [Server and Shell](../concepts/server-and-shell.md)
