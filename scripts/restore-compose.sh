#!/bin/bash
set -euo pipefail

archive="${1:?Usage: scripts/restore-compose.sh BACKUP_ARCHIVE}"
compose_file="${COMPOSE_FILE:-compose.production.yaml}"
volume="${RECEIPT_REPORT_DATA_VOLUME:-receipt-report-data}"
archive="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")"
test -f "$archive.sha256" && (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256")

docker compose -f "$compose_file" down
docker volume create "$volume" >/dev/null
docker run --rm -v "$volume:/data" -v "$(dirname "$archive"):/backup:ro" alpine:3.22 \
  sh -eu -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -C /data -xzf "/backup/$1"' sh "$(basename "$archive")"
docker compose -f "$compose_file" up --detach --wait
