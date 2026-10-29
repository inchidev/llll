---
title: Cloudflare access
description: How L4 uses your Cloudflare authorization, what the OAuth permissions are for, and how to keep, replace or revoke the access a Server keeps.
order: 2
---

L4 never receives an account-wide Cloudflare credential that you did not approve. The installer works through your own Cloudflare OAuth authorization in your browser. After installation, the Server can keep Cloudflare access so it can update and reconfigure itself. Keeping it is on by default and you can turn it off at any time.

## The installer's OAuth grant

When you select **Connect Cloudflare** at [llll.gg/create](https://llll.gg/create?tab=cloudflare), Cloudflare asks you to approve L4's permissions. The resulting grant:

- is encrypted inside your browser-bound installer session on llll.gg;
- lasts for that session only, which is one hour. Only an explicit connection renews it; polling and progress do not;
- is used to list the L4 Servers in the account, create Servers, and run updates or address changes you start;
- is removed when you select **Disconnect** or the session expires.

If an older authorization lacks a newer permission, select **Reconnect Cloudflare** and approve again. Reconnecting keeps an unfinished installation's Server ID, Worker name and Owner claim.

### Requested permissions

Cloudflare shows these on its consent screen. They fall into three groups.

| Group | Permissions | Used for |
| --- | --- | --- |
| Provisioning | Account settings and memberships (read); Workers Scripts (admin, content read); D1 (read, write); Workers KV Storage (read, write); Workers R2 (read, write) | Finding your accounts, creating and updating the Worker, database, KV namespace and buckets. |
| Domains and mail | Zone (read); DNS (read, write); Email Routing rules (read, write); Email Sending (read, write) | Server addresses and mail domains. |
| Optional providers | Browser Rendering (read); Containers (read, write); Artifacts (read, write); Realtime (read, write); Queues (read, write) | Compute nodes, Live and related features you may enable later. |

The grant also includes offline access, so it can be refreshed while it is in use.

## Keep Cloudflare access on this Server

The installer offers **Keep Cloudflare access on this Server** when it installs or updates a Server. It is checked by default.

When it is on, after the new Server answers, the installer hands its OAuth grant to the Server once through a single-use capability and then forgets it. The Server checks that the grant reaches its own Cloudflare account and stores it encrypted with its `AUTH_SECRET`. If the handoff fails, the installation still succeeds, and you can connect access later in Settings.

With kept access, the Server can do these on its own, without the installer:

- **Updates.** **Back up and update** runs on the Server; you can close the page. See [Updates](updates.md).
- **Server addresses.** Add, promote and remove custom domains. See [Custom domain](custom-domain.md).
- **Mail domains.** Connect and disconnect mail domains. See [Mail](mail.md).
- **Live.** Connect Live without a separate RealtimeKit token.

Moving files to R2 and setting up a compute node still go through the official installer.

The Server renews a kept OAuth grant every week, together with its weekly backup, so it keeps working between updates. If renewal fails, Settings asks you to reconnect.

> [!TIP]
> For safety, run each Server in its own Cloudflare account. A free account is enough. Kept access then reaches only that Server's resources. This is a recommendation, not a requirement.

## See and manage the kept access

Only the Owner can connect or disconnect it.

1. Open **Server settings → Deployment → Updates**.
2. The **Cloudflare access** card shows **Connected** or **Not connected**, the kind (**Kept from the official installer** or **API token**) and since when. It never shows the credential.

![The Cloudflare access card in Server settings → Deployment → Updates, showing Connected, Kept from the official installer with a date, and a Disconnect button](screenshot:cloudflare-access-card "The Cloudflare access card")

### Turn it off

Select **Disconnect** on the **Cloudflare access** card. This deletes the credential from the Server. From then on, updates and address changes go through the official installer with a fresh, one-time authorization.

An OAuth grant also stays revocable in your Cloudflare account. To be sure it can no longer be used, revoke L4's authorization in your Cloudflare profile as well.

To stop the Server from receiving access during installation or a later update, uncheck **Keep Cloudflare access on this Server** before you start.

## Connect with an API token instead

If you do not want to hand over the installer's grant, you can give the Server an API token you create yourself.

1. Open **Server settings → Deployment → Updates**.
2. On the **Cloudflare access** card, select **Connect with an API token**.
3. Select **Create a token in Cloudflare**. Cloudflare opens with the token name `L4 Server updates` and these permissions filled in:
   - Workers Scripts: Edit
   - D1: Edit
   - Workers R2 Storage: Edit
   - Workers KV Storage: Edit
   - Account Settings: Read
4. Select **Create** in Cloudflare and copy the token.
5. Paste it into the **Cloudflare API token** field and select **Connect**.

The Server checks that the token reaches the account it runs in and refuses a token for another account.

> [!NOTE]
> The pre-filled token covers updates. It has no zone, DNS, Email Routing or Email Sending permissions, so adding addresses or mail domains from Settings needs a token with those permissions too, or the installer's grant.

To revoke a token, select **Disconnect** on the card and delete the token in your Cloudflare dashboard.

## Without kept access

Nothing breaks. Without kept access:

- updates continue on llll.gg with a fresh Cloudflare authorization for that one update;
- an address change opens the official installer, which applies it with a one-time authorization. The Server receives only a single-use request, never an account-wide credential;
- mail domains are managed by the Server operator.
