# warmup

`crabbox warmup` provisions or leases a remote box and waits until SSH and Crabbox bootstrap plumbing are ready.

```sh
crabbox warmup --class beast
crabbox warmup --provider aws --class beast --market on-demand
crabbox warmup --actions-runner
crabbox warmup --provider blacksmith-testbox --blacksmith-workflow .github/workflows/ci-check-testbox.yml --blacksmith-job test
```

The command returns a stable `cbx_...` lease ID and a friendly slug. Reuse either for subsequent `run`, `status`, `ssh`, `inspect`, and `stop` commands; scripts should keep using the canonical ID.

With `--provider blacksmith-testbox`, the canonical ID is the Blacksmith `tbx_...` ID returned by `blacksmith testbox warmup`; Crabbox still assigns and stores a local slug for reuse.

On success, `warmup` prints a concise total duration line. Add `--timing-json` to emit a final JSON timing record with provider, lease ID, slug, total duration, and exit code.

Flags:

```text
--provider hetzner|aws|blacksmith-testbox
--profile <name>
--class <name>
--type <provider-type>
--market spot|on-demand
--ttl <duration>
--idle-timeout <duration>
--allowance-usd <amount>
--keep
--actions-runner
--reclaim
--timing-json
--blacksmith-org <org>
--blacksmith-workflow <file|name|id>
--blacksmith-job <job>
--blacksmith-ref <ref>
```

`--allowance-usd` sets the coordinator Tempo session spending limit, default `$5`. `--idle-timeout` releases non-metered leases after no touch for that duration, default `30m`. `--ttl` remains available for direct-provider cleanup labels and non-metered coordinators.
Warmup records a local claim tying the lease to the current repo; `--reclaim` overwrites an existing local claim for that lease.

For AWS, `--market` overrides `capacity.market` for this lease. Use
`--market on-demand` when Spot capacity is blocked or when a quota request was
approved only for the standard On-Demand quota. Explicit `--type` still means
exact type: Crabbox reports quota/capacity/policy failures instead of silently
changing capacity.

`--actions-runner` immediately registers the warm box as an ephemeral self-hosted GitHub Actions runner for the current repository. Most projects should prefer `crabbox actions hydrate --id <lease-id-or-slug>` after warmup because it also dispatches the workflow and waits for the ready marker.

`--actions-runner` is not supported with `blacksmith-testbox` because Blacksmith owns Testbox workflow hydration.

New leases use per-lease SSH keys under the user config directory:

```text
~/.config/crabbox/testboxes/<lease-id>/id_ed25519
```
