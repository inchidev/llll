---
title: Chat
description: Use channels, Threads, Direct Messages, mentions, files, search and the Inbox in an L4 Server.
order: 1
---

Chat is where people and Agents in a Server talk. Everything here stays inside one Server: its channels, Direct Messages and files are not visible from other Servers, even to the same person.

## Channels

Open **Chat** in the rail to see the Server's channels, grouped in categories.

- An **open** channel can be read by every Member of the Server.
- A **private** channel can be read only by its members. Its creator adds or removes people with **Manage channel members** in the channel header. People added to a private channel can read its whole history.

Members with **Manage channels** create channels and categories from the Server menu (**Create Channel**, **Create Category**) or in **Server settings → Channels**. There they can also make a channel private or open, move it to another category and archive it.

An **archived** channel leaves Chat and the Inbox and becomes read-only for everyone, its Threads included. Its history stays readable at its links and in search. Members with **Manage channels** restore it from the **Archived** tab; a private channel can be archived or restored only by its creator.

## Messages

Type in the composer and press Enter to send. Shift+Enter adds a new line, and Arrow Up edits your last message. Messages can be up to 2,000 characters and support a small Markdown subset: bold, italic, code, links and lists.

- **Files:** use **Upload a file** or drop files on the composer. Up to 8 files per message, each up to 10 MB, if your Role has **Attach files**.
- **Voice messages:** use **Record audio**. A recording stops at 5 minutes.
- **Reactions:** open a message's menu and choose **Add reaction**. Reactions are emoji only.

Open a message's menu, or right-click it, for more actions:

| Action | What it does |
| --- | --- |
| **Reply** | Replies to this message in the same conversation. |
| **Create thread** / **Open thread** | Starts or opens a Thread on the message. |
| **Pin message** | Pins it to the conversation, if you may pin there. |
| **Edit message** | Changes your own message. |
| **Create task** | Opens a new Task prefilled from the message; see [Projects and Tasks](projects-and-tasks.md). |
| **Copy text**, **Copy message link**, **Copy message ID** | Copies them. |
| **Delete message** | Deletes your own message, or any message in a channel you moderate. |

![A chat message with its menu open showing Add reaction, Reply, Create thread, Pin message, Create task and Delete message](screenshot:guides-chat-message-menu "The message menu")

If your connection drops while a message is still sending, L4 keeps it and sends it when you reconnect. Reloading or closing the page at that moment asks you to confirm, because pending messages are not saved on disk.

## Threads

A Thread is a child conversation started from one message, so a side discussion does not fill the main channel. Choose **Create thread** on a message to start one. Agents always reply in a Thread.

## Direct Messages

Direct Messages are private conversations between Members of the same Server. Start one with the **New direct message** button next to **Direct messages** and search for the person by name, nickname or handle.

- A one-to-one Direct Message stays between its two people. There is one per pair.
- Including someone else starts a separate group with no copied history.
- In a group, its creator can remove people and anyone can leave.

A one-to-one Direct Message also has a **Call** button; see [Calls and Live](calls.md). For conversations with Agents, see the [Agents overview](../agents/overview.md#talking-to-an-agent).

## Mentions

Type `@` in the composer to mention someone.

| Mention | Notifies |
| --- | --- |
| `@name` | That person. A direct mention is also the only way to address an Agent. |
| `@Role` | Everyone with that Role who can read the conversation, up to 500 people. |
| `@channel` | Everyone who can read the conversation, up to 500 people. |
| `@here` | Those of them who are online or idle, up to 500 people. |

Anyone can mention a Role whose settings allow it (**Allow anyone to mention this role**). The Owner and Members with **Manage channels** can mention any Role and use `@channel` and `@here`; from anyone else they stay plain text. Role and group mentions never wake Agents and add nobody in a Direct Message. Editing a message notifies only people a new mention reaches.

## Search

Press ⌘K (Ctrl+K on Windows and Linux), or select **Search** in the conversation header. Choose **This conversation** or **Whole server**. Results include archived channels.

## Inbox

**Inbox** is the first rail section and the one place to catch up. It lists only what needs you:

- **Approvals:** Agent actions from your Runs waiting for your decision.
- **Mentions:** unread messages that mention you directly, through your Role or through `@channel` or `@here`.
- **Agent work:** your Runs while queued or running and for three days after, with the draft pull request when one was opened.
- **My tasks:** Tasks assigned to you, and Tasks you created that wait for your review.
- **Mail:** Mailboxes you can read that have unread mail.
- **Unread chats:** unread channels, Direct Messages and Agent chats. Mark one as read without opening it, or use **Mark all as read**.

The Inbox badge in the rail counts only approvals and mentions, so ongoing work does not keep it lit.

## Related

- [Notifications](notifications.md)
- [Calls and Live](calls.md)
- [Accounts, Members and Roles](../concepts/accounts-members-roles.md)
