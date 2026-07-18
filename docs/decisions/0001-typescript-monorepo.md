# ADR 0001: TypeScript monorepo

- Status: Accepted
- Date: 2026-07-18

## Context

The application will be developed primarily by coding agents. Familiar,
explicit technology and fast automated feedback are more valuable than minimizing
the number of project directories.

## Decision

Use a pnpm TypeScript workspace with React/Vite for the web client, Express for
the API, and a separate worker package or application. Share runtime contracts
through Zod rather than duplicating frontend and backend types.

## Consequences

Frontend and backend boundaries remain visible while using one language. The
repository must maintain workspace tooling and ensure shared packages do not
create accidental coupling.
