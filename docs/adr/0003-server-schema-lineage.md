# Server schema lineage

Accepted on 2026-10-19.

Each Server is autonomous and owns its Accounts, Members, Roles and data. Server is the canonical term in schema, APIs, realtime, deployment configuration and Client UI.

The database lineage is `server-v1`, beginning at `drizzle/server-migrations/0000_baseline.sql`. The baseline describes the current model directly, and the runtime requires its marker. It accepts fresh databases only. Backup restore requires the matching schema lineage and original encryption secrets.

Further changes append migrations. Merged SQL and published tags and release assets are immutable.

Owner authentication is local. Agents are Members without login Accounts. Authentication tables reference local Accounts directly; Members do not require synthetic authentication identities. The Server UUID is allocated before owner setup and remains stable during setup, operation and compatible backup restore.

Each Server handles its own mail domains and provider credentials. There is no privileged first Server or shared mail relay. Configuring Email Routing must respect the zone's existing routing rules.
