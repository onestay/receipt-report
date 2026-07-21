# Testing strategy

High-confidence automated verification is a core requirement. Tests should make
agent-authored changes safe to review and should detect behavioral regressions,
not merely increase a coverage number.

## Test layers

### Unit tests

Use Vitest for deterministic domain behavior such as money calculations,
receipt reconciliation, categorization rules, validation, normalization, job
state transitions, and provider-response mapping. Prefer table-driven tests for
German receipt edge cases.

### Integration tests

Exercise meaningful boundaries together:

- Express routes through HTTP rather than direct handler calls
- Prisma against an isolated temporary SQLite database with real migrations
- Document ingestion against temporary filesystem storage
- Worker jobs against the database-backed queue
- AI adapters against deterministic fake transports and recorded synthetic
  responses, never paid providers in ordinary CI

Each test worker must use isolated database and storage paths. Tests may not
depend on execution order or persistent developer data.

### Browser tests

Use Playwright from the initial web scaffold. Browser tests run against a
production-like web/API stack with isolated test data. The suite begins with a
smoke test and grows with every user-facing vertical slice.

Core workflows should eventually cover:

- Uploading an image and a multi-page PDF
- Observing processing and validation states
- Reviewing and correcting extracted receipt data
- Approving a receipt
- Browsing, searching, and filtering receipts
- Viewing weekly and monthly reports

The document slice covers create-first upload recovery without duplicate
receipts, configured client-side validation, accessible busy/cancel states,
normalization polling and retry, ordered keyboard-navigable pages, and confirmed
replacement/removal. Playwright exercises real image/PDF normalization with the
API and worker; component tests deterministically cover failure states that
would otherwise require corrupting the queue.

Playwright should collect traces, screenshots, and videos on failure as CI
artifacts. Tests should prefer accessible roles and labels over implementation
selectors.

## Coverage policy

Vitest collects V8 coverage for unit and integration suites. The initial global
minimums are:

| Metric     | Minimum |
| ---------- | ------: |
| Lines      |     90% |
| Statements |     90% |
| Functions  |     90% |
| Branches   |     85% |

Thresholds apply to application and shared-package source code collectively and
must fail CI when unmet. Generated files, declarations, migrations, and trivial
tool configuration may be excluded explicitly. Domain, validation, API, worker,
and persistence code must not be excluded simply because it is difficult to
test.

Coverage must not decrease materially within changed code. If the chosen CI
coverage tooling cannot enforce changed-code coverage directly, reviewers must
use the generated report until an automated diff check is configured.

Percentages are a floor, not the goal. Critical receipt totals, correction
preservation, document validation, job idempotency, and migration behavior need
explicit boundary and failure-path tests even when global coverage already
passes.

## Pull-request checks

Every pull request must run:

1. Dependency installation from the committed lockfile
2. Formatting verification
3. Linting
4. Strict TypeScript checking
5. Unit and integration tests with coverage thresholds
6. Production builds
7. Playwright browser tests

CI publishes a browsable coverage report and Playwright failure artifacts. Test
commands must also be runnable locally through stable root-level package scripts.
Branch protection should require these checks once their workflow names exist.

Automated checks are followed by independent Claude code review on every
implementation pull request. Review findings must be resolved or explicitly
dispositioned before merge. Agent review complements, but cannot replace, the
required test and coverage checks.

## Fixtures and external systems

- Receipt fixtures must be synthetic or irreversibly anonymized.
- Small generated image and PDF fixtures may be committed when needed to verify
  parsing and page handling.
- Model behavior is represented by versioned synthetic responses.
- Real-provider and real-email tests are opt-in, excluded from ordinary CI, and
  must clearly state cost and privacy implications.

## Test quality rules

- Test observable behavior and invariants, not private implementation details.
- A bug fix includes a regression test that fails without the fix.
- Avoid broad snapshots for structured receipt data; assert meaningful fields
  and errors explicitly.
- Time, randomness, model responses, and filesystem locations must be controlled.
- Flaky tests are defects. Fix or revert the cause rather than adding blind
  retries or permanently skipping the test.
