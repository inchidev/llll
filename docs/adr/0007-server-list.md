# Server list

Accepted on 2026-11-04.

## Problem

The Shell at llll.gg kept a device's Servers and showed each one's Client in an iframe, talking to it over postMessage. Telegram was a second way into the same Shell, with a Mini App, sign-in and a notifications relay on the official Worker.

An iframe on llll.gg makes a Server's session a third-party cookie, and WebKit limits those. So sign-in on an iPhone depended on browser policy we do not control. A native bridge does not reach an iframe. `SameSite=None`, a Partitioned cookie and a list of permitted parents were a standing attack surface on every Server, kept for one site. And a Server should work without llll.gg. Its Client, its notifications and the way to reach it should not pass through a service someone else runs.

## Decision

**There is no Shell and no Telegram.** No `llll.gg/<server-id>`, no `/servers`, no iframe, no postMessage protocol, no `EMBED_ORIGINS`, no directory. No Mini App, Telegram sign-in, Telegram notifications or bot relay. Notifications are Web Push, sent by each Server itself.

**A Client is never embedded.** Server CSP is `frame-ancestors 'self'` and the session cookie is plain `SameSite=Lax`, not Partitioned.

**llll.gg is the installer and the Docs.** `/create` has the tabs On Cloudflare and On a VPS, with `/domain` and the update flow for customer Servers. The landing page, pricing, blog and billing stay in `inchidev/llll-cloud`.

**You use a Server by opening its address.** Going to another Server is an ordinary page load of another site.

**Switching lives in each Server's own Client.** The Server menu's **Add a Server** asks for an address. The browser keeps the list in `localStorage` on that Server's address, per device, so that Server's page can read it and no other Server can. Once it has an entry, a rail of Servers shows at the far left. An entry grants no membership, and you sign in to each Server separately.

**Links between Servers are pair-wise, and they ask.** The first time you go to a listed Server, the URL fragment carries `#from=<origin>` and that Server offers **Add the way back?**, showing the address to check first. Anyone can craft such a link, so nothing is added without confirmation.

**The apps keep the device's list.** In the iOS, Android and macOS apps the rail is a second WebView at the app's own address, beside the one showing a Server, and reads the list there. A Server's page can reach neither that WebView nor the list; it can only say whether it has room, so that on a phone the rail joins the navigation drawer. The Client's Server menu also shows **All Servers**, which opens the app's own list.

## Considered and rejected

**Passing the list from Server to Server.** It would spare adding each Server on each one, but every Server would learn the addresses of all the others, including ones its operator has no business knowing about. A pair of Servers learns only about each other, and only when you go from one to the other.

## Consequences

- Switching Servers is a full page load, not an instant swap in one window.
- There are no unread counts across Servers. Entries show a name or initial, and notifications cover the rest.
- Lists are not synced. Each Server's list holds only what was added there or accepted there, so someone with many Servers adds some more than once.
- On iPhone, each Server needs its own Home Screen icon, which is also what Web Push requires there.
- Old links and old Servers are not supported.
- A Server has no embedding or relay configuration left to get wrong, and needs nothing from llll.gg to run.
