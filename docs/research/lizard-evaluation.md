# Lizard execution provider evaluation

Date: 2026-10-27. Tracks [#365](https://github.com/inchidev/llll/issues/365). This is a bounded provider probe, not an L4 integration or a replacement for the local compute node.

## Decision

Conditional go for a separate provider prototype; no go for making it the default execution environment yet. Authentication, a disposable Linux environment, public repository checkout and cleanup worked. The advertised Pi template was unavailable to this account/region, and the fallback base image lacked Node and Pi. Consequently no model ran, no L4 build/test completed, and no task-to-draft-PR acceptance is established.

Keep Pi as L4's runtime and keep Server authorization, task state, source checkpoints and result acceptance in L4. The local compute node remains the working baseline. A future Lizard adapter must provide its own prepared toolchain, centrally bounded lifecycle and credential broker rather than transferring the provider management key into the guest.

## Live probe

Used official `@lizard-build/sdk` version 0.1.82, installed only under ignored `.deployment/lizard/eval/`. The account was already on its trial; no subscription, payment method, terms, account setting or existing resource was changed. The management token was read from an ignored host file and was not included in guest environment options. No private source, production data or L4 credentials were uploaded.

| Check | Observed result |
| --- | --- |
| API authentication and project discovery | Succeeded; one accessible existing project, zero sandboxes initially. |
| Advertised `pi` template | Create returned HTTP 400, `Unknown sandbox template 'pi' in region 'us-east-1'`. No sandbox was created by this request. |
| Fallback `base`, Small, 600-second lifetime | Created one disposable sandbox, `consider-lizard-kkzm`, in approximately 1.1 seconds. This measures this request only. |
| Command transport | Returned stdout, stderr and exit status. Guest reported Linux 6.1.177+ and Git 2.54.0. |
| Toolchain | Both `node` and `pi` returned command-not-found. Docker CLI was not found, and `/var/run/docker.sock` was absent. Installing or testing nested Docker was outside this bounded probe. |
| Disk observation | `df -B1 /` reported 5,800,038,400 bytes on the overlay filesystem. This is a filesystem observation, not proof of a durable capacity guarantee or quota enforcement. |
| Public repository | Shallow clone of `https://github.com/inchidev/llll.git` succeeded at `36c24791d9862ac93325c09bab6a45b578802dcd` (main 0.2.21). |
| File transfer into guest | SDK `fs.write` completed for a synthetic D1-pagination test file in the checkout. |
| Test execution / artifact export | The Node smoke could not run because Node was absent. Export was not reached. The combined runtime diagnostic's final shell exit status was zero, but its stderr explicitly showed the missing tools; that status is not a successful Node/Pi test. |
| Reconnect, process cancellation, pause/resume | Not reached after the toolchain failure. |
| Cleanup | `sandbox.kill()` succeeded; a subsequent API list returned zero sandboxes. No persistent volume, snapshot, fork, app, database or public port was created. |

The owned sandbox lived within a 7.4-second create/probe/cleanup sequence, with a 600-second expiry as an additional bound. Detailed command results and the probe script are in ignored `.deployment/lizard/eval/`; credentials and private account responses must remain there.

## Documented contract and gaps

The official SDK documents argv-based exec, streamed output, process signaling, explicit lifetimes and asynchronous pause/resume. Exec supports at most 600 seconds per command; its default server limit is 150 seconds while the TypeScript caller defaults to a 60-second wait. A raw create request without a lifetime has no expiry. Any L4 adapter must always set one and must not confuse a client timeout with a failed command. These behaviors were read, not all exercised. [SDK reference](https://lizard.build/docs/sandboxes/sdk-reference/)

The current CLI template catalog lists `pi`, but availability is checked by region. The failed live request means catalog presence alone is insufficient for admission. A connection test should verify the selected template and actual Node/Pi executable versions before offering it to tasks. [Sandbox CLI](https://lizard.build/docs/cli/sandbox/)

Trial accounts are restricted to Small and US regions. That prevented evaluation of Medium's advertised 20 GB disk; the Small plan advertises only 5 GB, below L4's desired 10 GiB workspace baseline. Region, size and remaining starts/concurrency need admission-time checks. [Limits](https://lizard.build/docs/platform/limits/)

Persistent Volumes mount at `/workspace`, allow one attachment at a time and remain node-local. Kill/expiry preserves an attached volume but deletes an ordinary sandbox disk. Fork with a volume is documented to return 409, and snapshots can copy its data into their sharing scope. L4 needs external checkpoints and explicit snapshot audience rules. None of these persistence paths was exercised here. [Persistent Volumes](https://lizard.build/docs/sandboxes/volumes/)

A failed pause can leave a sandbox running; observing the requested state transition matters before stopping accounting or returning capacity to L4's pool. [Known issues](https://lizard.build/docs/platform/known-issues/)

## Cost and comparison limits

Published compute rates are Small (2 vCPU / 4 GB / 5 GB) $0.0162/hour, Medium (4 vCPU / 8 GB / 20 GB) $0.0324/hour and Large (8 vCPU / 16 GB / 50 GB) $0.0648/hour. Pro is $19/month including $19 usage; the trial includes $5 credit. Running idle time is billed; paused compute is free, while retained volumes still cost storage. Using the Small rate, the observed 7.4-second sequence corresponds to roughly $0.00003 of compute; this is a rate-based estimate, not a reconciled invoice. [Pricing](https://lizard.build/pricing)

No Boat token or VM was used. The Boat pricing URL in #365 was unavailable to this research browser, so this run establishes no current same-task Boat cost or performance comparison. Neither provider's startup marketing benchmark is L4 acceptance evidence.

## Before enabling the adapter

1. Prepare and attest a Node 24 + Pi + Git toolchain, or confirm a usable Pi template through the live catalog; run a representative L4 task with actual inference credentials scoped to that task.
2. Run the same checkout/build/test/artifact task on Lizard and the existing local node, then compare total setup, active, idle and retention costs.
3. Exercise reconnect, streaming logs, explicit command cancellation, expiry during execution, failed pause and cleanup reconciliation. Verify a timeout never triggers blind replay.
4. Verify non-root execution, private-network/cloud-metadata isolation, public package egress and scoped Git credentials. Firecracker isolation is the vendor's documented architecture, not a security audit performed here. [Sandbox overview](https://lizard.build/docs/sandboxes/)
5. Exercise files/checkpoint export before deletion, volume attachment/fork restrictions and snapshots without granting broader access to task source.
6. Enforce L4 project policies, initiator ceilings, aggregate concurrency, paid-compute permission and per-task budgets on every create/resume/fork path. Keep all Customer Server connections operator-owned and optional.

No GitHub PR, issue, official deployment or release was changed by this evaluation.
