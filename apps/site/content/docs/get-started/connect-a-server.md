---
title: Connect to a Server
description: Open an L4 Server by its address or an invitation link, save it in your Shell and sign in with that Server's own Account.
order: 5
---

You can use any L4 Server directly at its address in a browser. The Shell at [llll.gg](https://llll.gg) is optional: it keeps a list of the Servers you use on this device and opens each one's own Client.

Saving a Server in the Shell is only a bookmark. It does not create an Account and does not grant membership. You still sign in on that Server, with that Server's Account.

## Add a Server to your Shell

1. Open [llll.gg/create](https://llll.gg/create). In the Shell, the plus button opens the same page.
2. Stay on the **Connect** tab.
3. In **Server address**, paste the Server's address (for example `chat.example.com`) or an invitation link.
4. Select **Connect**.
5. Sign in on the Server, or create an Account if the Server lets you.

![The Connect tab of the Add a Server page with the Server address field and the Connect button, and a Saved on this device list below](screenshot:get-started-connect-tab "Connect to a Server by address")

The Server appears under **Saved on this device**. The Shell recognizes a Server by its UUID, so adding it again by a different address of the same Server does not create a duplicate.

## Open your Servers

The Shell logo opens **My servers**, the list of Servers saved on this device. Select one to open it.

Each device keeps its own list. Bookmarks are not synced, and they contain no login or Cloudflare credential.

## Remove a Server from this device

On the **Connect** tab, select the **×** next to a Server under **Saved on this device**. In the Cloudflare tab, use **Remove from this device**.

Removing a bookmark does not delete the Server, your Account or your membership. You can add it again at any time.

If a saved Server on a `workers.dev` address has been deleted in Cloudflare, the Shell notices and removes it from this device, and tells you. Outages, timeouts and custom domains are never removed automatically.

## Use a Server without the Shell

Open the Server's address directly in your browser. Everything works there: login, conversations, files and Settings. The Shell only adds a list of Servers.

## Next steps

- [Invite your team](invite-your-team.md)
- [Server and Shell](../concepts/server-and-shell.md)
