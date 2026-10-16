# L4 product language

L4 (`llll.gg`, pronounced L4) is free MIT licensed software for independent communities. The product combines chat, rich messages, threads, tasks, mail, apps, structured data, documents, files and optional calls.

## Installation

An independent deployment and account authority at one origin. It owns accounts, login methods, sessions, invitations and its server directory. It can contain many servers. An installation is operated on its owner's Cloudflare account or VPS; the official client does not own its data or deployment credentials.

## Server

A separately permissioned community inside one installation. Each server has its own Worker, D1 database, private files bucket, KV ticket namespace and Durable Objects. Inside the inherited server runtime, `workspace` and the fixed database ID `main` refer to this single server. They do not identify the installation or another server.

Server roles, removal, onboarding and resource permissions are authoritative locally. Installation membership introduces an identity but cannot reactivate a removed member or grant server administration. The installation operator is nevertheless an infrastructure trust authority: it holds the keys used to introduce identities and controls its deployment.

## Account and identity

An installation account has a stable opaque ID. Password login works independently of the official identity service. Optional L4 OIDC and Telegram providers link to that account explicitly. Never merge accounts by email alone. The shared L4 account is an optional OIDC identity provider; each independent installation still owns its own local account and session.

## Client

One Nuxt SPA connects installations over HTTPS and WebSocket. Web, PWA, Capacitor iOS and Telegram use the same UI. A left rail groups servers by installation. Switching servers reloads the client so realtime state and query caches cannot leak between connections. Standard chat is rendered directly, without iframes. Embedded third-party apps keep their separate sandboxed integration boundary.

## Direct messages and threads

DMs belong to one server. Threads remain channels in their parent server. Cross-server DMs and cross-installation communication are deferred.

## Hosting and integrations

The official installation is a limited demo, not a public hosting marketplace. Inchi, AfterPrompt and OpenRivers can operate their own separately funded installations. Gitrew headless capabilities and embedding into those products are later integrations through documented APIs, not copied backends.

## Deployment and release

Cloudflare and celld run the same server logic. Cloudflare-only managed services, including RealtimeKit, Workers AI and email delivery, use bindings or explicitly configured REST credentials. Server snapshots go to a separate configured backup destination. A backup is not a copy of active sockets, running agents or third-party call state.

The repository is one source of truth with independently deployed site, common client, installation and server artifacts. Releases are immutable. Migration chains start at separate clean `0000` baselines; earlier schema fixtures are retained only for migration tests.
