# Self-host on celld

L4 runs as one Nuxt Worker. On Cloudflare that Worker uses Workers AI, Browser Rendering, Email Routing, and RealtimeKit when you bind them. [celld](https://celld.dev) (and other Workers runtimes with D1, KV, R2, and Durable Objects) can run the same build. This page is the celld path. It was exercised on celld 0.6.3 with [RustFS](https://github.com/rustfs/rustfs) as the S3 bucket.

For one machine, [self-host/README.md](../../self-host/README.md) runs that node under the shared Docker Compose, using a verified loaded image or the explicit source-build override. `pnpm dev:stack` provides [local development](../local-development.md) with Client HMR. The rest of this page is the same deployment without Docker.

celld does not implement Workers AI, Browser Rendering, or Email Workers. It also rejects Wrangler keys that depend on Cloudflare's network, including `ai`, `browser`, `routes`, `placement`, `observability`, and `preview_urls`. `wrangler.celld.json` is `wrangler.jsonc` with those keys removed and with placeholder names only. Replace every placeholder before you deploy. Do not reuse another server's database id, KV id, or hostname.

`LLLL_RUNTIME=celld` tells the app this process is not on Cloudflare's network. Inbound mail arrives through a signed webhook, or through Postmark, Mailgun, or Amazon SES. Workers AI, Browser Run, outbound mail, and RealtimeKit calls can use a Cloudflare API token over REST when the matching binding is absent. Text chat, tasks, data, documents, files, and backups do not need that network.

## Feature matrix

| Feature | On celld |
| --- | --- |
| Nuxt Worker, static assets, D1, D1 FTS5 search | Works |
| Durable Objects and WebSockets (channels, presence, notifications, rate limits) | Works |
| KV sessions and tickets | Works |
| R2 files, including a RustFS bucket | Works |
| Tasks, Data, Documents, manual backup export | Works |
| Cron trigger | Deploys. The weekly trigger was not observed in the single-node check |
| Workers AI | No `AI` binding. With `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, `/api/setup/health` reports `aiProvider: "workers-ai-rest"` and runs `POST /accounts/{account_id}/ai/run/{model}`. Otherwise set `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` for `openai-compatible` |
| Browser Rendering | No `BROWSER` binding. The same token uses Browser Run at `/accounts/{account_id}/browser-run/{markdown\|links\|screenshot}` and health reports `capabilities.browser: "cloudflare-rest"`. Otherwise set `BROWSER_CDP_URL`, or leave page reading off |
| Outbound email | No Email Workers binding. The same token uses Email Sending (`emailProvider: "cloudflare-rest"`) when the sender domain is onboarded. Otherwise `MAIL_GATEWAY_URL` or `SMTP_GATEWAY_URL` |
| Inbound email | No Email Routing handler in this process. `INBOUND_EMAIL_SECRET` reports `capabilities.emailInbound: "bridge"`. Postmark, Mailgun, and Amazon SES report `postmark`, `mailgun`, and `ses`. With none of those set, the value is `null` |
| Calls and Live (RealtimeKit) | With the same token, the first call creates a RealtimeKit app and health reports `callsProvider: "realtimekit-rest"`. Without it, the owner connects RealtimeKit in Settings → Live with a Realtime Admin token or the Server's kept Cloudflare access, and health reports `callsProvider: "realtimekit"` |
| Agent containers, computers, and shells | Unavailable on every runtime, including Cloudflare. The agent settings say so |
| `routes`, custom domains, smart placement | Rejected by celld. Put a reverse proxy in front for TLS and hostnames |

No post-build patch is required. The Worker aliases `node:timers` to a shim (`setImmediate` is `setTimeout(fn, 0)`) and ignores a `console.createTask` that throws.

## RustFS

RustFS is the S3 bucket celld and the server R2 binding share. One local process is enough for a single node.

```bash
rustfs --address 127.0.0.1:9000 ./data
```

Create a bucket named `cells` with any S3 client. Path-style addressing and region `us-east-1` match what celld expects. Point the client at `http://127.0.0.1:9000` and use the access key and secret you configured for RustFS.

```bash
aws s3 mb s3://cells --endpoint-url http://127.0.0.1:9000 --region us-east-1
```

Export those values before every `celld` command that reads or writes the bucket:

```bash
export S3_ENDPOINT=http://127.0.0.1:9000
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_REGION=us-east-1
```

Server file objects land under `r2/<bucket_name>/` inside that same bucket. Deployment blobs and D1 state use it too.

## Build and deploy

Install celld 0.6.3 or newer from <https://celld.dev>, then from this repository:

```bash
pnpm install
pnpm build
```

Edit `wrangler.celld.json`:

- `PUBLIC_ORIGIN` is the origin members open, such as `http://127.0.0.1:8080` before you add TLS.
- `ADMIN_EMAIL` is the first owner's email.
- `database_name` is the D1 name you will pass to migrations. The example uses `llll`. `database_id` and the KV `id` only need to be stable for this server.

`AUTH_SECRET` and `SETUP_TOKEN` in that file are the placeholders `invalid`. Both are shorter than 32 characters, so they do not pass validation: owner setup ignores the token, and session signing rejects the secret. Leave those placeholders in the tracked `wrangler.celld.json`. Each real value must be a random string of at least 32 characters.

celld 0.6.3 has no secrets store. Setting `CELLD_VARS_FILE` or any `CELLD_VAR_*` variable makes the process exit:

```text
CELLD_VARS_FILE is removed; set `vars` in the Wrangler config, or `.dev.vars` for `celld dev`
```

`.dev.vars` (and `.env` / `.env.local` beside the config) is read only by `celld dev`. It is not uploaded. `celld deploy` writes the Wrangler `vars` object into the deployment in the fleet bucket as plaintext `plain_text` bindings. There is no encrypted binding and no override at listen time.

Copy the example to a file that stays out of git, put the real values in its `vars`, and deploy that file. Generate the file from CI or a secret store when you do not want it on disk by hand. Mode `600`. Do not commit it. The bucket must be private, because those values are stored in the bucket in plaintext. `wrangler.celld.local.json` and `wrangler.celld.local.jsonc` are gitignored.

```bash
cp wrangler.celld.json wrangler.celld.local.json
chmod 600 wrangler.celld.local.json
```

In `vars` of `wrangler.celld.local.json`:

```json
"AUTH_SECRET": "<random 32+ characters>",
"SETUP_TOKEN": "<random 32+ characters>"
```

`CLOUDFLARE_API_TOKEN`, `AI_API_KEY`, and the inbound mail secrets belong in that same `vars` object. Changing `vars` takes effect on the next deploy.

## Cloudflare API token

A scoped API token lets this node call Cloudflare from outside Cloudflare's network. Bindings still win when they exist. After that, L4 uses this token. An OpenAI-compatible endpoint, an HTTP mail gateway, or a Chromium DevTools URL is used only when the token is absent. `/api/setup/health` reports which path it chose: `aiProvider`, `capabilities.browser`, `capabilities.emailProvider`, `capabilities.callsProvider`, and `capabilities.emailInbound`.

The account id is 32 hex characters. A placeholder such as `invalid` does not enable these calls.

1. In the Cloudflare dashboard, open **Workers AI**, select **Use REST API**, and copy **Account ID**. The same id is the first path segment of `https://dash.cloudflare.com/<account_id>/`. See [Find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).
2. Open **My Profile → API Tokens → Create Token → Create Custom Token**, or create an account API token at `https://dash.cloudflare.com/?to=/:account/api-tokens`. Name it for this server. Limit it to this one account.
3. Add only the account permissions for the services you want. Dashboard labels below are the ones in the current docs:

   | Service | Permission | What it calls |
   | --- | --- | --- |
   | Workers AI | **Workers AI - Read** and **Workers AI - Edit** | `POST /accounts/{account_id}/ai/run/{model}`. The [Workers AI REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) guide (updated Sep 15, 2026) requires both for a custom token. The [AI Gateway REST](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) page says **Account → Workers AI → Read** covers `/accounts/{account_id}/ai/*`. Include Read and Edit. |
   | Browser Run | **Browser Run - Edit** | `POST /accounts/{account_id}/browser-run/markdown`, `/links`, and `/screenshot`. The [Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/) page names **Browser Run - Edit**. The [markdown](https://developers.cloudflare.com/browser-run/quick-actions/markdown-endpoint/) and screenshot pages still say **Browser Rendering - Edit**. Pick the label the token form shows. |
   | Email Sending | **Email Sending: Edit** | `POST /accounts/{account_id}/email/sending/send`. See the [Email Sending REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/). The sender domain must already be onboarded under **Email Service → Email Sending**. Inbound mail is a separate webhook, described below. |
   | RealtimeKit | **Realtime Admin** | Creates this server's RealtimeKit app and the host and participant presets on the first call. The [RealtimeKit quickstart](https://developers.cloudflare.com/realtime/realtimekit/quickstart/) accepts **Realtime** or **Realtime Admin**. The [FAQ](https://developers.cloudflare.com/realtime/realtimekit/faq/) says to select **Realtime → Realtime Admin** when creating the token. **Realtime** without Admin can run meetings on an app that already exists. |

4. Continue to the summary and create the token. Copy it once. It is shown only then.
5. Add both values to `vars` in `wrangler.celld.local.json` and deploy that file again. They are stored in the bucket in plaintext, so the bucket stays private.

```json
"CLOUDFLARE_ACCOUNT_ID": "<account id>",
"CLOUDFLARE_API_TOKEN": "<api token>"
```

Optional model and browser values, in the same `vars` object, used when the Cloudflare token is not set. `AI_API_KEY` is stored in the bucket in plaintext with the rest of `vars`.

```json
"AI_BASE_URL": "https://llm.example.com/v1",
"AI_API_KEY": "<api key>",
"AI_MODEL": "your-model",
"BROWSER_CDP_URL": "http://127.0.0.1:9222"
```

`AI_BASE_URL` includes `/v1` when the server expects it. `BROWSER_CDP_URL` is a private Chromium started with `--remote-debugging-port=9222`.

`AI_MODEL` is the model id sent to that endpoint. A profile model that starts with `@cf/` is a Workers AI id and is not sent there. With the Cloudflare token, those `@cf/` ids are sent to Workers AI REST instead. `/api/setup/health` reports `aiProvider` as `workers-ai`, `workers-ai-rest`, `openai-compatible`, or `null`. Agents cannot be created while it is `null`. Apps assistance uses its explicitly assigned named model connection; it does not require a Workers AI binding.

Deploy the local config, then apply migrations. The migrations command takes the **database name**, not the binding name `DB`:

```bash
celld deploy wrangler.celld.local.json --bucket s3://cells
celld d1 migrations apply llll wrangler.celld.local.json --bucket s3://cells
```

With `LLLL_RUNTIME=celld`, L4 does not apply its bundled schema. `celld d1 migrations apply` is what creates the tables and records them.

Start one node. `--listen` is the public HTTP address. `--internal-listen` and `--advertise` are how nodes reach each other. On one machine they can all be loopback. Worker variables come from the deployment already written to the bucket; the listen command does not take a vars file.

```bash
celld --bucket s3://cells --listen 127.0.0.1:8080 --internal-listen 127.0.0.1:8081 --advertise 127.0.0.1:8081
```

A single node renews its own lease. After a stall long enough to miss that renewal it fences itself, logs `node lease not renewed within TTL`, and exits. The fenced process does not resume on its own. Run it under systemd with `Restart=always`. `RestartSec` should be at least one lease lifetime (`CELLD_TTL_MS`, 10 seconds by default) so a fence does not restart in a tight loop.

Save this as `/etc/systemd/system/llll.service`. The AWS values are the RustFS credentials from above, not Worker secrets. Worker secrets stay in `wrangler.celld.local.json`.

```ini
[Unit]
Description=L4 on celld
After=network-online.target
Wants=network-online.target

[Service]
User=llll
Environment=CELLD_BUCKET=s3://cells
Environment=S3_ENDPOINT=http://127.0.0.1:9000
Environment=AWS_ACCESS_KEY_ID=<access key>
Environment=AWS_SECRET_ACCESS_KEY=<secret key>
Environment=AWS_REGION=us-east-1
WorkingDirectory=/opt/llll
ExecStart=/usr/local/bin/celld --bucket s3://cells --listen 127.0.0.1:8080 --internal-listen 127.0.0.1:8081 --advertise 127.0.0.1:8081
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` only needs to exist; the node reads the deployed Worker from the bucket. Enable it with `systemctl enable --now llll`.

Open `/setup`, enter `SETUP_TOKEN` and create the owner. `PUBLIC_ORIGIN` must be the origin you use in the browser. The claim works only after the deployed `SETUP_TOKEN` is a random string of at least 32 characters.

## Reverse proxy

celld does not attach Cloudflare custom domains. Terminate TLS and map a hostname with a reverse proxy. This Caddy site proxies to the node's listen address:

```caddy
chat.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Set `PUBLIC_ORIGIN` to `https://chat.example.com` so cookies, links, and the setup claim match the hostname members use. WebSocket upgrades for chat must be forwarded. nginx does that with `proxy_http_version 1.1`, `Upgrade`, and `Connection`.

## Inbound mail

celld does not run the Worker's `email()` handler, and L4 does not open an SMTP port. Inbound mail uses the same mailbox ingest as Cloudflare Email Routing: the envelope recipient must be a mailbox in this server, the raw message and its attachments go to R2, and members with access see it in that mailbox. Messages larger than 25 MiB are rejected. Unsigned requests are rejected.

`/api/setup/health` reports `capabilities.emailInbound` as `bridge`, `postmark`, `mailgun`, or `ses`, in that order, for the first one you configure. On Cloudflare's network the value is `binding` even when a webhook secret is also set. With nothing configured it is `null`, and the mail settings screen says inbound mail is not configured. Every configured endpoint still accepts mail.

Put inbound secrets in `vars` of `wrangler.celld.local.json` and deploy that file. They are stored in the bucket in plaintext. Each shared secret must be at least 32 characters. A placeholder such as `invalid` does not enable a provider.

The default mailbox is created after an owner exists, and only when these vars are set:

- `MAIL_DOMAIN` is the domain of the address, such as `example.com`.
- `MAIL_APP_HOSTNAME` is this server's hostname, such as `chat.example.com`.
- `MAIL_DEFAULT_LOCAL_PART` is the local part, such as `support`. The address is then `support@example.com`.

On Cloudflare, `MAIL_ZONE_ID` is also required. Off Cloudflare, including celld, `MAIL_ZONE_ID` is optional. A `LLLL_EMAIL_DOMAINS` JSON entry still needs a non-empty `zoneId`. Without `MAIL_APP_HOSTNAME` nothing is written. Without `MAIL_DEFAULT_LOCAL_PART` the domain can be stored and no mailbox is created if none exists yet. Ingest looks up `email_mailboxes`. Mail for an address with no mailbox returns 404 `Unknown L4 mailbox`. Changing these vars takes effect on the next deploy.

The same RFC Message-ID is stored once per mailbox. A replayed signed request inside the 5-minute window returns 202 and does not add another copy. A message with no Message-ID is stored once per SHA-256 of its raw bytes. A different body is a different message. The same email sent to two mailboxes is stored in both. The digest is kept as the message's request key and is not written as a Message-ID, so a reply does not cite a synthetic id.

### Email Routing bridge

`examples/email-bridge` is a separate Cloudflare Worker. It receives mail from Email Routing and POSTs the raw RFC822 message to this server.

1. Set the same secret on both sides. On the self-hosted node, in `vars` of `wrangler.celld.local.json`, then deploy that file:

```json
"INBOUND_EMAIL_SECRET": "<random 32+ characters>"
```

On the bridge Worker the secret is a Cloudflare Worker secret, not a celld `vars` value. The working directory is `examples/email-bridge` inside a checkout of this repository. `src/index.ts` imports `../../../workers/email-bridge`, so the command is not run from a copied folder. See `examples/email-bridge/README.md`.

```bash
cd examples/email-bridge
npx wrangler secret put INBOUND_EMAIL_SECRET
```

2. In `examples/email-bridge/wrangler.jsonc`, set `LLLL_INBOUND_URL` to this server's public origin plus `/api/email/inbound`. The file ships as `https://chat.example.com/api/email/inbound`. Replace that hostname. Deploy the bridge on its own, not as part of the L4 Worker, from that same directory:

```bash
npx wrangler deploy
```

3. In the Cloudflare dashboard, turn on Email Routing for the domain and add the MX and TXT records Cloudflare shows. Add a Routing rule, including a catch-all if every address on the domain should arrive here, and choose **Send to a Worker** → `llll-email-bridge`.

4. Create the mailbox in L4. The bridge forwards the envelope recipient. Mail for an address with no mailbox is rejected.

The bridge signs `timestamp + "." + from + "." + to + "."` and then the raw bytes, with HMAC-SHA256, and sends the hex digest in `X-L4-Email-Signature`. `X-L4-Email-Timestamp` is unix seconds. `X-L4-Email-From` and `X-L4-Email-To` are the envelope. A timestamp more than 5 minutes from the node clock is rejected. A JSON body `{ "raw": "<rfc822>", "rawEncoding": "utf8" }` or `"base64"` is also accepted; the signature covers the decoded RFC822 bytes, and the envelope stays in the headers. Use `base64` when the message is not UTF-8.

The bridge throws on a network error and on status 408, 409, 425, 429, 500, 502, 503, or 504 so Email Routing retries. Other responses reject the message. A stored message returns 202.

### Postmark

Postmark does not HMAC-sign inbound webhooks. L4 checks HTTP Basic auth instead. The username can be anything. The password is `POSTMARK_INBOUND_SECRET`.

1. Add an inbound domain in Postmark. Postmark recommends a subdomain. Create an MX record for that name:

```
inbound.example.com.  MX  10  inbound.postmarkapp.com.
```

Set that domain as the server's inbound domain. See [Inbound domain forwarding](https://postmarkapp.com/developer/user-guide/inbound/inbound-domain-forwarding).

2. Set the inbound webhook URL to `https://chat.example.com/api/email/inbound/postmark`, with basic auth in the URL (`https://username:<password>@chat.example.com/api/email/inbound/postmark`). Check **Include raw email content in JSON payload**. See [Configure an inbound server](https://postmarkapp.com/developer/user-guide/inbound/configure-an-inbound-server).

3. On the node, in `vars` of `wrangler.celld.local.json`:

```json
"POSTMARK_INBOUND_SECRET": "<the basic-auth password, 32+ characters>"
```

L4 reads `RawEmail` as the RFC822 message, `OriginalRecipient` (then `ToFull[0].Email`, then `To`) as the mailbox, and `FromFull.Email` (then `From`) as the sender. A missing `RawEmail` returns 422. A stored message returns 200.

### Mailgun

1. Add the receiving domain in Mailgun and publish the MX records Mailgun shows. The usual US records are:

```
example.com.  MX  10  mxa.mailgun.org.
example.com.  MX  10  mxb.mailgun.org.
```

2. Create a receiving route whose action forwards to `https://chat.example.com/api/email/inbound/mailgun/mime`. The URL must end in `mime` or `raw-mime` so Mailgun includes `body-mime`, the raw MIME message. See [Route actions](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http).

3. Copy the HTTP webhook signing key from **Settings → API Security**. It is not the API key. On the node, in `vars` of `wrangler.celld.local.json`:

```json
"MAILGUN_WEBHOOK_SIGNING_KEY": "<webhook signing key>"
```

Mailgun signs `timestamp` concatenated with `token`, with no separator, using HMAC-SHA256, and sends `timestamp`, `token`, and `signature` as form fields. L4 rejects a signature older than 5 minutes and a request without `body-mime`. The mailbox is the `recipient` field. The sender is `sender`, then `from`. A stored message returns 200. See [Securing webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks).

### Amazon SES

1. Verify the domain in Amazon SES in the region that will receive mail. Publish the MX record Amazon shows. The usual value is:

```
example.com.  MX  10  inbound-smtp.<region>.amazonaws.com.
```

Replace `<region>` with that SES region, for example `us-east-1`.

2. Create an SNS topic, for example `arn:aws:sns:<region>:<account>:llll-inbound`. Add a receipt rule whose action is **Publish to Amazon SNS topic**, and choose that topic. That action includes the raw MIME message in the notification `content` field. SES only does this for messages of 150 KB or smaller, including headers. Larger messages bounce. See [Publish to Amazon SNS topic](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-sns.html).

3. Subscribe the topic to HTTPS `https://chat.example.com/api/email/inbound/ses`. L4 verifies the SNS signature (SignatureVersion 1 is RSA-SHA1, version 2 is RSA-SHA256) against `SigningCertURL`, which must be `https://sns.<region>.amazonaws.com/<name>.pem`. It confirms the subscription by requesting `SubscribeURL` only when that URL is HTTPS on `amazonaws.com`. The SNS `Timestamp` must be within 5 minutes.

4. On the node, set the topic that is allowed to deliver mail, in `vars` of `wrangler.celld.local.json`. Any other topic is rejected:

```json
"SES_SNS_TOPIC_ARN": "arn:aws:sns:<region>:<account>:llll-inbound"
```

The value must look like `arn:aws:sns:<region>:<12-digit account>:<topic name>`. L4 stores one copy for each address in `receipt.recipients`. A stored message returns 200. A notification without `content` returns 422.

## Outbound mail

Inbound mail is the webhook above. This process does not receive SMTP. The mail settings screen says inbound mail is not configured when `capabilities.emailInbound` is `null`.

Outbound mail still sends when an HTTP gateway is configured. L4 POSTs the same JSON a server email message already uses, with `Authorization: Bearer <token>`, and expects `{ "messageId": "..." }`. The body has `from`, `to`, optional `cc`, `bcc` and `replyTo`, `subject`, `text`, `html` when the email was formatted, `headers`, and `attachments`: a list of `{ "filename", "type", "content", "disposition": "attachment" }` with base64 `content`, at most 3 MB of files per email. A gateway that cannot deliver attachments must reject the message with an error rather than drop them.

An email binding is used first. Without one, Cloudflare Email Sending is used when `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set. The sender domain must be onboarded for Email Sending. Health then reports `emailProvider: "cloudflare-rest"`.

`MAIL_GATEWAY_URL` is the HTTP gateway after that. `MAIL_GATEWAY_TOKEN` is its bearer token. A `MAIL_GATEWAY` value that is itself an `http` or `https` URL is treated the same way. A Cloudflare service binding named `MAIL_GATEWAY` is used when no email binding and no Cloudflare Email Sending credential are present.

`SMTP_GATEWAY_URL` and `SMTP_GATEWAY_TOKEN` are the SMTP option. L4 does not open an SMTP connection. The gateway is an HTTP service you run that accepts the JSON body and relays it through SMTP. It is used when no mail binding, no Cloudflare Email Sending credential, and no `MAIL_GATEWAY_URL` are set.

Add these to `vars` of `wrangler.celld.local.json`. The tokens are stored in the bucket in plaintext.

```json
"MAIL_GATEWAY_URL": "https://mail.example.com/send",
"MAIL_GATEWAY_TOKEN": "<token>"
```

or:

```json
"SMTP_GATEWAY_URL": "https://smtp.example.com/send",
"SMTP_GATEWAY_TOKEN": "<token>"
```

## Browser and calls

A `BROWSER` binding is used first. Without one, the Cloudflare API token calls Browser Run. `BROWSER_CDP_URL` is the next choice: a Chromium DevTools HTTP base (`http://127.0.0.1:9222`) or a browser WebSocket (`ws://` or `wss://`). The agent reads a public http(s) URL, lists its links, or stores a screenshot. Private addresses and the server origin are rejected before navigation. Do not publish the DevTools port.

Without a binding, the Cloudflare token, and `BROWSER_CDP_URL`, page reading is off and the agent settings explain that.

Calls and live sessions use Cloudflare RealtimeKit. On Cloudflare's network the existing connection flow stays. With `LLLL_RUNTIME=celld` and the Cloudflare API token, the first call creates a RealtimeKit app named `L4` with the host and participant presets. Live settings explain that. A pasted Realtime token is optional. Without the API token, the owner connects RealtimeKit in Settings → Live the same way as on Cloudflare: paste a token with **Realtime Admin**, or use the Server's kept Cloudflare access. Until one of these is set, rooms do not start. Text chat keeps working.

Agents do not get a container, computer, or shell on celld or on Cloudflare. That row in agent settings is the capability flag `containers: false`.
