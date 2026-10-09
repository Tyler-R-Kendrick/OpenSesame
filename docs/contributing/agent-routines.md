# Agent routines — standing automation outside CI

CI is the merge gate, not the whole story. `.github/workflows/ci.yml` runs
what a diff can reach as the required up-to-date pull-request checks
(TypeScript, Bundle budgets, Rust), `.github/workflows/deploy-pages.yml`
publishes `apps/pages` from `main`, and two further workflows run the whole
TypeScript suite nightly (`full-suite.yml`) and the 2password parity gauntlet
on the pull requests that touch it (`password-parity.yml`). The long audit,
fuzz and drift passes are not Actions jobs. The deeper verification comes from
three layers (the gates and hooks are described in [Contributing](README.md)):

1. **Local git hooks** (`.githooks/` + `scripts/dev/setup-hooks.sh`) — run on
   every commit and push, on the contributor's own machine.
2. **CodeRabbit** — installed as a GitHub App. On this repository it skips
   automatic review while the repo has fewer than 10 stars and posts a
   manual-review notice. A firing does not wait on it.
3. **This layer: standing autonomous agent routines** — Claude Code cloud
   scheduled sessions ("Routines") that run the deeper, periodic work no
   human or CodeRabbit pass covers: dependency/secret scanning triage, a
   rotating security audit of the codebase, documentation drift detection, a
   fuzz batch and an agent-surface parity sweep. This document explains how to
   register and operate them.

## Why this replaces CI-hosted agents

A Routine is a plain Claude Code session that happens to be woken on a
timer. It runs `git`, `gh`, `pnpm`, and `cargo` the same way an interactive
session would, from inside its own environment — it never touches GitHub
Actions, and consumes **zero Actions minutes**, because there is no workflow
file, no runner, and no Actions API call anywhere in the loop. What it
consumes is ordinary Claude Code session time against the existing Claude
subscription, the same as a normal interactive session — no new billing
relationship, no new paid service, no marketplace app to install beyond what
`add_repo`/session access already requires.

**Interplay with CodeRabbit:** The app is installed. While this repository
has fewer than 10 stars it skips the diff. It does not run dependency
scanners, does not maintain a security checklist grounded in this repo's own
audit history, does not periodically re-scan surfaces nobody happens to be
touching this week, and does not check whether root docs still match the
tree. That is the gap these routine files close. The scheduled routines are
time-triggered, and `pr-security-review` is invoked on demand. Both read the
repo beyond a single diff.

## The routine files

All of them live under `ops/routines/` and are each a complete, self-contained
prompt — every firing is a fresh session with no memory of prior runs, so
each file restates the repo context, the hard rules, and the exact commands
to run, the same way this document restates context for you.

| File | Cadence | Deliverable |
|---|---|---|
| `ops/routines/nightly-dependency-triage.md` | Nightly | Fix PR (`fix(deps): ...`) or a dated note in `docs/security/tooling-evaluation.md` |
| `ops/routines/weekly-security-audit.md` | Weekly | New `docs/security/audits/YYYY-MM-DD-<topic>.md` + PR with any small fixes |
| `ops/routines/nightly-fuzz-batch.md` | Nightly | Crash fix PR (`fix(fuzz): …`) with a regression input and an audit note; no PR when CLEAN; never an Actions workflow |
| `ops/routines/weekly-docs-drift.md` | Weekly | Fix PR (`fix(docs): ...`) correcting stale references |
| `ops/routines/weekly-agent-surface-drift.md` | Weekly | Fix PR for a capability that never gained a registry entry |
| `ops/routines/pr-security-review.md` | On demand | One structured review comment on a named PR |

## How a routine executes

A firing follows `AGENTS.md` §9. The session does its editing in a
copy-on-write git worktree `/home/codex/repos/opensesame-<routine>` branched
from the latest `origin/main` (`git worktree add` shares the object
database). It uses the existing pnpm store and
`CARGO_TARGET_DIR=$HOME/.cache/packages/cargo-target`, and it does not copy
`node_modules` or `target/` into that worktree.

Independent findings run together through `.grok/workflows/task-swarm.rhai`:
one agent per disjoint set of files, and the parent integrates. Each logical
slice is its own GitHub-verified commit (`createCommitOnBranch`) on a stacked
pull request. After each commit the session runs `df -h /` and deletes only
the scratch and build output that commit created. A session that cannot reach
GraphQL builds the stack as local commits and has a person with a working `gh`
login replay it as verified commits with `scripts/release/land-signed-stack.mjs`
(see `scripts/release/README.md`). `/tmp/os-wallet-ship`, the
Host on `127.0.0.1:8787`, and unrelated worktrees stay in place.

When the stack is finished the session self-reviews, resolves review threads,
and squash-merges into `origin/main` only after TypeScript, Rust, and Bundle
budgets are green. It then removes the worktree and deletes the merged
branches. Copilot review requests on this repository return HTTP 422, and
CodeRabbit does not auto-review while the repository has fewer than 10 stars,
so the self-review is the review the firing waits on.

## Registering the three scheduled routines

Use `create_trigger` for each. All three fire into a **fresh session**
(`create_new_session_on_fire: true`) so that "no memory of prior runs" is
actually true, not just documented — a persistent-session Routine would
accumulate context across firings, which the routine files are not written
to expect. All cron expressions are UTC, per `create_trigger`'s contract.

Times are chosen so the three never overlap: dependency triage runs before
the work week starts each day, and the two weekly passes land on different
days at different hours, comfortably clear of the nightly run and of each
other.

### 1. nightly-dependency-triage

```
create_trigger(
  name: "nightly-dependency-triage",
  prompt: <the full contents of ops/routines/nightly-dependency-triage.md, pasted verbatim>,
  cron_expression: "0 6 * * *",       # 06:00 UTC, every day
  create_new_session_on_fire: true,
  environment_id: <this repo's environment id>
)
```

### 2. weekly-security-audit

```
create_trigger(
  name: "weekly-security-audit",
  prompt: <the full contents of ops/routines/weekly-security-audit.md, pasted verbatim>,
  cron_expression: "0 7 * * 2",       # 07:00 UTC, every Tuesday
  create_new_session_on_fire: true,
  environment_id: <this repo's environment id>
)
```

### 3. weekly-docs-drift

```
create_trigger(
  name: "weekly-docs-drift",
  prompt: <the full contents of ops/routines/weekly-docs-drift.md, pasted verbatim>,
  cron_expression: "0 8 * * 4",       # 08:00 UTC, every Thursday
  create_new_session_on_fire: true,
  environment_id: <this repo's environment id>
)
```

Schedule at a glance (UTC):

```
Mon   Tue        Wed   Thu        Fri   Sat   Sun
06:00 06:00      06:00 06:00      06:00 06:00 06:00   nightly-dependency-triage
      07:00                                            weekly-security-audit
                       08:00                            weekly-docs-drift
```

`nightly-fuzz-batch.md` and `weekly-agent-surface-drift.md` open with the same
"paste this whole file as the `prompt` of a scheduled session (a Routine,
`create_new_session_on_fire=true`)" instruction as the three above, but this
document gives them no schedule slot.

After creating each trigger, `list_triggers` returns the `trig_...` id —
record it if you need to `update_trigger`, `fire_trigger`, or
`delete_trigger` it later; the id is not guaranteed to stay in any
session's context after creation.

Each of these three routine files already restates, inline, the hard rules
that must hold on every firing (the routine never becomes an Actions job,
no new paid
dependencies/services, never commit secrets, don't touch Rust/Cargo files
unless the finding is in Rust, never expose `getSecret()`/raw secrets,
respect ADR 0004/0008/0017) — registering the trigger does not require
adding those rules anywhere else; they travel with the prompt.

## Invoking pr-security-review on demand

This one is deliberately **not** cron-scheduled — a security review only
makes sense once a specific PR exists to review. Two ways to run it:

**Ad hoc, no standing trigger:** paste the full contents of
`ops/routines/pr-security-review.md` into a new Claude Code cloud session
(or an existing one), followed by the PR number, e.g. `PR number: 123`.

**Via a poke-only Routine bound with `fire_trigger`:** register it once with
no `cron_expression` and no `run_once_at` (a Routine that never fires on its
own schedule — see `create_trigger`'s description), still with
`create_new_session_on_fire: true` so each invocation is a fresh session:

```
create_trigger(
  name: "pr-security-review",
  prompt: <the full contents of ops/routines/pr-security-review.md, pasted verbatim>,
  create_new_session_on_fire: true,
  environment_id: <this repo's environment id>
)
```

Then, whenever a review is wanted:

```
fire_trigger(
  trigger_id: <the trig_... id from list_triggers>,
  text: "PR number: 123"
)
```

`fire_trigger`'s `text` is appended as an extra user turn after the
Routine's configured prompt, which is exactly how `ops/routines/pr-security-review.md`
expects to receive the PR number — it explicitly stops and asks for one if
none was given, rather than guessing.

## Operating notes

- **Environment id.** `create_trigger` needs an `environment_id` pointing at
  an environment that can clone `https://github.com/Tyler-R-Kendrick/OpenSesame`.
  Use `list_environments` to find it; when creating a trigger from inside a
  session already running in the right environment, `environment_id` can be
  omitted and it will be inherited.
- **Model.** These routines do not require a specific model; `create_trigger`
  defaults to the environment's configured model. Change it later with
  `update_trigger(model: ...)` only if a human explicitly asks.
- **Disabling one temporarily.** `update_trigger(trigger_id: ..., enabled: false)`
  pauses a Routine without losing its run history or requiring a
  delete/recreate; flip `enabled: true` to resume.
- **Changing a prompt.** If `ops/routines/*.md` changes, update the matching
  Routine with `update_trigger(trigger_id: ..., prompt: <new file contents>)`
  rather than deleting and recreating — that keeps the Routine's id and run
  history intact.
- **No secrets in the prompt.** None of the routine files embed a
  credential — they authenticate as whatever the firing session's own
  environment/GitHub access already provides (the same `gh`/`git` access an
  interactive Claude Code session in this environment has). Do not paste an
  API key or token into a Routine's `prompt` field to "help" it authenticate.
