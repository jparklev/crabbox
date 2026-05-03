# Cost And Usage

Read when:

- changing budget guardrails;
- changing provider price lookup;
- interpreting `crabbox usage` output.

The coordinator tracks lease count, active leases, elapsed runtime, estimated elapsed cost, and reserved worst-case cost. This is an operational guardrail, not invoice reconciliation.

Pricing precedence:

```text
1. CRABBOX_COST_RATES_JSON explicit override.
2. Provider live pricing:
   - AWS EC2 Spot price history.
   - Hetzner Cloud server-type hourly prices.
3. Built-in static fallback rates.
```

Hetzner prices are converted from EUR to USD with `CRABBOX_EUR_TO_USD`, default `1.08`.

Budget controls:

```text
CRABBOX_MAX_ACTIVE_LEASES
CRABBOX_MAX_ACTIVE_LEASES_PER_OWNER
CRABBOX_MAX_ACTIVE_LEASES_PER_ORG
CRABBOX_MAX_MONTHLY_USD
CRABBOX_MAX_MONTHLY_USD_PER_OWNER
CRABBOX_MAX_MONTHLY_USD_PER_ORG
CRABBOX_DEFAULT_ORG
```

Identity for usage:

- signed GitHub login tokens carry owner/org identity;
- shared bearer-token CLI requests send `X-Crabbox-Owner`;
- `X-Crabbox-Owner` comes from `CRABBOX_OWNER`, Git email env, or `git config user.email`;
- `CRABBOX_ORG` sends `X-Crabbox-Org`.
- raw Cloudflare Access identity headers are ignored; only a verified Access JWT email can become the bearer-token owner.

`estimatedUSD` is elapsed runtime cost. `reservedUSD` is the metered allowance for paid coordinator leases or the direct/non-metered TTL worst-case cost. Provider extras such as static IP charges, egress, snapshots, taxes, credits, and discounts are not fully modeled.

Related docs:

- [usage command](../commands/usage.md)
- [Orchestrator](../orchestrator.md)
- [Providers](providers.md)
