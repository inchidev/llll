# L4 product language

L4 (`llll.gg`, pronounced L4) is free MIT licensed software for independent communities. The product combines chat, rich messages, threads, tasks, mail, apps, structured data, documents, files and optional calls.

## Installation

An independent deployment and account authority at one origin. It owns accounts, login methods, sessions, invitations and its server directory. It can contain many servers. An installation is operated on its owner's Cloudflare account or VPS; the official client does not own its data or deployment credentials.

## Server

A separately permissioned community inside one installation. Each server has its own Worker, D1 database, private files bucket, KV ticket namespace and Durable Objects. Inside the inherited server runtime, `workspace` and the fixed database ID `main` refer to this single server. They do not identify the installation or another server.

Server roles, removal, onboarding and resource permissions are authoritative locally. Installation membership introduces an identity but cannot reactivate a removed member or grant server administration. The installation operator is nevertheless an infrastructure trust authority: it holds the keys used to introduce identities and controls its deployment.

## Account and identity

Each installation owns local accounts and sessions. Email/password and optional Telegram login work at its direct address and inside its own iframe. No shared L4 account is required. Explicit account linking never merges accounts by email alone.

## Client

The official web/PWA/Telegram shell embeds the installation's own client and groups its servers in a narrow left rail. Installation names are rotated -90 degrees beside their servers. Different installations can run different UI and content API versions. The only shared client contract is a small validated postMessage bridge for navigation, metadata, theme and lifecycle. Chat is rendered inside the installation's origin. iOS/macOS delivery is frozen.

## Direct messages and threads

DMs belong to one server. Threads remain channels in their parent server. Cross-server DMs and cross-installation communication are deferred.

## Hosting and integrations

The official installation is a limited demo, not a public hosting marketplace. Inchi, AfterPrompt and OpenRivers can operate their own separately funded installations. Gitrew headless capabilities and embedding into those products are later integrations through documented APIs, not copied backends.

## Deployment and release

Cloudflare and celld run the same server logic. Cloudflare-only managed services, including RealtimeKit, Workers AI and email delivery, use bindings or explicitly configured REST credentials. Server snapshots go to a separate configured backup destination. A backup is not a copy of active sockets, running agents or third-party call state.

The repository is one source of truth with independently deployed site, common client, installation and server artifacts. Releases are immutable. Migration chains start at separate clean `0000` baselines; earlier schema fixtures are retained only for migration tests.
