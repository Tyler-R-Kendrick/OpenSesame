# Contributing to OpenSesame

Thanks for helping. This page is the checklist; the reasoning behind each item
is in [docs/contributing](docs/contributing/README.md), and the rules that gate
a merge are in [`AGENTS.md`](AGENTS.md) — read §5 before your first change.

## Set up

Node 22+, pnpm 9 via Corepack, Rust 1.88 (pinned by `rust-toolchain.toml`).

```bash
corepack enable
pnpm install
pnpm setup:hooks      # git uses .githooks/: lint, quality, types, Clippy, gitleaks
```

[Getting started](docs/getting-started/README.md) covers running each plane;
the [repository tour](docs/getting-started/repository-tour.md) covers where
code goes.

**Cursor Cloud Agents** use the repo-managed environment in `.cursor/` (see
[`AGENTS.md`](AGENTS.md) — Cursor Cloud specific instructions).

## Before you push

```bash
sh .githooks/pre-push   # also runs automatically on git push
```

The default pre-push hook runs changed-file lint, generated-artifact freshness,
anti-slop, static quality gates and typechecking, plus Clippy when Rust or its
configuration changed. Tests qualify delivery to environments; trunk CI builds
the affected dependency graph. Run focused tests locally while developing as
needed. `OPENSESAME_PREPUSH=full git push` explicitly opts into `pnpm verify`,
including tests and the battle test (`OPENSESAME_PREPUSH=off|fast|full`).

Browser gates run against a fresh Pages build during delivery qualification.
To exercise a changed boot, sign-in, shell, control, keyboard or touch path
locally: `pnpm --filter @opensesame/pages verify:<keyboard|mobile|static|auth|local-iam>`.

## Your pull request

- **Commits carry a GitHub-verified signature** (`git commit -S` with a signing
  key registered on your GitHub account, or commits GitHub itself creates). The
  default-branch ruleset enforces this independently of build CI.
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
budgets, with affected build scope. Bundle budgets is a compatibility check name;
bundle measurement and browser tests run during delivery qualification.
See [CI and promotion](docs/operators/ci-promotion.md)
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
