# Move guided installation authority to llll.gg

Status: superseded by ADR 0005.

L4.com is the private account and Installation Control Plane. An operator creates a permanent L4 Account, connects Cloudflare through OAuth, and manages discovered or newly provisioned Installations at `/admin`. Renewable Cloudflare credentials are encrypted at rest in the Control Plane and never copied into a workspace Worker.

New guided setup provisions a base Installation directly into the customer's Cloudflare account. It does not create an account-local Admin Worker. The first Installation in an account is Primary and is the only Installation eligible to own account- or zone-wide integrations such as mail routing and RealtimeKit. The first release of this model provisions the base workspace only; billing and optional infrastructure activation follow later.

Workspace content and runtime state remain in the customer's D1, R2, KV, and Durable Objects. The Control Plane stores only operator identity, connected-account metadata, encrypted Cloudflare OAuth credentials, and Installation metadata. If llll.gg is unavailable, existing workspace chat and data continue to operate while provisioning and infrastructure changes pause.

A fully independent lifecycle mode is deferred and must not be presented as shipped. The current model has one central account Control Plane and no account-local Admin Worker or per-workspace Cloudflare management token.
