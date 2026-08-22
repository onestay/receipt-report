# ADR 0020: Accept cross-reference-stream and empty-password PDFs

## Status

Accepted. Supersedes the encrypted-PDF rejection in ADR 0008 and the
compressed-stream compatibility limit recorded in the architecture overview.

## Context

The upload validator recognized only the plain-text PDF skeleton: it counted
`/Type /Page` occurrences, required the `xref` keyword, and rejected any file
containing `/Encrypt`. The worker separately rejected every PDF that `pdfinfo`
reported as encrypted.

Those rules exclude ordinary retail receipts. German grocery eBons are typically
PDF 1.6 files that store the catalog and page objects in a compressed object
stream, address them through a cross-reference stream rather than an `xref`
table, and apply the standard security handler with an empty user password and a
restrictive `/P` permission mask. Such a file opens in every reader without a
prompt, renders under `pdftoppm`, and is not malformed in any sense the upload
boundary can act on. A validator that reads only uncompressed bytes cannot see
page objects that were legitimately compressed, so absence of visible pages is
not evidence of an invalid document.

The competing concern is unchanged: the API process must not decompress,
decrypt, or execute untrusted document content, and both page count and decoded
pixels must stay bounded before rendering.

## Decision

The upload boundary validates the trailer skeleton that remains visible without
decompressing or decrypting anything: a `/Root` catalog reference, a classic
cross-reference table or a `/Type /XRef` stream, `startxref`, and `%%EOF`.
Visible `/Type /Page` objects are still capped by the configured page limit, but
their absence is accepted, and `/Encrypt` no longer rejects a file. The API adds
no PDF parser, decompressor, or cryptography.

The worker is authoritative for both properties the API can no longer establish.
Poppler decrypts standard-security PDFs that carry an empty user password, so a
successful `pdfinfo` invocation is the evidence that a file is readable, and its
reported page count is the enforced one. A file that genuinely requires a
password makes `pdfinfo` exit non-zero with `Incorrect password` on stderr,
which maps to the existing stable `encrypted_pdf` status. Command stderr is
retained on the internal renderer failure only for this classification and is
never persisted or exposed.

Permission masks such as `copy:no` are not enforced. They restrict a viewer's
handling of a document its owner already possesses, and rasterizing an uploaded
receipt for the owner's own extraction is outside what those flags govern.

## Consequences

- Receipts from mainstream retailers are ingestible without re-exporting them.
- Poppler, not the API, is exposed to encrypted content. It runs as a separate
  process under `prlimit` address-space and CPU limits, a wall timeout, an
  output-size ceiling, and no network, so the trust boundary is unchanged.
- Structurally valid PDFs with no pages, or with more pages than the limit
  allows, may now be accepted at upload and fail later in normalization. Upload
  cost stays bounded by the byte-size limit, and render cost by the worker's
  page and pixel limits.
- Password-protected uploads are reported after normalization rather than
  refused at upload time.
