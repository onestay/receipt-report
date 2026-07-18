# Agent workflow

Coding agents collaborate through issues, branches, pull requests, automated
checks, and independent cross-review. No single agent's output is accepted only
because it appears plausible.

## Issue preparation

1. Create one bounded issue using the appropriate template.
2. Specify the goal, scope, non-goals, acceptance criteria, dependencies, and
   verification plan.
3. Ask `@claude` to review the specification for ambiguity, missing failure
   cases, architectural conflicts, security or privacy concerns, and inadequate
   verification.
4. Incorporate the findings or record a concrete reason for declining them in
   the issue discussion.
5. Add `agent-ready` only after this review is complete and no material product
   decision remains unresolved.

Claude specification review is required for both human-authored and
agent-authored implementation issues. Small discussion notes and administrative
tracking items do not need `agent-ready` and are outside this gate.

## Implementation

1. An implementation agent takes one `agent-ready` issue.
2. It works on a dedicated branch and follows `AGENTS.md`.
3. It adds tests at the appropriate unit, integration, and browser levels.
4. It opens a pull request linked to the issue and reports exact verification.

The implementing agent must not reinterpret unresolved review findings or expand
the issue without returning the decision to the issue discussion.

## Pull-request review

1. Required formatting, linting, type, coverage, build, and Playwright checks
   must pass.
2. Request independent Claude code review with `@claude`.
3. The implementation agent addresses each finding or explains concretely why it
   should not result in a change.
4. Material scope or architecture concerns return to the issue rather than being
   decided silently in review.
5. A human performs the final review and merge unless explicitly choosing a
   different policy later.

Claude review is an additional signal. It does not waive tests, coverage,
acceptance criteria, or human oversight. Conversely, implementation agents
should evaluate findings against repository evidence rather than accepting them
blindly.
