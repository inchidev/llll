# Lizard execution provider evaluation

Initial probe: 2026-10-27. Managed-compute follow-up: 2026-10-28 (Asia/Ho_Chi_Minh). Tracks [#365](https://github.com/inchidev/llll/issues/365). L4-managed Lizard compute is implemented and verified locally; it does not replace the local compute node and has not been released.

## Decision

Conditional go for an optional L4 compute provider; no go for making it the default execution environment yet. The initial probes demonstrated the existing Docker workspace image, loop filesystems and cgroup limits on a temporary Lizard VM. Subsequent local testing completed model-backed Agent Runs through the managed provider, including VM idle shutdown and workspace recovery. Draft-PR publication through Lizard and production acceptance are not established.

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

## Earlier adapter checklist

1. Prepare the existing L4 compute daemon and its immutable workspace image, with Node 24, Docker and enforceable filesystem/cgroup limits. Pi remains embedded on the L4 Server; the VM needs no model or provider-management credentials. Run a representative L4 Run through the Server, its task permissions and the paired Node.
2. Run the same checkout/build/test/artifact task on Lizard and the existing local node, then compare total setup, active, idle and retention costs.
3. Exercise reconnect, streaming logs, explicit command cancellation, expiry during execution, failed pause and cleanup reconciliation. Verify a timeout never triggers blind replay.
4. Verify non-root execution, private-network/cloud-metadata isolation, public package egress and scoped Git credentials. Firecracker isolation is the vendor's documented architecture, not a security audit performed here. [Sandbox overview](https://lizard.build/docs/sandboxes/)
5. Exercise files/checkpoint export before deletion, volume attachment/fork restrictions and snapshots without granting broader access to task source.
6. Enforce L4 project policies, initiator ceilings, aggregate concurrency, paid-compute permission and per-task budgets on every create/resume/fork path. Keep all Customer Server connections operator-owned and optional.

No GitHub PR, issue, official deployment or release was changed by this evaluation.


## Compute follow-up: 2026-10-28

The user authorized installation of guest dependencies and a temporary Volume. A first 20 GB Volume, `fcv-Ud8m9DtL3vwqMTyh`, inherited `eu-west-lim-a`; sandbox creation then returned HTTP 403 because the account trial permits US regions only. That Volume was immediately deleted, and both resource lists were empty. Explicit region selection is necessary when defaults differ from account entitlement.

A second 20 GB Volume, `fcv-Kk0zsTejJPC8U8di`, and Small sandbox `accuse-struggle-nakl` were created explicitly in `us-east-1`, with a 600-second absolute sandbox lifetime. The guest reported Alpine 3.24.1, root access, loop devices and approximately 18.5 GB free at `/workspace`. Installing Docker 29.9.2, Node 24.22.1 and filesystem tools succeeded. A 1 GiB file was allocated, formatted as ext4, mounted through a loop device with `nodev,nosuid`, verified with `findmnt`, and unmounted.

Docker initially failed with `Devices cgroup isn't mounted`. The guest kernel exposed cgroup v2; mounting it normally at `/sys/fs/cgroup` enabled CPU, memory and PID controllers. Docker then started with its data directory on the temporary Volume. No unsafe runner, privileged task container or disabled resource limit was substituted.

The existing `packages/compute-node/Dockerfile.workspace` built successfully from only the compute source files transferred from this checkout. Its local immutable image ID was `sha256:b762775dcdbbb2cc313606dfd65fd0474540aa579a30f98154ef97574bb93ba8`. A real container running as UID 1000 reported `cpu.max=100000 100000`, `memory.max=268435456`, and `pids.max=32` with a read-only root, dropped capabilities, no-new-privileges and no network. Docker warned that the kernel does not support swap limits; CPU, RAM and PID limits were present. This is runtime configuration evidence, not a full hostile-workload audit.

The actual L4 daemon passed its own loop/filesystem startup probe with a configured 1 GiB task-disk capability. Its first pairing request reached the temporary origin but returned HTTP 404. At that point no L4 Node pairing or L4 Run had completed. The Server-side Pi runtime and model credentials remain outside the guest. Scripts and full command results are retained only in ignored `.deployment/lizard/eval/`, including `bootstrap-compute.sh`, `compute-probe.mjs`, `upload-compute.mjs` and `launch-compute.mjs`; no provider token is embedded in them.

A persistent Volume can extend a trial Small sandbox beyond its 5 GB ordinary root disk; `/workspace` is its documented mount. Compute rates and Volume storage remain separate, and stopping a VM does not remove its Volume. The bootstrap therefore requires explicit Volume deletion after VM cleanup. [Volume contract](https://lizard.build/docs/sandboxes/volumes/), [current pricing](https://lizard.build/pricing).


The local proxy itself was healthy, but its temporary quick-tunnel host returned 404 at the Cloudflare edge before reaching the proxy. This is a connection-test limitation, not evidence that the daemon, Lizard networking or L4 pairing endpoint failed. The user then redirected the implementation toward an operator-configured Lizard provider in L4 rather than further quick-tunnel troubleshooting. No L4 Run was claimed or completed.

Cleanup completed at `2026-10-27T18:14:22.748Z` (UTC): `sandbox.kill()` returned true, the temporary Volume deletion succeeded, and subsequent project lists returned `sandboxes=[]` and `volumes=[]`. No snapshot, registry image, public guest port or persistent provider configuration was left. The create/probe/cleanup sequence lasted about 263 seconds; at the published Small rate this is approximately $0.0012 of compute, plus brief Volume storage. This is an estimate, not an invoice.

The product integration still needs Server-owned provider credentials and a connection check, an optional Lizard provider selection for agents/Runs, and a provider lifecycle broker. That broker must create and expire the VM, install or restore an attested compute image, pair it with a reachable Server, export checkpoints, and reconcile/delete owned resources. The management key must stay outside task guests. The existing pull-based compute protocol can remain; inference and Pi stay on the Server. For a purely local Server, a deliberate narrow authenticated ingress or a separate provider transport is still needed. The discarded quick tunnel is not a shipped connectivity solution.

## Model-backed L4 Run: 2026-10-28

A fresh disposable Small VM and temporary 20 GB Volume in `us-east-1` ran the existing L4 Docker compute daemon with a 1 GiB workspace quota. An isolated test bridge forwarded only the compute-node pairing and poll endpoints between Lizard and the local Server. The bridge was a test harness, not a product integration. The Lizard management key stayed on the host; the VM received a one-use L4 pairing credential and the normal scoped source grant.

The local L4 Server paired the Node and ran an assigned developer Agent with real inference against `inchidev/llll`. The completed Run `01a17ea1-20ad-78bc-8e11-4ff190a78f09` bootstrapped the checkout pinned at `36c24791d9862ac93325c09bab6a45b578802dcd`, read README, wrote `LIZARD_AGENT_QA.md` and executed a shell verification showing the file and Git status. The Agent did not push or open a PR. The Node was disabled and revoked; the sandbox and Volume were deleted, and subsequent provider lists showed no remaining sandboxes or Volumes.

This first Run used a temporary bridge rather than the later L4-managed lifecycle. The temporary QA project, task, environment and Run remain on the local development Server as test records; the disposable VM's source disk was removed after the test.

## L4-managed provider acceptance: 2026-10-28

The local Server created and paired a Small Lizard VM through its saved connection, and the built-in browser showed Lizard as a selectable Compute Node in the repository environment editor. Agent Run `01a17ec2-8a39-7137-bf6c-8b6a82efcdd7` completed against `inchidev/llll`, bootstrapped the checkout, created `LIZARD_AGENT_QA.md` and verified it with shell commands. The VM was stopped, the disposable test disk deleted, and the provider then reported zero sandboxes and zero Volumes.

A separate idle test reached Ready, stopped the VM automatically and deleted the unused disk. A recovery test completed Run `01a17ecb-868a-7ba1-b10a-4be886834444`, stopped the idle VM while retaining its Task disk, then automatically created another VM for Run `01a17ecd-ff2b-72e4-baa1-8c37756395e4` and read back the previously written marker. Afterward both the VM and the disposable QA disk were deleted; the provider again reported zero sandboxes and zero Volumes. These are local development results, not a deployed release or a draft-PR acceptance.
