# Installation and server boundaries

Status: accepted.

An installation owns accounts, authentication, sessions, invitations, provisioning credentials and a directory of servers. Its controller and control D1 deploy to the operator's Cloudflare account or VPS. Each server owns its content, roles, onboarding, removals, database, files and realtime runtime.

Each server receives a distinct pairing key. Installation introductions are short-lived and scoped to one server. Server authorization stays local: an installation membership cannot reactivate a removed member or promote an existing member. The infrastructure operator remains trusted because it controls code and pairing keys.

`packages/deployment-core` is a library used by the installation. There is no separate account-wide Admin or public credential-holding control plane. Landing, common client, installation and server are independently deployed artifacts of this repository. An installation's client and password login work without the official client or identity provider.

Cloudflare provisioning currently accepts an operator API token. User OIDC login and Cloudflare deployment authorization are separate. OAuth onboarding requires a separately implemented and registered flow.

Consequences: control and server migrations/backups remain separate; updates preserve local bindings/secrets; domain routing, VPS services and deletion belong to the operator. Published migration baselines remain immutable, including dormant inherited tables.
