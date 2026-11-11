# Portal: a Mac window shared into a conversation

Decided on 2026-11-12 with the owner. The first slice is built in the same pull request; the stages below say what comes after it.

It builds on [Compute is the business](0009-compute-as-the-business.md), amended the same day to Usage, and replaces the separate product PartyPortal (`inchidev/partyportal`), which becomes its Mac module.

## Problem

PartyPortal is an experiment: a Mac app that shares one window as a link. The host captures and encodes on the Mac, the guest decodes in a browser, and every rule about what the guest may see or do is enforced on the Mac. It works, but alone it needs everything L4 already has: a public address (today a Cloudflare quick tunnel with a random name), rooms, people, roles, a relay for strict networks, a fan-out for several viewers, accounts and a bill. Its private cloud repository had planned all of that and built none of it.

L4 has the other half. Live rooms already exist in every conversation, a Server already knows who may do what, and L4 Cloud already bills. What L4 lacks is a way to hand a window, with control, to someone: a consultant helping a client, a teammate pairing, support, an Agent taking a desktop app. A screen share in a call shows a picture; it does not give control and it is drawn by the browser, which cannot see one window of another app, mask parts of it or move input into it.

## Decision

### Portal is a part of L4, and PartyPortal is its Mac module

- **One product.** Sharing a window is a capability of an L4 conversation, called Portal. The Mac code of PartyPortal (capture, masks, encoder, input, virtual display, WebRTC bridge) becomes a native module of the L4 Mac app. Until native app publication is unfrozen, the PartyPortal app is that module and is opened from the Client by a `partyportal://` link.
- **Pitched as help.** Support, consulting, pairing, an Agent at a desktop. Watching a film or taking turns at a game works the same way and is not advertised.
- **Distribution from the website.** The module calls private macOS interfaces (SkyLight for input to a background window, `CGVirtualDisplay`) and drives other apps through Accessibility, so it can never be in the Mac App Store; the Mac app is signed with Developer ID and notarized.
- **Only the host's Mac shares, and only macOS for now.** Guests watch and control from any browser. A Windows module is separate work, done when there is a reason.

### The host needs no Server

A Portal lives on some Server's address, and it is the address the link came from:

1. **A Portal from someone else's Server.** A consultant gives a client a Portal link to a thread on the consultant's Server. The client installs L4, opens the link, and shares a window into that thread as a guest. They need no Account and no Server.
2. **The host's own Server, or one where they may open a Portal.** The link is on that Server's domain.
3. **Nobody has a Server.** The link is on llll.gg, which serves the guest page and passes signalling only (built in `llll-cloud`, a later stage).

No tunnel is needed in any case: the Mac opens an outgoing connection to the Server like any client.

### The link is a capability for one Portal

- A Portal belongs to one conversation and is opened by a Member who may write in it.
- **The guest link** is `https://<server>/portal/<id>#t=<guest key>`. The key travels in the fragment, so it reaches no request line or log. It opens the guest page and the Portal's socket, and nothing else on the Server: a guest is not a Member and sees no conversation, person or file.
- **The host key** is separate and is given only to the Member who opened the Portal, inside the `partyportal://` link the Client opens on their Mac.
- The Server keeps only hashes of both keys. A Portal ends when the person who opened it or a conversation manager ends it, when the opener loses access to the conversation, or twelve hours after it was opened.

### Video and control never go through a Server

- **Direct is free, always.** The picture and the input go peer to peer between the Mac and the guest. The Server passes the signals that set up the connection.
- **Relays are usage.** When no direct path exists the picture goes through TURN, and several viewers go through a Realtime SFU (a later stage). On the operator's own Cloudflare the operator pays Cloudflare; on L4 Cloud it is a line of Usage (ADR 0009 as amended).
- **The first slice keeps PartyPortal's WebSocket fallback**: until the direct path is up, and when it fails, frames go through the Portal's Durable Object. Its cost is small enough to sit in the free base. It is replaced by TURN in stage 2.

### Rules are enforced on the Mac

- What the guest may see (which window, masks) and do (control, shortcuts, zones) is decided and enforced on the host's Mac, as in PartyPortal. The Server never widens it.
- Control is off by default. A guest asks; the host confirms each time in a dialog drawn by the native app, naming the person and the Server, never by a page of a Server; a key on the Mac takes control back even when the network or the Server is gone.
- A Server's page may only ask the native module for something. The L4 Mac app already grants native permissions per Server origin (`allow_origin`); a Portal link's origin gets the narrowest set: ask to share a window.

### Protocol and versions

The guest page is served by the Server and speaks to the module on the Mac, and the two can be at different versions: Servers stay on the release their operator chose, the module updates itself. The host's first frame names its relay protocol version (`v`), and the Server refuses one it does not speak with a close code the module shows as "update this Server or the app". The guest page and the module keep PartyPortal's own message set, which the relay passes through without reading.

## Stages

1. **This pull request.** A Portal per conversation with one guest at a time: `POST /api/channels/:id/portals` opens one and returns the guest link and the `partyportal://` link; `DELETE /api/portals/:id` ends it. A `PortalDurableObject` per Portal checks both keys and relays the host's and the guest's sockets frame for frame (`/portal/:id/host`, `/portal/:id/ws`). The Server serves PartyPortal's guest page at `/portal/:id`. ICE is STUN only. The PartyPortal app connects out to it (`inchidev/partyportal`, branch `claude/l4-portal`).
2. **TURN.** The Server mints TURN credentials from its own Realtime key and gives them to both sides; the WebSocket fallback of the picture goes away.
3. **Several viewers.** The Mac publishes one track to a Realtime SFU and each guest subscribes, as a second `LiveMedia` next to RealtimeKit; input travels in a data channel; a queue decides who controls; sound moves into the same connection as the picture so films stay in sync.
4. **The Mac app.** The module moves into the L4 Mac app (whether its shell stays on Tauri or becomes Swift is decided then); iOS and Android apps join as guests with touch control.
   - **First slice (built).** The L4 Mac app grants a Server's origin `allow-portal-share`, its narrowest native permission: the command `portal_share` takes the `partyportal://` link only when its Portal is `/portal/<id>` on the asking page's own origin, with exactly `url`, `key` and `t`. The app asks in its own alert, naming the Server from its own list with the address, then hands the link, rebuilt from the checked parts, to Launch Services; PartyPortal asks again. The Client's **Open PartyPortal** calls it through the injected bridge (`window.__LLLL_NATIVE_PORTAL__`) and shows its error, and stays a link in a browser. A build with `PARTYPORTAL_APP` carries PartyPortal in `Contents/Helpers` and prefers that copy. The module itself still runs as PartyPortal.
5. **A Portal in a thread.** The guest gets the thread's chat and its Live voice, may stay on the Server as a Member, and may sign in through their own L4 Server: that Server signs "this is Anna, Member of `<UUID>`", the host's Server or Mac checks the signature against `/.well-known/llll`, and the identity is linked as `{ provider: 'llll:<UUID>', subject }`.
6. **No Server at all.** llll.gg serves the guest page and the signalling for a Portal opened from the app without a Server.

## Consequences

- **A new Durable Object class**, `PortalDurableObject` (migration `v8-portal`), bound as `PORTAL_DO` on Cloudflare, celld and L4 Cloud. A Portal's state lives only there; it needs no table.
- **The guest page is a copy** of PartyPortal's `web/guest.html` in `server/assets/portal-guest.html`. It changes only together with the module's protocol.
- **`inchidev/partyportal-cloud` is not built.** Its accounts, plans and rooms are L4 Cloud's; its TURN relay is stage 2 here.
- **PartyPortal's tunnel goes** once stage 6 serves the no-Server case; until then the app keeps it for sharing without any Server.
- **AfterPrompt is unaffected.**
