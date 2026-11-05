---
title: Mail on Cloudflare
description: Connect a mail domain to your Cloudflare L4 Server with Cloudflare Email Routing and Email Sending, then create shared Mailboxes.
order: 5
---

Mail is optional. A Cloudflare Server receives and sends email for its shared Mailboxes through Cloudflare **Email Routing** and **Email Sending** on a domain in your Cloudflare account. The installer does not set up mail; you connect a mail domain later from the Server's Settings.

For using Mail day to day, see the [Mail guide](../guides/mail.md).

## Before you start

- The Server must **keep Cloudflare access**. The installer's OAuth grant has every permission mail needs. The pre-filled API token for updates does not. See [Cloudflare access](access.md).
- The domain must be active in the same Cloudflare account as the Server. See [Get a domain](custom-domain.md#get-a-domain).
- To send email to anyone outside your Cloudflare account, the account needs the **Workers Paid** plan. See [Costs and limits](costs-and-limits.md#free-and-paid-workers-plans).
- You must be the Owner.

Without kept access, the Domains tab asks you to keep it before you connect a domain.

> [!WARNING]
> Connecting a domain routes its mail to this Server. If the domain already receives mail through another provider, L4 refuses it and leaves that mail alone. Use a subdomain such as `mail.example.com` instead.

## Connect a mail domain

1. In your Server, open **Server settings → Mail** and choose the **Domains** tab.
2. Select **Connect domain**.
3. Choose the **Cloudflare zone**.
4. In **Mail domain**, keep the domain or enter a subdomain, for example `mail.example.com`.
5. Select **Connect**. The form for your first Mailbox opens next.

![The Domains tab in Mail settings with the Connect domain form showing the Cloudflare zone select, the Mail domain field and the Connect button](screenshot:cloudflare-mail-domain "Connect a mail domain")

The Server then:

- enables Cloudflare Email Routing for the domain, unless it already routes through Cloudflare;
- onboards the domain for Cloudflare Email Sending, or re-enables it if it was turned off;
- adds the Email Sending binding to its Worker;
- starts sending reset and confirmation emails from `no-reply` at the domain. To use another address, change **Sender address** in **Server settings → Authentication**.

You do not add any DNS records yourself.

If a domain shows **Receives mail, sending is off**, Cloudflare has not enabled sending yet. Select **Finish connecting** to try again. **Sending is not set up yet** at the top of the page means the same until the domain finishes connecting.

### If Cloudflare did not turn on Email Routing

Access kept from an older release lacks the permission to turn Email Routing on, so **Connect** stops with this message. Do one of these, then select **Connect** again:

- Update the Server through the [official installer](updates.md) with **Keep Cloudflare access on this Server** checked, which replaces the kept access.
- In your Cloudflare dashboard, go to **Compute → Email Service → Email Routing**, select **Onboard Domain** and choose the domain.

## Create a Mailbox

1. In **Server settings → Mail**, choose the **Mailboxes** tab.
2. Select **New mailbox**.
3. Enter the address and choose the domain, then select **Create mailbox**. The Owner and the person who created it get **Manage**.
4. Open the Mailbox to set its **Display name** and choose who else has access.

The Server creates a Cloudflare Email Routing rule that sends the address to it. If the address already has a rule for something else, the Mailbox is not created until you remove that rule. Deleting a Mailbox removes its rule.

Each Mailbox has its own access rules. People need a grant on the Mailbox plus **Read email** or **Send email**.

To check it works, send an email to the new address from your personal mail, then reply to it from **Mail** in L4.

## Disconnect a mail domain

On the **Domains** tab, select **Disconnect** next to the domain.

- If L4 created the domain's Email Sending configuration, it removes it again.
- When no mail domain remains, the Email Sending binding is removed from the Worker.
- Mailboxes and their history stay on the Server.

## Limits

- Up to 10 attachments, 3 MB in total, per email. This keeps a message within Cloudflare Email Sending's 5 MiB limit once encoded.
- Sending external email from an Agent always needs human approval.
- Mailboxes are read and answered in L4. There is no IMAP access for mail apps.
- A new Cloudflare account starts with a low daily sending limit, and mail from a new domain may land in spam until the domain builds a reputation.

Cloudflare's own limits and pricing apply. See [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) and [pricing](https://developers.cloudflare.com/email-service/platform/pricing/) in the Cloudflare docs.

## Related

- [Mail guide](../guides/mail.md)
- [Custom domain](custom-domain.md)
