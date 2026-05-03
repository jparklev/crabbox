# Orchestrator

Crabbox has one orchestrator: the Cloudflare Worker plus Fleet Durable Object. The CLI can still talk directly to Hetzner or AWS for debugging, but normal operation should go through the coordinator.

## Responsibilities

The orchestrator owns:

- lease IDs and lease state;
- provider credentials;
- server creation and deletion;
- idle expiry and heartbeat renewal;
- pool listing;
- cost controls and usage estimates;
- status lookup.

The CLI owns:

- local config;
- per-lease SSH key creation;
- SSH readiness waits;
- rsync of the dirty working tree;
- remote command execution;
- output streaming.

## Lease States

Current user-facing states:

```text
provisioning
active
ready
running
released
expired
failed
```

The Worker stores coordinator leases as `active`, `released`, `expired`, or `failed`. Provider labels add finer local runner state such as `leased`, `ready`, and `running`.

## Heartbeats And Idle Timeout

`crabbox warmup --allowance-usd 25` and `crabbox run --allowance-usd 25` set the spending limit for metered coordinator leases. The CLI sends coordinator heartbeats every 15 seconds; for paid leases each heartbeat advances the cumulative Tempo voucher. Non-metered leases still use `--idle-timeout` and `--ttl` to recompute `expiresAt = min(createdAt + ttl, lastTouchedAt + idleTimeout)`.

Direct-provider mode does not have a central heartbeat or alarm. It labels machines with `created_at`, `last_touched_at`, `idle_timeout_secs`, `expires_at`, `state`, `lease`, and `slug`; `crabbox cleanup` uses those labels conservatively.

## Cleanup

Brokered cleanup is owned by the Durable Object alarm. `crabbox cleanup` refuses to run when a coordinator is configured, because sweeping provider resources behind the coordinator can delete live leases.

Direct cleanup only deletes machines that are clearly safe:

- `keep=true` is skipped;
- running and provisioning states are skipped until the extra stale window;
- expired ready/leased/active direct machines can be cleaned up manually;
- expired inactive machines can be deleted;
- stale active states older than expiry plus 12 hours can be deleted.

## Cost Control

The orchestrator estimates cost before creating a machine. It fetches live provider pricing when possible, multiplies the hourly rate by lease TTL, and reserves that worst-case amount for the current month. This is a guardrail, not a billing export.

Provider-backed pricing:

- AWS: `DescribeSpotPriceHistory` for the requested instance type and region.
- Hetzner: Cloud API server-type prices for the requested location; hourly EUR prices are converted with `CRABBOX_EUR_TO_USD`, default `1.08`.

Static defaults remain as fallback values for provider API failures. Explicit overrides win over provider-fetched prices:

```text
CRABBOX_COST_RATES_JSON='{"aws:c7a.48xlarge":9,"hetzner:ccx63":1.08}'
CRABBOX_EUR_TO_USD=1.08
```

Supported limits:

```text
CRABBOX_MAX_ACTIVE_LEASES
CRABBOX_MAX_ACTIVE_LEASES_PER_OWNER
CRABBOX_MAX_ACTIVE_LEASES_PER_ORG
CRABBOX_MAX_MONTHLY_USD
CRABBOX_MAX_MONTHLY_USD_PER_OWNER
CRABBOX_MAX_MONTHLY_USD_PER_ORG
CRABBOX_DEFAULT_ORG
```

For signed GitHub login tokens, owner/org is embedded in the token that the Worker forwards to the Fleet Durable Object. In shared-token automation, the CLI sends `X-Crabbox-Owner` from `CRABBOX_OWNER`, Git author/committer email env, or local `git config user.email`, and sends `X-Crabbox-Org` from `CRABBOX_ORG` when set. Raw Cloudflare Access identity headers are ignored; only a verified Access JWT email can become the bearer-token owner.

If a new lease would exceed a configured active-lease or monthly reserved-cost limit, the coordinator returns `cost_limit_exceeded` and does not provision the machine.

## Usage Statistics

The coordinator exposes `GET /v1/usage`. `crabbox usage` can show a single user, an org, or the whole fleet for a month.

Usage reports include lease count, active lease count, elapsed runtime, estimated elapsed cost, reserved worst-case cost, and breakdowns by owner, org, provider, and server type.

## Actions Parity Boundary

Actions-backed lanes should run inside a real GitHub Actions job when they need Actions secrets, OIDC, service containers, or repository workflow setup. Crabbox should dispatch or host a real GitHub Actions job and attach to the hydrated runner, not parse workflow YAML into a local pseudo-runner.

The current bridge is `crabbox init`: generate repo-local workflow and agent instructions so warmup can hydrate the same dependencies the real CI uses. The Actions-backed backend should register ephemeral self-hosted runners or dispatch a configured workflow for full secrets/OIDC parity.
