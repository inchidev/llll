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
2. **TURN.** The Server mints TURN credentials from its own Realtime key and hands them to the host in `pp.ready` (`iceServers`); the host passes them to its guest. The key comes from `REALTIME_TURN_KEY_ID` and `REALTIME_TURN_KEY_API_TOKEN`, or a Server in its own Cloudflare account with kept Cloudflare access makes one (`portal.turn-key`, sealed with `AUTH_SECRET`). L4 Cloud and celld use the variables. The WebSocket fallback of the picture goes away once every host passes the credentials on.
3. **Several viewers.** The Mac publishes one track to a Realtime SFU and each guest subscribes, as a second `LiveMedia` next to RealtimeKit; input travels in a data channel; a queue decides who controls; sound moves into the same connection as the picture so films stay in sync.
   - **First slice (built): relay protocol v2.** v2 is negotiated: the Mac offers `v: 2` in its first frame, and the Server answers `{ t: 'pp.ready', v: 2, sfu: true, iceServers? }` only when it has a Realtime SFU app; otherwise it answers as v1, which is unchanged (one guest, frames verbatim). A Server from before v2 closes a `v: 2` hello with 4426, and the Mac then says `v: 1` to it from then on. The app comes from `REALTIME_SFU_APP_ID` and `REALTIME_SFU_APP_TOKEN`, or, only when its operator sets `PORTAL_SFU_AUTO=1`, a Server in its own Cloudflare account with kept Cloudflare access makes one (`POST /accounts/:id/calls/apps`, `{ name: 'L4 Portal' }`) and keeps it as `portal.sfu-app`, sealed with `AUTH_SECRET` (scope `portal-sfu-app`), as it does its TURN key; L4 Cloud and celld use the variables. Every SFU call is made by the Portal's Durable Object; the app's secret never reaches the Mac or a guest. This slice has run only against a fake of the SFU API and a peer-to-peer stand-in, never against Cloudflare's SFU, which is why it stays behind the variables until it has.
   - **What v2 does.** Up to 16 guests (`PORTAL_MAX_VIEWERS`); the next one reads a `bye` and is closed with 4503. Each guest gets a name `g`, and every frame between the host and a guest is wrapped so the Mac keeps its rules per guest: its own token check, hello and state, and input only from the one guest it gave control. The Mac's bridge publishes the picture once (one `RTCPeerConnection`, the video track in three simulcast layers `f`/`h`/`q` at full, half and quarter size, and the app's sound as an audio track). The Server subscribes a guest only after the Mac has checked its key (`pp.admit`): one SFU session per guest, remote tracks on the host's session, `simulcast.preferredRid: 'h'` with alphabetical fallback. The guest answers the SFU's offer, and the Server hands the answer to `renegotiate`. SFU calls of one session run one after another, offer and answer included (`createSerialQueue` per session). A subscription that finds no media yet is retried with a fresh session three more times, and is taken without sound on the last try. When the host leaves, its publication and every subscription go; the next host checks and admits its guests again.
   - **Control.** A viewer asks (`{ t: 'control', ask: true }`); the Mac lists who asks on its Share page, the host gives control to one viewer and takes it back there or from the menu bar. Input still goes through the Portal's socket in this slice, wrapped like every other guest frame; an SFU data channel with `canReply` for the one controller is a later step.
   - **Usage.** The Durable Object never sees media; it keeps the ids of the SFU sessions it made (`sfuSessions()`) for L4 Cloud to report SFU egress as llll-cloud's `portal_relay` (a TODO in `workers/portal-do.ts`).
   - **Not verified against a real SFU.** The SFU calls are tested against a stand-in of the Connection API (`tests/unit/portal.test.ts`); PartyPortal's `tools/portal-relay.mjs --v2` fakes the SFU peer to peer to exercise the Mac and the guest page end to end. The first run against a real Realtime SFU app is still to do.

   | Direction | Frame (v2) | Meaning |
   | --- | --- | --- |
   | host → Server | `{ t: 'host', key, v: 2 }` | First frame; offers v2 |
   | Server → host | `{ t: 'pp.ready', v: 2, sfu: true, iceServers? }` | v2 accepted; without an SFU app the answer is v1's `{ t: 'pp.ready' }` |
   | Server → host | `{ t: 'pp.guest', open, g }` | A guest arrived or left; `open: true` is followed by its own first frame as `pp.from` |
   | Server → host | `{ t: 'pp.from', g, f }` | A guest's frame `f` |
   | host → Server | `{ t: 'pp.to', g, f }`, `{ t: 'pp.all', f }` | A frame for one guest, or for all |
   | host → Server | `{ t: 'pp.close', g }` | Close that guest (4403), after the Mac's own `bye` |
   | host → Server | `{ t: 'pp.admit', g }` | The Mac checked that guest's key: subscribe it |
   | host → Server | `{ t: 'pp.sfu.publish', sdp, tracks: [{ mid, trackName, kind }] }` | The bridge's offer; `trackName` is `video` and optionally `audio` |
   | Server → host | `{ t: 'pp.sfu.answer', sdp, tracks }` | The SFU's answer, and which tracks it took |
   | Server → guest | `{ t: 'pp.sfu.offer', sdp, tracks, fresh, iceServers? }` | The SFU's offer for this guest's own session (`fresh`: a new connection) |
   | guest → Server | `{ t: 'pp.sfu.answer', sdp }` | The guest's answer, passed to `renegotiate` |
   | guest → Server | `{ t: 'pp.sfu.layer', rid }` | Ask for layer `f`, `h` or `q` (`tracks/update`); answered `{ t: 'pp.sfu.layer', rid, ok }` |
   | Server → host or guest | `{ t: 'pp.sfu.error', why, g? }` | An SFU call failed; `why` is the SFU's error code |
   | Server → guest | `{ t: 'pp.wait' }` | The host is away |

   No binary frame passes through a v2 Portal, and a guest's other `pp.` frames are dropped.
4. **The Mac app.** The module moves into the L4 Mac app (whether its shell stays on Tauri or becomes Swift is decided then); iOS and Android apps join as guests with touch control.
   - **First slice (built).** The L4 Mac app grants a Server's origin `allow-portal-share`, its narrowest native permission: the command `portal_share` takes the `partyportal://` link only when its Portal is `/portal/<id>` on the asking page's own origin, with exactly `url`, `key` and `t`. The app asks in its own alert, naming the Server from its own list with the address, then hands the link, rebuilt from the checked parts, to Launch Services; PartyPortal asks again. The Client's **Open PartyPortal** calls it through the injected bridge (`window.__LLLL_NATIVE_PORTAL__`) and shows its error, and stays a link in a browser. A build with `PARTYPORTAL_APP` carries PartyPortal in `Contents/Helpers` and prefers that copy. The module itself still runs as PartyPortal.
5. **A Portal in a thread.** The guest gets the thread's chat and its Live voice, may stay on the Server as a Member, and may sign in through their own L4 Server: that Server signs "this is Anna, Member of `<UUID>`", the host's Server or Mac checks the signature against `/.well-known/llll`, and the identity is linked as `{ provider: 'llll:<UUID>', subject }`.
6. **No Server at all.** llll.gg serves the guest page and the signalling for a Portal opened from the app without a Server.

## Consequences

- **A new Durable Object class**, `PortalDurableObject` (migration `v8-portal`), bound as `PORTAL_DO` on Cloudflare, celld and L4 Cloud. A Portal's state lives only there; it needs no table. In v2 it also keeps the host's SFU publication and the ids of the SFU sessions it made.
- **The guest page is a copy** of PartyPortal's `web/guest.html` in `server/assets/portal-guest.html`. It changes only together with the module's protocol.
- **`inchidev/partyportal-cloud` is not built.** Its accounts, plans and rooms are L4 Cloud's; its TURN relay is stage 2 here.
- **PartyPortal's tunnel goes** once stage 6 serves the no-Server case; until then the app keeps it for sharing without any Server.
- **AfterPrompt is unaffected.**
