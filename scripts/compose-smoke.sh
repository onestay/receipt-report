#!/bin/bash
set -euo pipefail

project_name="receipt-report-smoke-${CI_RUN_ID:-local}-$$"

cleanup() {
  docker compose --project-name "$project_name" down --volumes --remove-orphans --timeout 15
}
trap cleanup EXIT

docker compose --project-name "$project_name" config --quiet
docker compose --project-name "$project_name" up --detach --build --wait --wait-timeout 180
curl --fail --silent --show-error "http://127.0.0.1:${RECEIPT_REPORT_PORT:-3000}/api/v1/health"
docker compose --project-name "$project_name" exec --no-TTY api node --input-type=module -e \
  "import('@receipt-report/database').then(async ({createDatabase,checkDatabase})=>{const db=await createDatabase(process.env.DATABASE_URL);if(!await checkDatabase(db))process.exitCode=1;await db.\$disconnect()})"
