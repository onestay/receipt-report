# Durable self-hosted deployment

This is the first deployment profile intended to hold real receipt data. It is
single-user software with no authentication. The production Compose file binds
the API to `127.0.0.1`; keep it on the host, an authenticated VPN, or an SSH
tunnel. Do not port-forward it or expose it to the public internet. DNS, TLS,
reverse proxies, and authentication require a separate security decision.

## First use and pinned release

Install Docker Engine and Compose v2. Obtain API and worker images built from the
same release and pin `RECEIPT_REPORT_API_IMAGE` and
`RECEIPT_REPORT_WORKER_IMAGE` to immutable tags or digests. Copy
`.env.production.example` to `.env.production`, make it readable only by its
owner (`chmod 600`), and replace every placeholder. Never commit that file.
The authoritative variable reference, including defaults and service ownership,
is in the [README configuration section](../README.md#configuration).

Each release tag publishes both images to GitHub Container Registry. Take the
digests from the GitHub release notes for the version you selected and pin them:

```bash
docker pull ghcr.io/onestay/receipt-report-api@sha256:<api-digest>
docker pull ghcr.io/onestay/receipt-report-worker@sha256:<worker-digest>
```

The published images are `linux/amd64`. A host on another architecture, or an
air-gapped host, builds the same release locally instead and uses those tags:

```bash
git checkout <release-tag-or-commit>
docker build --target api-runtime -t receipt-report-api:<release> .
docker build --target worker-runtime -t receipt-report-worker:<release> .
```

Do not use `latest`; it is deliberately never published. Do not mix API and
worker from different releases.

Validate before startup:

```bash
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml up --detach --wait
curl --fail http://127.0.0.1:3000/api/v1/health
curl --fail http://127.0.0.1:3000/api/v1/operator/status | jq
```

Run `docker compose --env-file .env.production -f compose.production.yaml pull`
before `up` when the pins refer to registry images; skip it for locally built
tags.

The migration container must finish before API and worker start. A failed
`migrate` service identifies schema/database/volume ownership errors; an
unhealthy `api` identifies database, storage, or web-serving startup errors; an
unhealthy `worker` identifies renderer, storage, database, or provider
configuration errors. Inspect sanitized logs with `docker compose ... logs
SERVICE`. Provider errors are classified but secrets and raw receipt contents
are not logged. The fake provider is for tests and demos only: production
defaults to `openai-compatible` and deliberately requires its URL, model, and
key.

## Operator status

`GET /api/v1/operator/status` reports counts only. `healthy` means completed
normalization or successful extraction; `queued`, `running`, `retrying`,
`failed`, and `stale` distinguish work requiring attention. Stale means an
active row has not changed for `OPERATOR_STALE_AFTER_MS` (15 minutes by
default). The endpoint never returns filenames, document paths, receipt fields,
raw responses, keys, models, or error detail.

```bash
curl --silent --fail http://127.0.0.1:3000/api/v1/operator/status | jq -e \
  '.status == "healthy"'
```

Queued/running/retrying counts are normal while work progresses. Investigate
stale or failed counts using container health and sanitized service logs, then
use the existing receipt-level retry controls after correcting configuration.

## Backup, upgrade, rollback, and restore

The database and document tree are one recovery unit in the named data volume.
The backup script stops both writers before archiving the entire volume, so the
SQLite database, `-wal`/`-shm` state, originals, normalized pages, attempts,
proposals, decisions, corrections, categories, and reporting inputs share one
point in time.

```bash
mkdir -p backups
set -a; . ./.env.production; set +a
./scripts/backup-compose.sh backups
# copy both .tar.gz and .sha256 off-host and protect them like the receipts
```

For every upgrade: read the release migration/compatibility notes; create and
verify the backup; pull both immutable images from the same release (or build
both targets from that release); change both image pins; then run
`up --detach --wait`. Confirm health, operator status, a known approved
receipt, and its spending report. Never run a newer worker against an older
API/schema.

Application rollback is safe only when the release notes say the old binaries
remain compatible with every applied migration. Otherwise restore the
pre-upgrade backup; migration files are forward-only and are not manually
reversed.

```bash
set -a; . ./.env.production; set +a
./scripts/restore-compose.sh backups/receipt-report-YYYYMMDDTHHMMSSZ.tar.gz
```

Restore replaces the selected named volume, verifies the archive checksum when
present, runs migrations, and starts the pinned release. Restore only into an
empty/replacement environment or when discarding its current state is intended.
Run the isolated production-stack recovery check with
`pnpm compose:restore-drill`; it builds pinned local images, exercises the full
fake-provider workflow, invokes the real backup and restore commands, and
verifies that documents, approvals, corrections, and reporting state survive
while post-backup state is removed.

## Cutting a release

Releases are marked by tag, not by branch state. Tag a commit that is already
merged into `main`, then push the tag:

```bash
git checkout main && git pull --ff-only
git tag --annotate v1.2.0 --message 'Receipt Report v1.2.0'
git push origin refs/tags/v1.2.0
```

The `Release` workflow rejects a tag that is not `vMAJOR.MINOR.PATCH` or that
points outside `main`, re-runs the full `Verify` workflow for the tagged commit,
builds the `api-runtime` and `worker-runtime` targets from that one source tree,
and pushes them to `ghcr.io/onestay/receipt-report-api` and
`ghcr.io/onestay/receipt-report-worker` with the version tag, the `MAJOR.MINOR`
tag, and the commit SHA tag. It attests signed build provenance for both digests
and creates the GitHub release, whose notes carry the two digests to pin.

A prerelease tag such as `v1.2.0-rc.1` publishes images and a GitHub prerelease
but no `MAJOR.MINOR` tag. Tags are never moved or re-pushed: correcting a
release means publishing the next version. Add the migration, compatibility, and
rollback notes required by [ADR 0016](decisions/0016-durable-real-data-deployment.md)
to the generated release before deploying it. See
[ADR 0022](decisions/0022-tag-driven-container-releases.md) for the reasoning.

## Provider privacy and lifecycle

With `openai-compatible`, normalized receipt page images and the extraction
prompt leave the host for the configured provider. Canonical receipts,
categories, corrections, and reports remain local unless included in an
operator-created backup. Check the provider's own retention/training terms.

Rotate a key by updating only `.env.production`, then recreate the worker with
`docker compose ... up --detach --force-recreate worker`; confirm worker health
and enqueue a synthetic test before revoking the old key. Changing model or
profile affects only future attempts. Pin the model where the provider supports
it, update the model/profile together deliberately, recreate the worker, and
retain old attempts for provenance.

Raw provider responses are retained for seven days by default, then purged by
the worker; attempt metadata, validated proposals, approval/rejection decisions,
and correction events are durable audit history. Originals and normalized pages
remain until their receipt/document lifecycle permits removal. Storage therefore
grows roughly by original bytes plus normalized page images, durable database
metadata, and up to seven days of raw responses. Backups contain everything
present at backup time and do not independently expire—rotate them separately
and securely delete retired copies.
