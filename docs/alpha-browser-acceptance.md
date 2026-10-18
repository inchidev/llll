# Current alpha browser acceptance

2026-10-18. Target: the published `v0.1.0-alpha.1`, followed by unreleased fixes on an isolated Cloudflare fixture. No release tag, published asset or production deployment was changed.

## Deployment boundary

The initial Instance and two Server modules came from the downloaded release. Every release checksum, module SHA-256 and static-asset hash was verified before deployment. Server baseline SHA-256: `bc9436efce8a5e98724d7b92419de154e1597cb4360ec2a9cc8484ea83e2152b`. Instance baseline SHA-256: `18c2fec781af078ee9d5a3666be11825ab932ddf8bec1038f4098811eda9eeb5`.

All account operations used the connected Cloudflare API tool. New Workers, separate Instance/Server databases, private file buckets and ticket namespaces were created. The Backup bucket is separate from live files. Targets, pairing keys, test passwords, screenshots and detailed logs are in ignored `.deployment/alpha-browser/` state.

The connector could create a Static Assets upload session but could not authenticate the subsequent upload with its separate JWT: both upload attempts returned 401. The operator declined a local-upload exception. Exact release assets were therefore stored through the connector in an isolated KV namespace and exposed through a test-only `ASSETS` service binding. The adapter reproduces the SPA fallback to `index.html`. It is a test harness, not a new product deployment method.

The owner was claimed through the browser. The two Servers were provisioned through the connector and connected through the existing-server form. Automatic Server creation through a Cloudflare OAuth grant and the native Static Assets upload remain **unverified**. This is not a complete acceptance of the guided fresh installer.

## Reproduced defects and fixes

| Trigger | Published alpha behavior | Unreleased fix |
| --- | --- | --- |
| Instance proxies a same-account Server without a service binding | Cloudflare returns an error document instead of application HTTP/WebSocket traffic | Enable `global_fetch_strictly_public` on Instance, Server and portal deployments. Add it when installing/updating an older immutable Server manifest too. |
| Reload a Shell URL containing a Server UUID and Channel path | The prerendered landing page takes over and navigation returns to `/` | Route valid UUID paths to Nuxt's client-only `200.html` entry. The local portal fixture now models Cloudflare's `index.html` fallback rather than hiding this problem. |
| Kick a member while their Channel socket remains open | HTTP messages/files return 403, but the existing socket receives subsequent messages | Check current Server/Channel access before broadcasts, exclude unauthenticated sockets and close connections whose access was revoked. Workspace events and presence also exclude removed members. |
| Sign out while the sign-out request is delayed by 500 ms | Navigation cancels revocation; the previous signed token still returns 200. Waiting also exposed the endpoint's missing JSON body. | Send the required empty JSON body and await server sign-out before clearing connection state and navigating. |

Same-account routing was retested after removing the test fixture's forward and reverse service bindings. The runtime flag behavior is documented by [Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/fetch/).

## Browser evidence

Two independent Chromium browser sessions used an owner Account and an invited member Account. The Shell was deployed separately from the Instance using the release's portal module and assets; its routing fix was then tested from source.

| Scenario | Result |
| --- | --- |
| Fresh owner claim through the form | Passed |
| Register the two separately provisioned Servers through the operator form | Passed |
| Create an invitation and register the second Account through that link | Passed; the member sees only the invited Server |
| Send messages and a file through the UI | Passed; the member reads the exact uploaded text |
| Real browser WebSocket authentication and message delivery without reload | Passed after the runtime flag fix; captured `hello`, `typing`, `message`, presence and read events |
| Direct Channel reload and switching between Servers | Passed; selection survives reload and content stays separate |
| Open the official Shell and send a message from the embedded client | Passed |
| Direct-open and reload a Shell UUID/Channel deep link | Passed after the HTML-entry fix |
| Disable the member browser's network, send from the owner, reconnect | Passed; the Shell catches up the missed message |
| Request the uninvited Server from the member's browser | 403 |
| Read messages/files after removal | 403 |
| Hold sockets through removal and verify later events are denied | Passed locally and on Cloudflare; both member sockets closed and the new owner message was absent |
| Delay sign-out and verify the previous token is revoked | Passed on the fresh candidate client; the old signed token returns 401 after the 500 ms delay |

The fixture's removed-member row was explicitly reset only to repeat the before/after removal test. This was an isolated operator test reset, not a product re-admission feature. A fresh member browser was used for the candidate client: an existing PWA tab intentionally retains its preceding cached client generation until an update is activated.

## Local validation and remaining limits

499 unit tests across 95 files, lint, root/portal/Instance types, builds, fresh-schema checks, the three-runtime Instance fixture and the portal fixture passed. Regression coverage includes the older manifest's missing transport flag, the actual SPA fallback, held Channel/Workspace sockets through a kick, unauthenticated sockets, fail-closed recipient authorization and the JSON sign-out request waiting for revocation.

The final Server module built from source commit `0d36dda` was also deployed to the isolated fixture after local validation; SHA-256: `e7b2ea3bfa210aa65d66d1714705f5efafef6b13b66db66f5f9ee7f7059b573c`. Browser before/after reproductions and local real-runtime regressions are distinct evidence; the fixture does not change the published release's bytes.

Broadcast authorization now performs a fresh check per distinct connected user per event. High-fanout capacity has not been benchmarked by this two-person acceptance run.

Native Static Assets upload, guided OAuth provisioning, VPS/celld parity, Safari, physical devices, calls, mail delivery and inference are outside the verified results above. Published alpha artifacts still contain the original defects; fixes are in source and the isolated candidate only. Existing public site and prototype installations were not updated.
