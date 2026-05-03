# Coordinator

Read when:

- changing brokered lease behavior;
- debugging coordinator auth, health, pool, status, or usage;
- deciding whether behavior belongs in the CLI or Worker.

The coordinator is the Cloudflare Worker plus Fleet Durable Object. Normal Crabbox operation goes through this broker; direct provider mode is for debugging and escape hatches.

Responsibilities:

- authenticate broker requests with signed GitHub user tokens, the shared operator token, or the separate admin token, with optional verified Cloudflare Access context on protected fallback routes;
- serialize fleet state in one Durable Object;
- create, heartbeat, release, expire, and look up leases;
- own provider credentials;
- create and delete provider resources;
- list the pool;
- enforce cost and active-lease guardrails;
- expose usage statistics.

API surface:

```text
GET  /v1/health
GET  /v1/pool
GET  /v1/whoami
POST /v1/leases
GET  /v1/leases
GET  /v1/leases/{id-or-slug}
POST /v1/leases/{id-or-slug}/heartbeat
POST /v1/leases/{id-or-slug}/release
POST /v1/leases/{id-or-slug}/resume
GET  /v1/runs
POST /v1/runs
GET  /v1/runs/{run-id}
GET  /v1/runs/{run-id}/logs
POST /v1/runs/{run-id}/finish
GET  /v1/usage
GET  /v1/admin/leases
POST /v1/admin/leases/{id-or-slug}/release
POST /v1/admin/leases/{id-or-slug}/delete
```

GitHub browser-login tokens are owner/org scoped for lease, run, log, and usage routes. Shared-token admin auth is required for `GET /v1/pool`, admin lease routes, and fleet-wide usage/listing.

Lease responses include the canonical `cbx_...` ID, friendly slug when present, provider metadata, owner/org, `createdAt`, `lastTouchedAt`, `idleTimeoutSeconds`, `ttlSeconds`, and computed `expiresAt`. Metered leases also include `spendingLimitUSD`, `burnRateUSDPerMinute`, voucher coverage, and snapshot metadata when hibernated. Heartbeat is a touch for non-metered leases and a cumulative voucher update for paid leases.

The CLI owns local config, per-lease SSH keys, SSH readiness, sync, command execution, output streaming, and local fallback handling.

Related docs:

- [Orchestrator](../orchestrator.md)
- [Architecture](../architecture.md)
- [CLI](../cli.md)
- [usage command](../commands/usage.md)
