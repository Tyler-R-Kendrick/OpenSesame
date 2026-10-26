# Contributing to OpenSesame

Thanks for helping. This page is the checklist; the reasoning behind each item
is in [docs/contributing](docs/contributing/README.md), and the rules that gate
a merge are in [`AGENTS.md`](AGENTS.md) — read §5 before your first change.

## Set up

Node 22+, pnpm 9 via Corepack, Rust 1.88 (pinned by `rust-toolchain.toml`).

```bash
corepack enable
pnpm install
pnpm setup:hooks      # git uses .githooks/: lint, Clippy, design lint, gitleaks
```

[Getting started](docs/getting-started/README.md) covers running each plane;
the [repository tour](docs/getting-started/repository-tour.md) covers where
code goes.

**Cursor Cloud Agents** use the repo-managed environment in `.cursor/` (see
[`AGENTS.md`](AGENTS.md) — Cursor Cloud specific instructions).

## Report bugs

File bugs in [GitHub Issues](https://github.com/Tyler-R-Kendrick/OpenSesame/issues).
Never file a public issue carrying exploit details, tokens or claim secrets —
vulnerabilities go through [SECURITY.md](SECURITY.md) private reporting instead.

## Standards and tests

- Coding standards are enforced by tooling, not convention: Biome (lint +
  format) and the anti-slop Oxlint preset on TypeScript, rustfmt and Clippy on
  Rust (the hooks run them; `pnpm lint`, `pnpm audit:clippy`).
- New functionality includes automated tests that fail without it, beside the
  existing suites for the plane it touches.
- Test commands: `pnpm test` (every TypeScript workspace), `pnpm
  test:integration`, and `cargo +1.88.0 test --workspace --all-targets` for
  Rust.

## Before you push

```bash
pnpm lint && pnpm quality && pnpm typecheck && pnpm test
cargo +1.88.0 test --workspace --all-targets     # when Rust changed
```

`pnpm verify` is the full local gate: lint, anti-slop, quality, Clippy, every
test suite and the battle test. The `pnpm audit:*` security gates are separate;
run the ones that match what you touched, and `pnpm verify`, before anything
security-sensitive lands. The pre-push hook runs the anti-slop lint and plugin
tests, typecheck and tests by default (`OPENSESAME_PREPUSH=off|fast|full`).

Browser gates run against a fresh Pages build and are required when you touch
what they cover — boot, sign-in, the shell, controls, keyboard handling, touch
layout: `pnpm --filter @opensesame/pages verify:<keyboard|mobile|static|auth|local-iam>`.

## Your pull request

- **Commits carry a GitHub-verified signature** (`git commit -S` with a signing
  key registered on your GitHub account, or commits GitHub itself creates). CI
  rejects any other commit and the default-branch ruleset will not merge it.
- **A user-visible change carries before/after evidence** from two real
  builds for PR review ([how](skills/visual-evidence/SKILL.md)). Keep comparisons,
  raw recordings and drafts in ignored `work/evidence/` or temp storage. Persist
  only approved current-state evidence under
  `docs/evidence/<feature>/<project>/<platform>/` (lowercase kebab-case), replacing
  the affected slot and deleting superseded files. Record source and approval
  provenance. Use commit-SHA links for history; do not carry historical media
  forward into `main`. See the [persistence contract](docs/evidence/README.md).
- **A consequential decision gets an ADR** in `docs/adr/`, then
  `pnpm docs:index`.
- **A new user-facing capability gets a `packages/capability-registry` entry**
  mapping it to every agent surface, or an ADR-cited exclusion.
- **Ratchets only tighten.** If `pnpm quality` says something improved, commit
  the updated baseline; never raise a recorded number.

Merges are squash-only, up to date with `main`, with review threads resolved.
There is no merge queue; use auto-merge after review.

## After merge

`main` integrates continuously; publication follows the scheduled candidate
pipeline. Nightly at **00:17 America/Chicago**, `dev-nightly.yml` builds/reuses an
immutable successful-main candidate and qualifies its source and packaged bytes.
Thursday at **04:17 America/Chicago**, `release-weekly.yml` qualifies one fixed
candidate through full prerelease, mutation and security gates, then promotes the
same Pages/native files. Main continues moving while a release runs.

Use the same controllers' manual dispatch on `main` for an urgent release; it
runs the same gates. An old publisher or direct version-tag push cannot publish
around them. The required PR check names remain TypeScript, Rust and Bundle
budgets, with affected fast scope. See [CI and promotion](docs/operators/ci-promotion.md)
for versions, receipts, failure recovery and environment configuration.

Publication is complete only after the stored Pages payload is deployed, its
source/HTML/runtime marker is verified over HTTPS, and the immutable native
release assets and qualification evidence are published. Check the served marker:

```bash
node scripts/release/pages-release.mjs verify https://tyler-r-kendrick.github.io/OpenSesame/ <candidate-source-sha>
```

## Ground rules

- `@opensesame/os-domain` imports no Better Auth, oidc-provider, Hono, Drizzle
  or React.
- Prefer a mature library to protocol code of our own
  ([ADR 0008](docs/adr/0008-better-auth-oidc-provider.md)).
- The Identity and Host APIs stay separate
  ([ADR 0017](docs/adr/0017-host-client-product-topology.md)).
- No agent-facing API returns a secret
  ([ADR 0005](docs/adr/0005-authority-handle-connectionref.md)).
- Never remove the guest road from sign-in or unlock (`AGENTS.md` §5).
- Configuration follows [`.env.schema`](.env.schema). Never commit a live
  secret; development keys and peppers are generated outside git.
- No `sudo`.

## AI-assisted contributions

This project is built with coding agents under human direction and review.
Disclose significant AI-generated content in the pull request. When an agent
makes a commit, name the tool and model in the commit message or in the pull
request provenance.

Keep changes within the [repository footprint policy](docs/contributing/repository-footprint.md). Run `node scripts/quality/repository-size-gate.mjs`; do not commit raw reviews, scanner run histories, caches or reproducible task output.
