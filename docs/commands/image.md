# image

`crabbox image` contains trusted operator controls for runner images on AWS
and Hetzner Cloud.

```sh
crabbox image create --id cbx_... --name openclaw-crabbox-20260501-1246 --wait
crabbox image promote ami-...
crabbox image promote 382206402
```

Image commands require a configured coordinator and admin-token auth. Set
`broker.adminToken` or `CRABBOX_COORDINATOR_ADMIN_TOKEN` locally; the Worker
checks `CRABBOX_ADMIN_TOKEN`.
They are intentionally not available to normal GitHub browser-login users.

## create

Create an AMI (AWS) or snapshot (Hetzner) from an active lease. The provider
is inferred from the lease record.

Flags:

```text
--id <cbx_id>        source lease (AWS or Hetzner)
--name <name>        image name (AWS) or snapshot description (Hetzner)
--wait               poll until the image is available
--wait-timeout <d>   default 45m
--no-reboot          AWS only; default true
--json               print JSON
```

For AWS the Worker calls EC2 `CreateImage`. For Hetzner the Worker calls the
`create_image` server action with `type: "snapshot"`.

Hetzner snapshots taken from a running server include only data that has been
flushed to disk. Run `sync; sync` (or `fsfreeze -f /` followed by `fsfreeze
-u /` for non-ext4 filesystems) over SSH on the lease before creating the
image, otherwise recently written files may be missing or corrupt in the
restored snapshot.

Recommended bake flow:

```sh
crabbox warmup --provider aws --class standard --ttl 2h --idle-timeout 30m
crabbox run --id <slug> --shell -- 'command -v ssh git rsync curl jq && test -d /work/crabbox'
crabbox image create --id <cbx_id> --name openclaw-crabbox-YYYYMMDD-HHMM --wait
```

Use a fresh, intentionally warmed lease as the source. Do not bake personal
workspace state, local secrets, repository checkouts, or one-off debugging
artifacts into the image.

Failure handling:

- If `--wait` times out, run `crabbox image create ... --json` or inspect the
  AWS AMI state before retrying. AWS image creation can continue after the CLI
  stops polling.
- If the AMI enters a failed state, leave the current promoted image in place
  and create a new image from a fresh lease.
- If the source lease disappears, create a new warm lease and restart the bake;
  image creation requires the backing AWS instance ID.
- If the baked image boots but never reaches `crabbox-ready`, do not promote it.
  Keep the previous promoted AMI and debug bootstrap on a normal lease first.
- Cleanup of stale candidate AMIs is an AWS operator task. Promotion does not
  delete old images or snapshots.

## promote

Promote an available image as the coordinator's default for its provider:

```sh
crabbox image promote ami-1234567890abcdef0                  # AWS, tag=latest
crabbox image promote 382206402                              # Hetzner, tag=latest
crabbox image promote 382206402 --tag rust-beast             # named tag
```

Promotions are namespaced by tag. The default tag is `latest`. Future brokered
leases resolve the promoted image by tag at lease-creation time:

```sh
crabbox warmup --image-tag rust-beast
```

If the lease request omits both an explicit image (`awsAMI` / `image`) and an
`imageTag`, the broker falls back to the `latest` tag. AWS still respects
`CRABBOX_AWS_AMI` if set.

Promotion stores coordinator metadata only; it does not copy or modify the
underlying image.

Promotion and rollback:

```sh
crabbox image promote ami-new
crabbox warmup --provider aws --class standard --ttl 20m --idle-timeout 6m
crabbox run --id <slug> --shell -- 'echo image-smoke-ok && uname -srm && test -d /work/crabbox'
crabbox stop <slug>
```

If the smoke fails, promote the previous known-good AMI again. The coordinator
stores only the selected AMI ID, so rollback is another `image promote` call.
Keep the previous AMI available until at least one brokered AWS smoke succeeds
on the new image.

Related docs:

- [Infrastructure](../infrastructure.md)
- [Runner bootstrap](../features/runner-bootstrap.md)
