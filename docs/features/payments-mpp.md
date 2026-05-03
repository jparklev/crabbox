# MPP payments (Tempo)

The broker gates metered coordinator leases behind [Machine Payments Protocol]
Tempo sessions. A lease is not prepaid by TTL. Instead, the agent authorizes a
session allowance and then keeps the machine alive by sending cumulative Tempo
vouchers on heartbeat.

[Machine Payments Protocol]: https://mpp.dev

## Invariants

- **Zero overpayment:** settlement uses the highest cumulative voucher the
  broker actually received, not a guessed maximum instance price.
- **Zero broker liability:** provisioning starts only after the broker has a
  valid session credential with an initial two-minute buffer voucher.
- **Heartbeat equals voucher:** a coordinator heartbeat is a payment update. If
  vouchers stop covering elapsed runtime, the Durable Object hibernates the
  machine and terminates active compute.

## Enable

Set the following Worker secrets / vars:

```text
CRABBOX_MPP_RECIPIENT                0x... wallet that receives settlement
CRABBOX_MPP_CURRENCY                 0x... TIP-20 token contract
CRABBOX_MPP_DECIMALS                 integer 0-32 (default: 6)
CRABBOX_MPP_SECRET_KEY               HMAC secret binding challenges to their contents
CRABBOX_MPP_SETTLEMENT_PRIVATE_KEY   0x... broker key used to settle session vouchers
CRABBOX_MPP_RPC_URL                  optional Tempo RPC override
CRABBOX_MPP_REALM                    override the auto-detected realm
```

If `CRABBOX_MPP_RECIPIENT` is unset, the lease endpoint behaves as a normal
authenticated coordinator endpoint.

Deployments must set `CRABBOX_MPP_CURRENCY` explicitly so the broker opens
channels against the intended token.

## Wire Format

Lease creation uses a session challenge with the requested allowance:

```text
POST /v1/leases
{ "provider": "aws", "class": "beast", "spendingLimitUSD": 25.00, ... }

HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment realm="...", method="tempo", intent="session", limit="25.000000", ...
```

The client retries with:

```text
Authorization: Payment <session-credential>
```

After successful provisioning, the `201 Created` response includes the resolved
machine and exact `burnRateUSDPerMinute`. If AWS Spot falls back to a cheaper
candidate or Hetzner resolves to a lower-cost box, the returned burn rate is the
cheaper actual rate. The client simply burns through the same allowance more
slowly.

## Heartbeat Burn

The CLI heartbeat loop runs every 15 seconds. Each heartbeat is a `POST
/v1/leases/{id}/heartbeat`; when the broker needs more coverage it returns a
Tempo session 402 for the missing voucher delta, and the CLI shells out to
`mppx` when `CRABBOX_MPP_PAY=auto` is enabled.

The Durable Object stores:

```text
sessionID
sessionKey
spendingLimitUSD
burnRateUSDPerMinute
highestVoucherHeldUSD
highestVoucherHeldUnits
paymentCoveredUntil
lastLiquidityCheckAt
```

Voucher acceptance is strictly monotonic. A lower cumulative voucher is rejected
by the Tempo session verifier and never updates lease state.

## Teardown And Settlement

`POST /v1/leases/{id}/release` accepts the final voucher, deletes active
infrastructure, and submits the single highest voucher to Tempo settlement.
Long-running leases also settle intermediate vouchers about every ten minutes so
an agent cannot empty its source wallet and bounce the final payment.

If provisioning fails after the session opens, the broker intentionally skips
settlement for that session. No compute was rendered, so the agent pays nothing.

## Hibernate And Resume

When the pacing alarm finds that elapsed runtime is no longer covered by the
highest voucher, it does not immediately discard the agent workspace. It:

1. Creates a native provider image: Hetzner snapshot or AWS AMI.
2. Waits for the image to become available when the provider exposes that state.
3. Terminates the active server.
4. Stores `snapshotID` and marks the lease `hibernated`.

The agent can resume with:

```text
POST /v1/leases/{id}/resume
Authorization: Payment <new-session-credential>
{ "spendingLimitUSD": 25.00 }
```

The broker provisions from the saved snapshot and swaps in the new Tempo
session, so work continues from the hibernated disk image.

## CLI Client Behaviour

The Go CLI delegates Tempo signing to the `mppx` binary. When:

1. `CRABBOX_MPP_PAY=auto` is set,
2. a coordinator request returns `402 Payment Required`, and
3. `mppx` is available on `PATH`,

the CLI retries the request through `mppx`, using the configured Tempo account.
This applies to lease creation, heartbeats, and release. Use
`--allowance-usd` or `CRABBOX_ALLOWANCE_USD` to set the session spending limit.

Successful MPP-paid lease creation still returns a short-lived `cbxu_...`
lease bearer so non-payment endpoints like runs, logs, status, and SSH helpers
stay scoped to that lease.

Related docs:

- [MPP E2E recipe](./payments-mpp-e2e.md)
- [Cost and usage](./cost-usage.md)
- [Coordinator](./coordinator.md)
- [Broker auth and routing](./broker-auth-routing.md)
