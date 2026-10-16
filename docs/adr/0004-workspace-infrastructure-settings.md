# Put managed Installation settings in the workspace

Status: superseded by ADR 0005.

L4 Admin creates and discovers a Base Installation. It is not the everyday settings surface for that workspace. Once the Owner Setup Claim has created the Owner, App Domain, Email Domain, and Mailbox configuration belongs in Workspace Settings.

The broad Cloudflare OAuth credential remains encrypted in the llll.gg Control Plane and never enters the workspace Worker. A guided workspace instead receives one random Installation Control Credential. The Owner-facing workspace API may use that credential only through fixed operations for the same Installation: read active zones and tracked domain state, connect or disconnect its App Domain and Email Domains, and create or delete exact literal mailbox routes. The credential is not a general Cloudflare proxy and cannot address another Installation.

The Base Installation request remains free-plan-compatible and contains no domain choices. Domain lifecycle operations pause if the Control Plane is unavailable, while workspace chat and data continue from the customer's Cloudflare account.
