# Deploy a standalone Server

Deploy one Server, claim its owner, then invite members. Accounts, files and conversations belong to this Server. It works at its direct origin and through the optional Shell. There is no Instance service or second application Worker.

## Cloudflare

The official `/deploy` installer connects Cloudflare, selects an account, Server name, owner email and published standalone release, then configures a Git-connected Workers Build. The account must have Cloudflare's Git integration for this repository and an eligible Workers Builds deployment token. The installer reports missing prerequisites rather than uploading application code itself. OAuth must authorize administrative Workers Builds operations as well as the selected resources; configure and validate those rights before advertising an end-to-end installer.

The Build runs `node scripts/server-deploy.mjs`. Configure `CLOUDFLARE_ACCOUNT_ID`, an appropriate deployment token, `LLLL_SERVER_WORKER`, `LLLL_SERVER_RELEASE`, `LLLL_SERVER_NAME`, `LLLL_SERVER_OWNER_EMAIL`, `LLLL_SERVER_ORIGIN` and private `LLLL_SERVER_SETUP_TOKEN`. Optional custom domains use `LLLL_SERVER_ZONE_ID`, `LLLL_SERVER_ZONE_NAME` and `LLLL_SERVER_SUBDOMAIN`. Pin an immutable published standalone release. Ordinary main builds do not update a Server already running that version.

The deployment creates Server D1, private FILES storage, TICKETS KV, DO namespaces and a separate BACKUPS bucket. A private owner claim opens `/setup#claim=…`; it never enters public logs or Git. The website's encrypted browser-bound OAuth state is removed after successful verification or expiry. It is not handed to the Server as a permanent provisioning credential.

Application code may only deploy in Workers Builds from Git. Local Wrangler is limited to types, dry runs and isolated development. Connected Cloudflare API tools administer resources, domains and build configuration; they never upload application code from the developer machine.

## VPS / celld

Use `self-host/docker-compose.yml` or the Coolify standalone template with the portable image from a verified release. Configure `PUBLIC_ORIGIN`, `AUTH_SECRET`, `ADMIN_EMAIL`, private `SETUP_TOKEN` and persistent storage credentials in ignored/private operator configuration. Place TLS in front of celld, open `/setup#claim=…`, set the owner password and invite another person. No Instance process, pairing keys or private inter-server proxy is needed.

Keep each Server's D1, files and DO state separate. Preserve its original encryption secret and storage across restarts and updates. Operator Docker/SSH credentials do not enter the Client. Verify transport and browser behavior on celld separately from Cloudflare.

## Providers and recovery

RealtimeKit, AI and mail are optional Server-local settings. Cloudflare deployment does not imply they are configured. RealtimeKit's API token remains backend-only; clients receive participant credentials. See [runtime architecture](architecture.md) and [celld reference](self-host/celld.md).

Back up Server D1, live files and encryption/deployment secrets to a destination separate from live files. Backup buckets survive Server deletion. Restore into isolated resources and verify the same UUID, accounts, roles, messages and files. Save local account recovery keys privately; they are single-use and revoke sessions when redeemed.

There are no working Instances to migrate. This release installs fresh standalone databases and rejects an existing Instance-bound workspace rather than silently losing its login credentials. Merged baselines, release tags and assets remain immutable.

Published release discovery uses GitHub REST with an optional public-repository token, and falls back to the public release feed on quota responses. Feed entries must name a supported version and expose the deployment artifact and manifest in published checksums; the manifest must declare the matching standalone capability. Installing still verifies every artifact checksum.
