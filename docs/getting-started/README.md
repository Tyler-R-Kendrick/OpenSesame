# Getting started

From a fresh clone to a running app and a green test suite. Each step says
what it needs, so you can stop at the first one that covers your task.

## 1. Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 22 or newer | Everything TypeScript |
| pnpm | 9.15 — `corepack enable` picks the pinned version | Workspace installs and scripts |
| Rust | 1.88 — `rust-toolchain.toml` pins it | The Host plane (`crates/gateway`, `crates/daemon`, `apps/cli`, `crates/`) |
| PostgreSQL | any supported release | Only for `pnpm bootstrap` / `pnpm db:migrate`; the Identity API runs in memory without it |
| Docker | optional | The Compose stacks in [`ops/compose`](../../ops/compose) |
| Chromium | optional | Browser gates (`verify:*`); Playwright finds `PLAYWRIGHT_CHROMIUM` |

## 2. Install

```bash
corepack enable
pnpm install
pnpm setup:hooks        # point git at .githooks/ (lint, anti-slop, secret scan)
```

`pnpm bootstrap` does the same and also generates and applies the Identity
database schema; it needs `DATABASE_URL` set to a Postgres instance
(see [`.env.schema`](../../.env.schema)).

## 3. Run something

### The app, with no backend

```bash
pnpm --filter @opensesame/pages dev:web
```

Open <http://localhost:5180> — `localhost`, not `127.0.0.1`, or passkeys will
refuse the origin. You land on the front door: set up your own vault, join a
session, or press Skip to continue as a guest. Everything you do is sealed in
the browser; no server is involved. This is the same build GitHub Pages serves
([ADR 0090](../adr/0090-static-frontend-complete-without-backend.md)).

### The app with its backends

```bash
pnpm --filter @opensesame/pages dev
```

`scripts/dev/pages-dev.sh` starts the Host API (`:18787`), the Identity API
(`:18788`), the mock upstream IdP (`:9090`), four more mock IdPs for the demo
social providers (`:9091`–`:9094`) and Vite (`:5180`) together, and keeps
development keys in `~/.local/state/opensesame/development` so they survive
restarts without landing in git. It starts the Host with `cargo run --offline`,
so run `cargo +1.88.0 fetch` once first.

### The Identity plane alone

```bash
pnpm --filter @opensesame/mock-upstream-idp dev          # :9090
OPENSESAME_ALLOW_DEV_DEFAULTS=1 pnpm --filter @opensesame/control-plane start   # :8788
curl -s http://127.0.0.1:8788/v1/health/live
```

`OPENSESAME_ALLOW_DEV_DEFAULTS=1` allows generated development secrets; the
value must be exactly `1` (or `0`), and it is refused on a networked listener.
`OPENSESAME_ENV=development` on its own only names the mode: without an
`OPENSESAME_CLAIM_PEPPER` the Identity API still refuses to start. In
production (or on a networked listener) it requires an
`OPENSESAME_CLAIM_PEPPER` of at least 32 characters, an
`OPENSESAME_OPERATOR_TOKEN`, a `DATABASE_URL` and HTTPS endpoints.

### The Host plane alone

```bash
pnpm dev:host                        # Host API on 127.0.0.1:8787
pnpm dev:daemon                      # daemon on 127.0.0.1:18790
pnpm dev:cli -- daemon status
pnpm dev:cli -- login --flow device --no-browser
```

Run the first two in their own terminals. `dev:host`, `dev:daemon` and
`dev:cli` source `scripts/dev/local-env.sh`, which selects development mode and
generates, under `~/.local/state/opensesame/development`, the operator token
and claim pepper the binaries refuse to start without, plus a connection key
and a receipt-signing key. Run bare, `opensesame host run` and
`opensesame daemon run` exit unless you supply the mode and secrets yourself:
`OPENSESAME_ENV` or `OPENSESAME_ALLOW_DEV_DEFAULTS=1`, and
`OPENSESAME_OPERATOR_TOKEN` and, for the Host, `OPENSESAME_CLAIM_PEPPER`, each
an explicit secret of 32+ characters.

The host CLI also carries the sealed store (`opensesame pass …`, compatible
with `pass`), certificate issuance (`opensesame cert issue`) and developer
environment resolution (`opensesame dev`). `pass` and `cert` are former
top-level verbs the binary still accepts; `opensesame --help` shows them under
`vault` and `access`, and `dev` stays top-level. See
[`skills/opensesame-clis`](../../skills/opensesame-clis/SKILL.md) for the full
verb list.

### An example integration

The [examples](../../examples/README.md) are the shortest path to seeing
OpenSesame from the outside: a relying party signing a user in, an agent
registering and being claimed, a headless device login.

```bash
pnpm --filter @opensesame/example-rp-alpha dev   # :5174, signs in against :8788 (start the Identity plane first)
MOCK_DEVICE_FLOW=1 pnpm --filter @opensesame/example-headless start
```

## 4. Test

```bash
pnpm typecheck                                  # all TypeScript workspaces
pnpm test                                       # all TypeScript tests (Vitest)
cargo +1.88.0 test --workspace --all-targets    # all Rust tests
pnpm lint && pnpm quality                       # what CI checks besides tests
```

One package at a time is faster while you work:

```bash
pnpm --filter @opensesame/app-core test
pnpm --filter @opensesame/app-core exec vitest run src/lib/vault
cargo +1.88.0 test -p opensesame-sealed-store
```

Before touching sign-in, setup, the shell or keyboard handling, run the
browser gates listed in [`AGENTS.md` §3](../../AGENTS.md#3-command-crib-sheet);
they drive a real build in Chromium.

## 5. Next

- [Repository tour](repository-tour.md) — where each kind of code lives and
  which rules apply to it.
- [Architecture](../architecture/README.md) — how the planes fit together.
- [Contributing](../contributing/README.md) — the gates your change has to pass
  and why each exists.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| A `node` or `pnpm` command fails on `NODE_OPTIONS` | Your shell exports `NODE_OPTIONS` with a flag such as `--import tsx` that Node refuses there (the git hooks `unset` it for the same reason). Run with `NODE_OPTIONS=` in front, or unset it. |
| Passkey prompts fail on the dev server | Use `http://localhost:5180`, not `127.0.0.1`. |
| `db:migrate` exits with `DATABASE_URL is required` | Only migrations need Postgres. Skip `pnpm bootstrap`, or export `DATABASE_URL`. |
| Identity API refuses to start | Set `OPENSESAME_ALLOW_DEV_DEFAULTS=1` for local runs (exactly `1`; `true` is refused). |
| `host run` or `daemon run` exits on a missing secret or mode | Start them with `pnpm dev:host` / `pnpm dev:daemon`, which provision development secrets. |
| `pnpm quality` fails with "improvement not recorded" | You made a file smaller or simpler. Run `pnpm quality:gate --update` and commit the baseline. |
| `pnpm quality` fails on the docs index | You added an ADR, an audit or an evidence directory. Run `pnpm docs:index`. |
