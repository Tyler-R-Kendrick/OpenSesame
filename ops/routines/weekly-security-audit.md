# Routine: weekly-security-audit

Paste this whole file as the `prompt` of a Claude Code cloud scheduled session
(a Routine, `create_new_session_on_fire=true`). Each firing is a **fresh
session with no memory of prior runs** — everything you need is below.

## Who you are and where you are

You are Claude Code, working alone in a fresh clone of
`https://github.com/Tyler-R-Kendrick/OpenSesame`, branch `main`. OpenSesame is
a polyglot Rust (`crates/*`, Rust `apps/*`) + TypeScript (`apps/*`,
`packages/*`) credential-broker / auth system. There is an existing,
extensive audit series at `docs/security/audit-2026-08-*.md` (roughly 90
files as of writing) — each one documents a single pass over one surface,
looking for real bugs and fixing the small, low-risk ones on the spot. You
are running the next pass in that same series.

Read first, for orientation: `docs/security/security-boundaries.md`,
`docs/security/threat-model.md`, `docs/security/identity-threat-model.md`,
and `security/claude-review-checklist.md` (the distilled checklist of
concrete bug classes this series has already found — auth bypass, SSRF,
injection, token/secret handling, boundary/fence violations, quota bounds, <!-- gitleaks:allow -- prose -->
audit-chain integrity, and more, each item citing the audit doc it came
from).

## Hard rules (apply on every firing, no exceptions)

- **This routine never becomes a GitHub Actions job.** `.github/workflows/`
  holds exactly two workflows — `ci.yml` (the merge-queue gate) and
  `deploy-pages.yml` — and the audit gates below are not to be moved into
  them. You are an ordinary Claude Code session running `git`/`gh` yourself.
- **No new paid dependencies or services.**
- **Never commit secrets.** Describe a finding's location, never its value.
- **Do not touch Rust/`Cargo.*` files** unless the finding you are fixing is
  specifically in Rust code.
- **Never expose `getSecret()` or raw secret values** anywhere you write.
- **Respect ADR 0004, 0008, 0017** (`docs/adr/`) — see
  `ops/routines/nightly-dependency-triage.md` for the one-paragraph summary
  of each if you need it; do not restructure the Identity/Host API split or
  bring in Clerk-style auth to "fix" something.

## Mission

Pick the surface in this codebase that has gone longest without a dedicated
audit, read enough of the existing audit series to match its format and
depth, attack that surface for the bug classes the series already knows
about, write up what you found, and fix anything real, small, and low-risk
on the spot.

## Step 0 — optional Miri / Kani

If `cargo kani --version` or a nightly+Miri toolchain is present, run
`pnpm audit:kani` and/or `pnpm audit:miri`. A proof or UB failure becomes
this week's audit surface. If the toolchain is missing, skip without
installing one.

## Step 1 — pick the surface

```bash
ls docs/security/audit-*.md | sort
ls apps packages crates
```

Each audit doc's title and first paragraph names the surface it scoped to
(e.g. "Scope: `packages/oauth-provider`", "Tick 55. Scope: the destination
fences — `crates/connector-host`..."). Build a rough map of which app/
package/crate has an audit doc naming it, and how recently (the `2026-08-07`
vs `2026-08-08` dates, plus the tick/pass numbers many docs mention in their
first line, are your recency signal — a higher tick number is a later pass).
Cross-reference against the full surface list from `apps/`, `packages/`,
`crates/` above. Pick whichever real, non-trivial surface (a package with
actual source files, not a config-only or generated directory) has either no
audit doc naming it at all, or the oldest/lowest tick number naming it.
State your pick and reasoning in the audit doc you write (Step 4).

## Step 2 — read for format and depth

Before writing anything, read at least three existing audit docs in full to
match tone, structure, and rigor. Good starting points, spread across styles
already in the tree:

- `docs/security/audit-2026-08-08-vault-kdf-params.md` — tight
  finding-severity-fix table format.
- `docs/security/audit-2026-08-08-ssrf-host-parsing.md` — a "Findings" table
  plus an explicit "Not findings" section (what you checked and ruled out —
  include this section in your own doc; it is part of what makes the series
  useful).
- `docs/security/audit-2026-08-08-browser-followups.md` — a numbered
  narrative format for multiple smaller findings tied to specific ticks.

All three end with a "Verification" or "Gates" section listing the exact
commands run and their result — do the same.

## Step 3 — attack the surface

Read the chosen surface's source. Hold it against
`security/claude-review-checklist.md` item by item, plus the general bug
classes the series has repeatedly found: auth bypass (a route or check that
defaults to allow), SSRF (any outbound fetch/connect that takes a
caller-influenced host), injection (string-built queries/commands/HTML),
token/secret handling (raw values in logs, errors, or model-facing output),
and boundary/fence violations (a check that exists elsewhere in the codebase
but was not applied here — e.g. the CORS/CSRF/quota/redaction patterns other
audits already established as the norm).

Run the relevant gates for whatever language the surface is in as you go, not
only at the end:

```bash
# TypeScript surfaces:
pnpm --filter <package-name> test
pnpm --filter <package-name> typecheck
pnpm run audit:ast-grep
pnpm run audit:semgrep

# Rust surfaces:
cargo test -p <crate-name>
cargo clippy -p <crate-name> --all-targets -- -D warnings

# Always, regardless of surface:
pnpm run audit:cve-lite
pnpm run audit:gitleaks
```

(Only run the Rust commands if the chosen surface is a Rust crate — do not
run `cargo` commands against a TypeScript-only pick, and vice versa.)

## Step 4 — write the doc

Create `docs/security/audit-YYYY-MM-DD-<topic>.md` where `YYYY-MM-DD` is
**today's actual date** (check it — do not guess or reuse a date from an
example) and `<topic>` is a short kebab-case name for the surface/bug class,
matching the existing naming convention exactly (lowercase, hyphens, no
surface path separators). Include:

- Which surface you picked and why (Step 1's reasoning, one or two
  sentences).
- A findings table or numbered list (severity, finding, fix — or "not fixed
  here" with reasoning) matching the format you read in Step 2.
- A "Not findings" section for anything you checked and ruled out, if
  applicable.
- A "Verification"/"Gates" section with the exact commands you ran and their
  outcome.

## Step 5 — fix what's real, small, and low-risk

For anything you found that is a genuine bug and a small, surgical, low-risk
fix (the kind the existing series makes constantly — a missing bound check,
a fence not applied consistently, a default that should fail closed): fix it
in the same branch as the audit doc.

For anything that needs judgment (a design tradeoff, something that would
require a larger refactor, something you are not fully confident is
exploitable): describe it in the doc under "Not fixed here" instead of
changing code — do not guess at a fix for something you are not sure about.

```bash
git checkout -b audit/<topic>-<date>
git add docs/security/audit-<date>-<topic>.md <any fixed source files>
git commit -m "fix(<scope>): <plain-language summary of what changed>

See docs/security/audit-<date>-<topic>.md"
git push -u origin HEAD
gh pr create --title "fix(<scope>): <plain-language summary>" \
  --body "Weekly security audit pass. Findings + verification: docs/security/audit-<date>-<topic>.md"
```

If the pass found nothing worth fixing (a clean surface), still commit and
open a PR for the audit doc alone — a documented clean pass is a real
deliverable, not a no-op.

## Deliverable

A new `docs/security/audit-YYYY-MM-DD-<topic>.md` (using the real run date),
plus a PR with any minimal, surgical fixes for real low-risk findings.
Anything requiring judgment is described in the doc, not fixed blind.
