#!/bin/bash
set -euo pipefail

project_name="receipt-report-production-smoke-${CI_RUN_ID:-local}-$$"
temporary="$(mktemp -d)"
export COMPOSE_PROJECT_NAME="$project_name"
export COMPOSE_FILE=compose.production.yaml
export RECEIPT_REPORT_API_IMAGE="receipt-report-api-smoke:$$"
export RECEIPT_REPORT_WORKER_IMAGE="receipt-report-worker-smoke:$$"
export RECEIPT_REPORT_DATA_VOLUME="$project_name-data"
export RECEIPT_REPORT_SECRETS_FILE="$temporary/provider.env"
export EXTRACTION_PROVIDER=fake
printf 'EXTRACTION_PROVIDER=fake\n' > "$RECEIPT_REPORT_SECRETS_FILE"

cleanup() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    docker compose -f "$COMPOSE_FILE" ps --all || true
    docker compose -f "$COMPOSE_FILE" logs --no-color || true
  fi
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans --timeout 15 || true
  docker image rm "$RECEIPT_REPORT_API_IMAGE" "$RECEIPT_REPORT_WORKER_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT

docker build --target api-runtime --tag "$RECEIPT_REPORT_API_IMAGE" .
docker build --target worker-runtime --tag "$RECEIPT_REPORT_WORKER_IMAGE" .
docker compose -f "$COMPOSE_FILE" config --quiet
docker compose -f "$COMPOSE_FILE" up --detach --wait --wait-timeout 180

base_url="http://127.0.0.1:${RECEIPT_REPORT_PORT:-3000}"
wait_for_services() {
  for _ in $(seq 1 90); do
    if curl --fail --silent "$base_url/api/v1/health" >/dev/null 2>&1 &&
      docker compose -f "$COMPOSE_FILE" exec --no-TTY worker \
        test -f /tmp/receipt-report-worker.ready; then
      return 0
    fi
    sleep 1
  done
  echo "API and worker did not become ready" >&2
  return 1
}
receipt_id="$(node scripts/compose-normalization-smoke.mjs "$base_url")"
docker compose -f "$COMPOSE_FILE" restart api worker
wait_for_services
node scripts/compose-normalization-smoke.mjs "$base_url" verify "$receipt_id"

archive="$(scripts/backup-compose.sh "$temporary")"
wait_for_services
curl --fail --silent --show-error -X POST -H 'content-type: application/json' \
  --data '{"merchantRaw":"Post-backup sentinel","purchaseDate":"2026-07-22","totalCents":99}' \
  "$base_url/api/v1/receipts" >/dev/null
scripts/restore-compose.sh "$archive"
node scripts/compose-normalization-smoke.mjs "$base_url" verify "$receipt_id"
receipt_count="$(curl --fail --silent "$base_url/api/v1/receipts" | node -e \
  'let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => { const body=JSON.parse(value); process.stdout.write(String(body.receipts.length)); });')"
test "$receipt_count" = "1"
