# ADR 0008: Isolate deterministic document normalization in the worker

## Status

Accepted

## Context

Receipt originals are untrusted JPEG, PNG, or PDF files. Review and later AI
processing need one deterministic PNG profile and ordered PDF pages without
giving the API process native document-decoding responsibilities. PDF rendering
must be bounded against malformed, encrypted, oversized, decompression-bomb,
timeout, and renderer-crash cases.

Sharp is maintained, deterministic for the selected raster operations, and
provides explicit input-pixel limits, orientation handling, color conversion,
resizing, metadata removal, and PNG output. PDF.js is primarily a JavaScript
library and would keep parsing and substantial memory allocation inside the
long-lived Node worker. Poppler provides mature command-line PDF inspection and
one-page-at-a-time rasterization, so the operating system can enforce a process
boundary around each invocation.

## Decision

Profile `receipt-page-v1` uses Sharp/libvips to apply EXIF orientation, convert
to sRGB, fit within 2048 by 2048 pixels without enlargement, strip metadata, and
write non-interlaced PNG with compression level 9 and adaptive filtering off.
The profile version, SHA-256 digest, dimensions, byte size, and exact Sharp,
libvips, and (for PDFs) Poppler versions are persisted.

PDFs are inspected with `pdfinfo` and rendered one page at a time with
`pdftoppm`. Each subprocess runs through `prlimit` with CPU and address-space
limits plus a Node wall timeout, hard-kill signal, and pixel-derived output-buffer
ceiling. One deadline covers the complete PDF rather than restarting for every
page. Page count, per-page decoded pixels, and cumulative decoded pixels are
independently bounded, and encrypted PDFs are rejected before rendering. No
script engine or external resource loader is invoked, and the Compose worker has
networking disabled.

Sharp and the Poppler/util-linux packages exist only in the worker build and
runtime stages. The API and migration stages contain neither Sharp nor Poppler,
and the API and worker run as the unprivileged `node` user. The one-shot
migration service uses root only to initialize and hand off the named data
volume before either long-lived process starts.
The Debian base tag, pnpm lockfile, runtime renderer identity, and versioned
profile jointly make output provenance explicit; security-patched Debian package
revisions may advance on image rebuild without silently masquerading as the same
renderer.

Page files are staged and promoted under revisioned paths. A conditional
database claim with a unique generation token permits one publisher, and one
transaction replaces the full ordered page row set and marks the job complete.
Only expired claims are reclaimed. Durable cleanup intents cover crashes around
file promotion and are drained when either API or worker starts. Failure leaves
the retained original and any last complete page set unchanged.

## Consequences

- Worker images are larger and depend on Debian's Poppler packaging.
- PDF rendering failures are deliberately exposed only as stable sanitized
  status codes.
- The API remains a structural-validation and byte-serving boundary.
- Future normalization changes require a new profile version and intentional
  reprocessing rather than silently changing existing page provenance.
