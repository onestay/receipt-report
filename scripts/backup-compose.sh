#!/bin/bash
set -euo pipefail

compose_file="${COMPOSE_FILE:-compose.production.yaml}"
volume="${RECEIPT_REPORT_DATA_VOLUME:-receipt-report-data}"
destination="${1:?Usage: scripts/backup-compose.sh BACKUP_DIRECTORY}"
mkdir -p "$destination"
destination="$(cd "$destination" && pwd)"
archive="receipt-report-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"

for service in api worker; do
  container="$(docker compose -f "$compose_file" ps --status running -q "$service")"
  if [[ -z "$container" ]]; then
    echo "Refusing backup: $service is not running" >&2
    exit 1
  fi
done
docker compose -f "$compose_file" stop api worker
restart_writers() { docker compose -f "$compose_file" start api worker >/dev/null; }
trap restart_writers EXIT
docker run --rm -v "$volume:/data:ro" -v "$destination:/backup" alpine:3.22 \
  tar -C /data -czf "/backup/$archive" .
sha256sum "$destination/$archive" > "$destination/$archive.sha256"
trap - EXIT
restart_writers
printf '%s\n' "$destination/$archive"
