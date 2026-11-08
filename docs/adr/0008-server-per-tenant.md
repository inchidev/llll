# One Server per tenant on our Cloud

Proposed on 2026-11-04. It replaces ADR 0007, now removed. Amended on 2026-11-07 with the hostname, the control plane's relay and what the first slice builds, and on 2026-11-08 by [Three doors to a Server on L4 Cloud](0012-server-creation.md), which adds the agent and partner doors, the quotas and provisional Servers: `packages/deployment-core/src/hosted.ts` installs and deletes a hosted Server, and the Server runs as `LLLL_RUNTIME=cloud` (`shared/server-runtime.ts`). The control plane itself lives in `inchidev/llll-cloud`. The dispatch namespace `llll-cloud` exists; the unknowns below are settled by the first Server created through it.

## Problem

ADR 0007 puts every stranger in one Server, one Space each. Spaces were built as departments of one organization, so opening agents, Data and Apps to strangers would need per-Space model keys and repository connections, tenant checks on every path, and a single origin and cookie shared by all of them. The database cannot grow out of it: one D1 is limited to 10 GB and one writer, and that limit cannot be raised.

L4 already has a boundary that does all of this: a Server owns its Accounts, sessions, Worker, D1, files, Durable Objects, settings and `AUTH_SECRET`.

## Decision

**Each tenant gets a Server.** Sign-up creates one from a published, checksum-verified release, on Workers for Platforms, at **`<name>.llll.gg`**. Spaces stay departments inside it. Nothing in one tenant's Server can name another's.

The hostname was `<name>.cloud.llll.gg` until 2026-11-07. Universal SSL covers `llll.gg` and `*.llll.gg` and nothing deeper, so a second-level wildcard would need Advanced Certificate Manager for nothing else. One level means the site's own names (`www`, `docs`, `api`, `mail`, `cloud`, `app`, `admin`, `billing`, `status` and the like) are reserved and refused as Server names; the control plane keeps that list.

**Spaces are departments again.** They separate parts of one organization, as in [ADR 0005](0005-spaces.md), with one sign-in and shared people. They are not a boundary between strangers: that is a Server. A refresh signal that reaches another Space of the same Server stays as it is. Every Server can have as many as it needs: there is no license key, on Cloud or on a Server's own infrastructure.

**`LLLL_SHARED_CLOUD` goes.** It has never been deployed. Its inverted boundary, route list, tenant Role, Task tool allowlist and sign-up by code go with it. Sign-up by emailed code moves to the control plane, or stays as a Server's own sign-in if that is simpler.

**A control plane in `inchidev/llll-cloud` owns the fleet:** creating Servers, billing, backups and updates. A tenant never holds a Cloudflare token, because the account is shared: the Server runs as `LLLL_RUNTIME=cloud`, with no `ACCOUNT_ID`, so its own Deployment settings, self-update and domain management are off, as they are under `celld`, and its origin is exactly its `PUBLIC_ORIGIN`.

**The control plane speaks to a hosted Server through one relay**, `/.llll/cloud/*`, with the Server's own `CLOUD_SECRET` as a bearer token (`server/utils/cloud-relay.ts`): `scheduled` runs the weekly work, so backups do not depend on Cron Triggers reaching a user Worker, and `purge-files` empties the files bucket, which Cloudflare's API cannot do and a bucket must be before it is deleted. Any other Server answers 404 on those paths.

**Billing is per Server,** not per Space.

**Platform-paid services are opt-in per plan.** Models use the tenant's own keys. A free Server is created without the bindings that cost us money beyond voice: no `AI`, no `BROWSER`. Its own D1, two R2 buckets (files, backups) and KV are made in our account, named after its UUID.

**Updates go out in batches.** A user Worker update reaches all its traffic at once and gradual deployments are not available, so the control plane takes a verified backup and updates a few Servers at a time, stopping on failure.

This extends the deployment rule in `AGENTS.md`: the control plane may upload a published, immutable release to our own namespace, as the installer does for a customer. It never uploads unreleased code.

## Unknowns the prototype must settle

The documentation does not settle these. It does not say whether a user Worker can have:

- Cron Triggers. Backups, sweeps and license renewal use `scheduled`. Fallback: a dispatcher's cron calling each Server, or a Durable Object alarm in each Server.
- The `AI`, `BROWSER` and `EMAIL` bindings.
- SQLite Durable Objects with Hibernation and migrations on upload.

It also has to show that `CF-Connecting-IP` survives dispatch, that data survives a new version with a new migration, and how long a Server takes to create. The estimate of 30 to 60 seconds is unmeasured.

## Consequences

- **Costs at scale.** Workers for Platforms is $25 a month with 1,000 scripts, then $0.02 a script. KV namespaces cost $0.10 a month above 1,000, so one each for 10,000 tenants is about $900 a month, which is a reason to move sockets' tickets off KV. Certificates for `*.cloud.llll.gg` need Advanced Certificate Manager or a custom certificate.
- **API rate.** 1,200 requests per 5 minutes per token allows roughly 48 installs per 5 minutes, and a fleet update of 10,000 Servers takes at least about 42 minutes.
- **Installer changes.** `installHostedL4` uploads to the namespace through `scriptApiPath`; there is no workers.dev, custom domain, mail, Access or cron step; resources are made by name through the REST API and reused on a retry, never found by paging. Deleting a Server removes its script, D1, files bucket and KV and keeps the backup bucket.
- **Egress.** Outbound Workers do not cover `fetch` from Durable Objects, so they are not a complete egress control.
- **Mail** needs its own design: a shared inbound handler and platform sending.
- **A person in two tenants has two Accounts,** as on any two Servers. The Server rail is how they move between them.
- **Compute.** Factory containers bind as Durable Objects on a user Worker, per Server, and are paid only.
