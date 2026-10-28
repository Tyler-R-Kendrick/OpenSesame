# ADR 0214 — Trunk integration and scheduled artifact promotion

- **Status:** Accepted; normal verified merge and hosted qualification still apply
- **Date:** 2026-10-25
- **Builds on:** [ADR 0176](0176-ci-runs-what-a-diff-can-reach.md),
  [ADR 0212](0212-release-kit-binaries.md)
- **Amends:** ADR 0212's tag-triggered build/publication and producer identity;
  kit layout, production/test separation and bridge trust rules remain.
- **Implementation:** `.github/workflows/ci.yml`, `dev-nightly.yml`,
  `release-weekly.yml`, their reusables and `scripts/release/`.
  [Operating contract](../operators/ci-promotion.md).

## Context

Incremental stacked PRs repeatedly ran broad browser, native and auxiliary
matrices. Main pushes independently rebuilt/deployed Pages, while version tags
could start another native/container build. Review granularity, integration
confidence and publication cadence were coupled. Permanent environment branches
would defer integration and introduce more source identities to coordinate.

## Decision

Keep `main` as integration. Preserve affected required checks and their existing
names, signatures and selected browser trust regressions. Resolve main scope
cumulatively from a successful ancestor so coalesced runs cannot hide changes.

Build a complete immutable Pages/Linux-kit candidate nightly from successful
push-main CI; reuse complete compatible artifacts. Qualify the exact package in
dev, then select one candidate for the weekly prerelease, mutation/security and
publication graph. Bind receipts to source, producer run/attempt, artifact ID,
artifact digest and manifest digest. Source/test/mutant builds remain separate
from the production bytes that ship.

Use dependency gates and strict evidence verification. Original build and later
promotion attestations describe separate events. Publishing never recompiles
or restamps the approved application files. Preserve full browser/native/profile
coverage in prerelease and existing mutation/coverage floors. Scanner errors,
missing reports, unexpected skips and degraded fuzz runs fail qualification.
Retire old publishers; OCI/npm need candidate-bound integration before resuming.

## Consequences

PRs can merge without awaiting the weekly release; release failure stops
publication. Pages and native release publication share identity but are not an
atomic external transaction. Recovery requalifies the same candidate in a fresh
attempt and resumes its unpublished draft while the original dev evidence is
fresh. The first successful weekly selection is retained across attempts; a retry
cannot switch to a newer nightly candidate. A configured release approval occurs
after the draft and notes exist and before either production publication.
Published product bytes stay immutable.

The pipeline requires evidence retention, policy compatibility and version
collision handling. Set the prospective workspace version before building.
Environment/tag rules must admit the main-based publisher without bypassing
protections. Four qualification states do not imply four physical PWA origins;
a different baked profile needs a different artifact and its own qualification.

Local tests exercise malformed identities/archives, bad digests, missing/failed
evidence, stale attempts/policy, suite substitution and interrupted publication.
Hosted execution remains necessary to establish actual platform qualification
and live deployment; the implementation PR records that distinction.
