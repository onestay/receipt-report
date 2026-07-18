# Receipt Report

A personal, self-hosted application for turning German grocery receipts into a
searchable spending history. Receipt images and PDFs are processed by a
configurable multimodal AI provider, reviewed by the user, and summarized in
weekly and monthly reports.

This repository is currently in the planning and foundation phase. See
[`docs/product.md`](docs/product.md) for scope and [`docs/roadmap.md`](docs/roadmap.md)
for the intended delivery order.

## Intended stack

- TypeScript in a pnpm workspace
- React and Vite for the web client
- Express for the REST API
- Prisma with SQLite
- Zod for runtime validation and shared contracts
- A separate worker process for asynchronous receipt processing
- Local filesystem storage for receipt images and PDFs
- Vitest for unit and integration tests with enforced coverage thresholds
- Playwright for browser tests from the first user-facing workflow

The stack is recorded in [`docs/architecture.md`](docs/architecture.md). Changes
to foundational decisions should be captured in `docs/decisions/`.

Testing expectations are defined in [`docs/testing.md`](docs/testing.md).

## Development status

No application has been scaffolded yet. Work should be driven by small issues
with explicit acceptance criteria. Issues carrying the `agent-ready` label are
expected to be implementable without additional product decisions and to have
completed an independent Claude specification review. Implementation pull
requests receive Claude code review before merge so agents can cross-check one
another.

The complete handoff and cross-review process is documented in
[`docs/agent-workflow.md`](docs/agent-workflow.md).

## Data and privacy

This is a private, single-user application. Receipt documents and extracted data
may contain sensitive information. Secrets, receipt documents, databases, and
real email content must never be committed to Git.
