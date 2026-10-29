---
title: Create a Server on Cloudflare
description: Install an L4 Server in your own Cloudflare account from the browser, claim it as Owner and open it in your Shell.
order: 3
---

The official installer at [llll.gg/create](https://llll.gg/create?tab=cloudflare) creates a new Server in your Cloudflare account. It runs in your browser, uses your own Cloudflare authorization and installs only a published, checksum-verified release. It takes a few minutes.

## Before you start

- A Cloudflare account with a verified email address. If the email is not verified, the installer asks you to verify it and reconnect.
- The email address you want to use for the Owner Account.
- Optional: R2 enabled on the account. With R2 the Server gets a private files bucket and a separate backups bucket. Without it, the Server uses basic file storage and backups download to your device. See [What the installer creates](../cloudflare/overview.md#what-the-installer-creates).

> [!TIP]
> For safety, give each Server its own Cloudflare account. A free account is enough. This is a recommendation, not a requirement.

## 1. Connect Cloudflare

1. Open [llll.gg/create](https://llll.gg/create) and choose the **New on Cloudflare** tab. In the Shell, the plus button opens the same page.
2. Select **Connect Cloudflare**.
3. Sign in to Cloudflare and approve the requested permissions. [Cloudflare access](../cloudflare/access.md) explains each one.
4. Back on the installer, choose the account under **Cloudflare account**.

![The Create page with the New on Cloudflare tab selected, showing the Cloudflare account card with the Connect Cloudflare button](screenshot:get-started-connect-cloudflare "Connect your Cloudflare account")

The card shows how long the Cloudflare access and the installer session last. The installer session lasts one hour. Your Servers keep running when this connection ends.

## 2. Configure the Server

1. Select **Create a Server**.
2. Fill in the form:
   - **Your admin email**: the email for your Owner Account. You choose the password later, on the Server itself.
   - **Server name**: up to 80 characters. You can rename the Server later in Settings; this never changes Cloudflare resources.
   - **Release version**: the published release to install.
3. Leave **Keep Cloudflare access on this Server** checked if you want the Server to update itself from its own Settings. Uncheck it if you prefer the Server to keep no Cloudflare credential. See [Updates](../cloudflare/updates.md).
4. Select **Deploy Server**.

![The Create a Server form with the admin email, Server name and Release version fields, the Keep Cloudflare access on this Server checkbox and the Deploy Server button](screenshot:get-started-create-form "Configure the new Server")

## 3. Wait for the deployment

The installer shows its phases: **Configure your Server**, **Start deployment**, **Wait for Cloudflare verification** and **Ready**, with details for each step.

Before it creates anything, the installer downloads the selected release and verifies its checksums. A missing or mismatched checksum stops the installation without creating a Server.

Every step can be resumed. If something fails, fix the cause (for example reconnect Cloudflare) and select **Resume deployment**. A retry reuses the same Server ID and resources. **Pause and start another** keeps the unfinished installation in your installer session so you can resume it later with **Resume setup**.

A new Server starts on your account's `workers.dev` hostname. Its status may show **Waiting for HTTPS…** for a short time while Cloudflare prepares the address.

## 4. Claim the Server as Owner

When the Server is ready for setup, its row under **Your Servers** shows **Setup required** and a **Finish setup on your Server** button.

1. Select **Finish setup on your Server**. It opens the Server's `/setup` page in a new tab, on the Server's own address, so your browser can save the password for that site.
2. Check the **Email**, enter **Your name**, a **Password** and **Confirm password**.
3. Select **Sign in as owner**.

![The Server's Finish signing in page with Email, Server name, Your name, Password and Confirm password fields and the Sign in as owner button](screenshot:get-started-owner-setup "Claim the Server as Owner")

The setup link carries a private, single-use claim. Knowing the admin email alone cannot claim the Server. After you claim it, the claim is deleted.

The installer saves the Server in your Shell. Use **Open in Shell** or **Open directly**.

### If you lost the setup link

If you closed the tab or the installer session expired before you claimed the Server:

1. Open [llll.gg/create](https://llll.gg/create?tab=cloudflare) and select **Reconnect Cloudflare**.
2. Select **Refresh Servers**.
3. On the Server's row, select **Finish setup on your Server** or **Recover setup link**.

Recovery works only while the Server has no Owner and no login Accounts. It never resets an existing Owner.

## Next steps

- [Invite your team](invite-your-team.md)
- [Add a custom domain](../cloudflare/custom-domain.md)
- [Create your first Agent](first-agent.md)
- [Understand costs and limits](../cloudflare/costs-and-limits.md)
