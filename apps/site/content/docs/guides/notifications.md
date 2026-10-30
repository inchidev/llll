---
title: Notifications
description: Turn on push notifications for an L4 Server on each device, and learn which mentions, messages, calls, mail and reminders notify you.
order: 5
---

L4 sends browser push notifications for things that need you. Notifications are set per Server and per device: turn them on in each browser or installed app where you want them.

## Turn on push notifications

1. Open the Server and select your avatar at the bottom of the rail to open **User Settings**.
2. Choose **Notifications**.
3. Next to **Push notifications**, select **Enable** and allow notifications when your browser asks.

![User Settings → Notifications with the Push notifications row and its Enable button, and the Message sounds switch](screenshot:guides-notifications-settings "Turn on push notifications")

Turn the switch off to stop notifications on this device. **Message sounds** plays a sound when a message arrives while the tab is in the background.

If the row shows a badge instead of **Enable**:

| Badge | Meaning |
| --- | --- |
| **Blocked** | Notifications are blocked for this site in your browser settings. Allow them there, then reopen the page. |
| **Unavailable** | The Server has no Web Push configuration. Ask the Server operator. |
| **Unsupported** | This browser does not support web push. |

> [!TIP]
> On iPhone and iPad, Apple allows web push only for sites added to the Home Screen. Open the Server in Safari, add it to the Home Screen, open it from there and then enable notifications.

## What notifies you

| Event | Who is notified |
| --- | --- |
| A direct mention | The person mentioned, if they can read the conversation. |
| A role mention, `@channel` or `@here` | The people it reaches who can read the conversation, up to 500. See [mentions](chat.md#mentions). |
| A message in a Direct Message | Every other participant. |
| A new Live session | Other Members who can open its channel or Direct Message. |
| A call in a one-to-one Direct Message | The other person. |
| New email in a Mailbox's Inbox | Everyone with a grant on the Mailbox and **Read email** or **Send email**. Spam and Trash stay quiet. |
| A reminder you scheduled | You. The reminder also stays unread for you. |

Ordinary channel messages that do not mention you do not send push notifications; they appear as unread in Chat and in your [Inbox](chat.md#inbox). Joining, leaving and ending a Live session do not notify anyone. People who cannot read a conversation are never notified about it.

## App badge

When you install a Server as an app from its own address, each push also updates the app icon's badge with your count of unread conversations. Opening the app recalculates it. A message you read on another device updates the badge on the next push or launch.

## Notifications and the Shell

Each Server sends its own notifications. Adding a Server to the [llll.gg Shell](../concepts/server-and-shell.md) does not change who is notified, and the Shell receives no message content.

To get them in Telegram as well, or in the Telegram Shell where push notifications are not available, turn on **Telegram notifications** in the same settings. See [Telegram notifications](telegram.md#telegram-notifications).

## For operators

A Server's Web Push identity must stay stable: if it changes, existing subscriptions stop working and people need to select **Enable** again. You can configure the identity for the deployment yourself (`VAPID_SUBJECT`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, all three). Recent Servers without that configuration create their own identity when notification settings are first opened, provided the Server has an HTTPS address or an administrator email, and store it encrypted with `AUTH_SECRET`. Keep that secret with your [Backups](../cloudflare/backups.md).

## Related

- [Chat](chat.md)
- [Calls and Live](calls.md)
- [Schedules](../agents/schedules.md)
