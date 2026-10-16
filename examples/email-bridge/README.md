# L4 email bridge

A small Cloudflare Worker. Email Routing delivers a message here, and this Worker POSTs the raw RFC822 bytes to a self-hosted L4 inbound webhook.

This directory is not a pnpm workspace package. `src/index.ts` imports `../../../workers/email-bridge`, so the commands below run from a checkout of this repository, with the working directory `examples/email-bridge`. Copying this folder out of the checkout does not deploy.

## Deploy

1. Edit `LLLL_INBOUND_URL` in `wrangler.jsonc`. The file ships as `https://chat.example.com/api/email/inbound`. Replace `chat.example.com` with the self-hosted origin.
2. From `examples/email-bridge`:

```bash
npx wrangler secret put INBOUND_EMAIL_SECRET
npx wrangler deploy
```

`INBOUND_EMAIL_SECRET` is a Cloudflare Worker secret (`wrangler secret put`). It is not a var in `wrangler.jsonc`. Use the same value, at least 32 characters, in `vars` of the self-hosted `wrangler.celld.local.json`. On celld that value is stored in the fleet bucket in plaintext. See [Self-host on celld](../../docs/self-host/celld.md#email-routing-bridge).

3. In the Cloudflare dashboard, turn on Email Routing for the domain, add the MX and TXT records Cloudflare shows, and send a Routing rule (a catch-all, if every address should arrive here) to **Send to a Worker** → `llll-email-bridge`.

The self-hosted installation stores mail only for a mailbox that exists. Create that mailbox with `MAIL_DOMAIN`, `MAIL_APP_HOSTNAME`, and `MAIL_DEFAULT_LOCAL_PART`. `MAIL_ZONE_ID` is optional off Cloudflare.
