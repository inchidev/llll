---
title: Troubleshooting
description: Known L4 error messages and problems during install, setup, updates, Docker, mail, files and compute, with what causes them and how to fix them.
order: 2
---

Find the message you see, or the symptom, and follow the fix. Error messages are quoted as the software prints them.

## Owner setup

### "This setup link is invalid or expired"

The claim in the `/setup#claim=…` link does not match the Server's setup token.

- **Cloudflare:** reconnect Cloudflare on the [Create page](https://llll.gg/create?tab=cloudflare), refresh your Servers and choose **Recover setup link**. Recovery works only while the Server has no Owner and no login Accounts. It never resets an existing Owner.
- **Docker, Coolify or celld:** use the exact `SETUP_TOKEN` value of the running deployment. It must be a random string of at least 32 characters; a shorter value is ignored by owner setup.

### "Server setup is already complete"

The Server already has an Owner. Sign in instead. A lost password can be reset with your [recovery key](../concepts/accounts-members-roles.md#account), if you saved one.

### Sign-in or setup fails on the address you opened

`PUBLIC_ORIGIN` must be exactly the origin you open in the browser. Cookies, links and the setup claim depend on it. Additional hostnames must be listed as aliases (`LLLL_ORIGINS`, `llll domain add`, or **Server settings → Deployment → Domain** on Cloudflare). A hostname that only happens to reach the Server is rejected for sessions and changes.

A request rejected with "Origin mismatch" came from an address that is not one of the Server's listed origins. The message names the address the request came from and the Server's address. If they match, the reverse proxy changed the Host or scheme on the way to the Server.

## VPS installer

| Message | Fix |
| --- | --- |
| "VPS releases currently support Linux amd64 only; ARM64 local development is separate." | Use an amd64 VPS. |
| "Supported VPS systems: Debian 12/13 and Ubuntu 22.04/24.04." | Reinstall the VPS with a supported system. |
| "At least 2 GiB RAM is required." / "At least 5 GiB free disk space is required." | Use a larger VPS or free space. |
| "Snap Docker is unsupported; install Docker Engine from its official apt repository." | Remove Snap Docker and install Docker Engine from Docker's apt repository, or let the installer do it on a clean machine. |
| "Docker Engine >= 24 must be running on the local system socket." / "Docker Compose >= 2.24.4 is required." | Upgrade Docker yourself; the installer never replaces an existing Docker. |
| "This is a prerelease. Review it and explicitly set LLLL_CHANNEL=prerelease." | Add `LLLL_CHANNEL=prerelease`, or use a stable release. |
| "An existing Server has another version; use llll upgrade <version>." | Rerunning an installer only restarts the same version. Use `sudo llll upgrade`. |
| "Downgrades or invalid versions are refused; restore a complete backup instead." | Choose a newer version, or restore a backup. |
| "Another installer/CLI operation is running for this directory." | Wait for the other `llll` command to finish. |
| "LLLL_DIR exists and is not an empty directory or a managed installation." | Choose an empty directory, or remove the unrelated files. |
| "Scheduled updates/backups are not supported yet; use explicit llll upgrade and llll backup." | Remove `LLLL_AUTOUPDATE` and `LLLL_BACKUP_SCHEDULE`. |
| "Choose another primary before removing this address." | Run `llll domain primary <other-hostname>` first. |
| "The address change did not pass its checks; the previous configuration was restored." | Point the hostname's DNS at the VPS and make sure ports 80 and 443 are reachable, then retry. |
| "Upgrade did not succeed; previous Server restored." | The old version is running again. Check `sudo llll logs` before retrying. |

If an install stops before the Server is healthy, the private configuration is kept. Fix DNS, firewall or settings and rerun the same pinned script. Caddy needs correct DNS and reachable ports to get a certificate.

## Docker Compose and Coolify

### The container stops with "this data was migrated by L4 X; image Y is older"

Migrations only go forward. Set an image at least as new as the version in the message (`LLLL_IMAGE` in Docker Compose, `LLLL_VERSION` in Coolify). To really go back, restore a backup.

### `bucket-init` fails with "could not reach or create s3://cells"

RustFS is healthy but the host drops traffic between containers, typically legacy iptables with `-P FORWARD DROP`. Allow the Compose bridge, for example:

```bash
iptables -I DOCKER-USER -i br-<id> -j ACCEPT
```

Make the rule persistent.

### The `llll` container exits at start

The entrypoint checks its configuration first:

| Message | Fix |
| --- | --- |
| "llll: set AUTH_SECRET" (or another name) | Set the variable in `.env`. |
| "llll: AUTH_SECRET must be at least 32 characters" | Use `openssl rand -hex 32`. The same rule applies to `SETUP_TOKEN`, `CLOUDFLARE_API_TOKEN` and the inbound mail secrets. |
| "llll: CLOUDFLARE_ACCOUNT_ID must be 32 hex characters" | Copy the account ID from the Cloudflare dashboard, or leave it empty. |
| "llll: ADMIN_EMAIL must look like an email address" | Fix `ADMIN_EMAIL`. |
| "llll: RustFS did not answer at …" | Check that the `rustfs` service is healthy. |

### "waiting for the celld node to join" on first start

This is expected. Migrations apply as soon as the node registers. The container stays unhealthy until they finish, and the gateway starts after that.

### The Server restarts after "node lease not renewed within TTL"

A celld node that misses its lease renewal fences itself and exits. Compose and the Coolify template restart it automatically, after a short delay so the old lease can expire. If it happens often, check the machine's load and memory.

### Docker does not come back after a reboot

On hosts without systemd (containers, some minimal images), start `dockerd` yourself and arrange for it to start at boot. Compose restart policies apply only once Docker is running.

### Settings says "Updates are managed outside L4"

That is expected on a Docker or Coolify Server. Update by changing the image tag. See [Docker Compose](../self-host/docker.md#update).

## Cloudflare updates

### The update stops before deployment because the Server changed during backup

The installer compares the backup with the live database and files. If they changed while the backup was made, it stops before uploading anything. Retry when the Server is less busy.

### "Deployment needs verification"

A failure happened after the upload started. Other updates are blocked until it is resolved. Reopen the update from **Server settings → Deployment → Updates** (**Check or resume on llll.gg**). The installer checks the Server's identity and health, and reruns the upload only if the target version is not installed yet.

### Settings asks you to reconnect Cloudflare

The Cloudflare access kept on the Server stopped working, for example because it was revoked. Reconnect it in **Server settings → Deployment → Updates**, or update through the official installer.

### A self-update fails on the Workers Free plan

A Server updating itself uploads the release in one run, and the Free plan's subrequest budget is tight for large asset changes. This is a known limit.

### A 0.3.x release refuses the database

0.3.0 started the `server-v2` lineage. A 0.2.x database cannot be upgraded into it. Install a new Server for 0.3.x; the old one stays on its release.

## Files and secrets

### "File storage is unavailable. Ask the Server operator to configure storage."

The Server has no file storage. On Cloudflare, connect R2 in **Server settings → Storage**. On self-hosted Servers, check the storage configuration.

### "Saved secret cannot be decrypted. Replace it."

Backup settings show the same problem as "Saved Secret Access Key cannot be decrypted. Replace it." The Server's `AUTH_SECRET` changed since the secret was saved. Enter the credential again, or restore the original `AUTH_SECRET`.

## Mail

### Mail is rejected with "Unknown L4 mailbox"

The recipient address has no Mailbox on this Server. Create the Mailbox first. Only enabled addresses in the Server's own Mailbox list receive mail.

### Inbound mail is not configured (self-hosted)

Off Cloudflare, inbound mail needs a signed webhook: an Email Routing bridge (`INBOUND_EMAIL_SECRET`), Postmark, Mailgun or Amazon SES. Until one is set, the mail settings say inbound mail is not configured. Webhook timestamps more than five minutes from the Server's clock are rejected, so keep the clock in sync. See the [celld reference](https://github.com/inchidev/llll/blob/main/docs/self-host/celld.md#inbound-mail).

## Agents, calls and compute

### Agents cannot be created

The Server has no model provider. Add one in **Server settings → Models**. On a self-hosted Server, a Cloudflare token or an OpenAI-compatible endpoint also works; see [Optional providers](../self-host/docker.md#optional-providers).

### The call button is disabled on a self-hosted Server

Calls use Cloudflare RealtimeKit. Off Cloudflare they need `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Text chat keeps working without them.

### "No Compute Node is connected. Repository metadata remains available; coding needs a Node."

Add compute in **Server settings → Compute**. See [Compute Nodes](../self-host/compute-nodes.md).

### Compute Node setup fails on a VPS

| Message | Fix |
| --- | --- |
| "Compute Node needs 17 GiB free disk capacity for a 10 GiB Task workspace, its image and reserve for the Server." | Free disk space or use a larger disk. |
| "Factory needs 2 GiB available RAM, including reserve for the Server." | Use a larger VPS. |
| "Factory needs systemd as PID 1 (/run/systemd/system) before it writes executor files." | Add `--no-systemd` and start the Node yourself. |
| "Docker shares the host kernel. Run llll factory enable --trust-shared-kernel only for trusted code/users." | Add `--trust-shared-kernel` if you trust the code and people on this VPS. |
| "The released image changed. Existing executor and source remain pinned." | Export source, disable and revoke the Node in Settings, and pair a replacement for new Tasks. |

If only the compute step fails during a new install, the Server stays installed and the script prints the command to retry.

## Shell

### A Server disappeared from My servers

When a saved Server stops answering, llll.gg checks its address. Only Cloudflare's answer that no Worker serves that `workers.dev` address (error 1042) counts as deleted; the Shell then forgets it on this device and says so. Outages, timeouts and custom domains are never forgotten automatically. If the Server still exists, add it again from **Connect**.
