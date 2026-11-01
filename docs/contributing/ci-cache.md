# CI cache

Trunk CI can reuse a Turborepo remote cache when the repository has optional
credentials. Nothing here requires a paid plan. With the secret unset, Turbo
uses the local cache only and the build still runs.

## Variables

| Name | Source | Meaning |
|---|---|---|
| `TURBO_TOKEN` | Actions secret `TURBO_TOKEN` (optional) | Remote-cache credential. Empty when the secret is unset. |
| `TURBO_TEAM` | Actions variable `TURBO_TEAM` | Turborepo team slug. Empty when unset. |
| `TURBO_REMOTE_CACHE_READ_ONLY` | computed | `true` for a fork pull request or when `TURBO_TOKEN` is missing. `false` when a same-repository run has a token. |

`.github/workflows/ci.yml` sets these at workflow scope so every job sees them.
Fork detection uses `github.event.pull_request.head.repo.full_name` compared
with `github.repository`. The TypeScript build job runs
`node scripts/lib/ci-turbo-cache.mjs` before `turbo`, which writes the same
three variables to `GITHUB_ENV`. That step is the live copy of
[`turboCacheEnv`](../../scripts/lib/ci-turbo-cache.mjs).

`turboCacheEnv(githubContext)` returns `{ TURBO_TOKEN, TURBO_REMOTE_CACHE_READ_ONLY, TURBO_TEAM }`.
Pass `eventName`, `repository`, `headRepository`, `token`, and `team`. A
`pull_request` whose head repository is missing or differs from the base
repository is read-only. A missing or blank token is read-only. The function
does not print the token. Do not echo `TURBO_TOKEN` in a workflow step.

This repository's Turbo still honors `TURBO_REMOTE_CACHE_READ_ONLY` and warns
that it is deprecated in favor of `TURBO_CACHE=remote:r,local:rw` for a
read-only remote cache. CI keeps the name the helper returns.

`turbo.json` sets `envMode` to `strict`. `typecheck` ignores `**/*.md` and
`**/__snapshots__/**`, which the typechecker does not read. `test` ignores
`README.md` only. A blanket `!**/*.md` also drops
`src/__snapshots__/*.approved.md`, and Turbo does not add those files back
when a later glob includes `__snapshots__`. Vitest snapshots and those
approval files stay in the test cache key. `build` outputs stay `dist/**`.
