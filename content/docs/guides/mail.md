---
title: Mail
description: Read, reply to, forward and triage email in shared L4 Mailboxes, write internal notes and control who can use each Mailbox.
order: 3
---

Mail lets a team share email addresses such as `support@example.com` inside the Server. Each **Mailbox** is a shared inbox with its own address and access rules. Incoming mail, replies and internal notes are grouped into **Email Conversations**.

Mail is optional. Before anyone can use it, the Server needs an email domain and at least one Mailbox. On Cloudflare, the Owner connects a mail domain and creates Mailboxes as described in [Mail on Cloudflare](../cloudflare/mail.md). On other runtimes, email domains are managed by the Server operator.

## Who can use a Mailbox

Two things decide access:

- a **grant on the Mailbox** itself, and
- **Read email** or **Send email** in the Member's Role.

Members with **Manage server** set grants in **Server settings → Mail → Mailboxes**: open a Mailbox and, under **Access**, choose for each person **No access**, **Read only**, **Read and send** or **Manage**. Even the Owner needs a grant to see a Mailbox.

![A Mailbox in Server settings → Mail with the Display name field, the Receive email switch and the Access list with per-member access levels](screenshot:guides-mail-access "Mailbox access")

In the same place you can set the **Display name** shown as the sender name, and turn **Receive email** off to pause a Mailbox. A paused Mailbox accepts no new mail and is hidden from Mail; nothing is deleted. **Delete mailbox** removes the address and its conversations.

## Read mail

Open **Mail** in the rail. Your Mailboxes are listed with their folders: **Inbox**, **Drafts**, **Sent**, **Archive**, **Spam** and **Trash**.

- Search a folder by subject, address, sender name and the text of emails and internal notes.
- Move a conversation with **Archive**, **Spam** or **Trash** in its header. Moving it changes it for everyone with the Mailbox, and needs a Read and send or Manage grant plus **Send email**.
- New mail can reopen an archived conversation. Mail filed as Spam or Trash stays there.

Your Inbox rail section lists Mailboxes with unread mail. Individual conversations stay in Mail.

## Send email

You need a **Read and send** or **Manage** grant and **Send email** in your Role.

1. Select **Compose**.
2. Fill in **To** and **Subject**. Select **Add Cc/Bcc** for more recipients. Bcc recipients stay out of the conversation's participants.
3. Write the **Message**. The formatting toolbar adds bold, italic, links, lists and quotes. Plain text is sent as typed.
4. Optionally **Attach** files.
5. Select **Send email**.

![The New email composer with To, Cc/Bcc, Subject and Message fields, the formatting toolbar and the Send email button](screenshot:guides-mail-compose "Write a new email")

### Reply and forward

In a conversation, the composer at the bottom has two modes:

- **Reply** sends an email. It goes to the sender (or their Reply-To address) by default; switch **Reply to sender** to **Reply all** to include everyone in To and Cc. You can edit the recipients before sending.
- **Internal note** adds a note for people who can open the Mailbox. It is never sent as email.

**Forward** opens a new email that quotes the original and copies its attachments.

### Drafts

The composer saves a draft a second after you stop typing. Drafts are yours and belong to one Mailbox; they are listed in **Drafts**. A reply draft reopens in its conversation. Sending removes the draft, and **Discard** deletes it with its uploads.

### Attachments

- Up to 10 attachments, 3 MB in total, per email.
- Files stay private to you until sent, then belong to the conversation.
- Programs and scripts are refused. HTML, SVG and XML are sent as plain downloads.
- Attachments need Server file storage. Without it, the composer explains that attachments are unavailable.

Signatures are not supported yet.

## Delivery status

Each email you send shows its status, such as **Sending**, **Sent** or **Not delivered**. If a send failed, use **Retry**. If L4 cannot tell whether the provider accepted it, it shows **Delivery unknown** and **Send again…**, and asks you to confirm before sending another copy, so you do not send a duplicate by accident.

## Notifications

Each new email that lands in a Mailbox's Inbox sends a push notification to every person with a grant on that Mailbox and **Read email** or **Send email**, and to the Owner if they have a grant. Mail filed as Spam or Trash stays quiet. See [Notifications](notifications.md).

## Agents and MCP

- MCP clients approved for the Mail scopes can list, search and read conversations and mark or move them, under the same grants. They cannot send email. See [Connect an MCP client](../agents/mcp.md#mail).
- Sending external email always needs a human. In this release Agents cannot send email; only the Mail interface sends.
- Email content comes from outside. Agents and clients treat it as untrusted data.

## Related

- [Mail on Cloudflare](../cloudflare/mail.md)
- [Inbox](chat.md#inbox)
