# Agent instructions

These instructions apply to the entire repository.

## Before changing code

1. Read the issue and the relevant documents under `docs/`.
2. Confirm the issue has a bounded goal, acceptance criteria, and explicit
   non-goals. Do not silently expand its scope.
3. Inspect the current implementation and working tree before editing.

## Engineering rules

- Keep the system API-first. The web client and future clients consume the same
  versioned REST API.
- Prefer explicit, conventional code over framework magic or novel abstractions.
- Use strict TypeScript. Do not introduce `any` without a documented reason.
- Validate every external boundary, including model output, with Zod.
- Keep provider-specific AI behavior behind the receipt-model interface.
- Treat model output as untrusted input; validate it before persistence.
- Do not expose Prisma models as public API contracts.
- Database and public API changes require migrations or contract updates and
  corresponding tests.
- Keep receipt calculations deterministic and independent of the AI provider.
- Do not add a dependency unless the standard library or an existing dependency
  cannot reasonably solve the problem. Explain meaningful additions in the PR.
- Never commit secrets, receipt images, databases, or real email content.

## Verification

- Add or update tests for behavior changes.
- Run the repository's formatting, linting, type-checking, test, and build
  commands before finishing. If a command cannot be run, state why.
- Keep anonymized fixtures minimal and clearly synthetic.

## Documentation and decisions

- Update documentation when behavior, architecture, or contracts change.
- Record foundational or difficult-to-reverse choices as a short ADR under
  `docs/decisions/`.
- Do not reverse an accepted ADR incidentally within an unrelated issue.

## Git workflow

- Work on one issue per branch and pull request.
- Use focused commits and do not alter unrelated user changes.
- PR descriptions must link the issue, summarize the result, and list the
  verification performed.
- Agents must not merge their own pull requests unless explicitly instructed.
