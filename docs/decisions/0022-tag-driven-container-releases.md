# ADR 0022: Tag-driven container releases

- Status: Accepted
- Date: 2026-08-22

## Decision

A release is marked by pushing an annotated `vMAJOR.MINOR.PATCH` tag to a commit
that is already on `main`. The `Release` workflow re-runs the full `Verify`
workflow for that commit, then builds the `api-runtime` and `worker-runtime`
targets of the repository `Dockerfile` from that one source tree and pushes them
to GitHub Container Registry as `ghcr.io/<owner>/receipt-report-api` and
`ghcr.io/<owner>/receipt-report-worker`.

Both images carry the version tag, the `MAJOR.MINOR` tag, and the full commit
SHA tag. No `latest` tag is published, and the workflow refuses tags that are
not annotated, not semantic versions, or that point outside `main`. Signed build provenance is
attested for both digests, and the generated GitHub release records the two
image digests as the recommended `.env.production` pins.

Images are built for `linux/amd64` only. Prerelease tags (`v1.2.0-rc.1`)
publish images and a GitHub prerelease, but no `MAJOR.MINOR` tag.

## Consequences

Operators pin immutable digests produced by one verified commit instead of
building locally, which keeps the ADR 0016 requirement that API and worker move
together mechanically enforced rather than procedural. Publication is only as
trustworthy as `main`: a tag on an unreviewed commit cannot be released, and a
tag never mutates an existing image, so a mistaken release is superseded by a
new version rather than overwritten.

Because no `latest` tag exists, every deployment names an exact version, and
upgrades stay a deliberate operator action with the ADR 0016 backup and rollback
procedure. A host on another architecture must still build images itself.
