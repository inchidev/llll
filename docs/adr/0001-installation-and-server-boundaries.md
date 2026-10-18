# Installation and server boundaries

Status: superseded by [0002](0002-standalone-servers.md). The following records the retired design.

An installation owns accounts, authentication, sessions, invitations, provisioning credentials and a directory of servers. Its controller and control D1 deploy to the operator's Cloudflare account or VPS. Each server owns its content, roles, onboarding, removals, database, files and realtime runtime.

Each server receives a distinct pairing key. Installation introductions are short-lived and scoped to one server. Server authorization stays local: an installation membership cannot reactivate a removed member or promote an existing member. The infrastructure operator remains trusted because it controls code and pairing keys.

`packages/deployment-core` is a library used by the installation. There is no separate account-wide Admin or public credential-holding control plane. The site/shell/installer, installation and server are independently deployed artifacts of this repository. An installation's client and password login work without the official client or identity provider.

Cloudflare provisioning accepts an operator API token or a handed-off OAuth grant. The web’s `/deploy` flow uses PKCE and a browser-bound encrypted temporary grant. The official shell embeds independently versioned installation clients and exchanges only bounded navigation/metadata events; authentication and content remain local. Shared L4 identity is deferred.

Consequences: control and server migrations/backups remain separate; updates preserve local bindings/secrets; domain routing, VPS services and deletion belong to the operator. Published migration baselines remain immutable, including dormant inherited tables.
