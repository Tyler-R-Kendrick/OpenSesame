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

## Before you push

```bash
pnpm lint && pnpm quality && pnpm typecheck && pnpm test
cargo +1.88.0 test --workspace --all-targets     # when Rust changed
```

`pnpm verify` runs everything, including the security audits and the battle
test; run it before anything security-sensitive lands. The pre-push hook runs
typecheck and tests by default (`OPENSESAME_PREPUSH=off|fast|full`).

Browser gates run against a fresh Pages build and are required when you touch
what they cover — boot, sign-in, the shell, controls, keyboard handling, touch
layout: `pnpm --filter @opensesame/pages verify:<keyboard|mobile|static|auth|local-iam>`.

## Your pull request

- **Commits are signed** (`git commit -S`). CI rejects unsigned commits and the
  default-branch ruleset will not merge them.
- **A user-visible change carries before/after evidence** from two real
  builds, committed under `docs/evidence/<yyyy-mm-dd>-<topic>/` and linked
  from the PR ([how](skills/visual-evidence/SKILL.md)).
- **A consequential decision gets an ADR** in `docs/adr/`, then
  `pnpm docs:index`.
- **A new user-facing capability gets a `packages/capability-registry` entry**
  mapping it to every agent surface, or an ADR-cited exclusion.
- **Ratchets only tighten.** If `pnpm quality` says something improved, commit
  the updated baseline; never raise a recorded number.

Merges are squash-only, up to date with `main`, with review threads resolved.
There is no merge queue; use auto-merge after review.

## After merge

`main` deploys `apps/pages` to GitHub Pages. Publication is complete only when
the Deploy Pages workflow's live check passes: it stamps `release.json` with
the source SHA and hashes of the HTML and runtime configuration, then verifies
those bytes over HTTPS. Check a release by hand with:

```bash
node scripts/pages-release.mjs verify https://tyler-r-kendrick.github.io/OpenSesame/ <full-sha>
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
