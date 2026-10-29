---
title: Mail on Cloudflare
description: Connect a mail domain to your Cloudflare L4 Server with Cloudflare Email Routing and Email Sending, then create shared Mailboxes.
order: 5
---

Mail is optional. A Cloudflare Server receives and sends email for its shared Mailboxes through Cloudflare **Email Routing** and **Email Sending** on a domain in your Cloudflare account. The installer does not set up mail; you connect a mail domain later from the Server's Settings.

For using Mail day to day, see the [Mail guide](../guides/mail.md).

## Before you start

- The Server must **keep Cloudflare access** with permission for zones, DNS, Email Routing and Email Sending. The installer's OAuth grant has these. The pre-filled API token for updates does not. See [Cloudflare access](access.md).
- The domain must be in an active zone in the same Cloudflare account as the Server.
- You must be the Owner.

Without kept access, the Domains tab says email domains are managed by the Server operator.

> [!WARNING]
> Connecting a domain turns on Cloudflare Email Routing for it and routes its mail to this Server. If the domain already receives mail through another provider, use a subdomain such as `mail.example.com` instead, so existing mail keeps working.

## Connect a mail domain

1. In your Server, open **Server settings → Mail** and choose the **Domains** tab.
2. Select **Connect domain**.
3. Choose the **Cloudflare zone**.
4. In **Mail domain**, enter the zone itself or a subdomain, for example `mail.example.com`.
5. Select **Connect**.

![The Domains tab in Mail settings with the Connect domain form showing the Cloudflare zone select, the Mail domain field and the Connect button](screenshot:cloudflare-mail-domain "Connect a mail domain")

The Server then:

- enables Cloudflare Email Routing for the domain;
- onboards the domain for Cloudflare Email Sending, or re-enables it if it was turned off;
- adds the Email Sending binding to its Worker.

If the page shows **Sending is not set up yet**, mail can be received but the Server cannot send until the domain finishes connecting in Cloudflare. Check the domain's status under Email in your Cloudflare dashboard.

## Create a Mailbox

1. In **Server settings → Mail**, choose the **Mailboxes** tab.
2. Select **New mailbox**.
3. Enter the address and choose the domain, then select **Create mailbox**.
4. Open the Mailbox to set its **Display name** and choose who has access.

Each Mailbox has its own access rules. People need a grant on the Mailbox plus **Read email** or **Send email**.

## Disconnect a mail domain

On the **Domains** tab, select **Disconnect** next to the domain.

- If L4 created the domain's Email Sending configuration, it removes it again.
- When no mail domain remains, the Email Sending binding is removed from the Worker.
- Mailboxes and their history stay on the Server.

## Limits

- Up to 10 attachments, 3 MB in total, per email. This keeps a message within Cloudflare Email Sending's 5 MiB limit once encoded.
- Sending external email from an Agent always needs human approval.

Cloudflare's own Email Routing and Email Sending limits and pricing apply. See [Email Routing](https://developers.cloudflare.com/email-routing/) in the Cloudflare docs.

## Related

- [Mail guide](../guides/mail.md)
- [Custom domain](custom-domain.md)
