#!/bin/bash
set -euo pipefail

source_volume="receipt-report-drill-source-$$"
target_volume="receipt-report-drill-target-$$"
temporary="$(mktemp -d)"
cleanup() {
  docker volume rm "$source_volume" "$target_volume" >/dev/null 2>&1 || true
  rm -rf "$temporary"
}
trap cleanup EXIT
docker volume create "$source_volume" >/dev/null
docker run --rm -v "$source_volume:/data" alpine:3.22 sh -c \
  'mkdir -p /data/documents/original /data/documents/pages; printf database-state > /data/receipt-report.db; printf wal-state > /data/receipt-report.db-wal; printf proposal-correction-report > /data/audit-fixture; printf source > /data/documents/original/source.pdf; printf page > /data/documents/pages/page.png'
docker run --rm -v "$source_volume:/data:ro" -v "$temporary:/backup" alpine:3.22 tar -C /data -czf /backup/drill.tar.gz .
docker volume create "$target_volume" >/dev/null
docker run --rm -v "$target_volume:/data" -v "$temporary:/backup:ro" alpine:3.22 tar -C /data -xzf /backup/drill.tar.gz
source_hash="$(docker run --rm -v "$source_volume:/data:ro" alpine:3.22 find /data -type f -exec sha256sum {} \; | sed 's#/data/##' | sort)"
target_hash="$(docker run --rm -v "$target_volume:/data:ro" alpine:3.22 find /data -type f -exec sha256sum {} \; | sed 's#/data/##' | sort)"
test "$source_hash" = "$target_hash"
printf 'Backup/restore drill recovered database, WAL, documents, and audit fixtures.\n'
