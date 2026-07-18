# ADR 0005: Independent agent cross-review

- Status: Accepted
- Date: 2026-07-18

## Context

The project is developed primarily by coding agents. A single agent can produce
internally consistent specifications and implementations while overlooking the
same assumption throughout. Claude issue and code review are available in the
GitHub repository.

## Decision

Require Claude specification review before an implementation issue receives the
`agent-ready` label. Require Claude code review on every implementation pull
request before merge. Findings must be incorporated or explicitly dispositioned
in the relevant issue or pull request.

Automated tests and a final human review remain required; cross-review does not
replace either. Administrative issues that are never marked `agent-ready` are
outside the specification-review gate.

## Consequences

Issue preparation and pull-request review take an additional step, but agents
receive an independent check for ambiguity, omissions, and implementation
mistakes. The workflow depends on the Claude integration being available; when
it is unavailable, the issue or pull request remains blocked unless the human
owner explicitly waives the gate.
