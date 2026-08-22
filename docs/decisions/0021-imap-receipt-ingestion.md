# ADR 0021: Dedicated IMAP receipt ingestion

## Status

Accepted

## Decision

Use ImapFlow in the worker to read one configured mailbox over certificate-
verified TLS. Fetch BODYSTRUCTURE first and stream only explicit attachment
parts. Do not request envelopes, headers, or message bodies. MIME metadata is
untrusted; accepted files pass the existing byte-based JPEG, PNG, or PDF
validator and storage limits.

Persist a resumable cursor per opaque account/mailbox identity and UIDVALIDITY
epoch. Message discovery and part outcomes are separate. Attachment work is
claimed before download with an expiring token. Store-wide SHA-256 plus byte
size provides deduplication across messages and UIDVALIDITY epochs. Receipt,
document, normalization job, and successful import outcome commit together
after file promotion; existing durable cleanup handles database failure.

This builds on ADR 0003 and ADR 0008's untrusted-input boundaries and ADR
0012's durable claim/retry model. It preserves ADR 0002's single-instance
deployment assumption; leases cover overlapping iterations and crash recovery,
not multi-host coordination.

## Consequences

Credentials remain worker-only and startup validation is strict when enabled.
Transient IMAP failure does not stop normalization or extraction. Operator
status exposes only enablement, last successful poll time, and aggregate counts.
Mailbox flags and content remain untouched.
