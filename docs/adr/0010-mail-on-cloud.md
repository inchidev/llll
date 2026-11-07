# Mail on Cloud

Proposed on 2026-11-07. Nothing here is built. It settles the point [ADR 0008](0008-server-per-tenant.md) left open: "Mail needs its own design: a shared inbound handler and platform sending."

## Problem

On a customer's own Cloudflare account a Server connects a mail domain by itself: it turns on Email Routing for the zone, onboards the domain for Email Sending, adds the `MAIL_EMAIL` binding to its Worker and creates one literal routing rule per Mailbox (`packages/deployment-core/src/domains.ts`). That works because the zone, the Worker and the Server live in one account the Owner controls.

On Cloud every tenant Server runs in our account, on Workers for Platforms, and never holds a Cloudflare token. The same recipe would mean adding customers' zones to our account and letting our control plane edit them, and it runs into Cloudflare's limits before it runs into policy:

- Email Routing allows 200 routing rules per domain and 30 domains per zone for Routing and Sending together, the apex included. A catch-all exists only on the apex. One literal rule per Mailbox on `llll.gg`, or one subdomain per tenant, is a few hundred Mailboxes, not a fleet.
- Email Sending sends only from domains onboarded in the account that sends. A customer's domain cannot send from our account unless its zone moves to us.
- Bounce and complaint suppressions are scoped by sending domain, and reputation is too. Every tenant sending from one of our domains shares one list and one reputation.
- Email Routing delivers only to zones on Cloudflare DNS. A customer whose domain is elsewhere cannot point MX records at us at all.

[ADR 0003](0003-server-schema-lineage.md) already says each Server handles its own mail domains and provider credentials, and that there is no shared mail relay. This decision keeps that rule and says what Cloud offers instead.

## Decision

**A web address is not a mail domain.** A tenant's own hostname for the Server (`chat.example.com`) is a Cloudflare for SaaS custom hostname on our zone: the customer adds a CNAME, the zone stays wherever it is, nothing is added to our account. Mail is a separate decision, made per domain.

**Two kinds of mail domain on Cloud.**

1. **A platform address, free.** Every Cloud Server may create Mailboxes on one domain we own and run, such as `acme-support@<mail domain>`. The local part carries the tenant, since Routing cannot spread tenants across subdomains at scale. One apex catch-all on that zone sends every message to one **shared inbound Worker** in `llll-cloud`. It looks the address up in the fleet, rejects what no tenant claims, and hands the raw RFC822 bytes to the tenant's Server over the signed HTTP entry Servers already accept from `examples/email-bridge` (`INBOUND_EMAIL_SECRET`, `workers/inbound-email.ts`). The Server stores and routes the message as it does today; the shared Worker keeps nothing. Sending uses the control plane's `EMAIL` binding on that domain, through the same signed channel in the other direction. Because reputation and suppressions on that domain are shared by every tenant, the control plane rate-limits sending per Server, uses a dedicated zone rather than `llll.gg`, and may stop a Server's sending on complaints. A Mailbox on the platform domain is a cheap start and a support address, not a company's mail.

2. **The customer's own domain, with the customer's own provider.** This is the Server's existing self-host path, unchanged: Postmark, Mailgun or SES inbound and an SMTP or HTTP gateway outbound, with keys the Owner enters in Server settings → Integrations. A customer on Cloudflare can instead deploy `examples/email-bridge` in their own account and point a Routing rule at it. Either way the domain, its DNS, its reputation and its bill stay with the customer. Cloud adds nothing to our Cloudflare account for it. `llll-cloud` may later resell a provider under our account as a paid option, in the same way it sells Compute; that is a separate decision and not part of this one.

**What Cloud does not do.** It does not onboard customer zones into our account, does not create per-tenant subdomains for Routing or Sending, and does not run a relay that holds mail. The Server's Deployment and Domains tabs that call the Cloudflare API stay off on Cloud, as [ADR 0008](0008-server-per-tenant.md) already requires.

## Consequences

- **A second inbound path becomes first-class.** The signed HTTP entry and the bridge Worker stop being a self-host example and become the way every Cloud Server receives mail, so they need the same tests and limits as the binding path: size, replay window, and a rejection for an address the Server does not own.
- **Address claims live in the fleet.** The shared Worker must answer "whose address is this" from control-plane data, not by asking each Server; a Server may claim a local part only once, and a deleted Server releases its addresses.
- **Shared reputation is a product risk.** One abusive tenant can hurt every platform address. Per-Server sending limits, a dedicated sending zone and complaint handling are part of the first version, not a follow-up. Human approval for external sending by Agents stays as it is.
- **Docs.** The Cloud docs say plainly that a company's own mail domain means their own provider or their own Cloudflare account, and link to the existing self-host mail pages.
- **Unknowns the prototype must settle.** Whether Workers for Platforms user Workers can hold an `EMAIL` binding at all (open since [ADR 0008](0008-server-per-tenant.md)); if they can, platform sending may run inside the tenant's Worker instead of the control plane. The cost of a dedicated mail zone and of Email Sending at fleet volume. How a tenant proves it may use a given local part, so that `acme-support` cannot be taken by someone who is not Acme.
