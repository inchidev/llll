---
title: Calls and Live
description: Start audio and video calls, Live sessions and screen sharing in L4 channels and Direct Messages, and connect Cloudflare RealtimeKit as the Owner.
order: 4
---

Every channel and Direct Message has one Live room for audio, camera and screen sharing. In a one-to-one Direct Message it rings the other person as a **Call**; everywhere else it is **Live**, a room anyone in the conversation can join. Media runs on Cloudflare RealtimeKit in the Server's own Cloudflare account. Nothing is recorded.

## Start or join

1. Open the channel or Direct Message.
2. Select the phone button (**Call**) in a one-to-one Direct Message, or the waveform button (**Start live**) in a channel or group.
3. Check your **Microphone**, **Camera** and **Speaker** in the preview, then start.

If a room is already running, the button says **Join call** or **Join live**, and a bar in the conversation offers to join.

![A channel header with the Start live button and the Live preview dialog showing the Microphone, Camera and Speaker choices](screenshot:guides-calls-start "Start a Live session")

Starting a room needs **Start live sessions** in your Role; the built-in Member Role has it. Anyone who can open the conversation can join. You cannot start a room in an archived channel or a Direct Message you can no longer write to.

## During a call

- Mute or unmute, turn the camera on or off and share your screen from the controls.
- Minimize the room to keep chatting; the Live bar stays visible.
- **Leave** a Live session, or **Hang up** a call.

If the connection drops, L4 reconnects and keeps your microphone and camera settings.

The person who started a Live session, and in channels Members with **Manage channels**, can **Mute for everyone**, **Remove from live session** and **End for everyone**. In a one-to-one call both people have host controls.

## Incoming calls

When someone calls you in a one-to-one Direct Message, L4 rings and shows **Answer**, **Decline** and **Ignore**. If you are already in another room, **Leave and answer** switches over. An unanswered call stops ringing after 45 seconds.

Calls and newly started Live sessions also send push notifications; see [Notifications](notifications.md).

## Your audio settings

In **User Settings → Voice & Video** you choose the **Input Device** and **Output Device**, and turn **Ring for incoming calls** on or off. Mute and deafen are also on your account panel.

## Connect Live (Owner)

Calls need Cloudflare RealtimeKit. The Owner connects it in **Server settings → Live**.

- **With kept Cloudflare access:** if the Server keeps Cloudflare access (see [Cloudflare access](../cloudflare/access.md)), select **Connect using this Server's Cloudflare access**. No separate token is needed.
- **With an API token:** select **Create token**, create a Cloudflare API token with the **Realtime Admin** permission for the account the Server runs in, paste it and select **Connect**. If the token reaches several accounts, choose one.

L4 then creates its own RealtimeKit app with separate host and participant presets. The token is stored encrypted. Use **Test connection** to check it, **Replace token** to change it and **Disconnect** to turn Live off.

![Server settings → Live with the Connect using this Server's Cloudflare access button and the API token steps](screenshot:guides-calls-connect-live "Connect Live")

Messages you may see:

| Message | Meaning |
| --- | --- |
| **Calls are unavailable on this runtime** | The Server cannot reach Cloudflare RealtimeKit, so calls stay off. Text chat is unaffected. |
| **Calls use your Cloudflare API token** | The operator configured Cloudflare credentials for the deployment; the first call creates the RealtimeKit app. |
| **Managed by the deployment** | RealtimeKit credentials come from the deployment's environment and override anything saved here. |
| **The saved token can no longer be read** | The Server's `AUTH_SECRET` is missing or changed. Restore it, or paste a token to reconnect. |
| **Everyone joins with host controls** | Live was connected before hosts and participants had separate permissions. Select **Reconnect**. |

Cloudflare RealtimeKit usage is billed to your Cloudflare account. See [Costs and limits](../cloudflare/costs-and-limits.md).

## Related

- [Chat](chat.md)
- [Notifications](notifications.md)
