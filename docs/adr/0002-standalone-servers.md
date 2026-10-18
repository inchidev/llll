# Standalone Servers with an optional Shell

Status: accepted. Supersedes 0001.

Each Server owns Accounts, login, sessions, community membership, content, Worker/celld runtime, D1, files and DO namespaces. No Instance or first-server master role exists. The persistent public UUIDv4 is also the internal workspace identity. A local account is independent of identically named accounts on other Servers.

Shell embeds each Server's Client directly and exchanges bounded metadata/navigation events. Credentials and content stay local. Optional future shared identity links login methods explicitly; it does not replace local Accounts or authorize membership.

Creating a Server requires one application Worker. The installer launches Workers Builds from Git; the ordinary Server runtime receives no account-wide provisioning grant. Published artifacts and merged SQL are immutable. The transition is for fresh databases; no running Instances need migration.

Consequences: simpler install, direct routing and recovery; account administration is per Server. Cross-server DM/federation and a global identity service remain outside scope. Hosted Cloud may operate independent Servers later without changing their local identity boundary.
