# Operational logging

The API and worker write one JSON object per line. Docker or the host runtime is
responsible for rotation, retention, shipping, and access control. Treat logs as
sensitive operational data even though receipt content is excluded by default.

Use `LOG_LEVEL` to choose the minimum level and `LOG_SLOW_OPERATION_MS` for slow
operation warnings. `LOG_SENSITIVE_PROVIDER_ERRORS=false` is the safe default.
When explicitly enabled it can write up to 16 KiB of a non-2xx textual provider
body under a clearly named sensitive field; that text may contain provider or
receipt data. Successful output, prompts, images, credentials, and
validation-failing 2xx payloads are never logged by this option.

Request events return and carry `X-Request-ID`. Valid inbound IDs use
`^[A-Za-z0-9._-]{1,64}$`; all others are replaced. Worker events use opaque
`job_id`, `attempt_id`, `document_id`, revision, and attempt-number fields.

Useful queries:

```sh
docker compose logs api worker --no-log-prefix | jq -c 'select(.level == "error")'
docker compose logs api --no-log-prefix | jq -c 'select(.request_id == "REQUEST_ID")'
docker compose logs worker --no-log-prefix | jq -c 'select(.job_id == "JOB_ID")'
```

Investigation sequence:

1. Find `api.request.completed` and follow its `request_id`; validation failures
   contain only issue paths/codes/counts.
2. Follow the document/job/attempt IDs through claim, provider, publish, retry,
   lease-recovery, and terminal events.
3. For provider failures inspect `failure_stage`, safe origin, HTTP status,
   Retry-After, response byte count, and the unchanged `failure_kind`.
4. Database/storage events expose named operations and safe error codes without
   SQL parameters or paths. Raw response content should normally be inspected
   through protected retained attempt data, not routine logs.

Successful health/operator polling is debug-level, idle worker polling is
silent, and recovery/purge summaries emit only for non-zero work.
