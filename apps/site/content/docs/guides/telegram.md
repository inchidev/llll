---
title: Telegram
description: Open L4 Servers inside Telegram as a Mini App, sign in with Telegram, and what a Server operator must configure for it.
order: 6
---

L4 can run inside Telegram as a **Mini App**. The [llll.gg Shell](../concepts/server-and-shell.md) shows the Servers saved on your device, like in a browser. When you open one, that Server's own Client takes over the Mini App, so you sign in on the Server's own site and stay signed in; Telegram's **Back** button returns to My Servers. Each Server still keeps its own Accounts and sessions; Telegram never grants membership.

## Open a Server in Telegram

When the Shell opens as a Telegram Mini App, it fits itself to Telegram's window and safe areas. A Mini App link whose start parameter is `server_<Server UUID>` opens that Server directly. If the Server is not saved on the device yet, the Shell looks it up by its UUID and connects to it.

A Server's own Client can also be opened as a Mini App. A start parameter of `invite_<code>` then opens that invitation.

Open the official Shell in Telegram from [@L4_agent](https://t.me/L4_agent). It opens on **My Servers**, like the installed app, and is the same Shell as on the web: connect a Server by its address, open the Servers saved on this device, or create a new one.

## Create a Server from Telegram

Cloudflare sign-in does not work reliably inside Telegram, so **Create → Cloudflare** offers **Continue in browser** and opens the installer in your phone's browser. Create the Server there as usual. When it is ready, **Open in Telegram** next to it opens that Server in the Telegram Shell, which saves it on this device.

## Telegram notifications

Browsers inside Telegram cannot receive push notifications, so the L4 bot can send them instead:

1. Open the Server in the Telegram Shell and sign in the usual way, with any login method.
2. Open **User Settings → Notifications** and turn on **Telegram notifications**.
3. Allow the bot to message you when Telegram asks.

The bot then tells you about the same events as [push notifications](notifications.md#what-notifies-you): mentions, Direct Messages, new Live sessions and email. Each message names only the kind of event and the Server, with an **Open** button. It never contains what was said, who said it or where.

The Server stores only an opaque delivery token, not your Telegram ID, and the official site keeps no list of who receives what. Turn the switch off to stop, or block the bot to stop Telegram notifications from every Server at once. Each Server must run a release with this feature.

## Sign in with Telegram

When you open a Server through the Shell in Telegram and that Server supports Telegram Mini App sign-in, the Shell passes your Telegram launch data to the Server and you are signed in automatically:

- If your Telegram account is already linked to an Account on that Server, you are signed in to it.
- If it is not linked and the Server's registration is open, a new Account is created for you from your Telegram name.
- If registration is closed, sign-in is refused; use another login method or an invitation.

The Telegram proof is checked by the Server itself and is valid for five minutes. If sign-in fails, close the Mini App and open it again. You can always sign in with the Server's ordinary login instead.

Linking Telegram to an existing Account must be done explicitly from that Account; L4 never matches Accounts by name or email.

> [!NOTE]
> Telegram does not replace local Accounts. Each Server has its own Accounts, so signing in with Telegram on one Server does not sign you in to another.

## Telegram login in a browser

Separately from the Mini App, the Owner can offer **Continue with Telegram** on the Server's sign-in page:

1. Open **Server settings → Authentication**.
2. Turn on **Enable Telegram** and enter its **Client ID** and **Client secret**.
3. Use the callback address shown there, `/api/auth/callback/telegram` on your Server, when you create those credentials.
4. Select **Save changes**.

## For operators: Mini App sign-in

Mini App sign-in is off until the Server's deployment environment has one of:

| Variable | Use |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | The token of a Telegram bot you own. The Server verifies Mini App data with it. |
| `TELEGRAM_TRUSTED_BOT_ID` | The ID of a shared bot you explicitly trust. The Server verifies Telegram's public signature for that bot and never receives the bot's secret. |

A Server with either one reports Telegram support in its public metadata, and the Shell then passes Telegram's launch data to that Server's Client. Without them, the Server's ordinary login still works inside Telegram. L4 has no guided setup for these variables yet; set them where you manage the deployment's other secrets.

## Related

- [Server and Shell](../concepts/server-and-shell.md)
- [Connect a Server](../get-started/connect-a-server.md)
- [Notifications](notifications.md)
