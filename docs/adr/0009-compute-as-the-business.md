# Compute is the business

Proposed on 2026-11-05, pricing section revised the same day from a flat worker to elastic hours. Nothing here is built; prices are hypotheses to be checked against real use, and the published ones live only in `inchidev/llll-cloud`.

## Problem

L4 and Orbit (orbit.so, from the Coolify team) promise nearly the same workspace: chat, Tasks, documents, repositories, MCP, self-hosting and a Cloud. Orbit charges per workspace, Notion per block, Slack and Mattermost per seat and per call. If L4 charges for the workspace too, every feature Orbit adds is a feature L4 has to add, and the race never ends. A workspace feature takes a weekend to copy; a business model does not.

Agents in L4 already need somewhere to run code: a Compute Node that executes Task work in an isolated workspace and hands a draft pull request back to a person. Today three providers are wired by name into this repository: a Docker daemon on the operator's own Linux host, Cloudflare Containers on the operator's own account, and Lizard, whose sandboxes are created and billed through an API key the Owner enters in Server settings. The Lizard integration is about 560 lines in `workers/lizard-compute-do.ts`, `server/utils/lizard-*.ts` and `server/api/compute-providers/lizard/`, plus one environment flag in the Node daemon. It is in the public repository under the Elastic License, so "our provisioning is proprietary" is not yet true in code.

The earlier plan of a flat Cloud price per Server (and before it a Business key and per-Space plans) competes on the same table as Orbit. The Business key and the one-Space limit are already removed.

## Decision

**The workspace is free. L4 earns when agents work.** No price per Server, per Space, per person, per message, per history, per call or per feature, on L4 Cloud or on the operator's own infrastructure. The only thing sold is Managed Compute: machines L4 creates, runs, isolates, updates and bills for the customer, so that an Agent gets work done without anyone operating a box. The goal is the most parallel development a team can use, with L4 earning on every hour of it, so nothing in the price limits how many Agents work at once.

**Three ways to get compute, one Node protocol.** A Server knows one kind of machine: a Compute Node that pairs with a credential and polls for work (`claim`, `begin`, `heartbeat`, `result` in `server/utils/compute-nodes.ts`). Where the Node runs is the only difference:

- **Your own VPS.** The published `@llll/compute-node` daemon on a Linux Docker host the operator trusts. Free, no license limit on Nodes or parallel Runs; the operator installs, isolates and updates it. Any host counts: a home server, Hetzner, Kubernetes, or a sandbox the operator rents directly from Lizard or anyone else.
- **Your own Cloudflare.** Containers on the operator's Cloudflare account, as today. Free from L4; the operator pays Cloudflare.
- **L4 Compute.** Elastic: `llll-cloud` starts a microVM running the same published daemon for each Task that needs one, pairs it to the Server, and stops it when the Task's work is done. A hundred Agents get a hundred boxes. Paid by the hour of agent work, billed by the second. A self-hosted Server buys it exactly like a Cloud Server: Server settings → Compute → Add L4 Compute, signing in with the llll.gg account. No API key field and no environment variable.

**What is source available and what is not.** This repository keeps the Node protocol, the daemon, the Cloudflare Containers path, the Server-side client that asks `llll-cloud` for a box, and the whole Task workspace, review and publication flow. It is complete on its own: an operator with one VPS has everything, and this daemon is the reference implementation for anyone who wants to run L4 work on other machines. `llll-cloud` holds provisioning (Lizard today, any provider tomorrow, behind one internal interface), per-tenant isolation, metering, billing and the fleet of boxes. There is no public Provider API and no third-party provisioner plug-in: the daemon is the open interface.

**Lizard leaves this repository.** The `lizard-*` files, the `compute-providers/lizard` routes, the `lizard` transport branch in `requireComputeNode`, the `provider: 'lizard'` capability and the daemon's `LLLL_COMPUTE_PROVIDER` flag go in one release, replaced by the L4 Compute client. A Node created by L4 Compute looks to the Server exactly like a VPS Node with a durable disk.

**Compute is sold by the hour of agent work, with a margin, and nothing else.** No subscription, no slot, no minimum: a box per Task, billed by the second while it runs, in Small, Medium and Large sizes at different hourly prices. The Owner sets a monthly spend limit and sees the running total. Lizard bills a Small microVM (2 vCPU, 4 GB) at about $0.0162 an hour by the second; a price of roughly three times cost is the starting hypothesis. Revenue then grows with the work Agents do: a small team with a thousand half-hour Tasks a month pays about $25 on $8 of cost, a shop running 10,000 hours pays about $500 on $162. A flat worker per month was considered and rejected: it caps parallelism, which is the thing L4 wants teams to do more of, and it makes the customer decide to buy before working. A reserved box at a discount may come later for teams that want a fixed bill; it is not part of this decision.

**Compute funds collaboration.** Each tenant's workspace costs on Cloud (D1, R2, Durable Object time, RealtimeKit minutes) are covered from a resource budget: a free base for every tenant plus a share of its Compute spend for the month, on the order of 10 to 15% as a starting hypothesis. The budget is computed monthly on our actual costs, not granted for life after one purchase. Its rules and the current usage are visible to the Owner; nothing is silently cut, deleted or blocked. Files and calls are the only costs large enough to need a ceiling for tenants who buy no Compute, and those ceilings are stated, not hidden.

**Features stay off the strategy.** A feature enters the roadmap when it removes an obstacle for a real team using L4, not because Orbit shipped it, an announcement looked good, an agent could build it overnight or issues piled up.

## Unknowns to settle before building billing

- **Hours and margin.** Run the real Tasks of two of our own teams through Managed Compute for a month and measure box hours per Task, hours per team per month, box start time and how much idle time a box keeps while an Agent waits for review. This sets the hourly price, the size defaults and whether a box is stopped between operations or kept for the Task.
- **Provider interface in `llll-cloud`.** Lizard is first; Cloudflare Containers or Sandboxes in our own account and a plain VM pool must fit the same interface without the Server noticing.
- **Pairing handoff.** How `llll-cloud` pairs a box to a Server it does not operate, many times a day: the Server asks for a box for one Task and receives Node credentials, or issues a pairing token the box redeems. Either way a box's credential is scoped to one Server, ends with its Task, and is revocable from both sides. The Server also needs a spend limit check before asking for a box.
- **Resource budget arithmetic.** Actual D1, R2, DO and RealtimeKit costs of a small active tenant, measured, before choosing the base budget and the share.
- **Cloudflare credits.** L4 runs on Workers, D1, R2 and Durable Objects, so Cloudflare for Startups credits and Workers Launchpad are worth applying for; they would cover free tenants and the Workers for Platforms base fee in the first year. Terms and deadlines on their pages disagree and must be checked at application time.

## Consequences

- **Server settings → Compute shows three choices** and nothing provider-specific beyond them. The Lizard key field is gone. An operator who wants Lizard directly rents a sandbox there and installs the daemon: it is a VPS to the Server.
- **One release removes Lizard** from `inchidev/llll`. Servers that paired Lizard Nodes through the old routes lose them on update; this is accepted, nothing of it has customers yet.
- **`llll-cloud` grows a second product**, L4 Compute, with its own catalogue entry, Paddle product, a seconds ledger and a fleet of short-lived microVMs. Its existing prepaid compute hours and seconds ledger fit this model and stay; only the paid Cloud plan goes. Billing stays per Server as in [ADR 0008](0008-server-per-tenant.md), but the Cloud plan itself is free.
- **Pricing and landing in `llll-cloud` change**: no price per Server; the pitch is a free workspace where you pay for the hours your Agents work, by the second, with no limit on how many work at once. The Docs here keep linking to Pricing and never quote numbers.
- **Isolation is per tenant by construction.** Managed boxes are Firecracker microVMs with their own kernel, one Task of one Server each. The shared-kernel Docker path stays what [Compute nodes and Task workspaces](../software-factory.md) says it is: for the operator's own trusted code, never resold.
- **The Docker daemon stays complete in the open**, so a self-hosted L4 with its own machines is a full product, and the free product is the funnel for Managed Compute, not a crippled copy of it.
- **Supersedes** the flat Cloud price per Server and the Business key as revenue. Models keep running on the customer's own subscription; selling tokens is not part of this decision.
