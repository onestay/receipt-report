#!/bin/bash
set -euo pipefail

project_name="receipt-report-smoke-${CI_RUN_ID:-local}-$$"

cleanup() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    docker compose --project-name "$project_name" ps --all || true
    docker compose --project-name "$project_name" logs --no-color || true
  fi
  docker compose --project-name "$project_name" down --volumes --remove-orphans --timeout 15
  exit "$status"
}
trap cleanup EXIT

docker compose --project-name "$project_name" config --quiet
docker compose --project-name "$project_name" up --detach --build --wait --wait-timeout 180
curl --fail --silent --show-error "http://127.0.0.1:${RECEIPT_REPORT_PORT:-3000}/api/v1/health"
docker compose --project-name "$project_name" exec --no-TTY api sh -c \
  "cd /app/apps/api && node --input-type=module -e \"import('@receipt-report/database').then(async ({createDatabase,checkDatabase})=>{const db=await createDatabase(process.env.DATABASE_URL);if(!await checkDatabase(db))process.exitCode=1;await db['\\x24disconnect']()})\""
docker compose --project-name "$project_name" exec --no-TTY worker sh -c \
  "command -v pdfinfo && command -v pdftoppm && command -v prlimit && pdftoppm -v"
docker compose --project-name "$project_name" exec --no-TTY api sh -c \
  "cd /app/apps/api && if node --input-type=module -e \"import('sharp')\" 2>/dev/null; then exit 1; fi"
node scripts/compose-normalization-smoke.mjs \
  "http://127.0.0.1:${RECEIPT_REPORT_PORT:-3000}"
