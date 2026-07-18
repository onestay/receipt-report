# ADR 0004: Tests and coverage are foundation infrastructure

- Status: Accepted
- Date: 2026-07-18

## Context

Most implementation work will be performed by coding agents. Strong automated
feedback and reproducible behavior are necessary to prevent plausible-looking
changes from accumulating regressions. Browser testing added late tends to expose
architectural and accessibility problems only after workflows are established.

## Decision

Adopt Vitest for unit and integration tests and Playwright for browser tests from
the initial workspace scaffold. Enforce global coverage minimums of 90% for
lines, statements, and functions and 85% for branches. Run tests, coverage,
builds, static checks, and Playwright on every pull request.

Integration tests use real temporary SQLite databases, migrations, HTTP
requests, and filesystem storage. Ordinary CI replaces paid or external systems
with deterministic fakes. CI retains human-readable coverage and browser failure
artifacts.

## Consequences

Foundation work is larger and feature issues must budget for tests at multiple
levels. In return, refactoring and agent-authored changes receive fast,
repeatable feedback. Coverage thresholds require care to avoid low-value tests;
critical invariants still need explicit scenario and failure-path coverage.
